'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createMediaPolicy, publicAddress } = require('../lib/media-policy');
const { MemoryRoomStore } = require('../lib/room-store');

test('media policy blocks credentials, private/mapped/reserved IPs and mixed DNS answers', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2001:4860:4860::8888'), true);
  const policy = createMediaPolicy({ allowedHosts: ['media.example'],
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(policy.validate('https://media.example/movie.mp4'), /mixed DNS/);
  await assert.rejects(policy.validate('https://user:pass@media.example/movie.mp4'), /credentials/);
  await assert.rejects(policy.validate('file:///etc/passwd'));
  await assert.rejects(policy.validate('https://media.example:8080/movie.mp4'), /ports/);
  await assert.rejects(policy.validate('https://media.example.attacker.test/movie.mp4'), /not approved/);
});

test('upstream DNS is pinned at socket creation and redirects are revalidated', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('test video bytes');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  let lookups = 0;
  const policy = createMediaPolicy({ allowedHosts: ['media.test'], allowPrivate: true,
    lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
  try {
    const port = upstream.address().port;
    const { response } = await policy.open(`http://media.test:${port}/movie`);
    let data = ''; for await (const chunk of response) data += chunk;
    assert.equal(data, 'test video bytes');
    assert.equal(lookups, 1, 'actual socket must reuse the validated resolution, not ask DNS again');
    await assert.rejects(policy.open(`http://media.test:${port}/redirect`), /not approved/);
    assert.equal(hits, 2, 'redirect to metadata was never fetched');
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});

test('memory room store restores state and keeps rooms distinct', async () => {
  const events = [];
  const store = new MemoryRoomStore();
  await store.connect(event => events.push(event));
  await store.dispatch('room-one', { type: 'pause', time: 42, by: 'A' }, 'a');
  assert.deepEqual(await store.state('room-one'), { playing: false, time: 42 });
  assert.deepEqual(await store.state('room-two'), { playing: false, time: 0 });
  assert.equal(events[0].excludeId, 'a');
  assert.equal(await store.touch('room-one', 'a'), 1);
  assert.equal(await store.touch('room-one', 'b'), 2);
  assert.equal(await store.leave('room-one', 'a'), 1);
  assert.deepEqual(await store.state('room-one'), { playing: false, time: 42 });
  await store.close();
});

test('browser reconnect ignores stale sockets and respects an intentional disconnect', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const match of scripts) new vm.Script(match[1]);
  const script = scripts[0][1];
  const source = script.slice(script.indexOf('    function connectSocket()'), script.indexOf('    function joinRoom()'));
  const sockets = [], timers = [];
  class FakeSocket {
    constructor(url) { this.url = url; sockets.push(this); }
  }
  const context = vm.createContext({
    window: { location: { protocol: 'https:', host: 'watch.example' } },
    WebSocket: FakeSocket, ws: null, shouldReconnect: true,
    reconnectDelay: 1000, reconnectTimer: null,
    stopSyncLoop() {}, setStatus() {}, log() {}, clearTimeout() {},
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; }
  });
  vm.runInContext(source + ';connectSocket();connectSocket();', context);
  assert.equal(sockets[0].url, 'wss://watch.example/ws');
  sockets[0].onclose();
  assert.equal(timers.length, 0, 'a stale close must not replace the active connection');
  sockets[1].onclose();
  assert.equal(timers.length, 1);
  vm.runInContext('shouldReconnect = false;', context);
  timers[0].fn();
  assert.equal(sockets.length, 2, 'intentional disconnection must not schedule a fresh socket');
});

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.REDIS_URL;
delete process.env.VERCEL;
delete process.env.REQUIRE_SHARED_ROOMS;
delete process.env.ALLOW_PRIVATE_MEDIA;
delete process.env.MEDIA_ALLOWED_HOSTS;
const app = require('../server');
let base, wsBase;
before(async () => {
  await app.start();
  base = `http://127.0.0.1:${app.server.address().port}`;
  wsBase = base.replace('http:', 'ws:') + '/ws';
});
after(async () => { await app.close(); });

function client(url = wsBase, options) {
  const ws = new WebSocket(url, options);
  const events = [];
  ws.on('message', raw => events.push(JSON.parse(String(raw))));
  ws.on('error', () => {});
  return {
    ws, events,
    async wait(type) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        const index = events.findIndex(event => event.type === type);
        if (index >= 0) return events.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for ' + type);
    }
  };
}

test('real HTTP server exposes honest capabilities and blocks unsafe relay/subtitle requests', async () => {
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.multiInstance, false);
  assert.equal(config.roomStore, 'memory');
  assert.equal(config.relayEnabled, false);
  const proxy = await fetch(base + '/api/proxy?url=' + encodeURIComponent('http://169.254.169.254/latest'));
  assert.equal(proxy.status, 403);
  assert.equal((await fetch(base + '/api/subtitles/list?url=http://127.0.0.1/')).status, 501);
  assert.equal((await fetch(base + '/api/config', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.match(await (await fetch(base)).text(), /Try with a sample video/);
});

test('two actual WebSocket visitors synchronise/chat, and a new connection restores room state', async () => {
  const a = client(), b = client();
  let c;
  try {
    await Promise.all([once(a.ws, 'open'), once(b.ws, 'open')]);
    a.ws.send(JSON.stringify({ type: 'join', room: 'integration-room', name: 'Alice' }));
    b.ws.send(JSON.stringify({ type: 'join', room: 'integration-room', name: 'Bob' }));
    await a.wait('joined'); await b.wait('joined');
    a.ws.send(JSON.stringify({ type: 'pause', time: 31.25 }));
    assert.equal((await b.wait('pause')).time, 31.25);
    b.ws.send(JSON.stringify({ type: 'chat', text: '<img onerror=alert(1)>hello' }));
    assert.equal((await a.wait('chat')).text, '<img onerror=alert(1)>hello');
    a.ws.close(); await once(a.ws, 'close');
    c = client(); await once(c.ws, 'open');
    c.ws.send(JSON.stringify({ type: 'join', room: 'integration-room', name: 'Alice' }));
    const joined = await c.wait('joined');
    assert.equal(joined.state.playing, false);
    assert.equal(joined.state.time, 31.25);
    c.ws.send(JSON.stringify({ type: 'join', room: 'separate-room', name: 'Other' }));
    assert.equal((await c.wait('joined')).state.time, 0);
  } finally {
    a.ws.terminate(); b.ws.terminate(); c?.ws.terminate();
  }
});

test('WebSocket handshake rejects a foreign browser origin', async () => {
  const socket = new WebSocket(wsBase, { origin: 'https://attacker.example' });
  socket.on('error', () => {});
  const [request, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 401);
  response.resume();
  request.destroy();
});

test('oversized WebSocket payload is closed before parsing', async () => {
  const a = client();
  await once(a.ws, 'open');
  const closed = once(a.ws, 'close');
  a.ws.send('x'.repeat(20000));
  assert.equal((await closed)[0], 1009);
});


test('real relay rewrites playlist length and refuses active HTML content', async () => {
  const { createProxyHandler } = require('../lib/proxy');
  const playlist = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.media.test/key"\nsegment.ts\n';
  const upstream = http.createServer((req, res) => {
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>bad()</script>'); return; }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(playlist) });
    res.end(playlist);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const policy = createMediaPolicy({ allowedHosts: ['media.test'], allowPrivate: true,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const proxy = createProxyHandler(policy, app.rewriteM3U8);
  const relay = http.createServer((req, res) => proxy(req, res, new URL(req.url, 'http://relay.test')));
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  try {
    const relayBase = 'http://127.0.0.1:' + relay.address().port;
    const source = 'http://media.test:' + upstream.address().port;
    const response = await fetch(relayBase + '/?url=' + encodeURIComponent(source + '/playlist.m3u8'));
    const rewritten = await response.text();
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(rewritten));
    assert.match(rewritten, /\/api\/proxy\?url=/);
    assert.match(rewritten, /segment.ts/);
    assert.equal((await fetch(relayBase + '/?url=' + encodeURIComponent(source + '/page'))).status, 415);
  } finally {
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => relay.close(resolve))]);
  }
});


test('cloud configuration refuses memory fallback and private relay on public binds', () => {
  const { spawnSync } = require('node:child_process');
  const cloud = spawnSync(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, REQUIRE_SHARED_ROOMS: 'true', REDIS_URL: '', VERCEL: '', ALLOW_PRIVATE_MEDIA: '' },
    timeout: 3000, encoding: 'utf8'
  });
  assert.notEqual(cloud.status, 0);
  assert.match(cloud.stderr, /Shared Redis room storage is required/);
  const unsafeLocal = spawnSync(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, REQUIRE_SHARED_ROOMS: '', REDIS_URL: '', VERCEL: '', HOST: '0.0.0.0', ALLOW_PRIVATE_MEDIA: 'true' },
    timeout: 3000, encoding: 'utf8'
  });
  assert.notEqual(unsafeLocal.status, 0);
  assert.match(unsafeLocal.stderr, /Private media is permitted only on a loopback/);
});
