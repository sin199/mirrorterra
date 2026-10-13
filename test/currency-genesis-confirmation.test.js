import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GENESIS_CONFIRMATION_OPTIONS, reviewGenesisExplicitConfirmation,
  validateGenesisConfirmationRequest } from '../src/currency-genesis-confirmation.js';
import { confirmWorldTokenIssuance } from '../src/world-token-issuance.js';
import { inspectSyncTokenomicsSpecification, SYNC_GENESIS_ISSUER_AGENT_ID,
  TOKENOMICS_MANIFEST_HASH } from '../src/arc/sync-tokenomics.js';

const specification = { name: 'Local parser fixture', symbol: 'FIX', meaning: 'An isolated fixture.',
  purpose: 'Exercise confirmation without authoring.', rationale: 'Only the resident can choose confirmation.',
  decimals: 6, distribution: [], reserveAmount: '990000000', unallocatedSupplyHandling: 'protocol_managed_reserve',
  ownershipModel: 'erc20_holder_owned', authorityModel: 'immutable_protocol_rules' };
const hash = inspectSyncTokenomicsSpecification(specification).specificationHash;
const worldId = randomUUID(), intentId = randomUUID(), agentId = SYNC_GENESIS_ISSUER_AGENT_ID;
const body = () => ({ mode: 'confirmation_cognition', actionId: `confirmation-${randomUUID()}`,
  expectedSpecificationHash: hash, expectedManifestHash: TOKENOMICS_MANIFEST_HASH });

function fixture(overrides = {}) {
  const intent = { id: intentId, world_id: worldId, status: 'proposed', capability_generation: 1,
    proposer_agent_id: agentId, issuer_agent_id: agentId, issuer_selection_source: 'creator_genesis_assignment',
    ...specification, ownership_model: specification.ownershipModel, authority_model: specification.authorityModel,
    unallocated_supply_handling: specification.unallocatedSupplyHandling,
    metadata: { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH, agentSpecification: specification }, ...overrides };
  const queries = [], events = new Map();
  const result = (rows) => ({ rows, rowCount: rows.length });
  const client = { async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('SELECT 1 FROM world_members')) return result([{}]);
    if (sql.includes('SELECT * FROM arc_token_issuance_intents')) return result([intent]);
    if (sql.includes("event_type='currency_genesis.confirmation_review'")) return result(events.has(params[2]) ? [{ details: events.get(params[2]) }] : []);
    if (sql.includes('FROM world_genesis_issuer_assignments')) return result([{
      issuer_agent_id: agentId, issuerAgentId: agentId, issuerName: 'MirrorTerra-01',
      selection_source: 'creator_genesis_assignment', selectionSource: 'creator_genesis_assignment', capabilityGeneration: 1 }]);
    if (sql.includes('SELECT address FROM arc_agent_wallets')) return result([{ address: '0x1111111111111111111111111111111111111111' }]);
    if (sql.includes('SELECT * FROM arc_currency_genesis_requirements')) return result([{ world_id: worldId,
      status: 'ISSUER_SELECTED', capability_generation: 1 }]);
    if (sql.includes('member.energy,member.food')) return result([{ agentId, name: 'MirrorTerra-01',
      energy: 75, food: 70, social: 70, risk_tolerance: 0, risk_modifier: 0, curiosity: 0,
      ambition: 0.7, discipline: 0.5, skills: {}, goals: [], recentMemories: [] }]);
    if (sql.includes('SELECT name FROM agents')) return result([{ name: 'MirrorTerra-01' }]);
    if (sql.includes('INSERT INTO world_infrastructure_usage_events')) return result([{ id: randomUUID() }]);
    if (sql.includes('INSERT INTO world_v7_events')) {
      if (sql.includes("'currency_genesis.confirmation_review'")) events.set(params[5], JSON.parse(params[4]));
      return result([]);
    }
    if (/SELECT/.test(sql)) return result([]);
    throw new Error('Unexpected mutation: ' + sql);
  } };
  return { client, intent, queries, events };
}

test('confirmation request cannot contain a caller-selected decision or replacement fields', () => {
  validateGenesisConfirmationRequest(body());
  for (const extra of [{ decision: 'issue' }, { choice: 'confirm' }, { specification }, { agentId: randomUUID() }]) {
    assert.throws(() => validateGenesisConfirmationRequest({ ...body(), ...extra }), /TOKEN_CONFIRMATION_COGNITION_REQUIRED/);
  }
  assert.throws(() => validateGenesisConfirmationRequest({ ...body(), expectedManifestHash: `0x${'ab'.repeat(32)}` }),
    /TOKEN_CONFIRMATION_BINDING_INVALID/);
});

test('only a real offered confirm decision invokes confirmation with exact proposal and hashes', async () => {
  const f = fixture(); let confirmations = 0;
  const request = body();
  const result = await reviewGenesisExplicitConfirmation(f.client, { worldId, agentId, intentId, body: request,
    worldMinute: 100, chooseWithTypeSafe: async (review) => {
      assert.deepEqual(review.options.map((x) => x.id), ['confirm','revise','defer','reject']);
      assert.equal(review.agent.riskTolerance, 0);
      assert.equal(review.agent.curiosity, 0);
      assert.equal(review.state.currentProposal.specificationHash, hash);
      assert.equal(review.state.currentProposal.tokenomicsManifestHash, TOKENOMICS_MANIFEST_HASH);
      assert.equal(review.state.sessionBoundaries.authoringAllowed, false);
      return { choice: { id: 'confirm' }, confidence: 0.82, model: 'jev-1.13.0', inputTokens: 500 };
    }, confirmIssuance: async (client, args) => {
      confirmations += 1; assert.equal(client, f.client);
      assert.equal(args.intentId, intentId); assert.equal(args.agentId, agentId);
      assert.equal(args.decision, 'issue'); assert.equal(args.actionId, request.actionId);
      assert.equal(args.expectedSpecificationHash, hash); assert.equal(args.expectedManifestHash, TOKENOMICS_MANIFEST_HASH);
      return { confirmed: true, readyForExecution: false, outboxCreated: false };
    } });
  assert.equal(confirmations, 1); assert.equal(result.confirmed, true);
  assert.equal(result.readyForExecution, false); assert.equal(result.authoringInvoked, false);
  assert.equal(result.specificationChanged, false); assert.equal(result.mainnetWriteGate, false);
  assert.ok(f.queries[1].sql.endsWith('FOR UPDATE'));
});

test('revise, defer and reject preserve the decision and stop without changing proposal or authoring', async () => {
  for (const decision of ['revise','defer','reject']) {
    const f = fixture(); const before = JSON.stringify(f.intent); let attempted = false;
    const result = await reviewGenesisExplicitConfirmation(f.client, { worldId, agentId, intentId, body: body(),
      worldMinute: 100, chooseWithTypeSafe: async () => ({ choice: decision, confidence: 0.9 }),
      confirmIssuance: async () => { attempted = true; throw new Error('must not confirm'); } });
    assert.equal(result.decision, decision); assert.equal(result.confirmed, false);
    assert.equal(result.proposalStatus, 'proposed'); assert.equal(attempted, false);
    assert.equal(JSON.stringify(f.intent), before);
    assert.equal(f.events.size, 1);
    assert.equal(f.queries.some((x) => /^\s*(UPDATE|DELETE)\b/.test(x.sql)), false);
  }
});

test('failed provider, malformed choice and low confidence remain technical outcomes, never confirmation', async () => {
  for (const response of [null, { choice: 'issue', confidence: 1 }, { choice: 'confirm', confidence: 0.1 },
    { currencyReviewDiagnostic: { outcome: 'provider_timeout', reasonCode: 'provider_request_timeout', providerAttempted: true } }]) {
    const f = fixture();
    const result = await reviewGenesisExplicitConfirmation(f.client, { worldId, agentId, intentId, body: body(),
      worldMinute: 100, chooseWithTypeSafe: async () => response,
      confirmIssuance: async () => { throw new Error('must not confirm'); } });
    assert.equal(result.confirmed, false); assert.equal(result.decision, null);
    assert.notEqual(result.cognition.outcome, 'explicit_no_action');
    assert.equal(f.events.size, 1);
  }
});

test('changed hash, wrong issuer, wrong assignment or wallet fail before cognition', async () => {
  for (const overrides of [{ purpose: 'Changed specification.' }, { issuer_agent_id: randomUUID() },
    { issuer_selection_source: 'turnkey' }, { issuer_wallet: '0x2222222222222222222222222222222222222222' }]) {
    const f = fixture(overrides); let called = false;
    await assert.rejects(reviewGenesisExplicitConfirmation(f.client, { worldId, agentId, intentId, body: body(),
      worldMinute: 100, chooseWithTypeSafe: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('same authenticated action is idempotent and never asks TypeSafe twice', async () => {
  const f = fixture(); const request = body(); let called = 0;
  const args = { worldId, agentId, intentId, body: request, worldMinute: 100,
    chooseWithTypeSafe: async () => { called += 1; return { choice: 'defer', confidence: 0.9 }; } };
  const first = await reviewGenesisExplicitConfirmation(f.client, args);
  const second = await reviewGenesisExplicitConfirmation(f.client, args);
  assert.equal(called, 1); assert.deepEqual(second, { ...first, idempotent: true });
});

test('confirmation function rechecks exact specification hash under the existing row lock', async () => {
  const f = fixture({ purpose: 'Changed while preparing the decision.' });
  await assert.rejects(confirmWorldTokenIssuance(f.client, { worldId, agentId, intentId, decision: 'issue',
    actionId: body().actionId, worldMinute: 100, expectedSpecificationHash: hash,
    expectedManifestHash: TOKENOMICS_MANIFEST_HASH }), /TOKEN_CONFIRMATION_SPECIFICATION_CHANGED/);
  assert.equal(f.queries.some((x) => /^\s*(INSERT|UPDATE)\b/.test(x.sql)), false);
});

test('signed API route selects server cognition for manifest-bound Genesis; no transaction signing API exists in confirmation', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.post('/v1/worlds/:worldId/token-issuance/intents/:intentId/issuer-decision'"),
    server.indexOf("app.post('/v1/worlds/:worldId/tokens/:tokenId/decision'"));
  assert.match(route, /metadata\?\.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH/);
  assert.match(route, /return reviewGenesisExplicitConfirmation/);
  const implementation = await readFile(new URL('../src/currency-genesis-confirmation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(implementation, /authorAgentCurrencyProposal|signTransaction|sendRawTransaction|sendTransaction/);
  assert.deepEqual(GENESIS_CONFIRMATION_OPTIONS.map((x) => x.id), ['confirm','revise','defer','reject']);
});
