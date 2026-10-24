export const MAP_REFRESH_INTERVAL_MS = 10_000;

// A visible tab revalidates the existing snapshot; background tabs send nothing.
export function createMapSnapshotLoader({ fetchImpl = fetch, visible = () => true } = {}) {
  let etag = null;
  let pending = null;
  return {
    load() {
      if (!visible()) return Promise.resolve({ skipped: true });
      if (pending) return pending;
      pending = (async () => {
        const response = await fetchImpl('/public/map-data', { cache: 'no-store',
          headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
          signal: AbortSignal.timeout(15_000) });
        if (response.status === 304) return { unchanged: true };
        if (!response.ok) {
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          throw Object.assign(new Error(`Map request failed (${response.status})`), { status: response.status,
            retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null });
        }
        const data = await response.json();
        if (!data.world || !Array.isArray(data.scenes) || !Array.isArray(data.residents) || !data.worldEvolution) {
          throw new Error('Incomplete public map response');
        }
        const nextEtag = response.headers.get('etag');
        const unchanged = Boolean(nextEtag && nextEtag === etag);
        etag = nextEtag;
        return unchanged ? { unchanged: true } : { data };
      })().finally(() => { pending = null; });
      return pending;
    }
  };
}

// mapfix1: a failed refresh never discards the map already on screen. Without any data yet the page
// retries quickly (1s, 2s, 4s, 8s, then every 10s); with data it backs off to at most once a minute.
export function mapRetryDelayMs(failures, { hasData = false, retryAfterMs = null } = {}) {
  if (!failures) return MAP_REFRESH_INTERVAL_MS;
  const delay = hasData ? Math.min(60_000, MAP_REFRESH_INTERVAL_MS * 2 ** (failures - 1))
    : Math.min(MAP_REFRESH_INTERVAL_MS, 1_000 * 2 ** (failures - 1));
  return Math.max(delay, Math.min(retryAfterMs || 0, hasData ? 60_000 : MAP_REFRESH_INTERVAL_MS));
}

export function createMapDataState({ now = Date.now } = {}) {
  let data = null;
  let failures = 0;
  let updatedAt = null;
  return {
    get data() { return data; },
    get failures() { return failures; },
    success(next) {
      if (next) { data = next; updatedAt = now(); }
      failures = 0;
      return { data, state: 'ready', showUnavailable: false, retryInMs: MAP_REFRESH_INTERVAL_MS };
    },
    failure(error) {
      failures++;
      return { data, state: data ? 'stale' : 'error', showUnavailable: !data, updatedAt,
        retryInMs: mapRetryDelayMs(failures, { hasData: Boolean(data), retryAfterMs: error?.retryAfterMs }) };
    }
  };
}

export function createResidentDetailStore({ now = Date.now } = {}) {
  const records = new Map();
  const empty = () => ({ data: null, state: 'loading', updatedAt: null });
  return {
    get(id) { return records.get(id) || empty(); },
    success(id, data) {
      if (!data?.resident || typeof data.resident !== 'object' || !data.economy) {
        throw new Error('Incomplete resident detail');
      }
      const record = { data, state: 'ready', updatedAt: now() };
      records.set(id, record);
      return record;
    },
    failure(id) {
      const previous = records.get(id);
      const record = previous?.data ? { ...previous, state: 'stale' }
        : { ...empty(), state: 'error' };
      records.set(id, record);
      return record;
    }
  };
}

export function authoritativePlaceCount(data) {
  const count = data?.worldEvolution?.dashboard?.places;
  return Number.isSafeInteger(count) && count >= 0 ? count : (data?.scenes || []).length;
}
