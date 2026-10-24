import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { ArcReadOnlyObserver } from '../src/arc/observer.js';
import { ArcRpcClient } from '../src/arc/rpc.js';
import { arcNetworkConfig } from '../src/arc/config.js';
import { summarizeArcObserverHealth } from '../src/arc/status.js';
import { createObservationScope } from '../src/arc/observation-scope.js';

const worldId = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const config = arcNetworkConfig({ ARC_ENV: 'mainnet' });
function observationPool() {
  const releases = [];
  let hang = false;
  const pool = {
    releases,
    set hang(value) { hang = value; },
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true, owner_pid: 123 }] };
      if (sql.includes('FROM world_runtime_state')) {
        if (hang) return new Promise(() => {});
        return { rows: [{ worldMinute: 100, lastTickAt: new Date() }] };
      }
      if (sql.includes('SELECT count(*)::int')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    },
    async connect() {
      let released = false;
      return { query: pool.query.bind(pool), release(destroyed = false) {
        assert.equal(released, false, 'a borrowed client is released once');
        released = true;
        releases.push(destroyed);
      } };
    }
  };
  return pool;
}
function healthyRpc() {
  return { async health() { return { chainId: 5042, rpcHealthy: true, latestBlock: 100 }; },
    async getCode() { return '0x1234'; }, async call() { return '0x6'; } };
}

test('a timed-out SQL read destroys its connection, preserves success time and can recover', async () => {
  const pool = observationPool();
  const observer = new ArcReadOnlyObserver({ pool, config, env: {}, rpcClient: healthyRpc(),
    sampleTimeoutMs: 500, queryTimeoutMs: 30 });
  try {
    await observer.start({ worldId });
    const success = observer.getStatus().lastSuccessfulSampleAt;
    assert.ok(success);
    pool.hang = true;
    const failed = await observer.sample();
    assert.equal(failed.lastError.code, 'ARC_OBSERVER_QUERY_TIMEOUT');
    assert.equal(failed.lastSuccessfulSampleAt, success);
    assert.equal(failed.lastSampleAt, success, 'a failed attempt cannot refresh success freshness');
    assert.equal(failed.sampleInProgress, false);
    assert.equal(failed.samplePhase, 'database_summary');
    assert.equal(pool.releases.filter(Boolean).length, 1);
    pool.hang = false;
    await observer.sample();
    assert.equal(observer.getStatus().lastError, null);
    assert.equal(observer.getStatus().lastSampleWorldMinute, 100);
  } finally { await observer.stop(); }
});

test('the sample deadline aborts real RPC fetches and does not enter an unbounded recovery probe', async () => {
  const pool = observationPool();
  let aborted = 0;
  const rpc = new ArcRpcClient({ config, fetchImpl: async (_url, { body, signal }) => {
    if (JSON.parse(body).method === 'eth_chainId') {
      return { ok: true, json: async () => ({ result: '0x13b2' }) };
    }
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted += 1; reject(signal.reason);
    }, { once: true }));
  } });
  const observer = new ArcReadOnlyObserver({ pool, config, env: {}, rpcClient: rpc, sampleTimeoutMs: 35 });
  try {
    await observer.start({ worldId });
    assert.equal(observer.getStatus().lastError.code, 'ARC_OBSERVER_SAMPLE_TIMEOUT');
    assert.equal(observer.getStatus().lastSuccessfulSampleAt, null);
    assert.equal(observer.getStatus().sampleInProgress, false);
    assert.ok(aborted > 0);
  } finally { await observer.stop(); }
});

test('stop aborts an in-flight sample, suppresses reentry and leaves no startup timer', async () => {
  const pool = observationPool();
  let calls = 0;
  const rpc = { async health() { calls += 1; return new Promise(() => {}); } };
  const observer = new ArcReadOnlyObserver({ pool, config, env: {}, rpcClient: rpc, sampleTimeoutMs: 1000 });
  const starting = observer.start({ worldId });
  await nextTurn();
  assert.equal((await observer.sample()).sampleInProgress, true);
  assert.equal(calls, 1);
  await observer.stop();
  await starting;
  assert.equal(observer.getStatus().running, false);
  assert.equal(observer.getStatus().reason, 'observer_stopped');
  assert.equal(observer.getStatus().sampleInProgress, false);
  assert.equal(pool.releases.length, 1, 'dedicated advisory-lock client is released');
});

test('a connection arriving after timeout is discarded rather than leaked into the pool', async () => {
  let released;
  const scope = createObservationScope({ async connect() {
    await delay(50);
    return { release(destroy) { released = destroy; }, query() { assert.fail('no query after timeout'); } };
  } }, { timeoutMs: 25 });
  try {
    await assert.rejects(scope.pool.query('SELECT 1'), { code: 'ARC_OBSERVER_SAMPLE_TIMEOUT' });
    await delay(50);
    assert.equal(released, true);
  } finally { scope.close(); }
});

test('public health marks stale last-good data explicitly and does not publish it as a healthy RPC', () => {
  const at = '2026-10-24T02:00:00Z';
  const raw = { available: true, running: true, samplingIntervalMs: 60_000,
    lastSampleAt: at, lastSuccessfulSampleAt: at, lastAttemptAt: '2026-10-24T02:03:00Z',
    rpc: { rpcHealthy: true }, arcMainnet: { rpcHealthy: true }, usdc: { verified: true } };
  const current = summarizeArcObserverHealth(raw, config, { now: Date.parse(at) + 120_001 });
  assert.equal(current.running, true);
  assert.equal(current.freshness.stale, true);
  assert.equal(current.rpc.rpcHealthy, false);
  assert.equal(current.arcMainnet.rpcHealthy, false);
  assert.equal(current.usdc.verified, false);
  assert.equal(current.lastSuccessfulSampleAt, at);
  assert.equal(current.reason, 'observer_sample_stale');
  assert.equal(summarizeArcObserverHealth(raw, config, { now: Date.parse(at) + 60_000 }).freshness.fresh, true);
});
