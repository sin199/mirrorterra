import { performance } from 'node:perf_hooks';

export function createTtlSingleFlightCache({
  ttlMs,
  maxStaleMs = 300_000,
  refreshRetryMs = 5_000,
  maxEntries = 8,
  now = Date.now,
  monotonicNow = () => performance.now(),
  onRefresh = null
}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('CACHE_TTL_INVALID');
  if (!Number.isFinite(maxStaleMs) || maxStaleMs <= ttlMs) throw new TypeError('CACHE_MAX_STALE_INVALID');
  if (!Number.isFinite(refreshRetryMs) || refreshRetryMs < 0) throw new TypeError('CACHE_REFRESH_RETRY_INVALID');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('CACHE_MAX_ENTRIES_INVALID');
  const entries = new Map();
  const pending = new Map();

  function trimEntries() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function startRefresh(key, producer, reason) {
    if (pending.has(key)) return pending.get(key);
    const started = monotonicNow();
    const promise = Promise.resolve().then(producer).then((value) => {
      const builtAt = now();
      entries.set(key, { value, freshUntil: builtAt + ttlMs, staleUntil: builtAt + maxStaleMs,
        nextRefreshAt: builtAt + ttlMs });
      trimEntries();
      onRefresh?.({ key, reason, status: 'success', durationMs: monotonicNow() - started, value });
      return value;
    }).catch((error) => {
      const entry = entries.get(key);
      if (entry) entry.nextRefreshAt = now() + refreshRetryMs;
      onRefresh?.({ key, reason, status: 'failure', durationMs: monotonicNow() - started, error });
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  return {
    async get(key, producer, onAccess = null) {
      const lookupStarted = monotonicNow();
      const currentTime = now();
      const entry = entries.get(key);
      if (entry && entry.freshUntil > currentTime) {
        onAccess?.('HIT', { lookupMs: monotonicNow() - lookupStarted });
        return entry.value;
      }
      if (entry && entry.staleUntil > currentTime) {
        const refreshStarted = !pending.has(key) && entry.nextRefreshAt <= currentTime;
        onAccess?.('STALE', { lookupMs: monotonicNow() - lookupStarted, refreshStarted });
        if (refreshStarted) startRefresh(key, producer, 'stale').catch(() => {});
        return entry.value;
      }
      if (entry) entries.delete(key);
      if (pending.has(key)) {
        onAccess?.('COALESCED', { lookupMs: monotonicNow() - lookupStarted });
        return pending.get(key);
      }
      onAccess?.('MISS', { lookupMs: monotonicNow() - lookupStarted });
      return startRefresh(key, producer, 'miss');
    },
    refresh(key, producer, reason = 'prewarm') {
      return startRefresh(key, producer, reason);
    },
    prewarm(key, producer) {
      const entry = entries.get(key);
      if (entry && entry.staleUntil > now()) return Promise.resolve(entry.value);
      if (pending.has(key)) return pending.get(key);
      return startRefresh(key, producer, 'prewarm');
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    }
  };
}
