import { performance } from 'node:perf_hooks';

export function createTtlSingleFlightCache({
  ttlMs,
  maxStaleMs = 300_000,
  refreshRetryMs = 5_000,
  maxEntries = 8,
  staleOnErrorMs = 0,
  now = Date.now,
  monotonicNow = () => performance.now(),
  onRefresh = null
}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('CACHE_TTL_INVALID');
  if (!Number.isFinite(maxStaleMs) || maxStaleMs <= ttlMs) throw new TypeError('CACHE_MAX_STALE_INVALID');
  if (!Number.isFinite(refreshRetryMs) || refreshRetryMs < 0) throw new TypeError('CACHE_REFRESH_RETRY_INVALID');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('CACHE_MAX_ENTRIES_INVALID');
  if (!Number.isFinite(staleOnErrorMs) || staleOnErrorMs < 0) throw new TypeError('CACHE_STALE_ON_ERROR_INVALID');
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
      entries.set(key, { value, builtAt, freshUntil: builtAt + ttlMs, staleUntil: builtAt + maxStaleMs,
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

  function lastResort(key, currentTime = now()) {
    const entry = entries.get(key);
    return staleOnErrorMs > 0 && entry && entry.builtAt + staleOnErrorMs > currentTime ? entry : null;
  }

  function staleOnError(key, onAccess) {
    const entry = lastResort(key);
    if (!entry) throw Object.assign(new Error('CACHE_REFRESH_FAILED'), { code: 'CACHE_REFRESH_FAILED' });
    onAccess?.('STALE_ERROR', { lookupMs: 0 });
    return entry.value;
  }

  return {
    // The newest value still inside the stale-on-error window (or maxStale), without refreshing.
    peek(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const currentTime = now();
      return entry.staleUntil > currentTime || lastResort(key, currentTime) ? entry.value : undefined;
    },
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
      // mapfix1: past maxStale the value is no longer served first, but (opt-in) it is still
      // the answer of last resort when the refresh fails.
      const fallback = lastResort(key, currentTime);
      if (entry && !fallback) entries.delete(key);
      if (fallback && !pending.has(key) && fallback.nextRefreshAt > currentTime) {
        onAccess?.('STALE_ERROR', { lookupMs: monotonicNow() - lookupStarted });
        return fallback.value;
      }
      if (pending.has(key)) {
        onAccess?.('COALESCED', { lookupMs: monotonicNow() - lookupStarted });
        return fallback ? pending.get(key).catch(() => staleOnError(key, onAccess)) : pending.get(key);
      }
      onAccess?.('MISS', { lookupMs: monotonicNow() - lookupStarted });
      const refreshed = startRefresh(key, producer, 'miss');
      return fallback ? refreshed.catch(() => staleOnError(key, onAccess)) : refreshed;
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
