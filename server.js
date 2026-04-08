const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3456);
const rooms = new Map();

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || '';

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    // Plain command name (PATH lookup at spawn time)
    return candidate;
  }
  return null;
}

const FFPROBE_BIN = firstExistingPath([
  process.env.FFPROBE_BIN,
  path.join(LOCAL_APP_DATA, 'Programs', 'Stremio', 'ffprobe.exe'),
  path.join(LOCAL_APP_DATA, 'Programs', 'LNV', 'Stremio-4', 'ffprobe.exe'),
  path.join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe'),
  'ffprobe',
]);

const FFMPEG_BIN = firstExistingPath([
  process.env.FFMPEG_BIN,
  path.join(LOCAL_APP_DATA, 'Programs', 'Stremio', 'ffmpeg.exe'),
  path.join(LOCAL_APP_DATA, 'Programs', 'LNV', 'Stremio-4', 'ffmpeg.exe'),
  path.join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  'ffmpeg',
]);

function parseHttpUrl(raw) {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function runCommandCapture(command, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Command timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 5_000_000) {
        stdout = stdout.slice(-2_500_000);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) {
        stderr = stderr.slice(-1_000_000);
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function safeRoomId(value) {
  const room = String(value || '').trim().slice(0, 80);
  return room.replace(/[^a-zA-Z0-9-_]/g, '') || 'movie-night';
}

function safeName(value) {
  const name = String(value || '').trim().slice(0, 32);
  return name.replace(/[<>]/g, '');
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      state: { playing: false, time: 0, updatedAt: Date.now() },
      nextUserId: 1,
    });
  }
  return rooms.get(roomId);
}

function allocateUserName(room, requestedName = '') {
  const base = String(requestedName || '').trim();
  const used = new Set();
  for (const client of room.clients) {
    if (client?.userName) used.add(String(client.userName).toLowerCase());
  }

  if (base && !used.has(base.toLowerCase())) return base;
  if (base && !/^host$/i.test(base)) {
    let n = 2;
    let candidate = `${base}-${n}`;
    while (used.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  let candidate;
  do {
    candidate = `User${room.nextUserId++}`;
  } while (used.has(candidate.toLowerCase()));
  return candidate;
}

function getEffectiveState(state) {
  const now = Date.now();
  const elapsed = Math.max(0, (now - state.updatedAt) / 1000);
  return {
    playing: !!state.playing,
    time: state.playing ? state.time + elapsed : state.time,
  };
}

function setRoomState(room, next) {
  room.state = {
    playing: typeof next.playing === 'boolean' ? next.playing : room.state.playing,
    time: Number.isFinite(next.time) ? Math.max(0, next.time) : getEffectiveState(room.state).time,
    updatedAt: Date.now(),
  };
}

function broadcast(roomId, payload, exclude = null) {
  if (!rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  const data = JSON.stringify(payload);
  for (const client of room.clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const roomId = ws.roomId;
  if (!rooms.has(roomId)) {
    ws.roomId = null;
    return;
  }

  const room = rooms.get(roomId);
  room.clients.delete(ws);
  ws.roomId = null;

  if (room.clients.size === 0) {
    rooms.delete(roomId);
    return;
  }

  broadcast(roomId, { type: 'user-count', users: room.clients.size });
  broadcast(roomId, {
    type: 'system',
    text: `${ws.userName || 'Someone'} left the room`,
    ts: Date.now(),
  });
}

function proxifyUrl(rawUrl, baseUrl) {
  let absolute;
  try {
    absolute = new URL(rawUrl, baseUrl).toString();
  } catch {
    return rawUrl;
  }
  return `/api/proxy?url=${encodeURIComponent(absolute)}`;
}

function rewriteM3U8(content, baseUrl) {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." attributes inside tags.
      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxifyUrl(uri, baseUrl)}"`);
        }
        return line;
      }

      // Rewrite media segment / child playlist lines.
      return proxifyUrl(trimmed, baseUrl);
    })
    .join('\n');
}

async function handleProxy(req, res, parsedUrl) {
  const targetRaw = parsedUrl.searchParams.get('url');
  if (!targetRaw) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Missing url query parameter' }));
    return;
  }

  let target;
  try {
    target = new URL(targetRaw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Invalid target URL' }));
    return;
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Only http/https target URLs are allowed' }));
    return;
  }

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
  if (req.headers.accept) headers.accept = req.headers.accept;

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'follow',
    });
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Failed to fetch upstream stream', detail: String(error) }));
    return;
  }

  const passHeaders = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'cache-control',
    'etag',
    'last-modified',
  ];

  for (const name of passHeaders) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  res.statusCode = upstream.status;

  const upstreamType = (upstream.headers.get('content-type') || '').toLowerCase();
  const looksLikeM3U8ByType = upstreamType.includes('mpegurl');

  if (looksLikeM3U8ByType || target.pathname.toLowerCase().endsWith('.m3u8')) {
    const playlist = await upstream.text();
    const isPlaylist = upstream.ok && (looksLikeM3U8ByType || playlist.trimStart().startsWith('#EXTM3U'));

    if (isPlaylist) {
      const rewritten = rewriteM3U8(playlist, upstream.url || target.toString());
      res.setHeader('content-type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.end(rewritten);
      return;
    }

    // Not a valid playlist body (often an upstream error text); pass through unchanged.
    res.end(playlist);
    return;
  }

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

async function handleSubtitleList(res, parsedUrl) {
  const targetRaw = parsedUrl.searchParams.get('url');
  const target = parseHttpUrl(targetRaw);
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Invalid or missing url query parameter' }));
    return;
  }

  if (!FFPROBE_BIN) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'ffprobe binary not found on host' }));
    return;
  }

  let probe;
  try {
    probe = await runCommandCapture(
      FFPROBE_BIN,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 's', target.toString()],
      30000,
    );
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Failed to run ffprobe', detail: String(error) }));
    return;
  }

  if (probe.code !== 0) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'ffprobe failed', detail: probe.stderr.slice(-4000) }));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(probe.stdout || '{}');
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'ffprobe output parse failed' }));
    return;
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const subtitles = streams.map((stream, idx) => ({
    streamIndex: Number.isFinite(stream?.index) ? stream.index : idx,
    codec: stream?.codec_name || 'unknown',
    language: stream?.tags?.language || stream?.tags?.LANGUAGE || 'und',
    title: stream?.tags?.title || stream?.tags?.TITLE || '',
    default: !!stream?.disposition?.default,
    forced: !!stream?.disposition?.forced,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ subtitles }));
}

async function handleSubtitleVtt(req, res, parsedUrl) {
  const targetRaw = parsedUrl.searchParams.get('url');
  const target = parseHttpUrl(targetRaw);
  const streamIndex = Number(parsedUrl.searchParams.get('index'));

  if (!target || !Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 999) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Invalid url or subtitle stream index' }));
    return;
  }

  if (!FFMPEG_BIN) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'ffmpeg binary not found on host' }));
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  const ffmpegArgs = ['-v', 'error', '-i', target.toString(), '-map', `0:${streamIndex}`, '-f', 'webvtt', '-'];
  const child = spawn(FFMPEG_BIN, ffmpegArgs, { windowsHide: true });

  let stderr = '';
  let didEnd = false;

  const hardKillTimer = setTimeout(() => {
    if (!didEnd) child.kill('SIGKILL');
  }, 90_000);

  const cleanup = () => {
    clearTimeout(hardKillTimer);
  };

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
  });

  child.on('error', (error) => {
    cleanup();
    if (didEnd) return;
    didEnd = true;
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Failed to spawn ffmpeg', detail: String(error) }));
  });

  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
  child.stdout.pipe(res);

  const abortChild = () => {
    if (!didEnd) {
      didEnd = true;
      child.kill('SIGKILL');
      cleanup();
    }
  };

  req.on('close', abortChild);
  res.on('close', abortChild);

  child.on('close', (code) => {
    cleanup();
    if (didEnd) return;
    didEnd = true;

    if (code !== 0 && !res.writableEnded) {
      res.end(`\n\nNOTE ffmpeg_error: ${stderr.replace(/\r?\n+/g, ' ').slice(-1000)}\n`);
      return;
    }

    if (!res.writableEnded) res.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (pathname === '/api/proxy') {
    await handleProxy(req, res, parsedUrl);
    return;
  }

  if (pathname === '/api/subtitles/list') {
    await handleSubtitleList(res, parsedUrl);
    return;
  }

  if (pathname === '/api/subtitles/vtt') {
    await handleSubtitleVtt(req, res, parsedUrl);
    return;
  }

  let file = pathname === '/' ? '/index.html' : pathname;
  const safeFilePath = path.normalize(path.join(__dirname, 'public', file));
  const publicRoot = path.normalize(path.join(__dirname, 'public'));

  if (!safeFilePath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(safeFilePath);
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  fs.readFile(safeFilePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.userName = '';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      leaveRoom(ws);

      ws.roomId = safeRoomId(msg.room);
      const requestedName = safeName(msg.name);

      const room = getRoom(ws.roomId);
      ws.userName = allocateUserName(room, requestedName);
      room.clients.add(ws);

      ws.send(
        JSON.stringify({
          type: 'joined',
          room: ws.roomId,
          users: room.clients.size,
          state: getEffectiveState(room.state),
          you: ws.userName,
        }),
      );

      broadcast(ws.roomId, { type: 'user-count', users: room.clients.size }, ws);
      broadcast(ws.roomId, {
        type: 'system',
        text: `${ws.userName} joined the room`,
        ts: Date.now(),
      });
      return;
    }

    if (!ws.roomId || !rooms.has(ws.roomId)) return;
    const room = rooms.get(ws.roomId);

    if (msg.type === 'request-state') {
      ws.send(JSON.stringify({ type: 'state', ...getEffectiveState(room.state) }));
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      broadcast(ws.roomId, {
        type: 'chat',
        from: ws.userName,
        text,
        ts: Date.now(),
      });
      return;
    }

    if (msg.type === 'play' || msg.type === 'pause' || msg.type === 'seek' || msg.type === 'sync') {
      const time = Number(msg.time);
      const current = getEffectiveState(room.state);

      if (msg.type === 'play') {
        setRoomState(room, { playing: true, time: Number.isFinite(time) ? time : current.time });
      } else if (msg.type === 'pause') {
        setRoomState(room, { playing: false, time: Number.isFinite(time) ? time : current.time });
      } else if (msg.type === 'seek') {
        setRoomState(room, { playing: room.state.playing, time: Number.isFinite(time) ? time : current.time });
      } else if (msg.type === 'sync') {
        const remotePlaying = typeof msg.playing === 'boolean' ? msg.playing : room.state.playing;
        const remoteTime = Number.isFinite(time) ? time : current.time;
        const drift = Math.abs(remoteTime - current.time);
        if (drift > 0.25 || remotePlaying !== current.playing) {
          setRoomState(room, { playing: remotePlaying, time: remoteTime });
        }
      }

      const outbound = {
        type: msg.type,
        time: getEffectiveState(room.state).time,
        playing: room.state.playing,
        by: ws.userName,
      };
      broadcast(ws.roomId, outbound, ws);
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

server.listen(PORT, () => {
  console.log(`Watch Party running at http://localhost:${PORT}`);
});
