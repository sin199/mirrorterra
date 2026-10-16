import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseReadinessProbe, publicReadinessSnapshot } from '../src/public-readiness.js';

const READY_ENGINE = {
  running: true,
  worldId: 'world-id',
  worldLockOwned: true,
  schedulerRunning: true,
  lastTickCompletedAt: '2026-10-16T00:00:00.000Z'
};

test('public readiness requires initialized server, usable database, writer, scheduler and fresh tick', () => {
  const now = Date.parse('2026-10-16T00:00:05.000Z');
  assert.deepEqual(publicReadinessSnapshot({ serverInitialized: true, databaseUsable: true,
    engine: READY_ENGINE, now }), { status: 'ok', ready: true });
  assert.deepEqual(publicReadinessSnapshot({ serverInitialized: true, databaseUsable: false,
    engine: READY_ENGINE, now }), { status: 'degraded', ready: false });
  assert.deepEqual(publicReadinessSnapshot({ serverInitialized: true, databaseUsable: true,
    engine: { running: false, reason: 'starting' }, now }), { status: 'starting', ready: false });
  assert.deepEqual(publicReadinessSnapshot({ serverInitialized: true, databaseUsable: true,
    engine: { ...READY_ENGINE, lastTickCompletedAt: '2026-10-15T23:58:00.000Z' }, now }),
  { status: 'degraded', ready: false });
});

test('database readiness probe is bounded, cached and shares an in-flight check', async () => {
  let queries = 0;
  let release;
  let currentTime = 1_000;
  const pool = { query: async (query) => {
    queries += 1;
    assert.deepEqual(query, { text: 'SELECT 1', query_timeout: 250 });
    await new Promise((resolve) => { release = resolve; });
  } };
  const probe = createDatabaseReadinessProbe({ pool, ttlMs: 500, queryTimeoutMs: 250,
    now: () => currentTime });
  const first = probe.check();
  const second = probe.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queries, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await probe.check(), true);
  assert.equal(queries, 1);
  currentTime += 501;
  let failedQueries = 0;
  pool.query = async () => { failedQueries += 1; throw new Error('database unavailable'); };
  assert.equal(await probe.check(), false);
  assert.equal(failedQueries, 1);
});
