// skillwork2: an idle pooled PostgreSQL client that errors (backend terminated, server restart, network
// drop) makes pg-pool emit 'error' on the Pool. With no listener Node throws it and the whole world
// process exits. pg-pool already discards the broken client and opens a new one on the next checkout, so
// the right reaction is to log one line and keep running. Checked-out clients still report their errors to
// the query that is running (unchanged).
export const PG_POOL_ERROR_EVENT = 'pg_pool_idle_client_error';

export function attachPoolErrorLogger(pool, name, {
  log = (record) => console.error(JSON.stringify(record)),
  now = () => new Date()
} = {}) {
  const state = { count: 0, lastCode: null };
  const handler = (error) => {
    state.count += 1;
    state.lastCode = String(error?.code || error?.name || 'UNKNOWN').slice(0, 40);
    try {
      log({ event: PG_POOL_ERROR_EVENT, pool: String(name || 'pool').slice(0, 40), code: state.lastCode,
        severity: error?.severity ? String(error.severity).slice(0, 20) : null,
        message: String(error?.message || '').replace(/\s+/g, ' ').slice(0, 160), count: state.count,
        at: now().toISOString() });
    } catch { /* Logging must never turn a recoverable pool error into a crash. */ }
  };
  pool.on('error', handler);
  return { handler, get count() { return state.count; }, get lastCode() { return state.lastCode; } };
}
