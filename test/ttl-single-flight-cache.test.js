import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtlSingleFlightCache } from '../src/ttl-single-flight-cache.js';

test('cache shares one in-flight producer and serves the value until TTL expires', async () => {
  let now = 0;
  let calls = 0;
  let release;
  const states = [];
  const cache = createTtlSingleFlightCache({ ttlMs: 30_000, now: () => now });
  const producer = () => {
    calls++;
    return new Promise((resolve) => { release = () => resolve({ value: calls }); });
  };

  const first = cache.get('world-a', producer, (state) => states.push(state));
  const second = cache.get('world-a', producer, (state) => states.push(state));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ value: 1 }, { value: 1 }]);
  assert.deepEqual(await cache.get('world-a', producer, (state) => states.push(state)), { value: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(states, ['MISS','COALESCED','HIT']);

  now = 30_001;
  const refreshed = cache.get('world-a', async () => ({ value: ++calls }), (state) => states.push(state));
  assert.deepEqual(await refreshed, { value: 2 });
  assert.equal(calls, 2);
  assert.equal(states.at(-1), 'MISS');
});

test('failed producers are not cached', async () => {
  const cache = createTtlSingleFlightCache({ ttlMs: 30_000 });
  await assert.rejects(cache.get('world-a', async () => { throw new Error('temporary failure'); }), /temporary failure/);
  assert.deepEqual(await cache.get('world-a', async () => 'recovered'), 'recovered');
});
