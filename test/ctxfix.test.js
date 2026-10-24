// ctxfix1: readCognitionContext world-events delta rewrite + short retry after a context-read timeout.
// Mock clients only; no database, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONTEXT_DELTA_EVENTS_SQL, CONTEXT_DELTA_LIMIT, CONTEXT_STATEMENT_TIMEOUT, LEGACY_CONTEXT_STATEMENT_TIMEOUT,
  LEGACY_DELTA_EVENTS_SQL, deltaFromRows, markContextReadError, readCognitionContext }
  from '../src/agent-runtime/open-cognition/context.js';
import { CONTEXT_RETRY_JITTER_MS, CONTEXT_RETRY_MIN_MS, CONTEXT_RETRY_RELEASE_SQL, contextRetryDelayMs,
  isContextReadTimeout } from '../src/agent-runtime/open-cognition/worker.js';
import { CONTEXT_READ_FIX_KEY, createContextReadFixFlags }
  from '../src/agent-runtime/open-cognition/contextfix-flags.js';

const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const AGENT = '46015f3f-d58c-4e0f-8bd6-bdb2afc3da91';
const LAST_SEEN = 909008;

// `relevantCount` unseen relevant events after LAST_SEEN; newest actor event id = scanCursor.
function relevantEvents(count) {
  return Array.from({ length: count }, (_, index) => ({ id: String(LAST_SEEN + 10 + index * 7),
    event_type: index % 3 ? 'world.agent_arrived' : 'world.project_contribution',
    data: { n: index }, action_id: `action-${index}`, created_at: new Date(1_760_000_000_000 + index * 1000).toISOString() }));
}
// Simulates exactly what Postgres returns for each SQL text.
function eventsResult(sql, count, scanCursor) {
  const events = relevantEvents(count);
  if (sql.includes('count(*) OVER()')) {
    const picked = events.slice(0, 100).map((row) => ({ ...row, relevant_count: String(count) }));
    return picked.length ? picked.map((row) => ({ ...row, scan_cursor: String(scanCursor) }))
      : [{ id: null, scan_cursor: String(scanCursor) }];
  }
  const limit = Number(/LIMIT (\d+)\s*\)/.exec(sql)[1]);
  const picked = events.slice(0, limit);
  return picked.length ? picked.map((row) => ({ ...row, scan_cursor: String(scanCursor) }))
    : [{ id: null, scan_cursor: String(scanCursor) }];
}

function mockPool({ relevantCount = 0, scanCursor = LAST_SEEN + 5000, failEvents = null } = {}) {
  const log = { sql: [], released: 0 };
  const client = {
    async query(sql, params) {
      const text = String(sql);
      log.sql.push(text);
      if (text.includes('FROM world_runtime_state WHERE world_id=$1') && text.startsWith('SELECT world_minutes')) {
        return { rowCount: 1, rows: [{ world_minutes: '1560000', tick_count: '1559000', environment: {} }] };
      }
      if (text.includes('FROM world_members m JOIN agents a')) {
        return { rowCount: 1, rows: [{ name: 'MirrorTerra-10', energy: 50, food: 50, social: 50, location: 'Plaza' }] };
      }
      if (text.startsWith('SELECT * FROM world_agent_cognition_state')) {
        return { rowCount: 1, rows: [{ revision: '3', last_context_event_id: String(LAST_SEEN), plans: [], goals: [],
          available_affordances: [], pending_action: {} }] };
      }
      if (text.includes('WITH last_seen AS (')) {
        if (failEvents) throw failEvents;
        const rows = eventsResult(text, relevantCount, scanCursor);
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    },
    release() { log.released += 1; }
  };
  return { pool: { async connect() { return client; } }, log };
}

const quiet = () => {};

test('fix on: 15 s statement timeout, delta query has no window count and stops at 101 rows', async () => {
  const { pool, log } = mockPool({ relevantCount: 250 });
  const { context } = await readCognitionContext(pool, { worldId: WORLD, agentId: AGENT }, { contextFix: true, log: quiet });
  assert.ok(log.sql.includes(`SET LOCAL statement_timeout = '${CONTEXT_STATEMENT_TIMEOUT}'`));
  assert.equal(CONTEXT_STATEMENT_TIMEOUT, '15s');
  const events = log.sql.find((sql) => sql.includes('WITH last_seen AS ('));
  assert.equal(events, CONTEXT_DELTA_EVENTS_SQL);
  assert.ok(!/OVER\s*\(/i.test(events), 'no window function');
  assert.match(events, /ORDER BY event\.id LIMIT 101\s*\)/);
  assert.equal(context.world.delta.eventCount, 100);
  assert.equal(context.world.delta.hasMore, true);
  assert.equal(context.world.delta.cursor, context.recentEvents.at(-1).id);
  assert.equal(log.released, 1);
  assert.ok(log.sql.includes('COMMIT'));
});

test('fix off: old 8 s timeout and the old count(*) OVER() query, unchanged', async () => {
  const { pool, log } = mockPool({ relevantCount: 250 });
  const { context } = await readCognitionContext(pool, { worldId: WORLD, agentId: AGENT }, { contextFix: false, log: quiet });
  assert.ok(log.sql.includes(`SET LOCAL statement_timeout = '${LEGACY_CONTEXT_STATEMENT_TIMEOUT}'`));
  assert.equal(LEGACY_CONTEXT_STATEMENT_TIMEOUT, '8s');
  assert.equal(log.sql.find((sql) => sql.includes('WITH last_seen AS (')), LEGACY_DELTA_EVENTS_SQL);
  assert.match(LEGACY_DELTA_EVENTS_SQL, /count\(\*\) OVER\(\) AS relevant_count/);
  assert.equal(context.world.delta.eventCount, 100);
  assert.equal(context.world.delta.hasMore, true);
});

test('same delta (ids, order, cursor, hasMore, excerpts) in both modes for 0/1/99/100/101/250 unseen events', async () => {
  for (const count of [0, 1, 99, 100, 101, 250]) {
    const scanCursor = LAST_SEEN + 9000 + count;
    const fixed = await readCognitionContext(mockPool({ relevantCount: count, scanCursor }).pool,
      { worldId: WORLD, agentId: AGENT }, { contextFix: true, log: quiet });
    const legacy = await readCognitionContext(mockPool({ relevantCount: count, scanCursor }).pool,
      { worldId: WORLD, agentId: AGENT }, { contextFix: false, log: quiet });
    assert.deepEqual(fixed.context.world.delta, legacy.context.world.delta, `delta for ${count}`);
    assert.deepEqual(fixed.context.recentEvents, legacy.context.recentEvents, `events for ${count}`);
    assert.equal(fixed.context.world.delta.hasMore, count > CONTEXT_DELTA_LIMIT);
    assert.equal(fixed.context.world.delta.cursor, count > 100 ? fixed.context.recentEvents.at(-1).id : scanCursor);
  }
});

test('deltaFromRows: 101st row only signals hasMore; null placeholder row is ignored', () => {
  const rows = relevantEvents(101);
  assert.deepEqual(deltaFromRows(rows).deltaRows.map((row) => row.id), rows.slice(0, 100).map((row) => row.id));
  assert.equal(deltaFromRows(rows).hasMore, true);
  assert.equal(deltaFromRows(rows.slice(0, 100)).hasMore, false);
  assert.deepEqual(deltaFromRows([{ id: null, scan_cursor: '5' }]), { deltaRows: [], hasMore: false });
  assert.equal(deltaFromRows([{ id: '1', relevant_count: '3' }], { contextFix: false }).hasMore, true);
});

test('57014 in the context read: rolled back, released, marked as a context-read timeout, logged', async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const { pool, log } = mockPool({ failEvents: timeout });
  const lines = [];
  await assert.rejects(readCognitionContext(pool, { worldId: WORLD, agentId: AGENT },
    { contextFix: true, log: (event, fields) => lines.push({ event, ...fields }) }),
  (error) => error.code === '57014' && error.cognitionContextRead === true);
  assert.ok(log.sql.includes('ROLLBACK'));
  assert.equal(log.released, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'cognition_context_read');
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].code, '57014');
  assert.equal(typeof lines[0].eventsMs, 'number');
});

test('successful read logs ms and eventsMs', async () => {
  const lines = [];
  await readCognitionContext(mockPool({ relevantCount: 3 }).pool, { worldId: WORLD, agentId: AGENT },
    { contextFix: true, log: (event, fields) => lines.push({ event, ...fields }) });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, true);
  assert.equal(typeof lines[0].ms, 'number');
  assert.equal(typeof lines[0].eventsMs, 'number');
  assert.equal(lines[0].fix, true);
});

test('only a marked 57014 with the fix on takes the short retry; other errors keep the old path', () => {
  const marked = markContextReadError(Object.assign(new Error('x'), { code: '57014' }));
  assert.equal(isContextReadTimeout(marked, { contextFix: true }), true);
  assert.equal(isContextReadTimeout(marked, { contextFix: false }), false);
  assert.equal(isContextReadTimeout(Object.assign(new Error('x'), { code: '57014' }), { contextFix: true }), false);
  assert.equal(isContextReadTimeout(markContextReadError(Object.assign(new Error('x'), { code: '40P01' })),
    { contextFix: true }), false);
  assert.equal(isContextReadTimeout({ code: 'BAI_BUDGET_UNAVAILABLE', cognitionContextRead: true }, { contextFix: true }), false);
  assert.equal(isContextReadTimeout(null, { contextFix: true }), false);
});

test('retry delay is 60-120 s', () => {
  assert.equal(contextRetryDelayMs(() => 0), CONTEXT_RETRY_MIN_MS);
  assert.ok(contextRetryDelayMs(() => 0.9999) < CONTEXT_RETRY_MIN_MS + CONTEXT_RETRY_JITTER_MS);
  assert.ok(contextRetryDelayMs(() => NaN) >= 60_000);
  for (let i = 0; i < 50; i += 1) {
    const ms = contextRetryDelayMs();
    assert.ok(ms >= 60_000 && ms < 120_000);
  }
});

test('retry release only clears our lease with a cooldown; review/plans/revision/budget untouched', () => {
  const sql = CONTEXT_RETRY_RELEASE_SQL;
  assert.match(sql, /lease_token=NULL/);
  assert.match(sql, /lease_until=now\(\)\+\(\$4::int \* interval '1 millisecond'\)/);
  assert.match(sql, /next_scheduled_at=CASE WHEN \$5::boolean/);
  assert.match(sql, /WHERE world_id=\$1 AND agent_id=\$2 AND lease_token=\$3/);
  for (const column of ['review_reason', 'next_review_world_minute', 'revision', 'plans', 'budget_deferred_until',
    'last_context_event_id', 'pending_action']) assert.ok(!sql.includes(column), column);
});

test('kill switch MIRRORTERRA_CONTEXT_READ_FIX: default on, env off, file wins and reloads', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctxfix-'));
  try {
    const file = path.join(dir, 'tickfix-flags.json');
    assert.equal(CONTEXT_READ_FIX_KEY, 'MIRRORTERRA_CONTEXT_READ_FIX');
    assert.equal(createContextReadFixFlags({ env: {}, file }).enabled(), true);
    assert.equal(createContextReadFixFlags({ env: { MIRRORTERRA_CONTEXT_READ_FIX: 'off' }, file }).enabled(), false);
    let t = 0;
    const flags = createContextReadFixFlags({ env: {}, file, now: () => t });
    writeFileSync(file, JSON.stringify({ MIRRORTERRA_CHAIN_FIX: 'on', [CONTEXT_READ_FIX_KEY]: 'off' }));
    assert.equal(flags.enabled(), false);
    writeFileSync(file, JSON.stringify({ [CONTEXT_READ_FIX_KEY]: 'on' }));
    assert.equal(flags.enabled(), false, 'cached for 15 s');
    t = 16_000;
    assert.equal(flags.enabled(), true);
    writeFileSync(file, '{broken');
    t = 40_000;
    assert.equal(createContextReadFixFlags({ env: { MIRRORTERRA_CONTEXT_READ_FIX: 'off' }, file, now: () => t }).enabled(), false,
      'unreadable file falls back to env');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function recordingPool({ rowCount = 1 } = {}) {
  const calls = [];
  let connects = 0;
  return { calls, get connects() { return connects; },
    async query(sql, params) { calls.push({ sql: String(sql), params }); return { rowCount, rows: [] }; },
    async connect() { connects += 1; throw Object.assign(new Error('old path reached'), { code: 'OLD_PATH' }); } };
}
const claimOf = (scheduled) => ({ agentId: AGENT, token: 'lease-token-1', correlationId: 'corr-1', revision: 4,
  trigger: scheduled ? 'scheduled' : 'plan_blocked', scheduled });

test('postponeTurn on a context-read timeout: lease released with 60-120 s cooldown, gate decision recorded, nothing else', async () => {
  const { postponeTurn } = await import('../src/agent-runtime/open-cognition/worker.js');
  for (const scheduled of [false, true]) {
    const pool = recordingPool();
    const error = markContextReadError(Object.assign(new Error('timeout'), { code: '57014' }));
    const before = Date.now();
    await postponeTurn(pool, WORLD, claimOf(scheduled), error, null, { contextFix: true });
    assert.equal(pool.connects, 0, 'no transaction, no members lock, no plan rewrite');
    assert.equal(pool.calls.length, 2);
    assert.equal(pool.calls[0].sql, CONTEXT_RETRY_RELEASE_SQL);
    const [world, agent, token, delay, isScheduled] = pool.calls[0].params;
    assert.deepEqual([world, agent, token, isScheduled], [WORLD, AGENT, 'lease-token-1', scheduled]);
    assert.ok(delay >= 60_000 && delay < 120_000);
    assert.match(pool.calls[1].sql, /UPDATE world_agent_cognition_gate_decisions SET decision=\$2/);
    assert.equal(pool.calls[1].params[0], 'corr-1');
    assert.equal(pool.calls[1].params[1], 'provider_deferred');
    assert.equal(pool.calls[1].params[2], '57014');
    const next = Date.parse(pool.calls[1].params[7]);
    assert.ok(next >= before + 60_000 && next <= Date.now() + 120_000);
  }
});

test('postponeTurn: lost lease = no gate update; fix off or other errors = old path', async () => {
  const { postponeTurn } = await import('../src/agent-runtime/open-cognition/worker.js');
  const lost = recordingPool({ rowCount: 0 });
  await postponeTurn(lost, WORLD, claimOf(false),
    markContextReadError(Object.assign(new Error('t'), { code: '57014' })), null, { contextFix: true });
  assert.equal(lost.calls.length, 1);
  const off = recordingPool();
  await assert.rejects(postponeTurn(off, WORLD, claimOf(false),
    markContextReadError(Object.assign(new Error('t'), { code: '57014' })), null, { contextFix: false }),
  (error) => error.code === 'OLD_PATH');
  assert.equal(off.calls.length, 0);
  const other = recordingPool();
  await assert.rejects(postponeTurn(other, WORLD, claimOf(false),
    Object.assign(new Error('deadlock'), { code: '40P01' }), null, { contextFix: true }),
  (error) => error.code === 'OLD_PATH');
});
