import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createPublicMapSnapshotService, mapBackgroundRefreshEnabled, mapRefreshDelayMs,
  servePublicMapSnapshot, validPublicMapPayload } from '../src/public-map-snapshot.js';
import { sendPublicMapSnapshot } from '../src/public-response-validator.js';
import { createTtlSingleFlightCache } from '../src/ttl-single-flight-cache.js';
import { enforcePublicApiReadiness } from '../src/request-routing.js';
import { createMapDataState, createMapSnapshotLoader, mapRetryDelayMs,
  MAP_REFRESH_INTERVAL_MS } from '../site/public-view-state.js';

const payload = (n = 1) => ({ world: { id: 'w', n }, scenes: [{ id: 'bank' }], residents: [{ id: 'r' }],
  worldEvolution: { dashboard: { places: 1 } }, generatedAt: `2026-10-22T00:00:0${n}Z` });
const quiet = () => {};

function mapApp(service) {
  const app = Fastify();
  app.get('/public/map-data', (request, reply) => servePublicMapSnapshot({ service, request, reply,
    send: sendPublicMapSnapshot, waitMs: 50 }));
  return app;
}

test('a failed background refresh keeps serving the last good snapshot (never 500)', async () => {
  let fail = false, n = 0;
  const service = createPublicMapSnapshotService({ log: quiet, build: async () => {
    if (fail) throw Object.assign(new Error('timeout exceeded when trying to connect'), { code: undefined });
    return { payload: payload(++n) };
  } });
  assert.ok(await service.refresh());
  const app = mapApp(service);
  const first = await app.inject('/public/map-data');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().world.n, 1);
  fail = true;
  for (let i = 0; i < 3; i++) assert.equal(await service.refresh(), null);
  assert.equal(service.status().failures, 3);
  const during = await app.inject('/public/map-data');
  assert.equal(during.statusCode, 200);
  assert.equal(during.json().world.n, 1);
  assert.equal(during.headers['x-map-data-source'], 'memory');
  const revalidated = await app.inject({ url: '/public/map-data', headers: { 'if-none-match': first.headers.etag } });
  assert.equal(revalidated.statusCode, 304);
  fail = false;
  await service.refresh();
  const recovered = await app.inject('/public/map-data');
  assert.equal(recovered.json().world.n, 2);
  assert.equal(service.status().failures, 0);
  await app.close();
});

test('an incomplete build never replaces the last good snapshot', async () => {
  let bad = false;
  const service = createPublicMapSnapshotService({ log: quiet,
    build: async () => (bad ? { payload: { world: null } } : { payload: payload(1) }) });
  await service.refresh();
  bad = true;
  assert.equal(await service.refresh(), null);
  assert.equal(service.current().payload.world.n, 1);
});

test('a hung build is bounded by the build timeout and the snapshot survives', async () => {
  const service = createPublicMapSnapshotService({ log: quiet, buildTimeoutMs: 30,
    build: () => new Promise(() => {}) });
  service.remember({ payload: payload(1) });
  assert.equal(await service.refresh(), null);
  assert.equal(service.status().lastError, 'PUBLIC_MAP_BUILD_TIMEOUT');
  assert.equal(service.current().payload.world.n, 1);
});

test('the snapshot is persisted atomically and loaded from disk at startup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mapfix-'));
  try {
    const filePath = path.join(dir, 'state', 'public-map-snapshot.json');
    const writer = createPublicMapSnapshotService({ log: quiet, filePath, build: async () => ({ payload: payload(7) }) });
    await writer.refresh();
    await writer.stop(); // waits for the persist
    assert.deepEqual((await readdir(path.dirname(filePath))).filter((f) => f.endsWith('.tmp')), []);
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.payload.world.n, 7);

    // "Restart": a new process whose database is unreachable still serves the saved snapshot.
    const restarted = createPublicMapSnapshotService({ log: quiet, filePath,
      build: async () => { throw new Error('timeout exceeded when trying to connect'); } });
    const loaded = await restarted.loadFromDisk();
    assert.equal(loaded.source, 'disk');
    assert.equal(await restarted.refresh(), null);
    const app = mapApp(restarted);
    const response = await app.inject('/public/map-data');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().world.n, 7);
    assert.equal(response.headers['x-map-data-source'], 'disk');
    assert.ok(Number(response.headers['x-map-data-age-ms']) >= 0);
    assert.equal(response.headers.etag, writer.current().etag);
    await app.close();

    // A corrupt or foreign file is ignored rather than served.
    await writeFile(filePath, '{"version":1,"payload":{"world":null}}');
    const corrupt = createPublicMapSnapshotService({ log: quiet, filePath, build: async () => ({ payload: payload(1) }) });
    assert.equal(await corrupt.loadFromDisk(), null);
    await writeFile(filePath, 'not json');
    assert.equal(await corrupt.loadFromDisk(), null);
    const missing = createPublicMapSnapshotService({ log: quiet, filePath: path.join(dir, 'nope.json'),
      build: async () => ({ payload: payload(1) }) });
    assert.equal(await missing.loadFromDisk(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistence is throttled and skips unchanged snapshots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mapfix-'));
  try {
    let clock = 1_000_000, n = 0;
    const filePath = path.join(dir, 'snap.json');
    const service = createPublicMapSnapshotService({ log: quiet, filePath, now: () => clock,
      minPersistIntervalMs: 60_000, build: async () => ({ payload: payload(++n) }) });
    await service.refresh(); await service.stop();
    clock += 10_000; await service.refresh(); await service.stop();
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).payload.world.n, 1);
    clock += 60_000; await service.refresh(); await service.stop();
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).payload.world.n, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without any snapshot the endpoint answers 503 with retry advice, not 500', async () => {
  const service = createPublicMapSnapshotService({ log: quiet,
    build: async () => { throw new Error('timeout exceeded when trying to connect'); } });
  const app = mapApp(service);
  const response = await app.inject('/public/map-data');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  assert.deepEqual(response.json(), { error: 'MAP_DATA_WARMING', retryAfterSeconds: 5 });
  await app.close();
});

test('a first visitor waits for the in-flight build instead of failing', async () => {
  let release;
  const service = createPublicMapSnapshotService({ log: quiet,
    build: () => new Promise((resolve) => { release = () => resolve({ payload: payload(3) }); }) });
  service.refresh();
  const app = Fastify();
  app.get('/m', (request, reply) => servePublicMapSnapshot({ service, request, reply,
    send: sendPublicMapSnapshot, waitMs: 2_000 }));
  const pending = app.inject('/m');
  setTimeout(() => release(), 20);
  const response = await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().world.n, 3);
  await app.close();
});

test('the background loop single-flights, refreshes on its interval and backs off on failure', async () => {
  let builds = 0, fail = true, concurrent = 0, maxConcurrent = 0;
  const delays = [];
  const timers = [];
  const service = createPublicMapSnapshotService({ log: quiet, intervalMs: 45_000, minRetryMs: 5_000,
    maxBackoffMs: 300_000,
    setTimer: (fn, ms) => { if (ms !== 120_000) { delays.push(ms); timers.push(fn); } return { unref() {} }; },
    clearTimer: () => {},
    build: async () => {
      builds++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setImmediate(resolve));
      concurrent--;
      if (fail) throw new Error('timeout exceeded when trying to connect');
      return { payload: payload(builds) };
    } });
  service.start({ initialDelayMs: 2_000 });
  for (let i = 0; i < 4; i++) await timers.shift()();
  fail = false;
  await timers.shift()();
  await timers.shift()();
  assert.deepEqual(delays, [2_000, 5_000, 10_000, 20_000, 40_000, 45_000, 45_000]);
  assert.equal(maxConcurrent, 1);
  const [a, b] = [service.refresh('x'), service.refresh('y')];
  assert.equal(a, b);
  await a;
  await service.stop();
  assert.equal(mapRefreshDelayMs(20, { intervalMs: 45_000 }), 300_000);
});

test('MIRRORTERRA_MAP_BG_REFRESH is on by default and only an explicit off disables it', () => {
  assert.equal(mapBackgroundRefreshEnabled({}), true);
  assert.equal(mapBackgroundRefreshEnabled({ MIRRORTERRA_MAP_BG_REFRESH: 'on' }), true);
  for (const value of ['off', 'OFF', '0', 'false', 'disabled']) {
    assert.equal(mapBackgroundRefreshEnabled({ MIRRORTERRA_MAP_BG_REFRESH: value }), false);
  }
  assert.equal(validPublicMapPayload(payload()), true);
  assert.equal(validPublicMapPayload({ world: {}, scenes: [] }), false);
});

test('cache stale-on-error returns the last good value after maxStale when the refresh fails', async () => {
  let now = 0, calls = 0;
  const cache = createTtlSingleFlightCache({ ttlMs: 30, maxStaleMs: 300, refreshRetryMs: 20,
    staleOnErrorMs: 1_000, now: () => now });
  assert.equal(await cache.get('k', async () => 'good'), 'good');
  now = 500;
  const statuses = [];
  assert.equal(await cache.get('k', async () => { calls++; throw new Error('down'); }, (s) => statuses.push(s)), 'good');
  assert.equal(calls, 1);
  now = 505; // inside the retry window: no new database attempt, still the last good value
  assert.equal(await cache.get('k', async () => { calls++; throw new Error('down'); }), 'good');
  assert.equal(calls, 1);
  assert.equal(cache.peek('k'), 'good');
  now = 600;
  assert.equal(await cache.get('k', async () => 'fresh'), 'fresh');
  now = 2_000;
  assert.equal(cache.peek('k'), undefined);
  await assert.rejects(cache.get('k', async () => { throw new Error('too old'); }), /too old/);
  // Default (no staleOnErrorMs) keeps the old behaviour.
  const plain = createTtlSingleFlightCache({ ttlMs: 30, maxStaleMs: 300, now: () => now });
  await plain.get('k', async () => 'v');
  now += 301;
  await assert.rejects(plain.get('k', async () => { throw new Error('hard'); }), /hard/);
});

test('readiness gate: the snapshot route bypasses it and cached routes fall back to last good', async () => {
  const app = Fastify();
  let probes = 0;
  app.addHook('preHandler', async (request, reply) => {
    const pathOnly = request.raw.url.split('?')[0];
    const allowed = await enforcePublicApiReadiness({ pathOnly, reply,
      readReadiness: async () => { probes++; return { ready: false }; },
      bypass: (p) => p === '/public/map-data',
      fallback: (p) => (p === '/api/world/summary' ? { cached: true } : undefined) });
    if (!allowed) return reply;
  });
  app.get('/public/map-data', async () => ({ map: true }));
  app.get('/api/world/summary', async () => { throw new Error('handler must not run'); });
  app.get('/api/world/health', async () => { throw new Error('handler must not run'); });
  const map = await app.inject('/public/map-data');
  assert.equal(map.statusCode, 200);
  assert.equal(probes, 0, 'the map route never waits on the readiness probe');
  const summary = await app.inject('/api/world/summary');
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(summary.json(), { cached: true });
  assert.equal(summary.headers['x-served-stale'], 'not-ready');
  const health = await app.inject('/api/world/health');
  assert.equal(health.statusCode, 503);
  await app.close();
});

test('frontend keeps its map data when a fetch fails and retries with backoff', async () => {
  const state = createMapDataState({ now: () => 5 });
  const first = state.failure(new Error('Map request failed (503)'));
  assert.equal(first.showUnavailable, true);
  assert.equal(first.data, null);
  assert.equal(first.retryInMs, 1_000);
  assert.equal(state.failure(new Error('x')).retryInMs, 2_000);
  const data = payload(1);
  assert.equal(state.success(data).showUnavailable, false);
  const failed = state.failure(new Error('Map request failed (500)'));
  assert.equal(failed.data, data, 'the last map stays on screen');
  assert.equal(failed.state, 'stale');
  assert.equal(failed.showUnavailable, false);
  assert.equal(failed.retryInMs, MAP_REFRESH_INTERVAL_MS);
  assert.equal(state.failure(new Error('x')).retryInMs, 20_000);
  for (let i = 0; i < 6; i++) state.failure(new Error('x'));
  assert.equal(state.failure(new Error('x')).retryInMs, 60_000);
  assert.equal(state.data, data);
  assert.equal(state.success(null).data, data, 'a 304 keeps the current data');
  assert.equal(mapRetryDelayMs(1, { hasData: false, retryAfterMs: 5_000 }), 5_000);
  assert.equal(mapRetryDelayMs(10, { hasData: false }), MAP_REFRESH_INTERVAL_MS);
  assert.equal(mapRetryDelayMs(0), MAP_REFRESH_INTERVAL_MS);
});

test('frontend loader surfaces Retry-After from a warming 503', async () => {
  const loader = createMapSnapshotLoader({ fetchImpl: async () => new Response(
    JSON.stringify({ error: 'MAP_DATA_WARMING' }), { status: 503, headers: { 'retry-after': '5' } }) });
  await assert.rejects(loader.load(), (error) => error.status === 503 && error.retryAfterMs === 5_000);
});

test('app.js shows the unavailable message only without data and schedules retries', async () => {
  const app = await readFile(new URL('../site/app.js', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('async function loadMapData()'), app.indexOf('loadStats();\nloadMapData();'));
  assert.match(block, /mapDataState\.failure\(error\)/);
  assert.match(block, /if \(latestMapData\) \{[\s\S]*mapError\.hidden = true;[\s\S]*\} else \{[\s\S]*'Map data unavailable'/);
  assert.match(block, /scheduleMapRefresh\(nextDelay\)/);
});

test('server.js serves the map from the snapshot with split, bounded read pools', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /buildPublicMapData\(\{ pool: mapBuildPool,/);
  assert.match(source, /createDatabaseReadinessProbe\(\{ pool: readinessPool/);
  const handler = source.slice(source.indexOf('const publicMapDataHandler'), source.indexOf("app.get('/public/map-data'"));
  assert.ok(handler.indexOf('if (MAP_BG_REFRESH)') < handler.indexOf('publicMapDataCache.get'));
  const pools = [...source.matchAll(/const (\w+) = new Pool\(\{([\s\S]*?)\}\);/g)];
  let total = 0;
  for (const [, name, body] of pools) {
    const max = Number(body.match(/max: (\d+)/)?.[1] || 10);
    total += max;
    if (name !== 'pool') {
      assert.match(body, /default_transaction_read_only=on/, name);
      assert.match(body, /statement_timeout=(\d+|\$\{MAP_STATEMENT_TIMEOUT_MS\})/, name);
    }
  }
  assert.ok(total <= 40, `total pooled connections ${total}`);
  assert.match(source, /Number\(process\.env\.MIRRORTERRA_MAP_STATEMENT_TIMEOUT_MS\) \|\| 60_000/);
});
