import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { assertPlatformModelPrincipal } from '../src/agent-runtime/model-principal.js';
import { createBaiBudgetGateway } from '../src/agent-runtime/bai-budget.js';
import { initializeTypeSafeProvider, chooseWithTypeSafe, chooseCivilizationOption,
  chooseWorldV7Reflection, chooseEncounterDecision } from '../src/agent-runtime/typesafe.js';

const principal = { worldId: randomUUID(), agentId: randomUUID() };
function database(row, failure = null) {
  const statements = [];
  const query = async (sql) => {
    statements.push(sql);
    if (['BEGIN', 'ROLLBACK', 'COMMIT'].includes(sql)) return { rows: [] };
    if (failure) throw failure;
    assert.match(sql, /FROM agents a WHERE a.id=\$2::uuid/);
    return { rows: row ? [row] : [] };
  };
  return { query, statements, connect: async () => ({ query, release() {} }) };
}

test('model principal requires a known internal member; lookup errors fail closed', async () => {
  assert.deepEqual(await assertPlatformModelPrincipal(database({ external: false, member: true }), principal), principal);
  for (const row of [null, { external: false, member: false }, { member: true }]) {
    await assert.rejects(assertPlatformModelPrincipal(database(row), principal), { code: 'MODEL_PRINCIPAL_NOT_INTERNAL' });
  }
  await assert.rejects(assertPlatformModelPrincipal(database(null), {}), { code: 'MODEL_PRINCIPAL_REQUIRED' });
  await assert.rejects(assertPlatformModelPrincipal(database(null, new Error('connection lost')), principal),
    { code: 'MODEL_PRINCIPAL_UNAVAILABLE' });
});

test('B.AI rejects all external sources before budget, provider, or fallback; refusals do not poison gateway', async () => {
  const db = database({ external: true, member: true });
  const gateway = createBaiBudgetGateway(db);
  let sends = 0;
  for (const source of ['openCognition', 'memorySelection', 'modelAnalysis', 'currencyGenesisAuthoring']) {
    await assert.rejects(gateway.runRequest({ ...principal, external: false, source,
      model: 'claude-sonnet-5.5', tier: 'sonnet', body: '{}', maxTokens: 100, timeoutMs: 1_000 },
    async () => { sends += 1; }), { code: 'EXTERNAL_MODEL_CALL_FORBIDDEN' });
  }
  assert.equal(sends, 0);
  assert.equal(gateway.unsafe, false);
  assert.equal(db.statements.some((sql) => /budget_calls|budget_guard/.test(sql)), false);
});

test('all TypeSafe entrypoints refuse external residents before reserving or sending', async () => {
  const key = process.env.TYPESAFE_API_KEY;
  const original = TypeSafeClient.prototype.systemOne;
  let sends = 0;
  try {
    process.env.TYPESAFE_API_KEY = 'unit-test-no-network';
    TypeSafeClient.prototype.systemOne = async () => { sends += 1; throw new Error('must not send'); };
    initializeTypeSafeProvider({ db: database({ external: true, member: true }) });
    const runtime = {};
    const calls = [
      () => chooseWithTypeSafe({ worldId: principal.worldId, self: { agentId: principal.agentId } }, [{}, {}], runtime),
      () => chooseCivilizationOption({ ...principal, options: [{}, {}] }, runtime),
      () => chooseWorldV7Reflection({ ...principal, options: [{}, {}] }, runtime),
      () => chooseEncounterDecision(principal, runtime)
    ];
    for (const call of calls) await assert.rejects(call(), { code: 'EXTERNAL_MODEL_CALL_FORBIDDEN' });
    assert.equal(sends, 0);
    assert.deepEqual(runtime, {});
    // An admitted internal member still reaches the existing provider path.
    initializeTypeSafeProvider({ db: database({ external: false, member: true }) });
    TypeSafeClient.prototype.systemOne = async () => {
      sends += 1;
      return { answers: { civilization_choice: { choice: 'continue_design', confidence: 0.9 } },
        usage: { input_tokens: 10 } };
    };
    const result = await chooseCivilizationOption({ ...principal, choiceType: 'currency_genesis', options: [
      { id: 'continue_design', label: 'Continue' }, { id: 'propose_when_ready', label: 'Propose' }
    ] }, {}, { persistState: async () => {} });
    assert.equal(result.choice.id, 'continue_design');
    assert.equal(sends, 1);
  } finally {
    TypeSafeClient.prototype.systemOne = original;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
  }
});
