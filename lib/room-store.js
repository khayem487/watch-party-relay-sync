'use strict';
const { createClient } = require('redis');
const TTL = 3600;
const LEASE_MS = 70000;

function effective(state, now = Date.now()) {
  state ||= { playing: false, time: 0, updatedAt: now };
  return { playing: !!state.playing, time: Math.max(0, state.time + (state.playing ? Math.max(0, now - state.updatedAt) / 1000 : 0)) };
}
function nextState(previous, msg, now = Date.now()) {
  const current = effective(previous, now);
  const time = Number.isFinite(msg.time) ? Math.min(604800, Math.max(0, msg.time)) : current.time;
  const playing = msg.type === 'play' ? true : msg.type === 'pause' ? false
    : msg.type === 'sync' && typeof msg.playing === 'boolean' ? msg.playing : current.playing;
  return { playing, time, updatedAt: now };
}

class MemoryRoomStore {
  constructor() { this.mode = 'memory'; this.ready = false; this.states = new Map(); this.members = new Map(); }
  async connect(listener) { this.listener = listener; this.ready = true; }
  async publish(event) { this.listener(event); }
  async state(room) {
    const saved = this.states.get(room);
    if (saved && saved.expires > Date.now()) return effective(saved.state);
    this.states.delete(room);
    return effective(null);
  }
  async dispatch(room, msg, excludeId) {
    for (const [id, value] of this.states) if (value.expires <= Date.now()) this.states.delete(id);
    if (!this.states.has(room) && this.states.size >= 500) throw new Error('Room capacity reached.');
    const old = this.states.get(room);
    const state = nextState(old?.expires > Date.now() ? old.state : null, msg);
    this.states.set(room, { state, expires: Date.now() + TTL * 1000 });
    await this.publish({ room, excludeId, payload: { type: msg.type, ...effective(state), by: msg.by } });
  }
  async touch(room, id) {
    const members = this.members.get(room) || new Map();
    const now = Date.now();
    for (const [key, expiry] of members) if (expiry <= now) members.delete(key);
    members.set(id, now + LEASE_MS);
    this.members.set(room, members);
    return members.size;
  }
  async leave(room, id) {
    const members = this.members.get(room);
    if (!members) return 0;
    members.delete(id);
    if (!members.size) this.members.delete(room);
    return members.size;
  }
  async close() { this.ready = false; }
}

// Updating the shared state and publishing the event occur in one Redis operation.
const UPDATE_LUA = `
local raw = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
local s = raw and cjson.decode(raw) or {playing=false,time=0,updatedAt=now}
local t = s.time
if s.playing then t = t + math.max(0,now-s.updatedAt)/1000 end
local op = ARGV[2]
local supplied = tonumber(ARGV[3])
if supplied then t = math.max(0,math.min(604800,supplied)) end
if op == 'play' then s.playing = true elseif op == 'pause' then s.playing = false
elseif op == 'sync' and ARGV[4] ~= '' then s.playing = ARGV[4] == 'true' end
s.time=t; s.updatedAt=now
redis.call('SET',KEYS[1],cjson.encode(s),'EX',ARGV[8])
local event={room=ARGV[5],excludeId=ARGV[6],payload={type=op,time=t,playing=s.playing,by=ARGV[7]}}
redis.call('PUBLISH',ARGV[9],cjson.encode(event))
return cjson.encode(s)
`;
const TOUCH_LUA = `
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1])
redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3])
redis.call('EXPIRE',KEYS[1],120)
return redis.call('ZCARD',KEYS[1])
`;

class RedisRoomStore {
  constructor(url, prefix = 'watch-party:v1') {
    if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(prefix)) throw new Error('Invalid room store prefix.');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid Redis connection configuration.'); }
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('Use a Redis connection URL.');
    if ((process.env.VERCEL || process.env.REQUIRE_SHARED_ROOMS === 'true') && parsed.protocol !== 'rediss:')
      throw new Error('Cloud room storage requires a TLS Redis URL.');
    this.prefix = prefix; this.mode = 'redis'; this.ready = false;
    this.client = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 1000, socket: { connectTimeout: 8000, reconnectStrategy: retries => retries > 8 ? new Error('Redis unavailable.') : Math.min(retries * 200, 3000) } });
    this.subscriber = this.client.duplicate();
    this.client.on('error', () => { this.ready = false; });
    this.subscriber.on('error', () => { this.ready = false; });
    this.client.on('ready', () => { this.ready = this.subscriber.isReady; });
    this.subscriber.on('ready', () => { this.ready = this.client.isReady; });
  }
  key(room, kind) { return `${this.prefix}:room:${room}:${kind}`; }
  channel() { return `${this.prefix}:events`; }
  async connect(listener) {
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(this.channel(), raw => {
      try {
        const event = JSON.parse(raw);
        if (event && typeof event.room === 'string' && event.payload) listener(event);
      } catch { /* Invalid data from the configured store is never executed. */ }
    });
    this.ready = true;
  }
  check() { if (!this.client.isReady || !this.subscriber.isReady) throw new Error('Shared room store unavailable.'); }
  async publish(event) { this.check(); await this.client.publish(this.channel(), JSON.stringify(event)); }
  async state(room) {
    this.check();
    const raw = await this.client.get(this.key(room, 'state'));
    return effective(raw ? JSON.parse(raw) : null);
  }
  async dispatch(room, msg, excludeId) {
    this.check();
    await this.client.eval(UPDATE_LUA, {
      keys: [this.key(room, 'state')],
      arguments: [String(Date.now()), msg.type, Number.isFinite(msg.time) ? String(msg.time) : '',
        typeof msg.playing === 'boolean' ? String(msg.playing) : '', room, excludeId, msg.by, String(TTL), this.channel()]
    });
  }
  async touch(room, id) {
    this.check();
    const now = Date.now();
    return this.client.eval(TOUCH_LUA, {
      keys: [this.key(room, 'members')], arguments: [String(now), String(now + LEASE_MS), id]
    });
  }
  async leave(room, id) {
    this.check();
    const key = this.key(room, 'members');
    await this.client.zRem(key, id);
    await this.client.zRemRangeByScore(key, '-inf', String(Date.now()));
    return this.client.zCard(key);
  }
  async close() {
    this.ready = false;
    await Promise.allSettled([this.subscriber.close(), this.client.close()]);
  }
}

function createRoomStore(url = process.env.REDIS_URL) {
  return url ? new RedisRoomStore(url, process.env.REDIS_PREFIX || 'watch-party:v1') : new MemoryRoomStore();
}
module.exports = { createRoomStore, MemoryRoomStore, RedisRoomStore, effective, nextState };
