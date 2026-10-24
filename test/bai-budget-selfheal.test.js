// tickfix2: the B.AI budget gateway recovers from "unsafe" on its own (no restart needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBaiBudgetGateway, createBaiSelfHealFlags, isTransientDbError,
  DEFAULT_BAI_UNSAFE_COOLDOWN_MS } from '../src/agent-runtime/bai-budget.js';

const NO_FILE = path.join(tmpdir(), 'tickfix2-no-such-flags.json');
const input = { worldId: 'world-1', agentId: 'agent-1', source: 'openCognition', tier: 'haiku', model: 'claude-sonnet-5.5',
  body: '{}', maxTokens: 1_000, timeoutMs: 5_000 };
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

// A small in-memory ledger: one guard row + calls. `fail` lets a test break one statement.
function ledgerPool({ clock }) {
  const calls = new Map();
  const state = { active: null, activeUntil: null, guardRow: true, fail: [], sql: [] };
  const query = async (sql, values = []) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    state.sql.push(text);
    if (text.includes('FROM agents a WHERE a.id=$2::uuid')) return { rows: [{ external: false, member: true }] };
    const rule = state.fail.find((item) => text.includes(item.match) && item.times > 0);
    if (rule) { rule.times -= 1; throw rule.error; }
    if (['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN READ ONLY'].includes(text) || text.startsWith('SET LOCAL')) return { rows: [] };
    if (text.includes('FROM bai_model_budget_guard')) {
      if (!state.guardRow) return { rowCount: 0, rows: [] };
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
      calls.set(values[0], { status: values[6], reserved: values[10], effective: values[11],
        costSource: values[12] });
      return { rows: [] };
    }
    if (text.includes('UPDATE bai_model_budget_guard')) {
      state.active = values.length ? values[0] : null;
      state.activeUntil = values.length ? new Date(clock.t + values[1]) : null;
      return { rows: [] };
    }
    if (text.includes('SELECT reserved_cost_nano_usd')) {
      const row = calls.get(values[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ reserved_cost_nano_usd: row.reserved }] : [] };
    }
    if (text.includes('UPDATE bai_model_budget_calls SET status=')) {
      const row = calls.get(values[0]);
      row.status = values[1]; row.effective = values[5]; row.costSource = values[6]; row.failureCode = values[7];
      return { rows: [] };
    }
    if (text.includes('UPDATE bai_model_budget_calls SET rolling24h')) return { rows: [] };
    if (text.includes('SET provider_started_at')) return { rows: [] };
    throw new Error(`UNEXPECTED_SQL: ${text.slice(0, 80)}`);
  };
  return { calls, state, query, connect: async () => ({ query, release() {} }) };
}

function setup(env = {}) {
  const clock = { t: Date.now() }; // admit() itself compares the lease with the real clock
  const pool = ledgerPool({ clock });
  const events = [];
  const gateway = createBaiBudgetGateway(pool, { now: () => clock.t,
    env, flagFile: NO_FILE, log: (event, fields) => events.push({ event, ...fields }) });
  let sends = 0;
  const send = async () => { sends += 1; return { usage: { inputTokens: 10, outputTokens: 5 } }; };
  return { clock, pool, gateway, events, send, sends: () => sends };
}

test('admit deadlock / statement timeout / serialization / lost connection fail one call, gateway stays usable', async () => {
  for (const error of [pgError('40P01'), pgError('57014'), pgError('40001'),
    Object.assign(new Error('Connection terminated unexpectedly'), {})]) {
    const t = setup();
    t.pool.state.fail.push({ match: 'INSERT INTO bai_model_budget_calls', times: 1, error });
    await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_TRANSIENT' });
    assert.equal(t.gateway.unsafe, false);
    assert.equal(t.pool.calls.size, 0, 'rolled back: no reservation left behind');
    assert.ok(t.pool.state.sql.includes('ROLLBACK'));
    assert.equal(t.events.filter((e) => e.event === 'bai_budget_unsafe_set').length, 0);
    assert.equal(t.events.find((e) => e.event === 'bai_budget_admit_transient').reason,
      error.code || 'UNCODED_ERROR');
    await t.gateway.runRequest(input, t.send); // the very next call goes through
    assert.equal(t.sends(), 1);
    assert.equal(t.gateway.status().transientAdmitErrors, 1);
  }
});

test('settle failure marks unsafe, then the gateway heals itself after the cooldown', async () => {
  const t = setup({ MIRRORTERRA_BAI_SETTLE_RETRY: 'off' }); // tickfix3: retry tested in bai-budget-settle-retry
  t.pool.state.fail.push({ match: 'UPDATE bai_model_budget_calls SET status=', times: 1, error: pgError('40P01') });
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  assert.equal(t.gateway.unsafe, true);
  const pending = [...t.pool.calls.values()][0];
  assert.equal(pending.status, 'reserved', 'unsettled reservation keeps counting at reserved cost');
  assert.equal(pending.effective, pending.reserved);
  const set = t.events.find((e) => e.event === 'bai_budget_unsafe_set');
  assert.deepEqual({ phase: set.phase, reason: set.reason, selfHeal: set.selfHeal },
    { phase: 'settle', reason: '40P01', selfHeal: true });
  assert.equal(t.gateway.status().unsafeSince, new Date(t.clock.t).toISOString());

  t.clock.t += DEFAULT_BAI_UNSAFE_COOLDOWN_MS - 1_000;
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_UNAVAILABLE' });
  assert.equal(t.sends(), 1);

  t.clock.t += 2_000;
  t.pool.state.activeUntil = new Date(Date.now() - 1); // the stuck lease has expired by now
  await t.gateway.runRequest(input, t.send);
  assert.equal(t.sends(), 2);
  assert.equal(t.gateway.unsafe, false);
  const cleared = t.events.find((e) => e.event === 'bai_budget_unsafe_cleared');
  assert.equal(cleared.reason, 'settle:40P01');
  assert.ok(cleared.unsafeForMs >= DEFAULT_BAI_UNSAFE_COOLDOWN_MS);
  assert.ok(t.pool.state.sql.includes('BEGIN READ ONLY'), 'self-check is read-only');
  assert.equal(t.gateway.status().healedCount, 1);
  assert.equal(t.gateway.status().unsafeSince, null);
});

test('a failing self-check restarts the cooldown and keeps refusing calls', async () => {
  const t = setup();
  t.pool.state.guardRow = false;
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_GUARD_MISSING' });
  assert.equal(t.gateway.unsafe, true);
  assert.equal(t.gateway.status().unsafeReason, 'admit:BAI_BUDGET_GUARD_MISSING');
  t.clock.t += DEFAULT_BAI_UNSAFE_COOLDOWN_MS + 1;
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_UNAVAILABLE' });
  assert.equal(t.events.filter((e) => e.event === 'bai_budget_selfcheck_failed').length, 1);
  assert.equal(t.gateway.status().unsafeSince, new Date(t.clock.t).toISOString(), 'cooldown restarted');
  t.pool.state.guardRow = true;
  t.clock.t += 30_000;
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_UNAVAILABLE' });
  t.clock.t += 31_000;
  await t.gateway.runRequest(input, t.send);
  assert.equal(t.sends(), 1);
  assert.equal(t.gateway.unsafe, false);
});

test('kill switch off restores the old behaviour exactly (transient admit error -> unsafe until restart)', async () => {
  const t = setup({ MIRRORTERRA_BAI_BUDGET_SELF_HEAL: 'off' });
  t.pool.state.fail.push({ match: 'INSERT INTO bai_model_budget_calls', times: 1, error: pgError('40P01') });
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: '40P01' });
  assert.equal(t.gateway.unsafe, true);
  t.clock.t += 24 * 60 * 60_000;
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_UNAVAILABLE' });
  assert.equal(t.sends(), 0);
  assert.equal(t.gateway.status().selfHeal, false);
  assert.ok(!t.pool.state.sql.includes('BEGIN READ ONLY'));

  const s = setup({ MIRRORTERRA_BAI_BUDGET_SELF_HEAL: 'off', MIRRORTERRA_BAI_SETTLE_RETRY: 'off' });
  s.pool.state.fail.push({ match: 'SELECT reserved_cost_nano_usd', times: 1, error: pgError('57014') });
  await assert.rejects(s.gateway.runRequest(input, s.send), { code: 'BAI_BUDGET_SETTLEMENT_FAILED' });
  s.clock.t += 60 * 60_000;
  await assert.rejects(s.gateway.runRequest(input, s.send), { code: 'BAI_BUDGET_UNAVAILABLE' });
});

test('kill switch is also read from tickfix-flags.json and the cooldown is configurable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tickfix2-'));
  const file = path.join(dir, 'tickfix-flags.json');
  writeFileSync(file, JSON.stringify({ MIRRORTERRA_BAI_BUDGET_SELF_HEAL: 'off',
    MIRRORTERRA_BAI_BUDGET_UNSAFE_COOLDOWN_MS: 120000 }));
  const flags = createBaiSelfHealFlags({ env: {}, file });
  assert.equal(flags.selfHealEnabled(), false);
  assert.equal(flags.cooldownMs(), 120_000);
  const defaults = createBaiSelfHealFlags({ env: {}, file: NO_FILE });
  assert.equal(defaults.selfHealEnabled(), true);
  assert.equal(defaults.cooldownMs(), 60_000);
  const env = createBaiSelfHealFlags({ env: { MIRRORTERRA_BAI_BUDGET_UNSAFE_COOLDOWN_MS: '10' }, file: NO_FILE });
  assert.equal(env.cooldownMs(), 5_000, 'clamped to at least 5 s');
});

test('disable() at start-up (budget history unavailable) stays permanent even with self-heal on', async () => {
  const t = setup();
  t.gateway.disable();
  t.clock.t += 24 * 60 * 60_000;
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_BUDGET_UNAVAILABLE' });
  assert.equal(t.sends(), 0);
  assert.equal(t.gateway.status().disabled, true);
});

test('expired lease is taken over; a live lease is BUSY and never marks unsafe', async () => {
  const t = setup();
  // the stuck council call from 10-23 07:49 UTC: lease holder never settled
  t.pool.calls.set('a39f25ce', { status: 'reserved', reserved: '1000', effective: '1000', costSource: 'reservation' });
  t.pool.state.active = 'a39f25ce';
  t.pool.state.activeUntil = new Date(t.clock.t + 10_000);
  await assert.rejects(t.gateway.runRequest(input, t.send), { code: 'BAI_MODEL_CALL_BUSY' });
  assert.equal(t.gateway.unsafe, false);
  t.pool.state.activeUntil = new Date(Date.now() - 1); // lease ran out (active_until < now)
  await t.gateway.runRequest(input, t.send);
  assert.equal(t.sends(), 1);
  assert.equal(t.pool.state.active, null, 'new call settled and released the guard');
  const old = t.pool.calls.get('a39f25ce');
  assert.deepEqual({ status: old.status, effective: old.effective }, { status: 'reserved', effective: '1000' },
    'old reservation untouched, still counted at its reserved cost');
});

test('transient classification', () => {
  for (const code of ['40P01', '57014', '40001', '55P03', '08006', '57P01', 'ECONNRESET']) {
    assert.equal(isTransientDbError({ code }), true, code);
  }
  for (const code of ['BAI_BUDGET_GUARD_MISSING', '23505', '42P01', 'BAI_BUDGET_LEASE_LOST']) {
    assert.equal(isTransientDbError({ code }), false, code);
  }
  assert.equal(isTransientDbError(new Error('timeout exceeded when trying to connect')), true);
});
