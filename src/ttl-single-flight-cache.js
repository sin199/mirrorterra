export function createTtlSingleFlightCache({ ttlMs, maxEntries = 8, now = Date.now }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('CACHE_TTL_INVALID');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('CACHE_MAX_ENTRIES_INVALID');
  const entries = new Map();
  const pending = new Map();

  return {
    async get(key, producer, onAccess = null) {
      const currentTime = now();
      for (const [cachedKey, cachedEntry] of entries) {
        if (cachedEntry.expiresAt <= currentTime) entries.delete(cachedKey);
      }
      const entry = entries.get(key);
      if (entry && entry.expiresAt > currentTime) {
        onAccess?.('HIT');
        return entry.value;
      }
      if (pending.has(key)) {
        onAccess?.('COALESCED');
        return pending.get(key);
      }
      onAccess?.('MISS');

      const promise = Promise.resolve().then(producer).then((value) => {
        entries.set(key, { value, expiresAt: now() + ttlMs });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    }
  };
}
