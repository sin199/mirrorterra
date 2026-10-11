import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyGenesisInfrastructureFacts } from '../src/arc/currency-genesis-context.js';
import { arcNetworkConfig } from '../src/arc/config.js';
import { authorAgentCurrencyProposal, currencyGenesisAuthoringConfig,
  getCurrencyGenesisAuthoringConfig } from '../src/agent-runtime/currency-genesis-authoring.js';

const ENV = Object.freeze({ BAI_API_KEY: 'test-only-bai-key',
  CURRENCY_GENESIS_AUTHORING_PROVIDER: 'bai', CURRENCY_GENESIS_AUTHORING_MODEL: 'gpt-6-luna',
  BAI_API_BASE_URL: 'https://api.b.ai/v1' });
const SPECIFICATION = { name: 'Exchange', symbol: 'EX', meaning: 'A resident expression.', purpose: 'A resident purpose.',
  rationale: null, decimals: null, distribution: null, reserveAmount: null, unallocatedSupplyHandling: null,
  ownershipModel: null, authorityModel: null };
const USAGE = { prompt_tokens: 216, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens: 31,
  total_tokens: 247 };
const JSON_INSTRUCTION = '\n\nReturn exactly the canonical token specification fields required by the structured output schema. Include every key. Use null for each design field the resident has not decided. Do not add aliases, wrapper objects, initialSupply, totalSupply, or other fields. The fixed total supply is a world fact, not an authored specification field. distribution must be null or an array of objects with recipientType, recipientId, recipientAddress, and amount; use only explicit recipient addresses supplied in context.';

function chatResponse(specification, usage = USAGE, { status = 200, model = 'gpt-6-luna' } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify({ model,
    choices: [{ message: { content: JSON.stringify(specification) }, finish_reason: 'stop' }], usage }) };
}

function contextFromUserContent(value) {
  assert.ok(value.endsWith(JSON_INSTRUCTION));
  return JSON.parse(value.slice(0, -JSON_INSTRUCTION.length));
}

test('B.AI authoring sends resident context and parses its OpenAI-compatible JSON response', async () => {
  const residentInput = {
    resident: {
      agentId: 'resident-a', currentGoal: 'coordinate research exchange',
      goals: [{ category: 'cooperation', description: 'Share research notes', priority: 0.8, status: 'active' }],
      recentMemories: [{ memoryType: 'economy', summary: 'A peer lacked a way to record exchange.', worldMinutes: 40 }],
      energy: 0.7, food: 0.8, social: 0.6, knowledge: 0.9,
      traits: { curiosity: 0.8 }, skills: { research: 0.9 }
    },
    worldFacts: { ...currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' } }),
      currencyRequirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: 'UNRESOLVED',
      currentWorldMinute: 55, currentEconomicEvidence: ['Two unmet research exchanges.'] },
    publicCurrencyHistory: [{ type: 'proposal', agent: 'resident-b', decision: 'support',
      summary: 'A peer supported keeping exchange records.', worldMinute: 50 }],
    currentProposal: { status: 'proposed', proposer: 'resident-b', name: 'Exchange',
      existingSpecification: { name: 'Exchange', purpose: 'Resident authored purpose.' } },
    currentDesignDraft: { specification: { purpose: 'A resident draft purpose.', decimals: 4 },
      incompleteFields: ['name','symbol'] },
    availableRecipients: [{ type: 'agent', id: 'resident-a', name: 'Resident A', address: '0x1111111111111111111111111111111111111111' }]
  };
  let requestedUrl;
  let requestOptions;
  const result = await authorAgentCurrencyProposal(residentInput, { env: ENV, fetchImpl: async (url, options) => {
    requestedUrl = url;
    requestOptions = options;
    return chatResponse(SPECIFICATION);
  } });

  assert.equal(requestedUrl, 'https://api.b.ai/v1/chat/completions');
  assert.equal(requestOptions.method, 'POST');
  assert.equal(requestOptions.headers.authorization, 'Bearer test-only-bai-key');
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'currency_genesis_token_specification');
  assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['name','symbol','meaning','purpose','rationale','decimals','distribution',
    'reserveAmount','unallocatedSupplyHandling','ownershipModel','authorityModel']);
  assert.deepEqual(schema.properties.name.type, ['string','null']);
  assert.deepEqual(schema.properties.decimals.type, ['integer','null']);
  assert.deepEqual(schema.properties.distribution.type, ['array','null']);
  assert.deepEqual(schema.properties.distribution.items.required,
    ['recipientType','recipientId','recipientAddress','amount']);
  assert.equal(Object.hasOwn(schema.properties, 'initialSupply'), false);
  assert.equal(Object.hasOwn(body, 'temperature'), false, 'GPT-6 Luna request omits unsupported temperature');
  assert.doesNotMatch(body.messages[0].content, /already chosen whether to continue design or submit a proposal/);
  assert.match(body.messages[0].content, /mandatory world requirement/);
  assert.match(body.messages[0].content, /A partial specification is valid/);
  assert.match(body.messages[0].content, /does not confirm or authorize execution/);
  assert.match(body.messages[1].content, /Return exactly the canonical token specification fields/);
  const context = contextFromUserContent(body.messages[1].content);
  assert.equal(context.resident.id, 'resident-a');
  assert.equal(context.resident.currentGoal, 'coordinate research exchange');
  assert.equal(context.resident.goals[0].description, 'Share research notes');
  assert.equal(context.resident.recentMemories[0].summary, 'A peer lacked a way to record exchange.');
  const sharedFacts = currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' } });
  for (const key of ['executionNetwork','chainId','tokenCreationTarget','networkRole','mainnetWriteGate',
    'onchainStatus','currencyRequirement','requirementStatus','currencyRequirementMandatory','genesisIssuer',
    'generation','issuerSelectionSource','totalHumanReadableSupply']) {
    const expected = ['genesisIssuer','issuerSelectionSource'].includes(key) && sharedFacts[key] === null
      ? '' : sharedFacts[key];
    assert.equal(context.worldFacts[key], expected);
  }
  assert.equal(context.worldFacts.currentEconomicEvidence[0], 'Two unmet research exchanges.');
  assert.equal(context.publicCurrencyHistory[0].decision, 'support');
  assert.equal(context.currentProposal.existingSpecification.purpose, 'Resident authored purpose.');
  assert.equal(context.currentDesignDraft.specification.purpose, 'A resident draft purpose.');
  assert.equal(context.currentDesignDraft.specification.decimals, 4);
  assert.deepEqual(context.currentDesignDraft.incompleteFields, ['name','symbol']);
  assert.equal(context.availableRecipients[0].id, 'resident-a');
  assert.deepEqual(result.specification, SPECIFICATION);
  assert.deepEqual({ reason: result.reason, provider: result.provider, model: result.model,
    providerAttempted: result.providerAttempted },
  { reason: null, provider: 'bai', model: 'gpt-6-luna', providerAttempted: true });
  assert.match(result.callId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(result.usage, { inputTokens: 216, cachedInputTokens: 12, outputTokens: 31,
    totalTokens: 247, latencyMs: result.usage.latencyMs, providerReportedCostUsd: null });
  assert.ok(Number.isSafeInteger(result.usage.latencyMs) && result.usage.latencyMs >= 0);
});

test('provider and model are selected from environment without exposing endpoint credentials', () => {
  const config = getCurrencyGenesisAuthoringConfig(ENV);
  assert.equal(config.provider, 'bai');
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(config.endpoint, 'https://api.b.ai/v1/chat/completions');
  assert.equal(config.valid, true);
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
  assert.equal(currencyGenesisAuthoringConfig.provider, 'bai');
  assert.equal(currencyGenesisAuthoringConfig.model, 'gpt-6-luna');
  assert.equal(currencyGenesisAuthoringConfig.timeoutMs, 60_000);
});

test('provider misconfiguration and missing key fail closed without contacting Ollama or another host', async () => {
  let calls = 0;
  const input = { resident: { agentId: 'resident-a' } };
  const unsupported = await authorAgentCurrencyProposal(input, { env: { ...ENV,
    CURRENCY_GENESIS_AUTHORING_PROVIDER: 'ollama' }, fetchImpl: async () => { calls += 1; } });
  assert.equal(unsupported.reason, 'bai_authoring_configuration_invalid');
  assert.equal(unsupported.providerAttempted, false);
  const untrustedHost = await authorAgentCurrencyProposal(input, { env: { ...ENV,
    BAI_API_BASE_URL: 'https://attacker.invalid/v1' }, fetchImpl: async () => { calls += 1; } });
  assert.equal(untrustedHost.reason, 'bai_authoring_configuration_invalid');
  assert.equal(untrustedHost.providerAttempted, false);
  const noKey = await authorAgentCurrencyProposal(input, { env: { ...ENV, BAI_API_KEY: '' },
    fetchImpl: async () => { calls += 1; } });
  assert.equal(noKey.reason, 'bai_authoring_unavailable');
  assert.equal(noKey.providerAttempted, false);
  assert.equal(calls, 0);
});

test('network unavailability and timeout remain technical authoring failures', async () => {
  const input = { resident: { agentId: 'resident-a' } };
  const unavailable = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); } });
  assert.equal(unavailable.reason, 'bai_authoring_unavailable');
  assert.equal(unavailable.providerAttempted, true);
  const timedOut = await authorAgentCurrencyProposal(input, { env: ENV, timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }) });
  assert.equal(timedOut.reason, 'bai_authoring_timeout');
  assert.equal(timedOut.providerAttempted, true);
  assert.ok(timedOut.usage.latencyMs >= 0);
});

test('HTTP status classes retain provider error, unavailable, and timeout distinctions', async () => {
  const input = { resident: { agentId: 'resident-a' } };
  const responseFor = (status) => ({ ok: false, status, text: async () => JSON.stringify({ error: {
    type: 'invalid_request_error', code: 'request_rejected', param: 'input', message: 'safe synthetic diagnostic' } }) });
  const badRequest = await authorAgentCurrencyProposal(input, { env: ENV, fetchImpl: async () => responseFor(400) });
  assert.equal(badRequest.reason, 'bai_authoring_http_400');
  assert.equal(badRequest.providerStatus, 400);
  assert.equal(badRequest.providerCode, 'invalid_request_error');
  assert.equal(badRequest.providerParam, 'input');
  assert.equal(Object.hasOwn(badRequest, 'providerMessage'), false);
  assert.equal((await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => responseFor(503) })).reason, 'bai_authoring_unavailable');
  assert.equal((await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => responseFor(408) })).reason, 'bai_authoring_timeout');
});

test('malformed envelopes and JSON remain distinct from an Agent choice', async () => {
  const input = { resident: { agentId: 'resident-a' } };
  const malformedJson = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{' }) });
  assert.equal(malformedJson.reason, 'bai_authoring_response_invalid');
  const missingContent = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [] }) }) });
  assert.equal(missingContent.reason, 'bai_authoring_content_invalid');
  const invalidSpec = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => chatResponse('not-json') });
  assert.equal(invalidSpec.reason, 'bai_authoring_specification_invalid');
  assert.equal(invalidSpec.specification, null);
  assert.equal(invalidSpec.providerAttempted, true);
  const extraField = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => chatResponse({ ...SPECIFICATION, initialSupply: '1000000000' }) });
  assert.equal(extraField.reason, 'bai_authoring_specification_invalid');
  assert.equal(extraField.specification, null);
  const wrongType = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => chatResponse({ ...SPECIFICATION, name: { value: 'Exchange' } }) });
  assert.equal(wrongType.reason, 'bai_authoring_specification_invalid');
  const missingKey = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => { const { authorityModel, ...specification } = SPECIFICATION; return chatResponse(specification); } });
  assert.equal(missingKey.reason, 'bai_authoring_specification_invalid');
  const malformedDistribution = await authorAgentCurrencyProposal(input, { env: ENV,
    fetchImpl: async () => chatResponse({ ...SPECIFICATION, distribution: [{ recipientType: 'agent',
      recipientId: 'resident-a', recipientAddress: '0x1111111111111111111111111111111111111111',
      amount: '1', balance: 'invented' }] }) });
  assert.equal(malformedDistribution.reason, 'bai_authoring_specification_invalid');
});

test('strict specification parser accepts a canonical explicit recipient distribution', async () => {
  const distribution = [{ recipientType: 'agent', recipientId: 'e2d9c4ae-c749-49cb-9b2d-861699a7114c',
    recipientAddress: '0x1111111111111111111111111111111111111111', amount: '1000000000' }];
  const result = await authorAgentCurrencyProposal({ resident: { agentId: 'resident-a' } }, { env: ENV,
    fetchImpl: async () => chatResponse({ ...SPECIFICATION, distribution }) });
  assert.equal(result.reason, null);
  assert.deepEqual(result.specification.distribution, distribution);
});

test('missing resident context stays unresolved and does not call the provider', async () => {
  let called = false;
  const result = await authorAgentCurrencyProposal({ worldFacts: { currencyRequirement: 'CURRENCY_GENESIS_REQUIRED' } }, {
    env: ENV, fetchImpl: async () => { called = true; throw new Error('must not run'); }
  });
  assert.equal(called, false);
  assert.equal(result.reason, 'resident_context_missing');
  assert.equal(result.providerAttempted, false);
});

test('infrastructure facts follow Arc config and reconciled requirement, not execution preparation', () => {
  const config = arcNetworkConfig({});
  const issuerAssignment = { issuerName: 'MirrorTerra-01', capabilityGeneration: 1,
    selectionSource: 'creator_genesis_assignment' };
  const facts = currencyGenesisInfrastructureFacts({ config, requirement: { status: 'UNRESOLVED' }, issuerAssignment });
  assert.deepEqual(facts, { currencyRequirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: 'UNRESOLVED',
    currencyRequirementMandatory: true,
    genesisIssuer: 'MirrorTerra-01', generation: 1, issuerSelectionSource: 'creator_genesis_assignment',
    totalHumanReadableSupply: '1000000000', executionNetwork: 'Arc Mainnet', chainId: 5042,
    tokenCreationTarget: 'Arc Mainnet', networkRole: 'the blockchain execution environment for this pilot',
    mainnetWriteGate: false, onchainStatus: 'not yet created' });
  for (const status of ['UNRESOLVED', 'PROPOSAL_FORMED', 'EXECUTION_READY', 'SATISFIED']) {
    const statusFacts = currencyGenesisInfrastructureFacts({ config, requirement: { status } });
    assert.equal(statusFacts.onchainStatus, 'not yet created');
    assert.equal(statusFacts.currencyRequirementMandatory, status !== 'SATISFIED');
  }
  assert.equal(currencyGenesisInfrastructureFacts({ config, requirement: {
    status: 'SATISFIED', satisfied_token_id: 'reconciled-token-id' } }).onchainStatus, 'created');
  assert.equal(currencyGenesisInfrastructureFacts({ config, requirement: {
    status: 'EXECUTION_READY', satisfied_token_id: 'not-reconciled' } }).onchainStatus, 'not yet created');
});

test('network context preserves undecided fields and the B.AI request stays read-only', async () => {
  const undecided = Object.fromEntries(['name','symbol','meaning','purpose','rationale','decimals',
    'distribution','reserveAmount','unallocatedSupplyHandling','ownershipModel','authorityModel'].map(key => [key, null]));
  const facts = currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' } });
  const calls = [];
  const result = await authorAgentCurrencyProposal({ resident: { agentId: 'resident-a' }, worldFacts: facts }, {
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const body = calls.at(-1).body;
      const context = contextFromUserContent(body.messages[1].content);
      for (const key of ['executionNetwork','chainId','tokenCreationTarget','networkRole','mainnetWriteGate',
        'onchainStatus','currencyRequirement','requirementStatus','currencyRequirementMandatory','genesisIssuer',
        'generation','issuerSelectionSource','totalHumanReadableSupply']) {
        const expected = ['genesisIssuer','issuerSelectionSource'].includes(key) && facts[key] === null ? '' : facts[key];
        assert.equal(context.worldFacts[key], expected);
      }
      assert.equal(context.currentProposal, null);
      assert.equal(context.currentDesignDraft, null);
      assert.deepEqual(context.availableRecipients, []);
      assert.match(body.messages[0].content, /infrastructure constraints, not token attributes/);
      assert.match(body.messages[0].content, /does not mean a token will never be deployed/);
      assert.match(body.messages[0].content, /A partial specification is valid/);
      assert.match(body.messages[0].content, /Do not invent a default name/);
      return chatResponse(undecided);
    }
  });
  assert.deepEqual(result.specification, undecided);
  assert.deepEqual(calls.map((call) => call.url), ['https://api.b.ai/v1/chat/completions']);
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[0].body.messages.some((message) => /broadcast|sendTransaction/i.test(message.content)), true,
    'the existing system message states the broadcast constraint');
});
