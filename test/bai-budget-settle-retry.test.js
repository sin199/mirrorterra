// tickfix3: bounded, idempotent settle retry on transient DB errors (pg pool connect timeouts on 10-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBaiBudgetGateway, createBaiSelfHealFlags, DEFAULT_BAI_UNSAFE_COOLDOWN_MS }
  from '../src/agent-runtime/bai-budget.js';
import { mainPoolSettings } from '../src/pg-pool-config.js';

const NO_FILE = path.join(tmpdir(), 'tickfix3-no-such-flags.json');
const input = { worldId: 'world-1', agentId: 'agent-1', source: 'openCognition', tier: 'haiku', model: 'claude-sonnet-5.5',
  body: '{}', maxTokens: 1_000, timeoutMs: 5_000 };
const poolTimeout = () => new Error('timeout exceeded when trying to connect');
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

// In-memory ledger. connectFail: number of pool.connect() calls that throw (pool exhaustion).
// fail: statement rules {match, times, error, after:'commit'} - 'after commit' applies the
// statement then loses the reply on COMMIT (commit landed, client sees an error).
function ledgerPool({ clock }) {
  const calls = new Map();
  const state = { active: null, activeUntil: null, fail: [], sql: [], connectFail: [], settles: 0,
    loseCommitReply: 0 };
  function makeClient() {
    let pending = null;
    const query = async (sql, values = []) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      state.sql.push(text);
      if (text.includes('FROM agents a WHERE a.id=$2::uuid')) return { rows: [{ external: false, member: true }] };
      const rule = state.fail.find((item) => text.includes(item.match) && item.times > 0);
      if (rule) { rule.times -= 1; throw rule.error; }
      if (text === 'BEGIN' || text === 'BEGIN READ ONLY') { pending = []; return { rows: [] }; }
      if (text === 'COMMIT') {
        for (const apply of pending || []) apply();
        pending = null;
        if (state.loseCommitReply > 0) { state.loseCommitReply -= 1; throw pgError('08006'); }
        return { rows: [] };
      }
      if (text === 'ROLLBACK') { pending = null; return { rows: [] }; }
      if (text.startsWith('SET LOCAL')) return { rows: [] };
      const later = (fn) => { (pending ? pending.push(fn) : fn()); };
      if (text.includes('FROM bai_model_budget_guard')) {
        return { rowCount: 1, rows: [{ active_call_id: state.active, active_until: state.activeUntil }] };
      }
      if (text.includes('AS committed')) {
        const live = [...calls.values()].filter((row) => row.status !== 'blocked');
        return { rows: [{ committed: live.reduce((sum, row) => sum + BigInt(row.effective), 0n).toString(),
          unknown_calls: 0, unknown_latest_at: null }] };
      }
      if (text.includes('SELECT created_at,agent_id')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT id FROM bai_model_budget_calls ORDER BY')) return { rows: [], rowCount: 0 };
      if (text.includes('UPDATE bai_model_deferred_needs')) return { rows: [] };
      if (text.includes('INSERT INTO bai_model_budget_calls')) {
        later(() => calls.set(values[0], { status: values[6], reserved: values[10], effective: values[11] }));
        return { rows: [] };
      }
      if (text.includes('UPDATE bai_model_budget_guard')) {
        const v = [...values];
        later(() => { state.active = v.length ? v[0] : null;
          state.activeUntil = v.length ? new Date(clock.t + v[1]) : null; });
        return { rows: [] };
      }
      if (text.includes('SELECT status FROM bai_model_budget_calls')) {
        const row = calls.get(values[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ status: row.status }] : [] };
      }
      if (text.includes('SELECT reserved_cost_nano_usd')) {
        const row = calls.get(values[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ reserved_cost_nano_usd: row.reserved }] : [] };
      }
      if (text.includes('UPDATE bai_model_budget_calls SET status=')) {
        const v = [...values];
        later(() => { const row = calls.get(v[0]); row.status = v[1]; row.effective = v[5]; state.settles += 1; });
        return { rows: [] };
      }
      if (text.includes('UPDATE bai_model_budget_calls SET rolling24h')) return { rows: [] };
      if (text.includes('SET provider_started_at')) return { rows: [] };
      throw new Error(`UNEXPECTED_SQL: ${text.slice(0, 80)}`);
    };
    return { query, release() {} };
  }
  const pool = {
    calls, state,
    query: (sql, values) => makeClient().query(sql, values),
    async connect() {
      const failNext = state.connectFail.shift();
      if (failNext) throw failNext;
      return makeClient();
    }
  };
  return pool;
}

function setup(env = {}, { flagFile = NO_FILE } = {}) {
  const clock = { t: Date.now() };
  const pool = ledgerPool({ clock });
  const events = [];
  const sleeps = [];
  const gateway = createBaiBudgetGateway(pool, { now: () => clock.t, env, flagFile,
    log: (event, fields) => events.push({ event, ...fields }),
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, random: () => 0.5 });
  let sends = 0;
  const send = async () => { sends += 1; return { usage: { inputTokens: 10, outputTokens: 5 } }; };
  // Make the Nth pool.connect() from now fail; admit = connect #1, settle attempts follow.
  const failConnects = (pattern) => { pool.state.connectFail.push(...pattern.map((f) => (f ? poolTimeout() : null))); };
  return { clock, pool, gateway, events, sleeps, send, sends: () => sends, failConnects };
}
const count = (events, name) => events.filter((e) => e.event === name).length;

test('settle: pool connect timeout once -> retried after 1-3 s, settles once, no unsafe', async () => {
  const t = setup();
  t.failConnects([false, true]); // admit ok, first settle connect times out
  const result = await t.gateway.runRequest(input, t.send);
  assert.ok(result.usage);
  assert.equal(t.gateway.unsafe, false);
  const row = [...t.pool.calls.values()][0];
  assert.equal(row.status, 'succeeded');
  assert.equal(t.pool.state.settles, 1, 'exactly one settlement');
  assert.equal(t.pool.state.active, null, 'guard released');
  assert.deepEqual(t.sleeps, [2_000], 'jitter between 1 and 3 s (random 0.5 -> 2 s)');
  assert.equal(count(t.events, 'bai_budget_settle_retry'), 1);
  const rec = t.events.find((e) => e.event === 'bai_budget_settle_recovered');
  assert.deepEqual({ attempt: rec.attempt, alreadySettled: rec.alreadySettled }, { attempt: 1, alreadySettled: false });
  assert.equal(count(t.events, 'bai_budget_unsafe_set'), 0);
  const st = t.gateway.status();
  assert.deepEqual({ r: st.settleRetries, ok: st.settleRecovered, on: st.settleRetry, max: st.settleRetryMax },
    { r: 1, ok: 1, on: true, max: 2 });
  await t.gateway.runRequest(input, t.send); // next call unaffected
  assert.equal(t.sends(), 2);
});

test('settle: statement-level transient errors (40P01, 57014) are retried too; second retry can succeed', async () => {
  const t = setup();
  t.pool.state.fail.push({ match: 'UPDATE bai_model_budget_calls SET status=', times: 2, error: pgError('40P01') });
  await t.gateway.runRequest(input, t.send);
  assert.equal(t.gateway.unsafe, false);
  assert.equal(t.pool.state.settles, 1);
  assert.equal(count(t.events, 'bai_budget_settle_retry'), 2);
  assert.equal(t.events.find((e) => e.event === 'bai_budget_settle_recovered').attempt, 2);
});

test('settle: retries exhausted -> old path (unsafe set, SETTLEMENT_FAILED, self-heal after cooldown)', async () => {
  const t = setup();
  t.failConnects([false, true, true, true]); // first try + 2 retries all time out
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(t.gateway.unsafe, true);
  assert.equal(t.sleeps.length, 2, 'at most 2 retries');
  assert.equal(count(t.events, 'bai_budget_settle_retry'), 2);
  assert.equal(count(t.events, 'bai_budget_settle_recovered'), 0);
  const set = t.events.find((e) => e.event === 'bai_budget_unsafe_set');
  assert.deepEqual({ phase: set.phase, reason: set.reason }, { phase: 'settle', reason: 'UNCODED_ERROR' });
  const row = [...t.pool.calls.values()][0];
  assert.equal(row.status, 'reserved', 'still counted at reserved cost');
  assert.equal(t.pool.state.settles, 0);
  t.clock.t += DEFAULT_BAI_UNSAFE_COOLDOWN_MS + 1;
  t.pool.state.activeUntil = new Date(Date.now() - 1);
  await t.gateway.runRequest(input, t.send); // tickfix2 self-heal still works
  assert.equal(t.gateway.unsafe, false);
  assert.equal(count(t.events, 'bai_budget_unsafe_cleared'), 1);
});

test('settle: non-transient error is not retried (unsafe immediately)', async () => {
  const t = setup();
  t.pool.state.fail.push({ match: 'UPDATE bai_model_budget_calls SET status=', times: 1,
    error: Object.assign(new Error('bad'), { code: '23514' }) });
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(t.sleeps.length, 0);
  assert.equal(t.gateway.unsafe, true);
});

test('settle idempotent: commit landed but reply lost -> retry sees settled row, does not settle again', async () => {
  const t = setup();
  t.pool.state.loseCommitReply = 0;
  // admit commit must succeed; lose the reply of the 2nd COMMIT (the settle)
  const origConnect = t.pool.connect.bind(t.pool);
  let n = 0;
  t.pool.connect = async () => { n += 1; if (n === 2) t.pool.state.loseCommitReply = 1; return origConnect(); };
  await t.gateway.runRequest(input, t.send);
  assert.equal(t.pool.state.settles, 1, 'settled exactly once');
  assert.equal([...t.pool.calls.values()][0].status, 'succeeded');
  const rec = t.events.find((e) => e.event === 'bai_budget_settle_recovered');
  assert.equal(rec.alreadySettled, true);
  assert.equal(t.gateway.unsafe, false);
  const updates = t.pool.state.sql.filter((sql) => sql.includes('UPDATE bai_model_budget_calls SET status=')).length;
  assert.equal(updates, 1, 'no second UPDATE of the call row');
});

test('settle idempotent: retry with row still reserved but lease taken over -> LEASE_LOST, unsafe, no settle', async () => {
  const t = setup();
  const origConnect = t.pool.connect.bind(t.pool);
  let n = 0;
  t.pool.connect = async () => {
    n += 1;
    if (n === 2) { t.pool.state.active = 'someone-else'; throw poolTimeout(); }
    return origConnect();
  };
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(t.pool.state.settles, 0);
  assert.equal(t.sleeps.length, 1, 'LEASE_LOST is not transient: no further retry');
  assert.equal(t.gateway.status().unsafeReason, 'settle:BAI_BUDGET_LEASE_LOST');
});

test('kill switch: MIRRORTERRA_BAI_SETTLE_RETRY=off in env -> no retry (tickfix2 behaviour)', async () => {
  const t = setup({ MIRRORTERRA_BAI_SETTLE_RETRY: 'off' });
  t.failConnects([false, true]);
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(t.sleeps.length, 0);
  assert.equal(count(t.events, 'bai_budget_settle_retry'), 0);
  assert.equal(t.gateway.unsafe, true);
  assert.equal(t.gateway.status().settleRetry, false);
});

test('kill switch and knobs from tickfix-flags.json (file wins over env); clamps', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tickfix3-'));
  const file = path.join(dir, 'tickfix-flags.json');
  writeFileSync(file, JSON.stringify({ MIRRORTERRA_BAI_SETTLE_RETRY: 'off' }));
  const t = setup({ MIRRORTERRA_BAI_SETTLE_RETRY: 'on' }, { flagFile: file });
  t.failConnects([false, true]);
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(t.sleeps.length, 0);

  const flags = createBaiSelfHealFlags({ env: { MIRRORTERRA_BAI_SETTLE_RETRY_MAX: '9',
    MIRRORTERRA_BAI_SETTLE_RETRY_MIN_MS: '5000', MIRRORTERRA_BAI_SETTLE_RETRY_MAX_MS: '2000' }, file: NO_FILE });
  assert.equal(flags.settleRetryEnabled(), true);
  assert.equal(flags.settleRetryMax(), 5, 'clamped to 5');
  assert.deepEqual(flags.settleRetryDelayRangeMs(), { min: 2_000, max: 5_000 });
  const d = createBaiSelfHealFlags({ env: {}, file: NO_FILE });
  assert.equal(d.settleRetryMax(), 2);
  assert.deepEqual(d.settleRetryDelayRangeMs(), { min: 1_000, max: 3_000 });
  const zero = setup({ MIRRORTERRA_BAI_SETTLE_RETRY_MAX: '0' });
  zero.failConnects([false, true]);
  await assert.rejects(zero.gateway.runRequest(input, zero.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(zero.sleeps.length, 0, 'max 0 = no retry');
});

test('main pool settings: defaults 18 / 10 s, env override, clamps', () => {
  assert.deepEqual(mainPoolSettings({}), { max: 18, connectionTimeoutMillis: 10_000 });
  assert.deepEqual(mainPoolSettings({ MIRRORTERRA_PG_POOL_MAX: '10', MIRRORTERRA_PG_CONNECT_TIMEOUT_MS: '5000' }),
    { max: 10, connectionTimeoutMillis: 5_000 });
  assert.deepEqual(mainPoolSettings({ MIRRORTERRA_PG_POOL_MAX: '500', MIRRORTERRA_PG_CONNECT_TIMEOUT_MS: '1' }),
    { max: 40, connectionTimeoutMillis: 1_000 });
  assert.deepEqual(mainPoolSettings({ MIRRORTERRA_PG_POOL_MAX: 'x' }), { max: 18, connectionTimeoutMillis: 10_000 });
});
