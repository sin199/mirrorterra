import { WORLD_TICK_STALE_AFTER_MS } from './world-engine-diagnostics.js';

export function createDatabaseReadinessProbe({ pool, ttlMs = 1_000, queryTimeoutMs = 1_000,
  now = () => Date.now() } = {}) {
  if (!pool?.query) throw new TypeError('A database pool is required.');
  let last = { checked: false, usable: false, checkedAt: 0 };
  let inFlight = null;

  async function check({ force = false } = {}) {
    const currentTime = now();
    if (!force && last.checked && currentTime - last.checkedAt < ttlMs) return last.usable;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let usable = false;
      try {
        await pool.query({ text: 'SELECT 1', query_timeout: queryTimeoutMs });
        usable = true;
      } catch { /* readiness fails closed without exposing database diagnostics */ }
      last = { checked: true, usable, checkedAt: now() };
      return usable;
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  }

  return { check, snapshot: () => ({ ...last }) };
}

export function publicReadinessSnapshot({ serverInitialized = false, databaseUsable = false,
  engine = null, now = Date.now(), staleAfterMs = WORLD_TICK_STALE_AFTER_MS } = {}) {
  const lastTickAt = engine?.lastTickCompletedAt || engine?.lastTickAt || null;
  const lastTickMs = lastTickAt ? new Date(lastTickAt).getTime() : NaN;
  const tickFresh = Number.isFinite(lastTickMs) && Math.max(0, now - lastTickMs) <= staleAfterMs;
  const runtimeInitialized = Boolean(engine?.running && engine?.worldId);
  const ready = Boolean(serverInitialized && databaseUsable && runtimeInitialized
    && engine?.worldLockOwned && engine?.schedulerRunning && tickFresh);
  const starting = !serverInitialized || engine?.reason === 'starting'
    || (!runtimeInitialized && !engine?.reason);
  return { status: ready ? 'ok' : starting ? 'starting' : 'degraded', ready };
}
