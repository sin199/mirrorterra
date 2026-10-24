// tickfix3: main PostgreSQL pool size and connect timeout, overridable by env.
// 10-23: the main pool (pg default max 10, connect timeout 5 s) also holds ~6 permanent advisory-lock
// clients (world engine, ARC observer/settlement/reconciler/issuance, sync workers), leaving ~4 for all
// other work; settles and gambit steps hit "timeout exceeded when trying to connect" 54-87x/h.
// Defaults 18 / 10 s. PostgreSQL max_connections=100 (3 superuser reserved); all app pools together
// = main 18 + map 4 + public 4 + observer 2 + readiness 1 = 29.
export const MAIN_POOL_MAX_KEY = 'MIRRORTERRA_PG_POOL_MAX';
export const MAIN_POOL_CONNECT_TIMEOUT_KEY = 'MIRRORTERRA_PG_CONNECT_TIMEOUT_MS';
export const DEFAULT_MAIN_POOL_MAX = 18;
export const DEFAULT_MAIN_POOL_CONNECT_TIMEOUT_MS = 10_000;

function bounded(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function mainPoolSettings(env = process.env) {
  return {
    max: bounded(env?.[MAIN_POOL_MAX_KEY], DEFAULT_MAIN_POOL_MAX, 2, 40),
    connectionTimeoutMillis: bounded(env?.[MAIN_POOL_CONNECT_TIMEOUT_KEY], DEFAULT_MAIN_POOL_CONNECT_TIMEOUT_MS, 1_000, 60_000)
  };
}

export function poolStats(pool, max) {
  return { max, total: pool?.totalCount ?? null, idle: pool?.idleCount ?? null, waiting: pool?.waitingCount ?? null };
}
