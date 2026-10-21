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
        if (!response.ok) throw new Error(`Map request failed (${response.status})`);
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
