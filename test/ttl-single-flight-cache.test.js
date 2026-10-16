import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtlSingleFlightCache } from '../src/ttl-single-flight-cache.js';

test('cache shares cold work, serves stale immediately, and single-flights the background refresh', async () => {
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
  let releaseRefresh;
  const refreshProducer = () => {
    calls++;
    return new Promise((resolve) => { releaseRefresh = () => resolve({ value: calls }); });
  };
  assert.deepEqual(await cache.get('world-a', refreshProducer, (state) => states.push(state)), { value: 1 });
  assert.deepEqual(await cache.get('world-a', refreshProducer, (state) => states.push(state)), { value: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(states.slice(-2), ['STALE','STALE']);
  releaseRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await cache.get('world-a', refreshProducer, (state) => states.push(state)), { value: 2 });
  assert.equal(states.at(-1), 'HIT');
});

test('failed producers are not cached', async () => {
  const cache = createTtlSingleFlightCache({ ttlMs: 30_000 });
  await assert.rejects(cache.get('world-a', async () => { throw new Error('temporary failure'); }), /temporary failure/);
  assert.deepEqual(await cache.get('world-a', async () => 'recovered'), 'recovered');
});

test('failed stale refresh keeps the stale value through the retry window and hard-expires at maximum age', async () => {
  let now = 0;
  let failures = 0;
  const cache = createTtlSingleFlightCache({ ttlMs: 30, maxStaleMs: 300, refreshRetryMs: 20, now: () => now });
  assert.equal(await cache.get('world-a', async () => 'initial'), 'initial');
  now = 31;
  assert.equal(await cache.get('world-a', async () => { failures++; throw new Error('refresh failed'); }), 'initial');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
  now = 40;
  assert.equal(await cache.get('world-a', async () => { failures++; throw new Error('too soon'); }), 'initial');
  assert.equal(failures, 1);
  now = 301;
  await assert.rejects(cache.get('world-a', async () => { throw new Error('hard miss failed'); }), /hard miss failed/);
});
