import test from 'node:test';
import assert from 'node:assert/strict';
import { baiAdmissionEstimate, baiPricedNanoUsd, baiPricedUsageNanoUsd }
  from '../src/agent-runtime/bai-pricing.js';
import { backfillBaiBudgetHistory, createBaiBudgetGateway,
  nextAdmissionPossibleAt } from '../src/agent-runtime/bai-budget.js';
import { projectBaiBudgetDiagnostics } from '../src/agent-runtime/bai-budget-diagnostics.js';
import { createCognitionModelRouter } from '../src/agent-runtime/open-cognition/provider.js';
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

test('Luna reservation covers a fresh cache write and actual cache usage is priced', () => {
  const serializedBody = JSON.stringify({ model: 'gpt-6-luna', messages: [
    { role: 'system', content: 'Stable instructions' },
    { role: 'user', content: 'Current state' }] });
  const estimate = baiAdmissionEstimate({ model: 'gpt-6-luna', serializedBody,
    maxTokens: 5_000 });
  assert.ok(estimate.reservedNanoUsd
    > baiPricedNanoUsd('gpt-6-luna', estimate.estimatedInputTokens, 5_000));
  const cached = baiPricedUsageNanoUsd('gpt-6-luna', 1000, 100,
    { cacheReadTokens: 800, cacheWriteTokens: 100 });
  const uncached = baiPricedUsageNanoUsd('gpt-6-luna', 1000, 100);
  assert.ok(cached < uncached);
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

test('rolling diagnostics separate verified cost, uncertain history, and new reservations', () => {
  const at = new Date().toISOString();
  const diagnostics = projectBaiBudgetDiagnostics({ ledgerRows: [
    { source: 'openCognition', tier: 'sonnet', status: 'succeeded',
      request_bytes: 100, cost_source: 'usage_priced',
      effective_cost_nano_usd: '100000000', input_tokens: 100, output_tokens: 10, created_at: at },
    { source: 'memorySelection', tier: 'haiku', status: 'succeeded',
      request_bytes: 100, cost_source: 'provider_reported',
      effective_cost_nano_usd: '1000000', input_tokens: 20, output_tokens: 5, created_at: at },
    { source: 'modelAnalysis', tier: 'sonnet', status: 'blocked',
      request_bytes: 100, cost_source: 'blocked', effective_cost_nano_usd: '0', created_at: at }
  ], activity: { cache_hits: 2, grounding_succeeded: 1, world_executions: 1,
    replan_completed: 0, deterministic_gate_checks: 4 }, worldMinute: 20,
  deferredRows: [{ reason: 'budget', blocked_count: 1, suppressed_count: 3,
    created_at: at, deferred_until: new Date(Date.now() + 60_000).toISOString() }],
  states: [{ budget_deferred_until: new Date(Date.now() + 60_000).toISOString(),
    plans: [{ steps: [{ executionEvidence: { success: true, worldMinute: 19 } }] }] }] });
  assert.equal(diagnostics.rolling24h.knownCostUsd, 0.101);
  assert.equal(diagnostics.rolling24h.bySourceKnownCostUsd.openCognition, 0.1);
  assert.equal(diagnostics.rolling24h.bySourceKnownCostUsd.memorySelection, 0.001);
  assert.equal(diagnostics.rolling24h.unknownReserveUsd, 0);
  assert.equal(diagnostics.rolling24h.committedOrReservedUsd, 0.101);
  assert.equal('spentUsd' in diagnostics.rolling24h, false);
  assert.equal(diagnostics.rolling24h.blockedByBudget, 1);
  assert.equal(diagnostics.last15m.planStepsCompleted, 1);
  assert.equal(diagnostics.last15m.tokensPerWorldExecution, 135);
  assert.equal(diagnostics.budget.blockedByBudgetUnique, 1);
  assert.equal(diagnostics.budget.suppressedDuplicateBudgetAttempts, 3);
  assert.equal(diagnostics.deferred.pendingCurrentNeeds, 1);
  assert.equal(diagnostics.callActivityLast15m.deterministicGateChecks, 4);
  assert.equal(diagnostics.rateLimit.maxCallsPerRollingHour, 15);
});

test('14,380 unpriced historical calls share one bounded reserve and old rows expire', () => {
  const now = Date.parse('2026-10-17T05:00:00Z');
  const unknown = (created_at) => ({ source: 'openCognition', tier: 'sonnet',
    status: 'failed', request_bytes: 0, cost_source: 'reservation',
    effective_cost_nano_usd: '750000000', created_at });
  const rows = Array.from({ length: 14_380 }, () =>
    unknown(new Date(now - 60_000).toISOString()));
  rows.push(unknown(new Date(now - 24 * 60 * 60_000 - 1).toISOString()));
  let rolling = projectBaiBudgetDiagnostics({ ledgerRows: rows, now }).rolling24h;
  assert.equal(rolling.knownCostUsd, 0);
  assert.equal(rolling.unknownCallCount, 14_380);
  assert.equal(rolling.unknownReserveUsd, 1);
  assert.equal(rolling.committedOrReservedUsd, 1);
  assert.equal(rolling.remainingAdmissionUsd, 0);
  rolling = projectBaiBudgetDiagnostics({ ledgerRows: rows,
    now: now + 24 * 60 * 60_000 + 1 }).rolling24h;
  assert.equal(rolling.unknownCallCount, 0);
  assert.equal(rolling.unknownReserveUsd, 0);
  assert.equal(rolling.remainingAdmissionUsd, 1);
});

function budgetPool() {
  const calls = new Map();
  const deferred = new Map();
  let active = null;
  const query = async (sql, values = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('SELECT active_call_id,active_until')) return { rowCount: 1, rows: [{
      active_call_id: active, active_until: new Date(Date.now() + 60_000) }] };
    if (sql.includes('SELECT active_call_id FROM bai_model_budget_guard')) {
      return { rows: [{ active_call_id: active }] };
    }
    if (sql.includes('AS committed')) {
      const live = [...calls.values()].filter((row) => row.status !== 'blocked'
        && row.createdAt > Date.now() - 24 * 60 * 60_000);
      return { rows: [{ committed: live.filter((row) =>
        !(row.requestBytes === 0 && row.costSource === 'reservation'))
        .reduce((sum, row) => sum + BigInt(row.effective), 0n).toString(),
      unknown_calls: live.filter((row) => row.requestBytes === 0
        && row.costSource === 'reservation').length,
      unknown_latest_at: live.filter((row) => row.requestBytes === 0
        && row.costSource === 'reservation').sort((a, b) => b.createdAt - a.createdAt)[0]?.createdAt || null }] };
    }
    if (sql.includes('SELECT created_at,effective_cost_nano_usd')) {
      return { rows: [...calls.values()].filter((row) => row.status !== 'blocked'
        && row.requestBytes > 0 && row.createdAt > Date.now() - 24 * 60 * 60_000)
        .map((row) => ({ created_at: new Date(row.createdAt),
          effective_cost_nano_usd: row.effective })) };
    }
    if (sql.includes('SELECT created_at,agent_id FROM bai_model_budget_calls')) {
      const rows = [...calls.values()].filter((row) => row.status !== 'blocked'
        && row.requestBytes > 0 && row.createdAt > Date.now() - 60 * 60_000)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({ created_at: new Date(row.createdAt), agent_id: row.agentId }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT deferred_until,resolved_at FROM bai_model_deferred_needs')) {
      const row = deferred.get(values[0]);
      return { rows: row ? [{ deferred_until: row.deferredUntil }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO bai_model_deferred_needs')) {
      deferred.set(values[0], { deferredUntil: values[10], blockedCount: 1, suppressedCount: 0 });
      return { rows: [] };
    }
    if (sql.includes('UPDATE bai_model_deferred_needs')) {
      if (sql.includes('SET resolved_at=now()')) return { rows: [] };
      const row = deferred.get(values[0]);
      if (sql.includes('suppressed_count=')) row.suppressedCount += 1;
      else { row.blockedCount += 1; row.deferredUntil = values[1]; }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO bai_model_budget_calls')) {
      calls.set(values[0], { status: values[6], requestBytes: values[7], reserved: values[10],
        effective: values[11], costSource: values[12], agentId: values[2], createdAt: Date.now() });
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
      row.costSource = values[6];
      return { rows: [] };
    }
    if (sql.includes('UPDATE bai_model_budget_calls SET rolling24h')) return { rows: [] };
    if (sql.includes('UPDATE bai_model_budget_calls SET provider_started_at')) {
      calls.get(values[0]).providerStarted = true;
      return { rows: [] };
    }
    throw new Error(`UNEXPECTED_SQL: ${sql.slice(0, 70)}`);
  };
  return { calls, deferred, query, connect: async () => ({ query, release() {} }) };
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
  assert.ok([...pool.calls.values()].every((row) =>
    BigInt(row.effective) === baiPricedNanoUsd(input.model, 20, 10)));
});

test('unknown failed provider charge retains its reservation and blocks over-cap request', async () => {
  const pool = budgetPool();
  const gateway = createBaiBudgetGateway(pool);
  const input = { source: 'openCognition', tier: 'sonnet', model: 'claude-sonnet-5.5',
    body: '{}', maxTokens: 68_000, timeoutMs: 5_000 };
  await assert.rejects(gateway.runRequest(input, async () => { throw new Error('network'); }), /network/u);
  let contacted = false;
  const afterRestart = createBaiBudgetGateway(pool);
  await assert.rejects(afterRestart.runRequest(input, async () => { contacted = true; }),
    { code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
  assert.equal(contacted, false);
  assert.equal([...pool.calls.values()].filter((row) => row.status === 'blocked').length, 1);
  const failed = [...pool.calls.values()].find((row) => row.status === 'failed');
  assert.equal(failed.effective, failed.reserved);
  const rolling = projectBaiBudgetDiagnostics({ ledgerRows: [{
    source: input.source, tier: input.tier, status: failed.status,
    request_bytes: failed.requestBytes, cost_source: failed.costSource,
    effective_cost_nano_usd: failed.effective, created_at: new Date().toISOString()
  }] }).rolling24h;
  assert.equal(rolling.knownCostUsd, 0);
  assert.equal(rolling.newCallReservedUsd, Number(BigInt(failed.reserved)) / 1_000_000_000);
});

test('historical unknown uses one admission reserve, while expired unknown does not block', async () => {
  const pool = budgetPool();
  for (let index = 0; index < 4; index += 1) pool.calls.set(`old-${index}`, {
    status: 'failed', requestBytes: 0, costSource: 'reservation',
    effective: '750000000', createdAt: Date.now() - 60_000 });
  const input = { source: 'memorySelection', tier: 'haiku', model: 'claude-haiku-4.5',
    body: '{}', maxTokens: 100, timeoutMs: 5_000 };
  let contacted = false;
  await assert.rejects(createBaiBudgetGateway(pool).runRequest(input,
    async () => { contacted = true; }), { code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
  assert.equal(contacted, false);
  for (const row of pool.calls.values()) if (row.requestBytes === 0) {
    row.createdAt = Date.now() - 24 * 60 * 60_000 - 1;
  }
  await createBaiBudgetGateway(pool).runRequest(input,
    async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }));
});

test('next admission waits for the last historical unknown, then any remaining known cost', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const latest = new Date(now - 60_000).toISOString();
  const first = new Date(now - 23 * 60 * 60_000).toISOString();
  assert.equal(nextAdmissionPossibleAt({ now, knownCalls: [], unknownLatestAt: latest,
    reservationNanoUsd: 1n }), new Date(now - 60_000 + 24 * 60 * 60_000 + 1_000).toISOString());
  assert.equal(nextAdmissionPossibleAt({ now, knownCalls: [{ created_at: first,
    effective_cost_nano_usd: '750000000' }], unknownLatestAt: latest,
  reservationNanoUsd: 1n }), new Date(now - 60_000 + 24 * 60 * 60_000 + 1_000).toISOString());
  const laterKnown = new Date(now - 30_000).toISOString();
  assert.equal(nextAdmissionPossibleAt({ now, knownCalls: [{ created_at: laterKnown,
    effective_cost_nano_usd: '750000000' }], unknownLatestAt: latest,
  reservationNanoUsd: 1n }), new Date(now - 60_000 + 24 * 60 * 60_000 + 1_000).toISOString());
});

test('same Agent and fingerprint coalesce budget denials across restart', async () => {
  const pool = budgetPool();
  for (let index = 0; index < 3; index += 1) pool.calls.set(`historical-${index}`, {
    status: 'failed', requestBytes: 0, costSource: 'reservation', effective: '0',
    createdAt: Date.now() - (index + 1) * 60_000 });
  const input = { agentId: 'agent-1', source: 'openCognition', tier: 'sonnet',
    model: 'claude-sonnet-5.5', body: '{}', maxTokens: 5_000, timeoutMs: 5_000,
    goalId: 'goal', planId: 'plan', stepId: 'step', materialFingerprint: 'same' };
  let contacted = 0;
  const send = async () => { contacted += 1; return {}; };
  const first = await assert.rejects(createBaiBudgetGateway(pool).runRequest(input, send),
    { code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
  await assert.rejects(createBaiBudgetGateway(pool).runRequest(input, send),
    { code: 'MODEL_DAILY_BUDGET_EXCEEDED', suppressed: true });
  assert.equal(contacted, 0);
  assert.equal([...pool.calls.values()].filter((row) => row.status === 'blocked').length, 1);
  assert.equal([...pool.deferred.values()][0].suppressedCount, 1);
});

test('per-resident paid-call gate allows only two across sources and restarts', async () => {
  const pool = budgetPool();
  const input = { agentId: 'agent-1', source: 'memorySelection', tier: 'haiku',
    model: 'claude-haiku-4.5', body: '{}', maxTokens: 100, timeoutMs: 5_000 };
  let sent = 0;
  const send = async () => { sent += 1; return { usage: { inputTokens: 1, outputTokens: 1 } }; };
  await createBaiBudgetGateway(pool).runRequest(input, send);
  await createBaiBudgetGateway(pool).runRequest({ ...input, source: 'modelAnalysis' }, send);
  await assert.rejects(createBaiBudgetGateway(pool).runRequest({ ...input,
    source: 'openCognition' }, send), { code: 'MODEL_HOURLY_RATE_LIMITED' });
  assert.equal(sent, 2);
  assert.equal([...pool.calls.values()].filter((row) => row.requestBytes > 0).length, 2);
  assert.equal([...pool.deferred.values()][0].blockedCount, 1);
  await createBaiBudgetGateway(pool).runRequest({ ...input, agentId: 'agent-2' }, send);
  assert.equal(sent, 3);
});

test('global paid-call rate gate permits at most fifteen across residents', async () => {
  const pool = budgetPool();
  let sent = 0;
  const input = { source: 'openCognition', tier: 'haiku', model: 'gpt-6-luna',
    body: '{}', maxTokens: 100, timeoutMs: 5_000 };
  const send = async () => { sent += 1; return { usage: { inputTokens: 1,
    outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; };
  for (let index = 0; index < 15; index += 1) {
    await createBaiBudgetGateway(pool).runRequest({ ...input, agentId: `agent-${index}` }, send);
  }
  await assert.rejects(createBaiBudgetGateway(pool).runRequest({ ...input,
    agentId: 'agent-15' }, send), { code: 'MODEL_HOURLY_RATE_LIMITED' });
  assert.equal(sent, 15);
});

test('denied admissions never create provider-start telemetry or a historical backfill candidate', async () => {
  const events = [];
  const request = createCognitionModelRouter({ apiKey: 'test',
    catalog: { haiku: 'claude-haiku-4.5', sonnet: 'claude-sonnet-5.5',
      opus: 'claude-opus-4.5' },
    budgetGateway: { runRequest: async () => { throw Object.assign(new Error('budget'), {
      code: 'MODEL_DAILY_BUDGET_EXCEEDED' }); } },
    onCall: async (event) => events.push(event) });
  await assert.rejects(request({ tier: 'planning', trigger: 'plan_grounding',
    messages: [{ role: 'user', content: 'No provider call.' }] }),
  { code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
  assert.deepEqual(events, []);
});

test('backfill repairs fabricated historical costs and inserts unknown with zero row cost', async () => {
  const statements = [];
  const pool = { connect: async () => ({ release() {}, async query(sql, values = []) {
    statements.push({ sql, values });
    if (sql.includes('FROM world_agent_cognition_model_calls')) return { rows: [{
      id: 'history-id', world_id: 'world-id', agent_id: 'agent-id', tier: 'sonnet',
      model: 'claude-sonnet-5.5', trigger: 'scheduled', status: 'failed',
      failure_code: 'provider_request_failed', input_tokens: null, output_tokens: null,
      created_at: new Date(), completed_at: new Date() }] };
    if (sql.includes('FROM world_infrastructure_usage_events')) return { rows: [] };
    return { rows: [] };
  } }) };
  await backfillBaiBudgetHistory(pool);
  assert.ok(statements.some(({ sql }) => sql.includes('SET reserved_cost_nano_usd=0')));
  const insert = statements.find(({ sql }) => sql.includes('INSERT INTO bai_model_budget_calls'));
  assert.equal(insert.values[7], '0');
  assert.equal(insert.values[10], 'reservation');
  assert.equal(insert.values[11], 'provider_request_failed');
});
