'use strict';
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');

function attachRealtime(server, store, allowOrigin) {
  const rooms = new Map();
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 16384,
    verifyClient: info => allowOrigin(info.req) && wss.clients.size < 200
  });
  function deliver(event) {
    const room = rooms.get(event.room);
    if (!room) return;
    const data = JSON.stringify(event.payload);
    for (const client of room) {
      if (client.readyState === 1 && client.clientId !== event.excludeId) client.send(data);
    }
  }
  const emit = (room, payload, excludeId = '') => store.publish({ room, payload, excludeId });
  async function leave(ws) {
    if (!ws.roomId) return;
    const id = ws.roomId;
    ws.roomId = null;
    rooms.get(id)?.delete(ws);
    if (!rooms.get(id)?.size) rooms.delete(id);
    const users = await store.leave(id, ws.clientId);
    await emit(id, { type: 'user-count', users });
    await emit(id, { type: 'system', text: `${ws.userName} left the room`, ts: Date.now() });
  }
  async function handle(ws, raw) {
    if (ws.readyState !== 1) return;
    if (ws.rateWindow < Date.now() - 1000) { ws.rateWindow = Date.now(); ws.messages = 0; }
    if (++ws.messages > 30) { ws.close(1008, 'Message rate exceeded'); return; }
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.type === 'join') {
      const id = String(msg.room || '').trim();
      if (!/^[a-zA-Z0-9_-]{2,80}$/.test(id)) {
        ws.send(JSON.stringify({ type: 'error', text: 'Use a room name with 2–80 letters, numbers or dashes.' }));
        return;
      }
      await leave(ws);
      const state = await store.state(id);
      if (ws.readyState !== 1) return;
      ws.roomId = id;
      ws.userName = String(msg.name || 'Guest').replace(/[<>]/g, '').trim().slice(0, 26) || 'Guest';
      // Names are display labels; a short server suffix distinguishes visitors across instances.
      ws.userName += '-' + ws.clientId.slice(0, 4);
      const users = await store.touch(id, ws.clientId);
      if (!rooms.has(id)) rooms.set(id, new Set());
      rooms.get(id).add(ws);
      ws.send(JSON.stringify({ type: 'joined', room: id, users, state, you: ws.userName }));
      await emit(id, { type: 'user-count', users });
      await emit(id, { type: 'system', text: `${ws.userName} joined the room`, ts: Date.now() });
      return;
    }
    if (!ws.roomId) return;
    if (msg.type === 'request-state') {
      ws.send(JSON.stringify({ type: 'state', ...await store.state(ws.roomId) }));
    } else if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 300);
      if (text) await emit(ws.roomId, { type: 'chat', from: ws.userName, text, ts: Date.now() });
    } else if (['play', 'pause', 'seek', 'sync'].includes(msg.type)) {
      const time = Number(msg.time);
      if (!Number.isFinite(time) || time < 0 || time > 604800) return;
      await store.dispatch(ws.roomId, { type: msg.type, time, playing: msg.playing, by: ws.userName }, ws.clientId);
    }
  }
  wss.on('connection', ws => {
    ws.clientId = randomUUID();
    ws.roomId = null;
    ws.userName = 'Guest';
    ws.alive = true;
    ws.rateWindow = Date.now();
    ws.messages = 0;
    ws.queue = Promise.resolve();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      ws.queue = ws.queue.then(() => handle(ws, raw)).catch(() => ws.close(1013, 'Room service unavailable'));
    });
    ws.on('close', () => { ws.queue.then(() => leave(ws)).catch(() => {}); });
    ws.on('error', () => {});
  });
  const heartbeat = setInterval(async () => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
      if (ws.roomId) {
        try {
          const users = await store.touch(ws.roomId, ws.clientId);
          await emit(ws.roomId, { type: 'user-count', users });
        } catch { ws.close(1013, 'Room service unavailable'); }
      }
    }
  }, 20000);
  heartbeat.unref();
  return {
    deliver,
    localRoomCount: () => rooms.size,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    }
  };
}
module.exports = { attachRealtime };
