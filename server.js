const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createMediaPolicy } = require('./lib/media-policy');
const { createProxyHandler } = require('./lib/proxy');
const { createRoomStore } = require('./lib/room-store');
const { attachRealtime } = require('./lib/realtime');

const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || (process.env.VERCEL ? '0.0.0.0' : '127.0.0.1');
const allowPrivate = process.env.ALLOW_PRIVATE_MEDIA === 'true';
if (allowPrivate && (process.env.VERCEL || !['127.0.0.1', '::1', 'localhost'].includes(HOST)))
  throw new Error('Private media is permitted only on a loopback-only local server.');
const nativeSubtitles = allowPrivate && process.env.ENABLE_LOCAL_SUBTITLES === 'true';
const policy = createMediaPolicy({
  allowedHosts: String(process.env.MEDIA_ALLOWED_HOSTS || '').split(','), allowPrivate
});
if ((process.env.VERCEL || process.env.REQUIRE_SHARED_ROOMS === 'true') && !process.env.REDIS_URL)
  throw new Error('Shared Redis room storage is required for this cloud deployment.');
const store = createRoomStore();
function allowOrigin(req) {
  if (allowPrivate) {
    try {
      const hostname = new URL('http://' + req.headers.host).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return false;
    } catch { return false; }
  }
  const configured = String(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (req.headers.origin && configured.includes(req.headers.origin)) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return origin.host === req.headers.host;
  } catch { return false; }
}


const LOCAL_APP_DATA = process.env.LOCALAPPDATA || '';

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    // Locate an installed binary without executing a program during capability discovery.
    const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
    for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
      for (const extension of extensions) {
        const binary = path.join(directory, candidate + extension);
        if (fs.existsSync(binary)) return binary;
      }
    }
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

const handleProxy = createProxyHandler(policy, rewriteM3U8);

async function handleSubtitleList(res, parsedUrl) {
  if (!nativeSubtitles) {
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Embedded subtitle extraction is available only on a trusted local host with FFmpeg.' }));
    return;
  }
  try { await policy.validate(parsedUrl.searchParams.get('url') || ''); }
  catch {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'This source is not approved for local subtitle extraction.' }));
    return;
  }

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
  if (!nativeSubtitles) {
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Embedded subtitle extraction is available only on a trusted local host with FFmpeg.' }));
    return;
  }
  try { await policy.validate(parsedUrl.searchParams.get('url') || ''); }
  catch {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'This source is not approved for local subtitle extraction.' }));
    return;
  }

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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  let parsedUrl;
  try { parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  const pathname = parsedUrl.pathname;
  if (pathname.startsWith('/api/') && !allowOrigin(req)) {
    res.writeHead(403); res.end('Cross-origin request denied'); return;
  }
  if (pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ roomStore: store.mode, multiInstance: store.mode === 'redis' && store.ready,
      relayEnabled: policy.enabled, localMedia: allowPrivate, embeddedSubtitles: !!(nativeSubtitles && FFPROBE_BIN && FFMPEG_BIN) }));
    return;
  }

  if (pathname === '/health') {
    res.writeHead(store.ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: store.ready, localRooms: realtime.localRoomCount(), roomStore: store.mode, multiInstance: store.mode === 'redis' && store.ready }));
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

    if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405); res.end('Method not allowed'); return;
  }
  let file;
  try { file = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); }
  catch { res.writeHead(400); res.end('Bad path'); return; }
  if (file.includes('\0')) { res.writeHead(400); res.end('Bad path'); return; }
  const safeFilePath = path.resolve(__dirname, 'public', '.' + file);
  const publicRoot = path.normalize(path.join(__dirname, 'public'));

  if (!safeFilePath.startsWith(publicRoot + path.sep)) {
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

const realtime = attachRealtime(server, store, allowOrigin);
async function start() {
  await store.connect(realtime.deliver);
  await new Promise(resolve => server.listen(PORT, HOST, resolve));
  console.log(`Watch Party running at http://${HOST}:${server.address().port} (rooms: ${store.mode})`);
  return server;
}
async function close() {
  await realtime.close();
  await new Promise(resolve => server.close(resolve));
  await store.close();
}
if (require.main === module) {
  start().catch(() => {
    console.error('Watch Party could not start. Verify room-store configuration; no memory fallback was used.');
    process.exit(1);
  });
}
module.exports = { server, start, close, rewriteM3U8 };
