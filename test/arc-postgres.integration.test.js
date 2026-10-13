import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Interface, keccak256 } from 'ethers';
import { Pool } from 'pg';
import { foundWorldBusiness } from '../src/world-businesses.js';
import { startWorldEngine } from '../src/world-engine.js';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { prepareArcCapabilityProvenance } from '../src/arc/provenance.js';
import { prepareArcWorldCheckpoint } from '../src/arc/checkpoints.js';
import { indexTrackedUsdcTransfers } from '../src/arc/indexer.js';
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS } from '../src/arc/config.js';
import { ARC_AGENT_TOKEN_FACTORY_INTERFACE } from '../src/arc/token-issuance.js';
import { ManagedWalletArcInfrastructureSigner } from '../src/arc/wallet-provider.js';
import { ARC_SETTLEMENT_POLICY_INTERFACE, enqueueArcAgentEconomicAction } from '../src/arc/agent-economic-action.js';
import { ArcReadOnlyObserver } from '../src/arc/observer.js';
import { ArcSettlementOutboxWorker } from '../src/arc/settlement-worker.js';
import { ArcAgentTokenIssuanceWorker } from '../src/arc/token-issuance-worker.js';
import { currencyGenesisInfrastructureFacts } from '../src/arc/currency-genesis-context.js';
import { SYNC_GENESIS_ISSUER_AGENT_ID, SYNC_GENESIS_RESERVE, SYNC_TOKENOMICS_FIXED_FIELDS,
  TOKENOMICS_MANIFEST_HASH } from '../src/arc/sync-tokenomics.js';
import { advanceWorldCurrencyGenesis, confirmWorldTokenIssuance, listWorldTokenIssuance } from '../src/world-token-issuance.js';
import { authorAgentCurrencyProposal } from '../src/agent-runtime/currency-genesis-authoring.js';
import { chooseCivilizationOption } from '../src/agent-runtime/typesafe.js';
import { reserveArcMainnetPilotCost, releaseArcMainnetPilotCost,
  setArcMainnetPilotCostStatus } from '../src/arc/pilot-budget.js';
import { DeterministicFakeArcSigner, createIsolatedArcMainnetConfig } from './helpers/arc-mainnet-fakes.js';
import { fundTestResidents } from './helpers/economic-fixtures.js';
import { ARC_SETTLEMENT_INTERFACE, toArcBytes16Uuid } from '../src/arc/settlement.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTRACT = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
// The isolated database intentionally keeps generated test rows between runs.
// Use a fresh chain hash so a prior fake submission cannot collide with the
// production-shaped unique (chain_id, transaction_hash) constraint.
const HASH = `0x${randomBytes(32).toString('hex')}`;
const SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
const RUNTIME_CODE = '0x6001600055';
const RUNTIME_CODE_HASH = keccak256(RUNTIME_CODE);
const IDENTITY_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function usdc() view returns (address)'
]);
const TOKEN_INTERFACE = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]);
const ERC8004_INTERFACE = new Interface(['function ownerOf(uint256 tokenId) view returns (address)']);

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'Arc integration requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'Arc integration must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'Arc integration requires a *_test database');
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function fakeMainnetRpc({ worldId, config, identityOwner = PAYER }) {
  const calls = [];
  const rpc = {
    config,
    calls,
    async getChainId() { return ARC_MAINNET_CHAIN_ID; },
    async getBlockNumber() { return '0x1234'; },
    async getBlock() { return { number: '0x1234', baseFeePerGas: '0x4a817c800', transactions: [] }; },
    async getCode(address) { return address.toLowerCase() === CONTRACT.toLowerCase() ? RUNTIME_CODE : '0x6001'; },
    async getBalance() { return '0x3635c9adc5dea00000'; },
    async getTransactionCount() { return '0x0'; },
    async estimateGas() { return '0x5208'; },
    async maxPriorityFeePerGas() { return '0x0'; },
    async getTransactionReceipt() { return null; },
    async getLogs() { return []; },
    async health() { return { configured: true, chainId: ARC_MAINNET_CHAIN_ID,
      expectedChainId: ARC_MAINNET_CHAIN_ID, rpcHealthy: true, latestBlock: 0x1234,
      provider: 'isolated-deterministic-mainnet-fixture', latencyMs: 1, error: null }; },
    async call(transaction) {
      const selector = String(transaction.data || '').slice(0, 10).toLowerCase();
      calls.push(selector);
      if (transaction.to.toLowerCase() === ARC_MAINNET_USDC_ADDRESS.toLowerCase()) {
        if (selector === TOKEN_INTERFACE.getFunction('decimals').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('decimals', [6]);
        }
        if (selector === TOKEN_INTERFACE.getFunction('balanceOf').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('balanceOf', [1_000_000_000n]);
        }
        if (selector === TOKEN_INTERFACE.getFunction('allowance').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('allowance', [1_000_000_000n]);
        }
      }
      if (selector === IDENTITY_INTERFACE.getFunction('worldId').selector.toLowerCase()) {
        return IDENTITY_INTERFACE.encodeFunctionResult('worldId', [toArcBytes16Uuid(worldId)]);
      }
      if (selector === IDENTITY_INTERFACE.getFunction('usdc').selector.toLowerCase()) {
        return IDENTITY_INTERFACE.encodeFunctionResult('usdc', [ARC_MAINNET_USDC_ADDRESS]);
      }
      if (selector === ERC8004_INTERFACE.getFunction('ownerOf').selector.toLowerCase()) {
        return ERC8004_INTERFACE.encodeFunctionResult('ownerOf', [identityOwner]);
      }
      if (selector === ARC_AGENT_TOKEN_FACTORY_INTERFACE.getFunction('writer').selector.toLowerCase()) {
        return ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeFunctionResult('writer', [PAYER]);
      }
      if (selector === ARC_AGENT_TOKEN_FACTORY_INTERFACE.getFunction('maxTokenCreationsPerWorld').selector.toLowerCase()) {
        return ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeFunctionResult('maxTokenCreationsPerWorld', [1]);
      }
      if (selector === ARC_AGENT_TOKEN_FACTORY_INTERFACE.getFunction('creationCount').selector.toLowerCase()) {
        return ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeFunctionResult('creationCount', [0]);
      }
      if (selector === ARC_AGENT_TOKEN_FACTORY_INTERFACE.getFunction('tokenForIssuance').selector.toLowerCase()) {
        return ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeFunctionResult('tokenForIssuance',
          ['0x0000000000000000000000000000000000000000']);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('spendingPolicies').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('spendingPolicies',
          [100_000_000n, 500_000_000n, 0n, 0, true, false]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('allowedActionFamilies').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('allowedActionFamilies', [true]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('completedActions').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('completedActions', [false]);
      }
      throw new Error(`Unexpected isolated Arc eth_call selector: ${selector}`);
    }
  };
  return rpc;
}

test('Arc Mainnet Agent action reaches persistent outbox, policy evaluation, and fake signer on isolated PostgreSQL', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const payerId = SYNC_GENESIS_ISSUER_AGENT_ID;
  const recipientId = randomUUID();
  const rootCapabilityId = randomUUID();
  const childCapabilityId = randomUUID();
  const txHash = HASH;
  const nowMs = Date.now();
  let engineNowMs = nowMs;
  let engine = null;
  let worker = null;
  let tokenWorker = null;
  try {
    await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });
    await pool.query('DELETE FROM arc_mainnet_pilot_cost_reservations');
    await pool.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
      reserved_usdc_base_units=0 WHERE id=1`);
    await pool.query('DELETE FROM arc_nonce_reservations');
    await pool.query('DELETE FROM arc_nonce_cursors');
    await pool.query('DELETE FROM arc_infrastructure_nonce_reservations');
    await pool.query('DELETE FROM arc_infrastructure_nonce_cursors');
    await pool.query(`INSERT INTO agents(id,name,public_key) VALUES($1,'MirrorTerra-01',$2)
      ON CONFLICT (id) DO NOTHING`, [payerId, `arc-mainnet-test-${payerId}`]);
    const issuerFixture = await pool.query('SELECT name,public_key FROM agents WHERE id=$1', [payerId]);
    assert.deepEqual(issuerFixture.rows[0], { name: 'MirrorTerra-01', public_key: `arc-mainnet-test-${payerId}` },
      'the isolated fixture must use the canonical issuer UUID without modifying a pre-existing non-test agent');
    await pool.query(`INSERT INTO agents(id,name,public_key)
      VALUES($1,'Arc Mainnet Test Resident B',$2)`, [recipientId, `arc-mainnet-test-${recipientId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id)
      VALUES($1,$2,'Arc Mainnet isolated integration world',$3)`, [worldId, payerId, ARC_MAINNET_CHAIN_ID]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location)
      VALUES($1,$2,'owner','town-square'),($1,$3,'resident','town-square')`, [worldId, payerId, recipientId]);
    await pool.query(`INSERT INTO world_genesis_issuer_assignments(world_id,capability_generation,issuer_agent_id,
        selection_source,assigned_world_minute)
      VALUES($1,1,$2,'creator_genesis_assignment',1000)`, [worldId, payerId]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,3000,$2,$2)`, [worldId, new Date(nowMs - 2_000)]);
    await pool.query(`INSERT INTO world_epochs(world_id,epoch_code,name,status,started_world_minute,description)
      VALUES($1,'V7','V7 isolated Arc integration epoch','active',1000,'Mainnet-only fake-provider integration')`, [worldId]);
    await pool.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,status,
        version,parent_capability_id,creator_type,creator_agent_id,specification,created_world_minute,adopted_world_minute)
      VALUES($1,$3,'arc-mainnet-test-root','coordination','Arc root capability','Developer seeded test capability','active',1,NULL,
        'system',NULL,'{"steps":["observe"]}'::jsonb,100,100),
        ($2,$3,'arc-mainnet-test-child','coordination','Arc child capability','Resident created test capability','active',1,$1,
        'resident',$4,'{"steps":["observe","share"]}'::jsonb,200,250)`,
    [rootCapabilityId, childCapabilityId, worldId, payerId]);
    await pool.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,next_decision_at)
      VALUES($1,$2,'balanced',0.5,$3),($1,$4,'balanced',0.5,$3)`, [worldId, payerId, new Date(nowMs + 86_400_000), recipientId]);

    await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,current_goal)
      VALUES($1,$2,'scholar','coordinate a research exchange with peers'),
        ($1,$3,'maker','support useful research services')`, [worldId, payerId, recipientId]);
    await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        consolidation_key,long_term)
      VALUES($1,$2,'economy','A peer could not record the value of shared research.',0.8,2990,'test-currency-memory',true)`,
    [worldId, payerId]);
    await pool.query(`INSERT INTO arc_agent_wallets(world_id,agent_id,chain_id,address,provider,account_type,status,
        external_identity_id)
      VALUES($1,$2,$3,$4,'external_kms','eoa','active',818),($1,$5,$3,$6,'external_kms','eoa','active',819)`,
    [worldId, payerId, ARC_MAINNET_CHAIN_ID, PAYER, recipientId, RECIPIENT]);

    const config = createIsolatedArcMainnetConfig({ ARC_SETTLEMENT_RUNTIME_CODE_HASH: RUNTIME_CODE_HASH });
    const rpcClient = fakeMainnetRpc({ worldId, config });

    let allowProposal = false;
    let allowIssuerDecision = false;
    let completeContinueDesign = false;
    let authoringFailureOverride = null;
    let emptyAuthoringOverride = false;
    let invalidTokenomicsOverride = false;
    let authoringReplySequence = null;
    const authoringEnv = { BAI_API_KEY: 'isolated-test-bai-key', CURRENCY_GENESIS_AUTHORING_PROVIDER: 'bai',
      CURRENCY_GENESIS_AUTHORING_MODEL: 'gpt-6-luna', BAI_API_BASE_URL: 'https://api.b.ai/v1' };
    let responseRecorded = false;
    const authoringContextsObserved = [];
    let reviewOutcomeOverride = null;
    const cognitionChoices = [];
    const cognitionFacts = new Map();
    engine = await startWorldEngine(pool, { worldId, nowProvider: () => engineNowMs, schedule: false,
      currencyGenesisEnabled: true,
      onError: () => true,
      chooseCivilizationOption: async (request) => {
        if (request.choiceType !== 'currency_genesis') return null;
        cognitionFacts.set(request.agentId, request.state.worldFacts);
        if (reviewOutcomeOverride) {
          if (reviewOutcomeOverride.type === 'throw') throw reviewOutcomeOverride.error;
          return reviewOutcomeOverride.value;
        }
        for (const [key, value] of Object.entries(currencyGenesisInfrastructureFacts({
          requirement: { status: request.state.requirementStatus },
          issuerAssignment: { issuerAgentId: SYNC_GENESIS_ISSUER_AGENT_ID, issuerName: 'MirrorTerra-01', capabilityGeneration: 1,
            selectionSource: 'creator_genesis_assignment' } }))) {
          assert.equal(request.state.worldFacts[key], value);
        }
        assert.equal(request.state.worldFacts.genesisIssuer, 'MirrorTerra-01');
        assert.equal(request.state.worldFacts.issuerSelectionSource, 'creator_genesis_assignment');
        assert.equal(request.state.worldFacts.totalHumanReadableSupply, '1000000000');
        const options = request.options || [];
        const choose = options.find((option) => option.id === 'continue_design');
        let selected = choose;
        if (allowProposal && request.agentId === payerId
            && options.some((option) => option.id === 'propose_when_ready')
            && !request.state.currentProposal) {
          selected = options.find((option) => option.id === 'propose_when_ready');
        } else if (allowProposal && request.agentId === recipientId
            && options.some((option) => option.id.startsWith('response:') && option.id.endsWith(':support'))) {
          selected = options.find((option) => option.id.startsWith('response:') && option.id.endsWith(':support'));
          responseRecorded = true;
        } else if (allowProposal && allowIssuerDecision && responseRecorded && request.agentId === payerId) {
          selected = options.find((option) => option.id === `issuer:${request.state.currentProposal?.id}:issue`)
            || options.find((option) => option.id.startsWith('issuer:') && option.id.endsWith(':issue'))
            || choose;
        }
        if (selected) cognitionChoices.push({ agentId: request.agentId, choice: selected.id });
        return selected ? { choice: { id: selected.id }, confidence: 0.99,
          provider: 'isolated-resident-cognition', model: 'isolated-resident-cognition' } : null;
      },
      authorCurrencyProposal: async (input, authoringOptions = {}) => {
        assert.strictEqual(input.worldFacts, cognitionFacts.get(input.resident.agentId),
          'cognition and authoring receive the very same world facts object');
        const observed = { agentId: input.resident.agentId, currentGoal: input.resident.currentGoal,
          goalCount: input.resident.goals.length, memories: input.resident.recentMemories.map((memory) => memory.summary),
          requirementStatus: input.worldFacts.requirementStatus,
          recipientCount: input.availableRecipients.length, currentDesignDraft: input.currentDesignDraft,
          completionMode: authoringOptions.completionMode || 'partial' };
        authoringContextsObserved.push(observed);
        assert.ok(input.resident.agentId === payerId || input.resident.agentId === recipientId);
        assert.ok(input.resident.goals.length > 0, 'authoring receives this resident\'s active goals');
        assert.equal(input.worldFacts.requirementStatus, 'UNRESOLVED');
        const proposer = input.availableRecipients.find((recipient) => recipient.id === payerId);
        const peer = input.availableRecipients.find((recipient) => recipient.id === recipientId);
        assert.ok(proposer && peer, 'the resident receives real recipient options from the isolated world');
        if (authoringFailureOverride && input.resident.agentId === payerId) {
          return { specification: null, reason: authoringFailureOverride, provider: 'bai', model: 'gpt-6-luna',
            providerAttempted: true, callId: randomUUID(), usage: { inputTokens: 24, cachedInputTokens: 0, outputTokens: 0,
              totalTokens: 24, latencyMs: 2, providerReportedCostUsd: null } };
        }
        if ((allowProposal || completeContinueDesign || invalidTokenomicsOverride) && input.resident.agentId === payerId) {
          assert.equal(input.resident.currentGoal, 'coordinate a research exchange with peers');
          assert.ok(input.resident.recentMemories.some((memory) =>
            memory.summary === 'A peer could not record the value of shared research.'),
          'authoring receives this resident\'s own memory');
          if (input.currentDesignDraft) assert.equal(input.currentDesignDraft.specification?.purpose,
            input.resident.currentGoal, 'the prior resident-owned draft is available on the next design review');
        }
        const scriptedSpecification = input.resident.agentId === payerId && authoringReplySequence?.length
          ? authoringReplySequence.shift() : null;
        const specification = scriptedSpecification || (emptyAuthoringOverride && input.resident.agentId === payerId
          ? Object.fromEntries(['name','symbol','meaning','purpose','rationale','decimals','distribution','reserveAmount',
            'unallocatedSupplyHandling','ownershipModel','authorityModel'].map((field) => [field, null]))
          : (allowProposal || completeContinueDesign || invalidTokenomicsOverride) && input.resident.agentId === payerId ? {
            name: 'Research Exchange', symbol: 'REX',
            meaning: `A value record for ${input.resident.currentGoal}.`,
            purpose: input.resident.currentGoal,
            rationale: input.resident.recentMemories[0].summary,
            decimals: invalidTokenomicsOverride ? 5 : SYNC_TOKENOMICS_FIXED_FIELDS.decimals,
            distribution: [],
            reserveAmount: SYNC_GENESIS_RESERVE.toString(),
            unallocatedSupplyHandling: SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling,
            ownershipModel: SYNC_TOKENOMICS_FIXED_FIELDS.ownershipModel,
            authorityModel: SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel
          } : { purpose: input.resident.currentGoal || 'A resident-owned unresolved draft.' });
        const structuredSpecification = { name: null, symbol: null, meaning: null, purpose: null, rationale: null,
          decimals: null, distribution: null, reserveAmount: null, unallocatedSupplyHandling: null,
          ownershipModel: null, authorityModel: null, ...specification };
        return authorAgentCurrencyProposal(input, { ...authoringOptions, env: authoringEnv,
          fetchImpl: async (url, options) => {
          assert.equal(url, 'https://api.b.ai/v1/chat/completions');
          const body = JSON.parse(options.body);
          assert.equal(body.model, 'gpt-6-luna');
          assert.equal(body.response_format.type, 'json_schema');
          assert.equal(body.response_format.json_schema.strict, true);
          if (authoringOptions.repair) assert.match(body.messages[1].content,
            /Return only the canonical specification object/);
          else assert.match(body.messages[1].content, /Return exactly .*canonical (?:SYNC )?token specification/);
          return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'gpt-6-luna',
            choices: [{ message: { content: JSON.stringify(structuredSpecification) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 24, prompt_tokens_details: { cached_tokens: 0 },
              completion_tokens: 18, total_tokens: 42 } }) };
        } });
      },
      onAutonomousBusinessAction: enqueueArcAgentEconomicAction, emergencySink: { write() {} } });
    assert.equal(engine.running, true);
    await inTransaction(pool, (client) => fundTestResidents(client, { worldId, agentIds: [payerId, recipientId] }));
    await pool.query(`UPDATE world_agent_states SET next_decision_at=$3 WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`,
      [worldId, [payerId, recipientId], new Date(nowMs + 86_400_000)]);

    const runCurrencyReview = async () => {
      await pool.query(`UPDATE world_agent_states SET next_civilization_review_world_minutes=0
        WHERE world_id=$1`, [worldId]);
      const before = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
      engineNowMs += 60_000;
      await engine.tickOnce();
      const after = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
      assert.ok(Number(after.rows[0].world_minutes) > Number(before.rows[0].world_minutes),
        `isolated engine tick did not advance: ${JSON.stringify(engine.getLiveness())}`);
    };
    const runTransactionalGenesisAuthoring = async ({ minuteOffset, responses, expectedStatus }) => {
      const client = await pool.connect();
      const latestMinute = Number((await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`,
        [worldId])).rows[0].world_minutes);
      const worldMinute = latestMinute + minuteOffset;
      let responseIndex = 0;
      try {
        await client.query('BEGIN');
        const draftsBefore = Number((await client.query(`SELECT count(*)::int AS count FROM world_v7_events
          WHERE world_id=$1 AND actor_agent_id=$2 AND event_type='currency_genesis.design_draft'`,
        [worldId, payerId])).rows[0].count);
        const result = await advanceWorldCurrencyGenesis(client, {
          worldId,
          agent: { agentId: payerId, currentGoal: 'coordinate a research exchange with peers',
            primaryGoal: 'coordinate a research exchange with peers',
            goals: [{ category: 'cooperation', description: 'Share research notes', priority: 0.8, status: 'active' }],
            recentMemories: [{ memoryType: 'economy', summary: 'A peer could not record the value of shared research.',
              worldMinutes: latestMinute - 1 }], energy: 0.8, food: 0.8, social: 0.7, knowledge: 0.9,
            traits: { curiosity: 0.8 }, skills: { research: 0.9 } },
          worldMinute,
          chooseWithTypeSafe: async ({ state }) => {
            assert.equal(state.worldFacts.mainnetWriteGate, false);
            return { choice: { id: 'continue_design' }, confidence: 0.99,
              provider: 'isolated-resident-cognition', model: 'isolated-resident-cognition' };
          },
          authorProposal: (input, options = {}) => authorAgentCurrencyProposal(input, { ...options,
            env: authoringEnv, fetchImpl: async (_url, request) => {
              assert.ok(responseIndex < responses.length, 'each bounded attempt has one queued fixture response');
              const specification = responses[responseIndex++];
              const body = JSON.parse(request.body);
              assert.equal(body.model, 'gpt-6-luna');
              assert.equal(body.response_format.type, 'json_schema');
              assert.equal(body.response_format.json_schema.strict, true);
              if (options.repair) assert.match(body.messages[1].content, /This is your own previous design/);
              return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'gpt-6-luna',
                choices: [{ message: { content: JSON.stringify(specification) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 30 + responseIndex, prompt_tokens_details: { cached_tokens: 2 },
                  completion_tokens: 20, total_tokens: 50 + responseIndex } }) };
            } })
        });
        assert.equal(responseIndex, responses.length, 'the authoring loop stops at the first valid response or its bound');
        assert.equal(result.status, expectedStatus);
        const outcomeResult = await client.query(`SELECT details FROM world_v7_events WHERE world_id=$1
          AND actor_agent_id=$2 AND event_type='currency_genesis.authoring_outcome' AND world_minute=$3`,
        [worldId, payerId, worldMinute]);
        assert.equal(outcomeResult.rowCount, 1);
        const outcome = outcomeResult.rows[0].details;
        assert.equal(outcome.authoringAttemptCount, responses.length);
        assert.equal(outcome.providerAttemptCount, responses.length);
        assert.equal(outcome.provider, 'bai');
        assert.equal(outcome.model, 'gpt-6-luna');
        const attemptCallIds = outcome.attempts.map((attempt) => attempt.callId);
        assert.ok(attemptCallIds.every((callId) => /^[0-9a-f-]{36}$/i.test(callId)));
        assert.deepEqual(outcome.providerCallIds, attemptCallIds);
        const usage = await client.query(`SELECT provider,model,metadata FROM world_infrastructure_usage_events
          WHERE world_id=$1 AND agent_id=$2 AND metadata->>'cognitionType'='currency_genesis_authoring'
            AND metadata->>'callId'=ANY($3::text[]) ORDER BY metadata->>'attempt'`,
        [worldId, payerId, attemptCallIds]);
        assert.equal(usage.rowCount, responses.length, 'each real fake-provider call is metered separately');
        assert.ok(usage.rows.every((row) => row.provider === 'bai' && row.model === 'gpt-6-luna'
          && row.metadata.providerAttempted === true && row.metadata.inputTokens > 0
          && row.metadata.outputTokens === 20 && row.metadata.cachedInputTokens === 2));
        if (expectedStatus === 'AUTHORING_INVALID_NO_PROGRESS') {
          assert.equal(outcome.reasonCode, 'authoring_invalid_no_progress');
          assert.ok(outcome.attempts.every((attempt) => attempt.validationDiagnostics.length > 0));
          assert.ok(outcome.attempts.every((attempt) => attempt.invalidCandidate));
          assert.equal(Number((await client.query(`SELECT count(*)::int AS count FROM world_v7_events
            WHERE world_id=$1 AND actor_agent_id=$2 AND event_type='currency_genesis.design_draft'`,
          [worldId, payerId])).rows[0].count), draftsBefore, 'invalid candidates never become design drafts');
          assert.equal(Number((await client.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents
            WHERE world_id=$1`, [worldId])).rows[0].count), 0, 'invalid candidates never create proposals or intents');
        } else {
          const intent = await client.query(`SELECT id,status,specification_hash FROM arc_token_issuance_intents
            WHERE world_id=$1 AND created_world_minute=$2`, [worldId, worldMinute]);
          assert.equal(intent.rowCount, 1);
          assert.equal(intent.rows[0].status, 'proposed');
          assert.equal(intent.rows[0].specification_hash, null);
          assert.equal(Number((await client.query(`SELECT count(*)::int AS count FROM arc_token_issuance_decisions
            WHERE world_id=$1 AND intent_id=$2`, [worldId, intent.rows[0].id])).rows[0].count), 0,
          'a complete repaired specification is proposed without confirmation');
          assert.equal(Number((await client.query(`SELECT count(*)::int AS count FROM arc_agent_tokens
            WHERE world_id=$1`, [worldId])).rows[0].count), 0);
          assert.equal(Number((await client.query(`SELECT count(*)::int AS count FROM arc_genesis_token_settlement_outbox
            WHERE world_id=$1`, [worldId])).rows[0].count), 0);
        }
        return { result, outcome };
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    };
    await runCurrencyReview();
    let requirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    assert.equal(requirement.rows[0].status, 'UNRESOLVED', 'a no-action cognition choice keeps the persistent requirement alive');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'no proposal is created before a resident chooses one');
    let outcomeEvents = await pool.query(`SELECT actor_agent_id,world_minute,action_id,details FROM world_v7_events
      WHERE world_id=$1 AND event_type='currency_genesis.review_outcome' AND details->>'outcome'='explicit_continue_design'`, [worldId]);
    assert.equal(outcomeEvents.rowCount, 2, 'each resident review records that mandatory design remains open');
    assert.ok(outcomeEvents.rows.every((row) => row.details.reasonCode === 'offered_choice_selected'
      && row.details.provider === 'isolated-resident-cognition' && row.details.confidence === 0.99));
    const attributedInference = await pool.query(`SELECT action_id,attribution_type,agent_id,resource_category,provider,model,
        quantity_raw::text AS quantity_raw,unit,cost_status,cost_currency,cost_microunits::text AS cost_microunits,metadata
      FROM world_infrastructure_usage_events WHERE world_id=$1 ORDER BY agent_id`, [worldId]);
    const reviewUsage = attributedInference.rows.filter((row) => row.provider === 'isolated-resident-cognition');
    const authoringUsage = attributedInference.rows.filter((row) => row.provider === 'bai');
    assert.equal(reviewUsage.length, 2, 'each actual review provider request emits one attributable usage record');
    assert.ok(reviewUsage.every((row) => row.attribution_type === 'agent'
      && row.agent_id && row.resource_category === 'ai_inference'
      && row.provider === 'isolated-resident-cognition' && row.model === 'isolated-resident-cognition'
      && row.quantity_raw === '1' && row.unit === 'provider_request_attempt'
      && row.cost_status === 'unpriced' && row.cost_currency === null && row.cost_microunits === null
      && row.metadata.outcome === 'explicit_continue_design'));
    assert.equal(authoringUsage.length, 4,
      'the issuer initial call plus two repairs and the other resident draft are each attributable');
    assert.ok(authoringUsage.every((row) => row.attribution_type === 'agent' && row.agent_id
      && row.resource_category === 'ai_inference' && row.model === 'gpt-6-luna'
      && row.quantity_raw === '1' && row.unit === 'provider_request'
      && row.cost_status === 'unpriced' && row.cost_currency === null && row.cost_microunits === null
      && row.metadata.cognitionType === 'currency_genesis_authoring'
      && /^[0-9a-f-]{36}$/i.test(row.metadata.callId)
      && row.metadata.inputTokens === 24 && row.metadata.cachedInputTokens === 0
      && row.metadata.outputTokens === 18 && row.metadata.totalTokens === 42
      && Number.isSafeInteger(row.metadata.latencyMs)));
    assert.equal(authoringUsage.filter((row) => row.agent_id === payerId).length, 3,
      'an invalid mandatory design receives exactly two bounded repairs');
    assert.equal(authoringUsage.filter((row) => row.agent_id === recipientId).length, 1,
      'non-issuer partial authoring is unchanged');
    const initialDrafts = await pool.query(`SELECT actor_agent_id,details FROM world_v7_events WHERE world_id=$1
      AND event_type='currency_genesis.design_draft' ORDER BY actor_agent_id`, [worldId]);
    assert.equal(initialDrafts.rowCount, 1,
      'partial non-issuer work is persisted while mandatory issuer completion rejects partial output');
    assert.equal(initialDrafts.rows[0].actor_agent_id, recipientId);
    assert.ok(initialDrafts.rows[0].details.specification.purpose
      && initialDrafts.rows[0].details.incompleteFields.includes('name')
      && initialDrafts.rows[0].details.incompleteFields.includes('distribution')
      && initialDrafts.rows[0].details.authoring.provider === 'bai'
      && initialDrafts.rows[0].details.authoring.model === 'gpt-6-luna');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'partial drafts do not create proposal or intent rows');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_infrastructure_fee_policies
      WHERE world_id=$1`, [worldId])).rows[0].count), 0,
    'the infrastructure metering path does not configure an operator fee or Agent tax');

    const assertLatestReviewOutcome = async (expected) => {
      const latest = await pool.query(`SELECT world_minute FROM world_v7_events WHERE world_id=$1
        AND event_type='currency_genesis.review_outcome' ORDER BY world_minute DESC,created_at DESC LIMIT 1`, [worldId]);
      const events = await pool.query(`SELECT details->>'outcome' AS outcome FROM world_v7_events
        WHERE world_id=$1 AND event_type='currency_genesis.review_outcome' AND world_minute=$2`,
      [worldId, latest.rows[0].world_minute]);
      assert.equal(events.rowCount, 2);
      assert.ok(events.rows.every((row) => row.outcome === expected),
        `expected ${expected} outcomes, got ${JSON.stringify(events.rows)}`);
    };
    const runReviewFailure = async (override, expectedOutcome) => {
      const issuerAuthoringCountBefore = authoringContextsObserved.filter((context) => context.agentId === payerId).length;
      reviewOutcomeOverride = override;
      await runCurrencyReview();
      reviewOutcomeOverride = null;
      assert.equal(authoringContextsObserved.filter((context) => context.agentId === payerId).length,
        issuerAuthoringCountBefore + 3,
      `${expectedOutcome} TypeSafe result does not gate the issuer's initial authoring call and two repairs`);
      await assertLatestReviewOutcome(expectedOutcome);
      const currentRequirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
      assert.equal(currentRequirement.rows[0].status, 'UNRESOLVED', 'outcome diagnostics do not advance requirement state');
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
        [worldId])).rows[0].count), 0, 'outcome diagnostics do not create a proposal');
    };
    await runReviewFailure({ type: 'throw', error: Object.assign(new Error('timed out'), { name: 'APITimeoutError' }) },
      'provider_timeout');
    await runReviewFailure({ type: 'return', value: {} }, 'malformed_output');
    await runReviewFailure({ type: 'return', value: { choice: { id: 'continue_design' }, confidence: 0.1,
      model: 'isolated-resident-cognition', provider: 'isolated-resident-cognition' } }, 'low_confidence');
    await runReviewFailure({ type: 'throw', error: new Error('simulated provider error') }, 'provider_error');
    await runReviewFailure({ type: 'return', value: { choice: { id: 'not-an-offered-option' }, confidence: 0.99,
      model: 'isolated-resident-cognition', provider: 'isolated-resident-cognition' } }, 'invalid_choice');
    await runReviewFailure({ type: 'return', value: null }, 'no_valid_decision');

    reviewOutcomeOverride = null;
    const payerDraftCountBeforeAuthoringFailures = Number((await pool.query(`SELECT count(*)::int AS count
      FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
        AND event_type='currency_genesis.design_draft'`, [worldId, payerId])).rows[0].count);
    for (const [reason, expectedOutcome] of [
      ['bai_authoring_unavailable', 'provider_unavailable'],
      ['bai_authoring_timeout', 'provider_timeout'],
      ['bai_authoring_http_503', 'provider_unavailable'],
      ['bai_authoring_specification_invalid', 'malformed_output']
    ]) {
      authoringFailureOverride = reason;
      await runCurrencyReview();
      authoringFailureOverride = null;
      const latest = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
        AND event_type='currency_genesis.authoring_outcome'
        ORDER BY world_minute DESC,created_at DESC LIMIT 1`, [worldId, payerId]);
      assert.equal(latest.rows[0].details.outcome, expectedOutcome);
      assert.equal(latest.rows[0].details.reasonCode, reason);
      assert.equal(latest.rows[0].details.model, 'gpt-6-luna');
      assert.equal(latest.rows[0].details.provider, 'bai');
      assert.equal(latest.rows[0].details.providerAttempted, true);
      const payerDraftCount = Number((await pool.query(`SELECT count(*)::int AS count
        FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
          AND event_type='currency_genesis.design_draft'`, [worldId, payerId])).rows[0].count);
      assert.equal(payerDraftCount, payerDraftCountBeforeAuthoringFailures,
        'provider failure does not create a blank or synthetic Agent design draft');
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
        [worldId])).rows[0].count), 0, 'authoring failures do not create an issuance intent');
    }
    authoringFailureOverride = null;

    const validHistoricalDraftMinute = Number((await pool.query(`SELECT world_minutes FROM world_runtime_state
      WHERE world_id=$1`, [worldId])).rows[0].world_minutes) - 2;
    await pool.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
        world_minute,details,action_id) VALUES
      ($1,$2,'currency_genesis.design_draft','currency_genesis_design_draft',$1,$3,$4::jsonb,$5),
      ($1,$2,'currency_genesis.design_draft','currency_genesis_design_draft',$1,$6,$7::jsonb,$8)`,
    [worldId, payerId, validHistoricalDraftMinute,
      JSON.stringify({ specification: { name: 'Research Exchange', symbol: 'REX',
        meaning: 'A record for exchanging research contributions.',
        purpose: 'coordinate a research exchange with peers',
        rationale: 'A peer could not record the value of shared research.',
        decimals: SYNC_TOKENOMICS_FIXED_FIELDS.decimals, distribution: [],
        reserveAmount: SYNC_GENESIS_RESERVE.toString(),
        unallocatedSupplyHandling: SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling,
        ownershipModel: SYNC_TOKENOMICS_FIXED_FIELDS.ownershipModel,
        authorityModel: SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel }, incompleteFields: [],
        authoring: { provider: 'bai', model: 'gpt-6-luna', status: 'expressed',
          tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } }),
      `legacy-valid-draft-${payerId}`, validHistoricalDraftMinute + 1,
      JSON.stringify({ specification: {}, incompleteFields: ['name','symbol','distribution'],
        authoring: { provider: 'bai', model: 'gpt-6-luna', status: 'incomplete' } }),
      `legacy-empty-draft-${payerId}`]);

    const payerDraftCountBeforeNoFields = Number((await pool.query(`SELECT count(*)::int AS count
      FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
        AND event_type='currency_genesis.design_draft'`, [worldId, payerId])).rows[0].count);
    emptyAuthoringOverride = true;
    await runCurrencyReview();
    emptyAuthoringOverride = false;
    const noFieldsOutcome = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
      AND event_type='currency_genesis.authoring_outcome'
      ORDER BY world_minute DESC,created_at DESC LIMIT 1`, [worldId, payerId]);
    assert.equal(noFieldsOutcome.rows[0].details.outcome, 'invalid_no_progress');
    assert.equal(noFieldsOutcome.rows[0].details.reasonCode, 'authoring_invalid_no_progress');
    assert.equal(noFieldsOutcome.rows[0].details.providerAttempted, true);
    assert.equal(noFieldsOutcome.rows[0].details.validationCode, 'field_not_concrete');
    assert.equal(noFieldsOutcome.rows[0].details.authoringAttemptCount, 3,
      'a still-empty issuer response stops after the initial call and two repairs');
    assert.equal(noFieldsOutcome.rows[0].details.attempts[0].validationDiagnostics[0].field, 'name');
    const noFieldsContext = authoringContextsObserved.filter((context) => context.agentId === payerId).at(-1);
    assert.equal(noFieldsContext.currentDesignDraft.specification.purpose,
      'coordinate a research exchange with peers', 'a historical empty draft does not hide the latest valid design');
    const payerDraftCountAfterNoFields = Number((await pool.query(`SELECT count(*)::int AS count
      FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
        AND event_type='currency_genesis.design_draft'`, [worldId, payerId])).rows[0].count);
    assert.equal(payerDraftCountAfterNoFields, payerDraftCountBeforeNoFields,
      'an empty but structurally valid provider response does not create a fake design draft');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'an empty provider response does not create an issuance intent');

    invalidTokenomicsOverride = true;
    await runCurrencyReview();
    invalidTokenomicsOverride = false;
    const invalidEconomicsOutcome = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
      AND event_type='currency_genesis.authoring_outcome'
      ORDER BY world_minute DESC,created_at DESC LIMIT 1`, [worldId, payerId]);
    assert.equal(invalidEconomicsOutcome.rows[0].details.outcome, 'invalid_no_progress');
    assert.equal(invalidEconomicsOutcome.rows[0].details.reasonCode, 'authoring_invalid_no_progress');
    assert.equal(invalidEconomicsOutcome.rows[0].details.validationCode, 'tokenomics_fixed_field_mismatch');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'an invalid supply split cannot create a proposal or intent');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.design_draft'`, [worldId, payerId])).rows[0].count),
    payerDraftCountBeforeNoFields, 'an economically invalid complete response is not saved as a draft');

    const completeRepairCandidate = { name: 'Research Exchange', symbol: 'REX',
      meaning: 'A value record for shared research.', purpose: 'coordinate a research exchange with peers',
      rationale: 'A peer could not record the value of shared research.',
      decimals: SYNC_TOKENOMICS_FIXED_FIELDS.decimals, distribution: [],
      reserveAmount: SYNC_GENESIS_RESERVE.toString(),
      unallocatedSupplyHandling: SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling,
      ownershipModel: SYNC_TOKENOMICS_FIXED_FIELDS.ownershipModel,
      authorityModel: SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel };
    const wrongReserveCandidate = { ...completeRepairCandidate, reserveAmount: '989999999' };
    const badDecimalsCandidate = { ...completeRepairCandidate, decimals: 5 };
    const badAuthorityCandidate = { ...completeRepairCandidate, authorityModel: 'issuer_controlled_reserve' };
    const allNullCandidate = Object.fromEntries(Object.keys(completeRepairCandidate).map((field) => [field, null]));
    allNullCandidate.apiKey = 'sk-isolated-secret-sentinel-that-must-not-persist';

    const twoRepairResult = await runTransactionalGenesisAuthoring({ minuteOffset: 101,
      responses: [wrongReserveCandidate, badDecimalsCandidate, completeRepairCandidate], expectedStatus: 'PROPOSAL_FORMED' });
    assert.equal(twoRepairResult.outcome.outcome, 'expressed');
    assert.deepEqual(twoRepairResult.outcome.attempts.map((attempt) => attempt.reasonCode),
      ['authoring_invalid_no_progress', 'authoring_invalid_no_progress', null]);
    assert.equal(twoRepairResult.outcome.attempts[0].validationDiagnostics[0].code,
      'tokenomics_fixed_field_mismatch');
    assert.equal(twoRepairResult.outcome.attempts[0].validationDiagnostics[0].field, 'reserveAmount');
    assert.equal(twoRepairResult.outcome.attempts[1].validationDiagnostics[0].field, 'decimals');
    assert.equal(twoRepairResult.outcome.attempts[1].validationDiagnostics[0].code, 'tokenomics_fixed_field_mismatch');

    const exhaustedRepairResult = await runTransactionalGenesisAuthoring({ minuteOffset: 102,
      responses: [allNullCandidate, wrongReserveCandidate, badAuthorityCandidate],
      expectedStatus: 'AUTHORING_INVALID_NO_PROGRESS' });
    assert.equal(exhaustedRepairResult.outcome.outcome, 'invalid_no_progress');
    assert.equal(exhaustedRepairResult.outcome.reasonCode, 'authoring_invalid_no_progress');
    assert.equal(exhaustedRepairResult.outcome.attempts.length, 3);
    assert.equal(JSON.stringify(exhaustedRepairResult.outcome).includes('sk-isolated-secret-sentinel'), false,
      'unknown invalid candidate fields and secret-like values are not persisted');
    assert.ok(exhaustedRepairResult.outcome.attempts.every((attempt) => attempt.providerAttempted
      && attempt.validationDiagnostics.length && attempt.invalidCandidate));

    const savedApiKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    let unavailableResult;
    try {
      unavailableResult = await chooseCivilizationOption({ choiceType: 'currency_genesis', options: [
        { id: 'continue_design', label: 'Continue design', description: 'continue' },
        { id: 'propose_when_ready', label: 'Propose when ready', description: 'proposal' }
      ] }, {});
    } finally {
      if (savedApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = savedApiKey;
    }
    assert.equal(unavailableResult.currencyReviewDiagnostic.outcome, 'provider_unavailable');
    await runReviewFailure({ type: 'return', value: unavailableResult }, 'provider_unavailable');

    assert.ok(cognitionChoices.some((entry) => entry.choice === 'continue_design'));
    assert.ok(authoringContextsObserved.length >= 2, 'a continue-design choice invokes authoring to update its draft');
    for (const table of ['arc_token_issuance_issuer_candidates', 'arc_token_issuance_decisions', 'arc_agent_tokens']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE world_id=$1`, [worldId])).rows[0].count, 0);
    }
    assert.equal(cognitionFacts.get(payerId).mainnetWriteGate, false);

    reviewOutcomeOverride = null;
    completeContinueDesign = true;
    authoringReplySequence = [wrongReserveCandidate, completeRepairCandidate];
    await runCurrencyReview();
    assert.equal(authoringReplySequence.length, 0, 'the issuer made one bounded repair after invalid economics');
    authoringReplySequence = null;
    completeContinueDesign = false;
    let proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,specification_hash,
        created_world_minute AS "createdWorldMinute"
      FROM arc_token_issuance_intents WHERE world_id=$1 ORDER BY created_world_minute,id LIMIT 1`, [worldId]);
    assert.equal(proposal.rowCount, 1, 'a complete issuer-authored specification enters the proposed flow');
    assert.equal(proposal.rows[0].status, 'proposed', 'a complete specification remains unconfirmed');
    assert.equal(proposal.rows[0].specification_hash, null, 'a complete specification is not an issuance confirmation');
    requirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    assert.equal(requirement.rows[0].status, 'ISSUER_SELECTED',
      'a complete proposed specification enters issuer consideration without implying confirmation');
    const issuerReviewAtProposal = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.review_outcome' AND world_minute=$3`,
    [worldId, payerId, proposal.rows[0].createdWorldMinute]);
    assert.equal(issuerReviewAtProposal.rows[0].details.outcome, 'explicit_continue_design',
      'proposal creation does not require TypeSafe to select propose_when_ready');
    const repairedProposalOutcome = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.authoring_outcome' AND world_minute=$3`,
    [worldId, payerId, proposal.rows[0].createdWorldMinute]);
    assert.equal(repairedProposalOutcome.rows[0].details.authoringAttemptCount, 2);
    assert.equal(repairedProposalOutcome.rows[0].details.attempts[0].reasonCode, 'authoring_invalid_no_progress');
    assert.equal(repairedProposalOutcome.rows[0].details.attempts[0].validationDiagnostics[0].code,
      'tokenomics_fixed_field_mismatch');
    const repairedCallIds = repairedProposalOutcome.rows[0].details.attempts.map((attempt) => attempt.callId);
    const repairedUsage = await pool.query(`SELECT metadata FROM world_infrastructure_usage_events
      WHERE world_id=$1 AND agent_id=$2 AND metadata->>'cognitionType'='currency_genesis_authoring'
        AND metadata->>'callId'=ANY($3::text[])`, [worldId, payerId, repairedCallIds]);
    assert.equal(repairedUsage.rowCount, 2, 'initial and repair calls are both separately metered');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_decisions
      WHERE world_id=$1 AND intent_id=$2 AND agent_id=$3`, [worldId, proposal.rows[0].id, payerId])).rows[0].count), 0,
    'a repaired proposal remains unconfirmed by the issuer');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_genesis_token_settlement_outbox
      WHERE world_id=$1`, [worldId])).rows[0].count), 0,
    'a repaired proposal does not enter any token settlement outbox');

    allowProposal = true;
    await runCurrencyReview();
    proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,specification_hash
      FROM arc_token_issuance_intents WHERE world_id=$1 ORDER BY created_world_minute,id LIMIT 1`, [worldId]);
    for (let attempt = 0; attempt < 4 && (!proposal.rowCount || !responseRecorded); attempt += 1) {
      await runCurrencyReview();
      proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,specification_hash
        FROM arc_token_issuance_intents WHERE world_id=$1 ORDER BY created_world_minute,id LIMIT 1`, [worldId]);
    }
    assert.equal(proposal.rowCount, 1, 'a resident created a proposal through the persistent World Engine review');
    assert.equal(proposal.rows[0].decision_path, 'world_engine');
    assert.ok(authoringContextsObserved.some((context) => context.agentId === payerId
      && context.currentDesignDraft?.specification?.purpose === 'coordinate a research exchange with peers'),
    'the resident authoring call receives the prior draft');
    assert.equal(proposal.rows[0].name, 'Research Exchange', JSON.stringify(authoringContextsObserved));
    assert.equal(proposal.rows[0].status, 'proposed', 'a complete Agent-authored specification remains unconfirmed');
    assert.equal(proposal.rows[0].specification_hash, null,
      'proposal authoring is not itself execution confirmation');
    const preConfirmationDecisions = await pool.query(`SELECT decision,agent_id,action_id FROM arc_token_issuance_decisions
      WHERE world_id=$1 AND intent_id=$2 AND agent_id=$3
        AND decision IN ('issuer_confirm','issuer_reject','issuer_defer')`, [worldId, proposal.rows[0].id, payerId]);
    assert.equal(preConfirmationDecisions.rowCount, 0,
      `proposal authoring and resident response do not create an issuer decision: ${JSON.stringify(preConfirmationDecisions.rows)}`);
    const proposalId = proposal.rows[0].id;
    const response = await pool.query(`SELECT decision,agent_id FROM arc_token_issuance_responses
      WHERE world_id=$1 AND intent_id=$2`, [worldId, proposalId]);
    assert.equal(response.rowCount, 1);
    assert.equal(response.rows[0].agent_id, recipientId);
    assert.equal(response.rows[0].decision, 'support');
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.review_outcome'
      AND details->>'outcome'='explicit_response'`, [worldId, recipientId]);
    assert.ok(outcomeEvents.rowCount >= 1 && outcomeEvents.rows.some((row) =>
      String(row.details.actionId).startsWith('response:') && row.details.confidence === 0.99));
    await pool.query(`UPDATE arc_agent_wallets SET external_identity_id=NULL
      WHERE world_id=$1 AND agent_id=$2 AND chain_id=$3`, [worldId, payerId, ARC_MAINNET_CHAIN_ID]);
    await assert.rejects(() => inTransaction(pool, async (client) => {
      await client.query(`UPDATE arc_token_issuance_intents SET issuer_wallet=$3 WHERE world_id=$1 AND id=$2`,
        [worldId, proposalId, RECIPIENT]);
      return confirmWorldTokenIssuance(client, { worldId, agentId: payerId, intentId: proposalId, decision: 'issue',
        actionId: 'wallet-mismatch-before-confirm', worldMinute: 3000 });
    }), (error) => error.message === 'TOKEN_ISSUER_WALLET_MISMATCH');
    allowIssuerDecision = true;
    await assert.rejects(() => inTransaction(pool, (client) => confirmWorldTokenIssuance(client, {
      worldId, agentId: recipientId, intentId: proposalId, decision: null,
      actionId: 'missing-decision-confirmation', worldMinute: 3000
    })), (error) => error.message === 'TOKEN_ISSUER_DECISION_INVALID');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      proposal = await pool.query(`SELECT id,status FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`,
        [worldId, proposalId]);
      if (proposal.rows[0]?.status === 'issuer_confirmed') break;
      await runCurrencyReview();
    }
    proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,symbol,
        issuer_identity_id::text AS issuer_identity_id,issuer_wallet,specification_hash,prepared_calldata,
        transaction_sender,transaction_hash,nonce,initial_supply_human,distribution,unallocated_supply_handling,
        ownership_model,authority_model,metadata
      FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`, [worldId, proposalId]);
    assert.equal(proposal.rows[0].issuer_agent_id, payerId, 'Generation 1 uses the explicitly assigned MirrorTerra-01 issuer');
    assert.equal(proposal.rows[0].issuer_selection_source, 'creator_genesis_assignment');
    assert.equal(proposal.rows[0].status, 'issuer_confirmed', 'MirrorTerra-01 explicitly confirmed its complete Agent-authored specification');
    assert.equal(proposal.rows[0].name, 'Research Exchange');
    assert.equal(proposal.rows[0].symbol, 'REX');
    assert.equal(proposal.rows[0].initial_supply_human, '1000000000');
    assert.equal(proposal.rows[0].unallocated_supply_handling,
      SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling);
    assert.equal(proposal.rows[0].ownership_model, 'erc20_holder_owned');
    assert.equal(proposal.rows[0].authority_model, SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel);
    assert.deepEqual(proposal.rows[0].distribution, [], 'SYNC Genesis has no Creator or Agent initial allocation');
    assert.equal(proposal.rows[0].metadata.tokenomicsManifestHash, TOKENOMICS_MANIFEST_HASH,
      'the proposal binds the active immutable Tokenomics manifest');
    assert.equal(proposal.rows[0].metadata.agentSpecification.reserveAmount, SYNC_GENESIS_RESERVE.toString());
    assert.equal(proposal.rows[0].issuer_identity_id, null,
      'explicit confirmation does not invent or require an external issuer identity');
    assert.equal(proposal.rows[0].issuer_wallet, PAYER,
      'explicit confirmation binds the existing active issuer wallet');
    assert.match(proposal.rows[0].specification_hash, /^0x[0-9a-f]{64}$/i,
      '01 confirmation records the design hash while execution remains identity-gated');
    assert.equal(proposal.rows[0].metadata.executionStatus, 'identity_not_ready');
    assert.equal(proposal.rows[0].metadata.executionBlockReason, 'TOKEN_ISSUER_IDENTITY_NOT_READY');
    assert.equal(proposal.rows[0].prepared_calldata, null);
    assert.equal(proposal.rows[0].transaction_sender, null);
    assert.equal(proposal.rows[0].nonce, null);
    assert.equal(issuerReviewAtProposal.rows[0].details.outcome, 'explicit_continue_design',
      'the complete resident-authored design enters proposed state without a proposal action from TypeSafe');
    assert.ok(cognitionChoices.some((entry) => entry.choice.startsWith('response:') && entry.choice.endsWith(':support')));
    assert.ok(!cognitionChoices.some((entry) => entry.choice.startsWith(`nominate:${proposalId}:`)));
    assert.ok(!cognitionChoices.some((entry) => entry.choice.startsWith(`candidate:${recipientId}:`)));
    assert.ok(cognitionChoices.some((entry) => entry.agentId === payerId
      && entry.choice === `issuer:${proposalId}:issue`));
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.review_outcome'
      AND details->>'outcome'='other'`, [worldId, payerId]);
    assert.ok(outcomeEvents.rows.some((row) => row.details.actionId === `issuer:${proposalId}:issue`),
      'the explicit issuer decision is distinguishable from a provider non-decision');
    assert.equal(proposal.rows[0].transaction_hash, null, 'no chain submission is claimed by off-chain confirmation');
    requirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    assert.equal(requirement.rows[0].status, 'ISSUER_CONFIRMED',
      'issuer confirmation is distinct from execution readiness');
    const confirmedAgain = await inTransaction(pool, (client) => confirmWorldTokenIssuance(client, {
      worldId, agentId: payerId, intentId: proposalId, decision: 'issue',
      actionId: 'identity-not-ready-idempotent-read', worldMinute: 3000 }));
    assert.equal(confirmedAgain.readyForExecution, false);
    const issuanceListing = await listWorldTokenIssuance(pool, { worldId });
    assert.equal(issuanceListing.find((item) => item.id === proposalId).readyForExecution, false);
    assert.equal(issuanceListing.find((item) => item.id === proposalId).executionStatus, 'identity_not_ready');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_agent_tokens WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'no token is created in this isolated acceptance path');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_genesis_token_settlement_outbox
      WHERE world_id=$1`, [worldId])).rows[0].count), 0, 'missing identity creates no Genesis settlement outbox');

    let tokenBroadcasts = 0;
    const readOnlyConfig = Object.freeze({ ...config, writesEnabled: false });
    tokenWorker = new ArcAgentTokenIssuanceWorker({ pool, config: readOnlyConfig,
      env: {}, signer: { async getAddress() { return PAYER; }, async sendTransaction() { tokenBroadcasts += 1; } },
      rpcClient: { async getChainId() { return ARC_MAINNET_CHAIN_ID; }, async getBlockNumber() { return '0x1234'; } },
      isOwner: () => true, intervalMs: 60_000 });
    await tokenWorker.start({ worldId });
    assert.equal(tokenWorker.getStatus().mode, 'read_only_reconciliation');
    assert.equal(tokenWorker.getStatus().writesEnabled, false);
    assert.equal(tokenBroadcasts, 0, 'closed Mainnet gate prevents token issuance broadcast');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count
      FROM world_genesis_currency_activations WHERE world_id=$1`, [worldId])).rows[0].count), 0,
    'an issuer-confirmed intent without a reconciled Arc creation event does not activate Genesis');
    await tokenWorker.stop();
    tokenWorker = null;

    const writableTestConfig = createIsolatedArcMainnetConfig({ ARC_SETTLEMENT_RUNTIME_CODE_HASH: RUNTIME_CODE_HASH });
    const signerBroadcasts = [];
    const infrastructureSigner = new ManagedWalletArcInfrastructureSigner({ config: writableTestConfig,
      getAddress: async () => PAYER,
      submitTransaction: async (transaction) => { signerBroadcasts.push(transaction); return { hash: HASH }; } });
    const tokenWorkerEnv = { ARC_AGENT_TOKEN_FACTORY_ADDRESS: CONTRACT,
      ARC_AGENT_TOKEN_FACTORY_RUNTIME_CODE_HASH: RUNTIME_CODE_HASH,
      ARC_AGENT_TOKEN_FACTORY_DEPLOYMENT_BLOCK: '1' };
    tokenWorker = new ArcAgentTokenIssuanceWorker({ pool, config: writableTestConfig, env: tokenWorkerEnv,
      signer: infrastructureSigner, rpcClient: fakeMainnetRpc({ worldId, config: writableTestConfig }),
      isOwner: () => true, intervalMs: 60_000 });
    await tokenWorker.start({ worldId });
    assert.equal(tokenWorker.getStatus().lastResult?.preparation, undefined,
      'manifest-bound SYNC proposals stay outside the generic token execution worker pending Final Preflight');
    assert.equal(signerBroadcasts.length, 0);
    await tokenWorker.stop();
    tokenWorker = null;
    const blockedIntent = await pool.query(`SELECT status,issuer_identity_id::text AS issuer_identity_id,
        specification_hash,prepared_calldata,transaction_hash,metadata
      FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`, [worldId, proposalId]);
    assert.equal(blockedIntent.rows[0].status, 'issuer_confirmed');
    assert.equal(blockedIntent.rows[0].issuer_identity_id, null);
    assert.match(blockedIntent.rows[0].specification_hash, /^0x[0-9a-f]{64}$/i);
    assert.equal(blockedIntent.rows[0].prepared_calldata, null);
    assert.equal(blockedIntent.rows[0].transaction_hash, null);
    assert.equal(blockedIntent.rows[0].metadata.executionStatus, 'identity_not_ready');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_genesis_token_settlement_outbox
      WHERE world_id=$1`, [worldId])).rows[0].count), 0);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents
      WHERE world_id=$1 AND id=$2 AND transaction_hash IS NOT NULL`, [worldId, proposalId])).rows[0].count), 0);
    assert.equal(signerBroadcasts.length, 0, 'SYNC Final Preflight never signs or broadcasts through this worker');

    const latestRuntime = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
    await inTransaction(pool, (client) => advanceWorldCurrencyGenesis(client, { worldId,
      agent: { agentId: payerId }, worldMinute: Number(latestRuntime.rows[0].world_minutes) + 1,
      reviewDue: false }));
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND event_type='currency_genesis.review_outcome' AND details->>'outcome'='skipped_not_due'`, [worldId]);
    assert.equal(outcomeEvents.rowCount, 1, 'an explicit non-due review attempt is recorded once');
    assert.equal(outcomeEvents.rows[0].details.reasonCode, 'review_not_due');

    const revalidatedSchema = await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });
    assert.deepEqual(revalidatedSchema.applied, [], 'a restart reapplies no migration and preserves open currency history');
    assert.ok(revalidatedSchema.alreadyApplied.includes('0002_arc_agent_token_issuance.sql'));

    const fkClient = await pool.connect();
    try {
      await fkClient.query('BEGIN');
      await fkClient.query(`DELETE FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`, [worldId, proposalId]);
      const preservedRequirement = await fkClient.query(`SELECT world_id,capability_generation,status,current_proposal_id
        FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
      assert.equal(preservedRequirement.rows[0].world_id, worldId);
      assert.equal(preservedRequirement.rows[0].capability_generation, 1);
      assert.equal(preservedRequirement.rows[0].current_proposal_id, null,
        'deleting an intent clears only the nullable proposal pointer');
      assert.notEqual(preservedRequirement.rows[0].status, 'SATISFIED');
      await fkClient.query('ROLLBACK');
    } catch (error) {
      await fkClient.query('ROLLBACK');
      throw error;
    } finally { fkClient.release(); }

    const business = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: recipientId,
      actionId: 'arc-mainnet-business-seed', worldTime: 3000,
      proposal: { name: 'Arc Research Studio', businessType: 'research', purpose: 'Offer a research service in the isolated integration world.',
        serviceType: 'research_service', serviceName: 'Research Notes',
        serviceDescription: 'A deterministic research service for the isolated Arc integration world.', capitalUsdc: '250.00000000',
        basePriceUsdc: '5.00000000' } }));

    await pool.query(`UPDATE world_agent_states SET status='performing',planned_action='business_work',
        planned_context=$3::jsonb,action_started_at=$4,action_ends_at=$5,next_decision_at=$6
      WHERE world_id=$1 AND agent_id=$2`, [worldId, recipientId,
      JSON.stringify({ businessId: business.id, serviceId: business.serviceId }),
      new Date(nowMs - 30_000), new Date(nowMs - 1), new Date(nowMs + 86_400_000)]);
    await engine.tickOnce();
    const production = await pool.query(`SELECT data FROM world_events
      WHERE world_id=$1 AND actor_id=$2 AND event_type='world.action_completed'
        AND data->>'initiativeAction'='business_work' ORDER BY id DESC LIMIT 1`, [worldId, recipientId]);
    assert.equal(production.rowCount, 1, 'the business founder autonomously produced service stock through the World Engine');
    assert.equal(production.rows[0].data.abandoned, undefined);

    await pool.query(`UPDATE world_agent_states SET status='performing',planned_action='business_service',
        planned_context=$3::jsonb,action_started_at=$4,action_ends_at=$5,next_decision_at=$6
      WHERE world_id=$1 AND agent_id=$2`, [worldId, payerId,
      JSON.stringify({ serviceId: business.serviceId, maxPriceUsdc: '500.00000000' }),
      new Date(nowMs - 30_000), new Date(nowMs - 1), new Date(nowMs + 86_400_000)]);
    await engine.tickOnce();

    const actionResult = await pool.query(`SELECT id,data FROM world_events
      WHERE world_id=$1 AND actor_id=$2 AND event_type='world.action_completed'
        AND data->>'initiativeAction'='business_service' ORDER BY id DESC LIMIT 1`, [worldId, payerId]);
    assert.equal(actionResult.rowCount, 1, 'the World Engine completed the resident-selected service action');
    const outboxBeforePolicy = await pool.query(`SELECT world_action_id,world_event_id,chain_id,status,
        from_agent_id,to_agent_id,action_family,simulated_amount_usdc,created_world_minute,metadata
      FROM arc_settlement_outbox WHERE world_id=$1`, [worldId]);
    assert.equal(outboxBeforePolicy.rowCount, 1,
      `the autonomous action wrote a persistent outbox row; event=${JSON.stringify(actionResult.rows[0]?.data)} ` +
      `outbox=${JSON.stringify(outboxBeforePolicy.rows)}`);
    assert.equal(Number(outboxBeforePolicy.rows[0].chain_id), ARC_MAINNET_CHAIN_ID);
    assert.equal(outboxBeforePolicy.rows[0].status, 'policy_pending');
    assert.equal(outboxBeforePolicy.rows[0].from_agent_id, payerId);
    assert.equal(outboxBeforePolicy.rows[0].to_agent_id, recipientId);
    assert.equal(outboxBeforePolicy.rows[0].action_family, 'resident_service_purchase');
    assert.ok(Number(outboxBeforePolicy.rows[0].simulated_amount_usdc) < 10,
      'the real Agent action path stays within the shared 10 USDC pilot budget');
    assert.equal(String(outboxBeforePolicy.rows[0].world_event_id), String(actionResult.rows[0].id));
    const replayedOutbox = await inTransaction(pool, (client) => enqueueArcAgentEconomicAction(client, {
      worldId, worldActionId: outboxBeforePolicy.rows[0].world_action_id,
      worldEventId: actionResult.rows[0].id, fromAgentId: payerId, toAgentId: recipientId,
      simulatedAmountUsdc: String(outboxBeforePolicy.rows[0].simulated_amount_usdc),
      worldMinute: Number(outboxBeforePolicy.rows[0].created_world_minute),
      orderId: outboxBeforePolicy.rows[0].metadata.orderId,
      businessId: outboxBeforePolicy.rows[0].metadata.businessId
    }));
    assert.equal(replayedOutbox.created, false, 'replaying the same completed Agent action does not duplicate its settlement intent');
    assert.equal(String((await pool.query(`SELECT count(*)::int AS count FROM arc_settlement_outbox WHERE world_id=$1`,
      [worldId])).rows[0].count), '1');

    await pool.query(`INSERT INTO arc_spending_policies(world_id,agent_id,chain_id,token_address,
        per_action_limit_base_units,daily_limit_base_units,settlement_basis_points,allowed_action_families,
        allowed_contracts,emergency_paused,policy_version)
      VALUES($1,$2,$3,$4,100000000,500000000,10000,ARRAY['resident_service_purchase'],ARRAY[$5],false,1)`,
    [worldId, payerId, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS, CONTRACT]);

    const submitted = [];
    const signer = new DeterministicFakeArcSigner({ config,
      addresses: { [payerId]: PAYER, [recipientId]: RECIPIENT }, transactionHash: txHash,
      submitted });
    worker = new ArcSettlementOutboxWorker({ pool, config,
      env: { ARC_SETTLEMENT_CONTRACT_ADDRESS: CONTRACT }, signer, rpcClient,
      isOwner: () => true, intervalMs: 60_000 });
    await worker.start();
    const workerStatus = worker.getStatus();
    assert.equal(workerStatus.running, true);
    assert.ok(workerStatus.lastResult, `the outbox worker completed its startup pass: ${JSON.stringify(workerStatus)}`);
    assert.equal(workerStatus.lastResult.policyProcessed, true);
    assert.equal(workerStatus.lastResult.status, 'submitted');
    assert.equal(submitted.length, 1, 'only the deterministic fake signer receives the production-built transaction');
    assert.equal(submitted[0].chainId, ARC_MAINNET_CHAIN_ID);
    assert.equal(submitted[0].to, CONTRACT);
    assert.ok(rpcClient.calls.includes(ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('spendingPolicies').selector.toLowerCase()),
      'the worker read and evaluated the on-chain spending policy');
    const outboxAfterPolicy = await pool.query(`SELECT status,transaction_hash,amount_base_units,policy_reason
      FROM arc_settlement_outbox WHERE world_id=$1`, [worldId]);
    assert.equal(outboxAfterPolicy.rows[0].status, 'submitted');
    assert.equal(outboxAfterPolicy.rows[0].transaction_hash, txHash);
    assert.ok(BigInt(outboxAfterPolicy.rows[0].amount_base_units) > 0n);
    assert.equal(outboxAfterPolicy.rows[0].policy_reason, 'ONCHAIN_POLICY_APPROVED');

    const checkpointClient = await pool.connect();
    try {
      const checkpoint = await prepareArcWorldCheckpoint(checkpointClient, { worldId, chainId: ARC_MAINNET_CHAIN_ID });
      const replay = await prepareArcWorldCheckpoint(checkpointClient, { worldId, chainId: ARC_MAINNET_CHAIN_ID });
      assert.equal(checkpoint.due, true);
      assert.equal(checkpoint.checkpoint.version, '1');
      assert.equal(replay.due, false, 'a world minute with an existing checkpoint is not checkpointed twice');
      assert.equal(replay.reason, 'world_minute_not_advanced');
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_world_checkpoints
        WHERE world_id=$1 AND chain_id=$2`, [worldId, ARC_MAINNET_CHAIN_ID])).rows[0].count), 1);
      const capability = await prepareArcCapabilityProvenance(checkpointClient, {
        worldId, capabilityId: childCapabilityId, chainId: ARC_MAINNET_CHAIN_ID
      });
      const capabilityReplay = await prepareArcCapabilityProvenance(checkpointClient, {
        worldId, capabilityId: childCapabilityId, chainId: ARC_MAINNET_CHAIN_ID
      });
      assert.equal(capability.created, true);
      assert.equal(capabilityReplay.created, false);
      assert.equal(capability.provenance.creator_type, 'resident');
      assert.equal(capability.provenance.parent_capability_id, rootCapabilityId);
      assert.equal(capability.provenance.adopted_world_minute, '250');
    } finally { checkpointClient.release(); }

    const indexed = await indexTrackedUsdcTransfers({ client: pool, rpc: { async getLogs() {
      return [{ transactionHash: txHash, blockNumber: '0x123', logIndex: '0x0', blockHash: HASH,
        address: SYSTEM_EMITTER, topics: [HASH], data: '0x' }];
    } }, chainId: ARC_MAINNET_CHAIN_ID, sourceKey: `arc-mainnet-isolated:${worldId}`, worldId,
    trackedWallets: [PAYER], startBlock: 1n, latestBlock: 300n, maxBlockCount: 500n, maxPages: 1 });
    assert.equal(indexed.indexedLogs, 1);

    const observer = new ArcReadOnlyObserver({ pool, config,
      env: { ARC_SETTLEMENT_CONTRACT_ADDRESS: CONTRACT,
        ARC_WORLD_REGISTRY_ADDRESS: '0x4444444444444444444444444444444444444444',
        ARC_CAPABILITY_PROVENANCE_ADDRESS: '0x5555555555555555555555555555555555555555' },
      rpcClient, isOwner: () => true, intervalMs: 60_000 });
    try {
      await observer.start({ worldId });
      const status = observer.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.mode, 'read_only');
      assert.equal(status.worldId, worldId);
      assert.equal(status.usdc.verified, true);
      assert.equal(status.arcMainnet.pendingSettlements, 1);
      assert.equal(status.arcMainnet.settlementEnabled, false);
      assert.equal(status.database.capabilityProvenance.total, 1);
      assert.equal(status.database.recentSettlements[0].transactionHash, txHash);
    } finally { await observer.stop(); }

    await pool.query('DELETE FROM arc_mainnet_pilot_cost_reservations');
    await pool.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
      reserved_usdc_base_units=0 WHERE id=1`);
    const reserveConcurrent = async (operationId) => {
      try {
        return await inTransaction(pool, (client) => reserveArcMainnetPilotCost(client, {
          operationType: 'token_creation', operationId, worldId,
          transferUsdcBaseUnits: 6_000_000n, gasLimit: 1n, maxFeePerGas: 1n
        }));
      } catch (error) {
        if (error.code === 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED') return null;
        throw error;
      }
    };
    const concurrentBudgetResults = await Promise.all([
      reserveConcurrent(`budget-a-${worldId}`), reserveConcurrent(`budget-b-${worldId}`)
    ]);
    assert.equal(concurrentBudgetResults.filter(Boolean).length, 1,
      'two concurrent operations cannot each reserve the same remaining 10 USDC pilot budget');
    const reservedOperation = concurrentBudgetResults[0] ? `budget-a-${worldId}` : `budget-b-${worldId}`;
    await inTransaction(pool, (client) => setArcMainnetPilotCostStatus(client, {
      operationType: 'token_creation', operationId: reservedOperation, status: 'submission_unknown'
    }));
    await assert.rejects(() => inTransaction(pool, (client) => releaseArcMainnetPilotCost(client, {
      operationType: 'token_creation', operationId: reservedOperation
    })), { code: 'ARC_PILOT_COST_RESERVATION_CANNOT_BE_RELEASED' });
    const budgetAfterUnknown = await pool.query(`SELECT reserved_usdc_base_units::text AS reserved
      FROM arc_mainnet_pilot_budget WHERE id=1`);
    assert.equal(budgetAfterUnknown.rows[0].reserved, '6000001',
      'unknown submission keeps its global pilot budget reservation');
    await pool.query('DELETE FROM arc_mainnet_pilot_cost_reservations');
    await pool.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
      reserved_usdc_base_units=0 WHERE id=1`);
  } finally {
    if (tokenWorker) await tokenWorker.stop();
    if (worker) await worker.stop();
    if (engine) await engine.stop();
    await pool.end();
  }
});
