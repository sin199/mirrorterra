const HOUR = 60;
const DEFAULT_WINDOW = 10_080;
const readiness = new WeakMap();

function minute(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('INVALID_EMERGENCE_MINUTE');
  return number;
}

export async function emergenceRollupsReady(pool) {
  const cached = readiness.get(pool);
  if (cached && Date.now() - cached.at < 30_000) return cached.ready;
  const result = await pool.query(`SELECT to_regclass('world_emergence_rollup_state') IS NOT NULL
    AND to_regclass('world_emergence_hour_rollups') IS NOT NULL AS ready`);
  const ready = result.rows[0]?.ready === true;
  readiness.set(pool, { at: Date.now(), ready });
  return ready;
}

// Raw emergence events are written only by the singleton World tick, in the same
// transaction as its monotonic runtime clock. A closed World hour is immutable.
// Backfill those hours rather than a sequence-ID cursor, which could skip an ID
// allocated in a transaction that has not committed yet.
export async function refreshEmergenceRollup(pool, { worldId, maxHours = 2,
  windowMinutes = DEFAULT_WINDOW, deadlineMs = 1_500 } = {}) {
  if (!Number.isSafeInteger(maxHours) || maxHours < 1 || maxHours > 24) throw new TypeError('INVALID_ROLLUP_BATCH');
  const window = minute(windowMinutes);
  const timeout = Math.max(100, Math.min(10_000, Math.trunc(Number(deadlineMs) || 1500)));
  const client = await pool.connect();
  let connectionError = null;
  const onConnectionError = (error) => { connectionError ||= error; };
  client.on('error', onConnectionError);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SET LOCAL statement_timeout='${timeout}ms'`);
    await client.query("SET LOCAL lock_timeout='250ms'");
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired`,
      [`emergence-rollup:${worldId}`]);
    if (!lock.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'another_rollup_writer', rowsProcessed: 0 };
    }
    const clock = await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]);
    if (!clock.rowCount) throw Object.assign(new Error('WORLD_RUNTIME_UNAVAILABLE'), { code: 'WORLD_RUNTIME_UNAVAILABLE' });
    const now = minute(clock.rows[0].world_minutes);
    const closedThrough = Math.floor(now / HOUR) * HOUR;
    const start = Math.floor(Math.max(0, now - window) / HOUR) * HOUR;
    await client.query(`INSERT INTO world_emergence_rollup_state(world_id,start_world_minute,through_world_minute)
      VALUES($1,$2,$2) ON CONFLICT(world_id) DO NOTHING`, [worldId, start]);
    const state = (await client.query(`SELECT start_world_minute,through_world_minute
      FROM world_emergence_rollup_state WHERE world_id=$1 FOR UPDATE`, [worldId])).rows[0];
    const savedThrough = minute(state.through_world_minute);
    if (savedThrough > closedThrough) throw Object.assign(new Error('ROLLUP_AHEAD_OF_WORLD'), { code: 'ROLLUP_AHEAD_OF_WORLD' });
    const from = Math.max(savedThrough, start);
    const retainedStart = Math.max(minute(state.start_world_minute), start);
    const through = Math.min(closedThrough, from + maxHours * HOUR);
    let rowsProcessed = 0;
    if (through > from) {
      const copied = await client.query(`WITH written AS (
        INSERT INTO world_emergence_hour_rollups(world_id,bucket_world_minute,system,stage,
          action_key,action_is_null,reason_code,event_count)
        SELECT world_id,(world_minutes/60)*60,system,stage,COALESCE(action,''),action IS NULL,reason_code,count(*)
        FROM world_emergence_events WHERE world_id=$1 AND world_minutes >= $2 AND world_minutes < $3
        GROUP BY world_id,(world_minutes/60)*60,system,stage,COALESCE(action,''),action IS NULL,reason_code
        ON CONFLICT(world_id,bucket_world_minute,system,stage,action_key,action_is_null,reason_code)
        DO UPDATE SET event_count=EXCLUDED.event_count RETURNING event_count
      ) SELECT COALESCE(sum(event_count),0)::text AS events FROM written`, [worldId, from, through]);
      rowsProcessed = Number(copied.rows[0].events);
    }
    // Bound only the rebuildable cache. Raw history is never removed, and reads
    // before retainedStart still use raw rows. Pruning is itself a small batch.
    await client.query(`DELETE FROM world_emergence_hour_rollups WHERE ctid IN (
      SELECT ctid FROM world_emergence_hour_rollups WHERE world_id=$1 AND bucket_world_minute<$2
      ORDER BY bucket_world_minute LIMIT 2000)`, [worldId, retainedStart]);
    await client.query(`UPDATE world_emergence_rollup_state
      SET start_world_minute=$2,through_world_minute=$3,updated_at=now() WHERE world_id=$1`,
    [worldId, retainedStart, through]);
    await client.query('COMMIT');
    return { cursor: through, startWorldMinute: retainedStart, rowsProcessed,
      caughtUp: through === closedThrough, skipped: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw connectionError || error;
  } finally {
    client.release(Boolean(connectionError));
    client.removeListener('error', onConnectionError);
  }
}

export async function readEmergenceRollup(pool, { worldId, fromWorldMinute, toWorldMinute }) {
  const from = minute(fromWorldMinute);
  const to = minute(toWorldMinute);
  if (!await emergenceRollupsReady(pool)) return null;
  const row = (await pool.query(`SELECT start_world_minute,through_world_minute,updated_at
    FROM world_emergence_rollup_state WHERE world_id=$1`, [worldId])).rows[0];
  if (!row) return null;
  if (minute(row.through_world_minute) > Math.floor(to / HOUR) * HOUR) return null;
  const start = Math.max(Math.ceil(from / HOUR) * HOUR, minute(row.start_world_minute));
  const through = Math.min(Math.floor(to / HOUR) * HOUR, minute(row.through_world_minute));
  if (start >= through) return null;
  return { start, through, updatedAt: row.updated_at };
}

// One aggregation replaces the old two independent table scans. Cached complete
// hours and the raw boundary/tail are disjoint, so a partially backfilled cache
// remains exact. NULL and empty action strings are deliberately distinct.
export async function readEmergenceAggregates(pool, { worldId, fromWorldMinute, toWorldMinute }) {
  const from = minute(fromWorldMinute);
  const to = minute(toWorldMinute);
  const ready = await emergenceRollupsReady(pool);
  // Read coverage and its rows in one statement snapshot: the worker may prune
  // old buckets as soon as it advances start_world_minute.
  const coverageSql = ready ? `SELECT * FROM (
      SELECT GREATEST((($2::bigint+59)/60)*60,start_world_minute) AS start,
        LEAST(($3::bigint/60)*60,through_world_minute) AS through,updated_at
      FROM world_emergence_rollup_state WHERE world_id=$1
        AND through_world_minute<=($3::bigint/60)*60
    ) bounds WHERE start<through`
    : 'SELECT NULL::bigint AS start,NULL::bigint AS through,NULL::timestamptz AS updated_at WHERE false';
  const sources = ready ? `SELECT system,stage,action,reason_code,1::bigint AS n
      FROM world_emergence_events WHERE world_id=$1 AND world_minutes >= $2
        AND NOT EXISTS(SELECT 1 FROM coverage)
    UNION ALL SELECT source.*,1::bigint AS n FROM coverage CROSS JOIN LATERAL (
      SELECT system,stage,action,reason_code FROM world_emergence_events
      WHERE world_id=$1 AND world_minutes >= $2 AND world_minutes < coverage.start OFFSET 0
    ) source
    UNION ALL SELECT source.*,1::bigint AS n FROM coverage CROSS JOIN LATERAL (
      SELECT system,stage,action,reason_code FROM world_emergence_events
      WHERE world_id=$1 AND world_minutes >= $2 AND world_minutes >= coverage.through OFFSET 0
    ) source
    UNION ALL SELECT system,stage,CASE WHEN action_is_null THEN NULL ELSE action_key END AS action,
      reason_code,event_count AS n FROM world_emergence_hour_rollups CROSS JOIN coverage WHERE world_id=$1
      AND bucket_world_minute >= coverage.start AND bucket_world_minute < coverage.through`
    : `SELECT system,stage,action,reason_code,1::bigint AS n FROM world_emergence_events
      WHERE world_id=$1 AND world_minutes >= $2`;
  const result = await pool.query(`WITH coverage AS MATERIALIZED (${coverageSql}),
    observations AS (${sources}), grouped AS (
      SELECT system,stage,action,reason_code,sum(n)::text AS count,GROUPING(reason_code) AS action_group
      FROM observations GROUP BY GROUPING SETS ((system,stage,action),(system,stage,reason_code))
    ) SELECT grouped.*,coverage.start AS rollup_start,coverage.through AS rollup_through,
      coverage.updated_at AS rollup_updated_at
    FROM (SELECT 1) root LEFT JOIN coverage ON true LEFT JOIN grouped ON true
    ORDER BY system,stage,action`, ready ? [worldId, from, to] : [worldId, from]);
  const first = result.rows[0];
  const coverage = first?.rollup_start != null ? { start: minute(first.rollup_start),
    through: minute(first.rollup_through), updatedAt: first.rollup_updated_at } : null;
  const counts = [];
  const blockedReasons = [];
  for (const row of result.rows) {
    if (row.action_group == null) continue; // Empty observations still return coverage metadata.
    const count = Number(row.count);
    if (!Number.isSafeInteger(count)) throw new RangeError('EMERGENCE_COUNT_OUT_OF_RANGE');
    if (row.action_group === 1) counts.push({ system: row.system, stage: row.stage, action: row.action, count });
    else if (row.stage === 'blocked' && row.reason_code !== 'NONE') {
      blockedReasons.push({ system: row.system, reason_code: row.reason_code, count });
    }
  }
  blockedReasons.sort((a, b) => b.count - a.count || (a.system < b.system ? -1 : a.system > b.system ? 1
    : a.reason_code < b.reason_code ? -1 : a.reason_code > b.reason_code ? 1 : 0));
  return { counts, blockedReasons: blockedReasons.slice(0, 30), coverage };
}

export function startEmergenceRollupWorker({ pool, worldId, isOwner = () => true,
  intervalMs = 5_000, onError = () => {} }) {
  let stopped = false;
  let inFlight = null;
  const status = { running: true, lastCompletedAt: null, lastError: null, cursor: null, caughtUp: false };
  async function run() {
    if (stopped || inFlight || !isOwner()) return;
    const work = (async () => {
      try {
        if (!await emergenceRollupsReady(pool)) { status.lastError = 'ROLLUP_MIGRATION_REQUIRED'; return; }
        const result = await refreshEmergenceRollup(pool, { worldId });
        Object.assign(status, result, { lastCompletedAt: new Date().toISOString(), lastError: null });
      } catch (error) {
        status.lastError = String(error.code || 'ROLLUP_REFRESH_FAILED').slice(0, 64);
        onError({ code: status.lastError });
      }
    })();
    inFlight = work;
    try { await work; } finally { inFlight = null; }
  }
  const timer = setInterval(() => { run().catch(() => {}); }, intervalMs);
  timer.unref();
  return { run, getStatus: () => ({ ...status, inFlight: Boolean(inFlight) }),
    async stop() { stopped = true; status.running = false; clearInterval(timer); await inFlight; } };
}
