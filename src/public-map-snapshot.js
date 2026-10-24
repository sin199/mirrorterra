// mapfix1: the public map is served from the last good snapshot, built in the background.
// A visitor request never waits on (or fails because of) a database read once one good
// snapshot exists; the snapshot is persisted atomically so a restart serves it at once.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { publicResponseEtag } from './public-response-validator.js';

export const MAP_SNAPSHOT_FILE_VERSION = 1;

export function mapBackgroundRefreshEnabled(env = process.env) {
  const value = String(env.MIRRORTERRA_MAP_BG_REFRESH ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no', 'disabled'].includes(value);
}

export function validPublicMapPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && payload.world && typeof payload.world === 'object'
    && Array.isArray(payload.scenes) && Array.isArray(payload.residents) && payload.worldEvolution
    && typeof payload.worldEvolution === 'object');
}

// Retry delay after `failures` consecutive failed builds: interval, then doubling to the cap.
export function mapRefreshDelayMs(failures, { intervalMs, minRetryMs = 5_000, maxBackoffMs = 300_000 } = {}) {
  if (!failures) return intervalMs;
  return Math.min(maxBackoffMs, Math.max(minRetryMs, Math.round(minRetryMs * 2 ** (failures - 1))));
}

function safeError(error) {
  return String(error?.code || error?.message || 'PUBLIC_MAP_REFRESH_FAILED').slice(0, 120);
}

export function createPublicMapSnapshotService({
  build,
  filePath = null,
  intervalMs = 30_000,
  minRetryMs = 5_000,
  maxBackoffMs = 300_000,
  buildTimeoutMs = 120_000,
  minPersistIntervalMs = 60_000,
  now = Date.now,
  monotonicNow = () => performance.now(),
  log = (record) => console.log(JSON.stringify(record)),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof build !== 'function') throw new TypeError('MAP_SNAPSHOT_BUILD_REQUIRED');
  let current = null; // { payload, etag, timing, builtAt, source }
  let inFlight = null;
  let timer = null;
  let running = false;
  let failures = 0;
  let lastPersistAt = 0;
  let lastPersistedEtag = null;
  let persisting = null;
  const stats = { totalSuccesses: 0, totalFailures: 0, lastError: null, lastSuccessAt: null, lastFailureAt: null };

  function adopt(payload, { timing = null, builtAt = now(), source = 'memory', etag = null } = {}) {
    current = { payload, etag: etag || publicResponseEtag(payload), timing, builtAt, source };
    return current;
  }

  async function persist(entry) {
    if (!filePath || entry.etag === lastPersistedEtag) return false;
    if (now() - lastPersistAt < minPersistIntervalMs && lastPersistedEtag) return false;
    if (persisting) return false;
    persisting = (async () => {
      const tmp = `${filePath}.${process.pid}.tmp`;
      let handle = null;
      try {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
        handle = await open(tmp, 'w', 0o640);
        await handle.writeFile(JSON.stringify({ version: MAP_SNAPSHOT_FILE_VERSION,
          savedAt: new Date(now()).toISOString(), builtAt: new Date(entry.builtAt).toISOString(),
          etag: entry.etag, payload: entry.payload }));
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tmp, filePath);
        lastPersistAt = now();
        lastPersistedEtag = entry.etag;
        return true;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await unlink(tmp).catch(() => {});
        log({ event: 'public_map_snapshot_persist', status: 'failure', error: safeError(error) });
        return false;
      } finally {
        persisting = null;
      }
    })();
    return persisting;
  }

  async function loadFromDisk() {
    if (!filePath) return null;
    try {
      const saved = JSON.parse(await readFile(filePath, 'utf8'));
      if (saved?.version !== MAP_SNAPSHOT_FILE_VERSION || !validPublicMapPayload(saved.payload)) {
        log({ event: 'public_map_snapshot_load', status: 'invalid' });
        return null;
      }
      if (current) return current; // a live build already won
      const builtAt = Date.parse(saved.builtAt) || Date.parse(saved.savedAt) || now();
      adopt(saved.payload, { builtAt, source: 'disk' });
      lastPersistedEtag = current.etag;
      log({ event: 'public_map_snapshot_load', status: 'success', age_ms: Math.max(0, now() - builtAt) });
      return current;
    } catch (error) {
      log({ event: 'public_map_snapshot_load', status: error?.code === 'ENOENT' ? 'missing' : 'failure',
        error: safeError(error) });
      return null;
    }
  }

  function withTimeout(promise) {
    if (!buildTimeoutMs) return promise;
    let handle;
    const timeout = new Promise((_resolve, reject) => {
      handle = setTimer(() => reject(Object.assign(new Error('PUBLIC_MAP_BUILD_TIMEOUT'),
        { code: 'PUBLIC_MAP_BUILD_TIMEOUT' })), buildTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimer(handle));
  }

  function refresh(reason = 'background') {
    if (inFlight) return inFlight;
    const started = monotonicNow();
    inFlight = (async () => {
      try {
        const built = await withTimeout(Promise.resolve().then(build));
        if (!validPublicMapPayload(built?.payload)) {
          throw Object.assign(new Error('PUBLIC_MAP_PAYLOAD_INCOMPLETE'), { code: 'PUBLIC_MAP_PAYLOAD_INCOMPLETE' });
        }
        const entry = adopt(built.payload, { timing: built.timing || null, etag: built.etag || null });
        failures = 0;
        stats.totalSuccesses++;
        stats.lastSuccessAt = now();
        log({ event: 'public_map_data_refresh', key: 'current-open-world', reason, status: 'success',
          refresh_ms: Number((monotonicNow() - started).toFixed(3)),
          ...(entry.timing ? { build_ms: entry.timing.total_ms } : {}) });
        persist(entry).catch(() => {});
        return entry;
      } catch (error) {
        failures++;
        stats.totalFailures++;
        stats.lastFailureAt = now();
        stats.lastError = safeError(error);
        log({ event: 'public_map_data_refresh', key: 'current-open-world', reason, status: 'failure',
          refresh_ms: Number((monotonicNow() - started).toFixed(3)), error: stats.lastError,
          consecutive_failures: failures, serving: current ? 'last_good' : 'none',
          ...(current ? { snapshot_age_ms: Math.max(0, now() - current.builtAt) } : {}) });
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule(delayMs) {
    if (!running) return;
    clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      await refresh('background');
      schedule(mapRefreshDelayMs(failures, { intervalMs, minRetryMs, maxBackoffMs }));
    }, delayMs);
    timer?.unref?.();
  }

  return {
    loadFromDisk,
    refresh,
    start({ initialDelayMs = 0 } = {}) {
      if (running) return;
      running = true;
      schedule(initialDelayMs);
    },
    async stop() {
      running = false;
      clearTimer(timer);
      timer = null;
      await inFlight?.catch?.(() => {});
      await persisting?.catch?.(() => {});
    },
    current: () => current,
    // Remember a snapshot built elsewhere (the kill-switch path) so it can be served on error.
    remember(entry) {
      if (!validPublicMapPayload(entry?.payload)) return null;
      const adopted = adopt(entry.payload, { timing: entry.timing || null, etag: entry.etag || null });
      persist(adopted).catch(() => {});
      return adopted;
    },
    pending: () => inFlight,
    status: () => ({ running, failures, hasSnapshot: Boolean(current), source: current?.source || null,
      ageMs: current ? Math.max(0, now() - current.builtAt) : null, ...stats })
  };
}

// Serve the snapshot (ETag/304 aware). Without one, wait briefly for an in-flight build and
// otherwise answer 503 with retry advice: never a 500.
export async function servePublicMapSnapshot({ service, request, reply, send, waitMs = 20_000,
  retryAfterSeconds = 5, now = Date.now }) {
  let entry = service.current();
  if (!entry) {
    const pending = service.pending() || service.refresh('miss');
    let handle;
    entry = await Promise.race([pending, new Promise((resolve) => {
      handle = setTimeout(() => resolve(null), waitMs); handle.unref?.();
    })]).finally(() => clearTimeout(handle)) || service.current();
  }
  if (!entry) {
    reply.header('Cache-Control', 'no-store');
    reply.header('Retry-After', String(retryAfterSeconds));
    return reply.code(503).send({ error: 'MAP_DATA_WARMING', retryAfterSeconds });
  }
  reply.header('X-Map-Data-Source', entry.source);
  reply.header('X-Map-Data-Age-Ms', String(Math.max(0, Math.round(now() - entry.builtAt))));
  return send(request, reply, entry);
}
