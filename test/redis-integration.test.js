'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { RedisRoomStore } = require('../lib/room-store');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

test('two independent Redis-backed stores share state, events and presence',
  { skip: !process.env.TEST_REDIS_URL && 'No TEST_REDIS_URL supplied; external Redis integration unverified.' },
  async () => {
    const prefix = 'watch-party-test:' + randomUUID();
    const a = new RedisRoomStore(process.env.TEST_REDIS_URL, prefix);
    const b = new RedisRoomStore(process.env.TEST_REDIS_URL, prefix);
    const events = [];
    try {
      await a.connect(() => {});
      await b.connect(event => events.push(event));
      assert.equal(await a.touch('shared-room', 'alice'), 1);
      assert.equal(await b.touch('shared-room', 'bob'), 2);
      await a.dispatch('shared-room', { type: 'pause', time: 29.75, by: 'Alice' }, 'alice');
      assert.deepEqual(await b.state('shared-room'), { playing: false, time: 29.75 });
      const until = Date.now() + 2000;
      while (!events.some(event => event.payload.type === 'pause') && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(events.find(event => event.payload.type === 'pause').payload.time, 29.75);
      assert.equal(await b.leave('shared-room', 'bob'), 1);
      await a.client.del(a.key('shared-room', 'state'));
      await a.client.del(a.key('shared-room', 'members'));
    } finally { await Promise.allSettled([a.close(), b.close()]); }
  });

// Separate OS processes ensure there is no accidental shared in-memory hub.
function launchServer(prefix) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', VERCEL: '',
      REQUIRE_SHARED_ROOMS: 'false', REDIS_URL: process.env.TEST_REDIS_URL,
      REDIS_PREFIX: prefix, ALLOW_PRIVATE_MEDIA: 'false', ENABLE_LOCAL_SUBTITLES: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const started = new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('Test server startup timed out.')), 20000);
    const fail = () => { clearTimeout(timeout); reject(new Error('Test server could not start; check the test Redis service.')); };
    child.once('error', fail);
    child.once('exit', fail);
    child.stdout.on('data', data => {
      stdout = (stdout + data.toString()).slice(-4000);
      const match = stdout.match(/running at http:\/\/127\.0\.0\.1:(\d+) \(rooms: redis\)/);
      if (!match) return;
      clearTimeout(timeout);
      child.removeListener('error', fail);
      child.removeListener('exit', fail);
      resolve(Number(match[1]));
    });
    // Never forward stderr: connection diagnostics can contain a credential URL.
    child.stderr.resume();
  });
  return { child, started };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function connectVisitor(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  await once(ws, 'open');
  return { ws, messages };
}

async function waitFor(messages, predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected cross-process WebSocket event did not arrive.');
}

test('two real server processes share playback and chat, and a restarted process restores the room',
  { skip: !process.env.TEST_REDIS_URL && 'No TEST_REDIS_URL supplied; cross-process Redis integration unverified.', timeout: 60000 },
  async () => {
    const prefix = 'watch-party-process-test:' + randomUUID();
    const cleanup = new RedisRoomStore(process.env.TEST_REDIS_URL, prefix);
    const children = [], sockets = [];
    try {
      await cleanup.connect(() => {});
      const a = launchServer(prefix), b = launchServer(prefix);
      children.push(a.child, b.child);
      const [portA, portB] = await Promise.all([a.started, b.started]);
      const alice = await connectVisitor(portA), bob = await connectVisitor(portB);
      sockets.push(alice.ws, bob.ws);
      alice.ws.send(JSON.stringify({ type: 'join', room: 'shared-room', name: 'Alice' }));
      await waitFor(alice.messages, message => message.type === 'joined');
      bob.ws.send(JSON.stringify({ type: 'join', room: 'shared-room', name: 'Bob' }));
      const bobJoined = await waitFor(bob.messages, message => message.type === 'joined');
      assert.equal(bobJoined.users, 2);
      alice.ws.send(JSON.stringify({ type: 'pause', time: 29.75 }));
      const paused = await waitFor(bob.messages, message => message.type === 'pause');
      assert.equal(paused.time, 29.75);
      assert.equal(paused.playing, false);
      bob.ws.send(JSON.stringify({ type: 'chat', text: 'Across two actual processes' }));
      await waitFor(alice.messages, message => message.type === 'chat' && message.text === 'Across two actual processes');

      await stopServer(b.child);
      const replacement = launchServer(prefix);
      children.push(replacement.child);
      const carol = await connectVisitor(await replacement.started);
      sockets.push(carol.ws);
      carol.ws.send(JSON.stringify({ type: 'join', room: 'shared-room', name: 'Carol' }));
      const restored = await waitFor(carol.messages, message => message.type === 'joined');
      assert.deepEqual(restored.state, { playing: false, time: 29.75 });
      carol.ws.send(JSON.stringify({ type: 'chat', text: 'After process restart' }));
      await waitFor(alice.messages, message => message.type === 'chat' && message.text === 'After process restart');
    } finally {
      for (const socket of sockets) socket.terminate();
      await Promise.allSettled(children.map(stopServer));
      try {
        if (cleanup.client.isReady) {
          await cleanup.client.del(cleanup.key('shared-room', 'state'));
          await cleanup.client.del(cleanup.key('shared-room', 'members'));
        }
      } finally { await cleanup.close(); }
    }
  });
