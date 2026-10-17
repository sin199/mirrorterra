import test from 'node:test';
import assert from 'node:assert/strict';
import { baiAdmissionEstimate, baiPricedNanoUsd } from '../src/agent-runtime/bai-pricing.js';
import { createBaiBudgetGateway } from '../src/agent-runtime/bai-budget.js';
import { projectBaiBudgetDiagnostics } from '../src/agent-runtime/bai-budget-diagnostics.js';
import { materialCognitionFingerprint, nextScheduledSlot, shouldCallForMaterialChange,
  SCHEDULE_PERIOD_MS } from '../src/agent-runtime/open-cognition/schedule.js';

test('admission reserves actual serialized input plus max output, not the context window', () => {
  const body = JSON.stringify({ model: 'claude-sonnet-5.5', messages: [
    { role: 'system', content: 'Think carefully.' }, { role: 'user', content: 'One fact.' }] });
  const estimate = baiAdmissionEstimate({ model: 'claude-sonnet-5.5',
    serializedBody: body, maxTokens: 5_000 });
  assert.equal(estimate.requestBytes, Buffer.byteLength(body));
  assert.ok(estimate.estimatedInputTokens >= estimate.requestBytes);
  assert.ok(estimate.estimatedInputTokens < 2_000);
  const priced = baiPricedNanoUsd('claude-sonnet-5.5', estimate.estimatedInputTokens, 5_000);
  assert.equal(estimate.reservedNanoUsd, (priced * 105n + 99n) / 100n);
  assert.throws(() => baiAdmissionEstimate({ model: 'unknown', serializedBody: body,
    maxTokens: 5_000 }), { code: 'BAI_PRICE_UNAVAILABLE' });
});

test('scheduled slots are fixed, staggered, and never replay missed slots', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const slots = Array.from({ length: 10 }, (_, ordinal) => nextScheduledSlot(now, ordinal, 10));
  assert.ok(slots.every((slot) => slot > now && slot <= now + SCHEDULE_PERIOD_MS));
  assert.equal(new Set(slots).size, 10);
  for (const slot of slots) assert.equal(nextScheduledSlot(slot, slots.indexOf(slot), 10), slot + SCHEDULE_PERIOD_MS);
});

test('healthy plan step progress does not cause Sonnet at a scheduled slot', () => {
  const plan = { id: 'plan-1', goalId: 'goal-1', summary: 'Learn', status: 'active',
    currentStep: 0, steps: [{ targetId: 'a' }, { targetId: 'b' }] };
  const context = { prior: { goals: [{ id: 'goal-1', status: 'active', title: 'Learn' }],
    plans: [plan] }, targetState: null };
  const prior = materialCognitionFingerprint(context);
  assert.equal(shouldCallForMaterialChange({ context: { ...context, prior: {
    ...context.prior, plans: [{ ...plan, currentStep: 1 }] } },
  previousFingerprint: prior, trigger: 'scheduled' }).call, false);
  assert.equal(shouldCallForMaterialChange({ context: { ...context, targetState: { status: 'closed' } },
    previousFingerprint: prior, trigger: 'scheduled' }).call, false);
  assert.equal(shouldCallForMaterialChange({ context: { ...context, prior: {
    ...context.prior, plans: [{ ...plan, status: 'blocked' }] } },
    previousFingerprint: prior, trigger: 'scheduled' }).call, true);
});

test('failed replan is deferred until explicitly eligible for provider recovery', () => {
  const plan = { id: 'p', status: 'blocked', currentStep: 0, steps: [{}],
    executionReplans: [{ fingerprint: 'x', status: 'pending', replanTriggered: true,
      providerRetryEligible: false }] };
  const context = { prior: { goals: [], plans: [plan] } };
  const previousFingerprint = materialCognitionFingerprint(context);
  assert.equal(shouldCallForMaterialChange({ context, previousFingerprint,
    trigger: 'world_outcome' }).call, false);
  const recovered = { ...context, prior: { goals: [], plans: [{ ...plan,
    executionReplans: [{ ...plan.executionReplans[0], providerRetryEligible: true }] }] } };
  assert.equal(shouldCallForMaterialChange({ context: recovered, previousFingerprint,
    trigger: 'scheduled' }).call, true);
});

test('rolling diagnostics split source costs and do not count blocked calls as spend', () => {
  const at = new Date().toISOString();
  const diagnostics = projectBaiBudgetDiagnostics({ ledgerRows: [
    { source: 'openCognition', tier: 'sonnet', status: 'succeeded',
      effective_cost_nano_usd: '100000000', input_tokens: 100, output_tokens: 10, created_at: at },
    { source: 'memorySelection', tier: 'haiku', status: 'succeeded',
      effective_cost_nano_usd: '1000000', input_tokens: 20, output_tokens: 5, created_at: at },
    { source: 'modelAnalysis', tier: 'sonnet', status: 'blocked',
      effective_cost_nano_usd: '0', created_at: at }
  ], activity: { cache_hits: 2, grounding_succeeded: 1, world_executions: 1,
    replan_completed: 0 }, worldMinute: 20, states: [{ plans: [{ steps: [
      { executionEvidence: { success: true, worldMinute: 19 } }] }] }] });
  assert.equal(diagnostics.rolling24h.spentUsd, 0.101);
  assert.equal(diagnostics.rolling24h.bySourceUsd.openCognition, 0.1);
  assert.equal(diagnostics.rolling24h.bySourceUsd.memorySelection, 0.001);
  assert.equal(diagnostics.rolling24h.blockedByBudget, 1);
  assert.equal(diagnostics.last15m.planStepsCompleted, 1);
  assert.equal(diagnostics.last15m.tokensPerWorldExecution, 135);
});

function budgetPool() {
  const calls = new Map();
  let active = null;
  const query = async (sql, values = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('SELECT active_call_id,active_until')) return { rowCount: 1, rows: [{
      active_call_id: active, active_until: new Date(Date.now() + 60_000) }] };
    if (sql.includes('SELECT active_call_id FROM bai_model_budget_guard')) {
      return { rows: [{ active_call_id: active }] };
    }
    if (sql.includes('SELECT COALESCE(sum(effective_cost_nano_usd)')) return { rows: [{
      amount: [...calls.values()].filter((row) => row.status !== 'blocked')
        .reduce((sum, row) => sum + BigInt(row.effective), 0n).toString() }] };
    if (sql.includes('INSERT INTO bai_model_budget_calls')) {
      calls.set(values[0], { status: values[6], reserved: values[10], effective: values[11] });
      return { rows: [] };
    }
    if (sql.includes('UPDATE bai_model_budget_guard')) {
      active = values.length ? values[0] : null;
      return { rows: [] };
    }
    if (sql.includes('SELECT reserved_cost_nano_usd')) {
      return { rowCount: 1, rows: [{ reserved_cost_nano_usd: calls.get(values[0]).reserved }] };
    }
    if (sql.includes('UPDATE bai_model_budget_calls SET status=')) {
      const row = calls.get(values[0]);
      row.status = values[1];
      row.effective = values[5];
      return { rows: [] };
    }
    if (sql.includes('UPDATE bai_model_budget_calls SET rolling24h')) return { rows: [] };
    throw new Error(`UNEXPECTED_SQL: ${sql.slice(0, 70)}`);
  };
  return { calls, connect: async () => ({ query, release() {} }) };
}

test('global gateway serializes concurrent sends and settles with reported usage', async () => {
  const pool = budgetPool();
  const gateway = createBaiBudgetGateway(pool);
  const input = { source: 'openCognition', tier: 'sonnet', model: 'claude-sonnet-5.5',
    body: '{}', maxTokens: 5_000, timeoutMs: 5_000 };
  let inFlight = 0;
  let peak = 0;
  const send = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { usage: { inputTokens: 20, outputTokens: 10 } };
  };
  await Promise.all([gateway.runRequest(input, send), gateway.runRequest(input, send)]);
  assert.equal(peak, 1);
  assert.equal(pool.calls.size, 2);
  assert.ok([...pool.calls.values()].every((row) => row.status === 'succeeded'
    && BigInt(row.effective) < BigInt(row.reserved)));
});

test('unknown failed provider charge retains its reservation and blocks over-cap request', async () => {
  const pool = budgetPool();
  const gateway = createBaiBudgetGateway(pool);
  const input = { source: 'openCognition', tier: 'sonnet', model: 'claude-sonnet-5.5',
    body: '{}', maxTokens: 68_000, timeoutMs: 5_000 };
  await assert.rejects(gateway.runRequest(input, async () => { throw new Error('network'); }), /network/u);
  let contacted = false;
  await assert.rejects(gateway.runRequest(input, async () => { contacted = true; }),
    { code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
  assert.equal(contacted, false);
  assert.equal([...pool.calls.values()].filter((row) => row.status === 'blocked').length, 1);
});
