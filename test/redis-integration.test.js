'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { RedisRoomStore } = require('../lib/room-store');

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
