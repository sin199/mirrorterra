import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyGenesisInfrastructureFacts } from '../src/arc/currency-genesis-context.js';
import { arcNetworkConfig } from '../src/arc/config.js';
import { authorAgentCurrencyProposal, currencyGenesisAuthoringConfig,
  getCurrencyGenesisAuthoringConfig } from '../src/agent-runtime/currency-genesis-authoring.js';
import { SYNC_GENESIS_ISSUER_AGENT_ID, SYNC_GENESIS_RESERVE, SYNC_OPERATING_POOL_GENESIS,
  SYNC_TOKENOMICS_FIXED_FIELDS, TOKENOMICS_MANIFEST_HASH } from '../src/arc/sync-tokenomics.js';

const ENV = Object.freeze({ BAI_API_KEY: 'test-only-bai-key',
  CURRENCY_GENESIS_AUTHORING_PROVIDER: 'bai', CURRENCY_GENESIS_AUTHORING_MODEL: 'gpt-6-luna',
  BAI_API_BASE_URL: 'https://api.b.ai/v1' });
const SPECIFICATION = { name: 'Exchange', symbol: 'EX', meaning: 'A resident expression.', purpose: 'A resident purpose.',
  rationale: null, decimals: null, distribution: null, reserveAmount: null, unallocatedSupplyHandling: null,
  ownershipModel: null, authorityModel: null };
const USAGE = { prompt_tokens: 216, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens: 31,
  total_tokens: 247 };
const JSON_INSTRUCTION = '\n\nReturn exactly the canonical token specification fields required by the structured output schema. Include every key. Use null for each design field the resident has not decided. Do not add aliases, wrapper objects, initialSupply, totalSupply, or other fields. The fixed total supply is a world fact, not an authored specification field. distribution must be null or an array of objects with recipientType, recipientId, recipientAddress, and amount; use only explicit recipient addresses supplied in context.';
const MANDATORY_JSON_INSTRUCTION = '\n\nReturn exactly one complete concrete canonical token specification object required by the structured output schema. Every field must have an actual value: do not return null, an empty or whitespace-only string, an empty array, or an empty object. distribution must contain at least one recipient, and every recipient identity and address must match an entry supplied in availableRecipients. Do not add aliases, wrapper objects, initialSupply, totalSupply, or other fields. The fixed total supply is a world fact, not an authored specification field.';
const SYNTHETIC_RECIPIENT = { type: 'agent', id: 'e2d9c4ae-c749-49cb-9b2d-861699a7114c',
  name: 'Synthetic Agent', address: '0x1111111111111111111111111111111111111111' };
const COMPLETE_SPECIFICATION = { name: 'A synthetic currency', symbol: 'SYN', meaning: 'A test-only unit.',
  purpose: 'Validate mandatory Genesis authoring.', rationale: 'A synthetic rationale for an offline test.', decimals: 0,
  distribution: [{ recipientType: 'agent', recipientId: SYNTHETIC_RECIPIENT.id,
    recipientAddress: SYNTHETIC_RECIPIENT.address, amount: '1000000000' }], reserveAmount: '0',
  unallocatedSupplyHandling: 'fully_distributed', ownershipModel: 'erc20_holder_owned', authorityModel: 'no_mint_no_burn' };
const SYNC_COMPLETE_SPECIFICATION = { name: 'A synthetic currency', symbol: 'SYN', meaning: 'A test-only unit.',
  purpose: 'Validate mandatory SYNC Genesis authoring.', rationale: 'A synthetic rationale for an offline test.',
  decimals: SYNC_TOKENOMICS_FIXED_FIELDS.decimals, distribution: [], reserveAmount: SYNC_GENESIS_RESERVE.toString(),
  unallocatedSupplyHandling: SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling,
  ownershipModel: SYNC_TOKENOMICS_FIXED_FIELDS.ownershipModel,
  authorityModel: SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel };
const SYNC_MANDATORY_JSON_INSTRUCTION = '\n\nReturn exactly one complete canonical SYNC token specification. You author only name, symbol, meaning, purpose, and rationale. Copy the Creator-fixed monetary fields exactly: decimals=6; distribution=[]; reserveAmount="990000000"; unallocatedSupplyHandling="protocol_managed_reserve"; ownershipModel="erc20_holder_owned"; authorityModel="immutable_protocol_rules". The 10,000,000 SYNC Operating Pool is an external fixed genesis allocation; it is not part of distribution and is not an authored field. Do not add initialSupply, totalSupply, aliases, wrapper objects, or other fields.';

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
  assert.deepEqual(Object.keys(body.response_format).sort(), ['json_schema','type']);
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(Object.keys(body.response_format.json_schema).sort(), ['name','schema','strict']);
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
  assert.equal(schema.properties.distribution.items.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), schema.required.slice().sort());
  assert.deepEqual(Object.keys(schema.properties.distribution.items.properties).sort(),
    ['recipientAddress','recipientId','recipientType','amount'].sort());
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
    totalTokens: 247, latencyMs: result.usage.latencyMs, providerReportedCostUsd: null,
    cacheReadTokens: null, cacheWriteTokens: null, uncachedInputTokens: null });
  assert.ok(Number.isSafeInteger(result.usage.latencyMs) && result.usage.latencyMs >= 0);
});

test('mandatory Generation 1 authoring requires every concrete canonical field and includes fixed facts', async () => {
  const input = { resident: { agentId: SYNC_GENESIS_ISSUER_AGENT_ID, currentGoal: 'complete the required currency design' },
    worldFacts: { ...currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' },
      issuerAssignment: { issuerAgentId: SYNC_GENESIS_ISSUER_AGENT_ID, issuerName: 'MirrorTerra-01', capabilityGeneration: 1,
        selectionSource: 'creator_genesis_assignment' } }),
      currencyRequirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: 'UNRESOLVED' },
    currentDesignDraft: { specification: { purpose: 'An earlier synthetic tentative purpose.' },
      incompleteFields: ['name','symbol'] }, availableRecipients: [SYNTHETIC_RECIPIENT] };
  let requestBody;
  const result = await authorAgentCurrencyProposal(input, { env: ENV, completionMode: 'mandatory_genesis',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return chatResponse(SYNC_COMPLETE_SPECIFICATION);
    } });
  const schema = requestBody.response_format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), schema.required.slice().sort());
  for (const property of Object.values(schema.properties)) {
    assert.ok(!Array.isArray(property.type) || !property.type.includes('null'));
  }
  assert.deepEqual(schema.properties.decimals.enum, [6]);
  assert.equal(schema.properties.distribution.maxItems, 0);
  assert.deepEqual(schema.properties.reserveAmount.enum, [SYNC_GENESIS_RESERVE.toString()]);
  assert.deepEqual(schema.properties.unallocatedSupplyHandling.enum, ['protocol_managed_reserve']);
  assert.deepEqual(schema.properties.ownershipModel.enum, ['erc20_holder_owned']);
  assert.deepEqual(schema.properties.authorityModel.enum, ['immutable_protocol_rules']);
  assert.equal(Object.hasOwn(schema.properties, 'initialSupply'), false);
  assert.match(requestBody.messages[0].content, /CURRENCY_GENESIS_REQUIRED is mandatory and unresolved/);
  assert.match(requestBody.messages[0].content, /Do not decide whether to confirm issuance/);
  assert.match(requestBody.messages[0].content, /distribution=\[\]/);
  assert.match(requestBody.messages[1].content, /distribution=\[\]/);
  const context = JSON.parse(requestBody.messages[1].content.slice(0, -SYNC_MANDATORY_JSON_INSTRUCTION.length));
  assert.equal(context.genesisDesignConstraints.requirement, 'CURRENCY_GENESIS_REQUIRED');
  assert.equal(context.genesisDesignConstraints.tokenomicsManifestHash, TOKENOMICS_MANIFEST_HASH);
  assert.equal(context.genesisDesignConstraints.monetaryRules.externalMarketFee.buyFeeBps, 50);
  assert.equal(context.genesisDesignConstraints.monetaryRules.externalMarketFee.sellFeeBps, 50);
  assert.equal(context.genesisDesignConstraints.monetaryRules.externalMarketFee.destination, 'protocol_market_pool');
  assert.equal(context.genesisDesignConstraints.genesisAgentInitialAllocation, '0');
  assert.equal(context.genesisDesignConstraints.worldOperatingPoolGenesis, SYNC_OPERATING_POOL_GENESIS.toString());
  assert.equal(context.genesisDesignConstraints.genesisReserve, SYNC_GENESIS_RESERVE.toString());
  assert.deepEqual(context.genesisDesignConstraints.distribution, []);
  assert.deepEqual(context.currentDesignDraft.specification, { purpose: 'An earlier synthetic tentative purpose.' });
  assert.deepEqual(result.specification, SYNC_COMPLETE_SPECIFICATION);
  assert.equal(result.reason, null);
  assert.equal(result.providerAttempted, true);
});

test('mandatory authoring rejects blank design and recipients absent from the supplied context as no progress', async () => {
  const input = { resident: { agentId: 'synthetic-genesis-issuer' }, availableRecipients: [SYNTHETIC_RECIPIENT] };
  const allNull = Object.fromEntries(Object.keys(COMPLETE_SPECIFICATION).map((field) => [field, null]));
  const blank = { ...COMPLETE_SPECIFICATION, meaning: '   ' };
  const emptyDistribution = { ...COMPLETE_SPECIFICATION, distribution: [] };
  const inventedRecipient = { ...COMPLETE_SPECIFICATION, distribution: [{ ...COMPLETE_SPECIFICATION.distribution[0],
    recipientAddress: '0x2222222222222222222222222222222222222222' }] };
  for (const specification of [allNull, blank, emptyDistribution, inventedRecipient]) {
    const result = await authorAgentCurrencyProposal(input, { env: ENV, completionMode: 'mandatory_genesis',
      fetchImpl: async () => chatResponse(specification) });
    assert.equal(result.reason, 'authoring_invalid_no_progress');
    assert.equal(result.specification, null);
    assert.deepEqual(result.candidate, specification,
      'the invalid model candidate is retained for bounded in-memory repair');
    assert.deepEqual(JSON.parse(result.candidateJson), specification,
      'the original model JSON remains available to the caller');
    assert.equal(result.providerAttempted, true);
    assert.ok(result.validationCode);
  }
});

test('mandatory repair request includes the prior candidate and exact diagnostics without design suggestions', async () => {
  const candidate = { ...COMPLETE_SPECIFICATION, distribution: [{ ...COMPLETE_SPECIFICATION.distribution[0],
    amount: '999999999', operatorNote: 'sk-nested-secret-value-must-not-be-forwarded' }],
    initialSupply: 'not-canonical', apiKey: 'sk-test-secret-value-must-not-be-forwarded' };
  const diagnostics = [{ field: 'distribution/reserveAmount/decimals',
    expected: 'distribution plus reserve equals fixed supply', actual: 'TOKEN_INITIAL_DISTRIBUTION_MUST_EQUAL_FIXED_SUPPLY',
    code: 'TOKEN_INITIAL_DISTRIBUTION_MUST_EQUAL_FIXED_SUPPLY' }];
  const input = { resident: { agentId: 'synthetic-genesis-issuer' },
    worldFacts: { ...currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' },
      issuerAssignment: { issuerName: 'MirrorTerra-01', capabilityGeneration: 1,
        selectionSource: 'creator_genesis_assignment' } }), currencyRequirement: 'CURRENCY_GENESIS_REQUIRED',
      requirementStatus: 'UNRESOLVED' }, availableRecipients: [SYNTHETIC_RECIPIENT] };
  let body;
  const result = await authorAgentCurrencyProposal(input, { env: ENV, completionMode: 'mandatory_genesis',
    repair: { attempt: 1, candidate, diagnostics }, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return chatResponse(COMPLETE_SPECIFICATION);
    } });
  const userMessage = body.messages[1].content;
  const payload = JSON.parse(userMessage.slice(0, userMessage.indexOf('\n\nThis is your own previous design.')));
  assert.equal(payload.genesisDesignConstraints.requirement, 'CURRENCY_GENESIS_REQUIRED');
  assert.deepEqual(payload.previousCandidate, { ...COMPLETE_SPECIFICATION,
    distribution: [{ ...COMPLETE_SPECIFICATION.distribution[0], amount: '999999999' }] });
  assert.equal(Object.hasOwn(payload.previousCandidate, 'initialSupply'), false);
  assert.equal(Object.hasOwn(payload.previousCandidate, 'apiKey'), false);
  assert.deepEqual(payload.validationErrors, diagnostics);
  assert.match(userMessage, /revise the fields that caused them/);
  assert.match(userMessage, /do not use a preset answer/);
  assert.doesNotMatch(userMessage, /suggested token name|recommended symbol|Creator design answer/i);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.specification, COMPLETE_SPECIFICATION);
});

test('mandatory repair payload rejects attempts beyond the two-repair bound', async () => {
  let called = false;
  const result = await authorAgentCurrencyProposal({ resident: { agentId: 'synthetic-genesis-issuer' } }, {
    env: ENV, completionMode: 'mandatory_genesis',
    repair: { attempt: 3, candidate: COMPLETE_SPECIFICATION, diagnostics: [] },
    fetchImpl: async () => { called = true; throw new Error('must not run'); }
  });
  assert.equal(called, false);
  assert.equal(result.reason, 'bai_authoring_repair_context_invalid');
  assert.equal(result.providerAttempted, false);
});

test('mandatory repair payload requires the previous model candidate', async () => {
  let called = false;
  const result = await authorAgentCurrencyProposal({ resident: { agentId: 'synthetic-genesis-issuer' } }, {
    env: ENV, completionMode: 'mandatory_genesis', repair: { attempt: 1, diagnostics: [] },
    fetchImpl: async () => { called = true; throw new Error('must not run'); }
  });
  assert.equal(called, false);
  assert.equal(result.reason, 'bai_authoring_repair_context_invalid');
  assert.equal(result.providerAttempted, false);
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
  const issuerAssignment = { issuerAgentId: SYNC_GENESIS_ISSUER_AGENT_ID, issuerName: 'MirrorTerra-01', capabilityGeneration: 1,
    selectionSource: 'creator_genesis_assignment' };
  const facts = currencyGenesisInfrastructureFacts({ config, requirement: { status: 'UNRESOLVED' }, issuerAssignment });
  assert.equal(facts.tokenomicsVersion, 1);
  assert.equal(facts.tokenomicsManifestHash, TOKENOMICS_MANIFEST_HASH);
  assert.deepEqual(facts.syncGenesisRules.genesisAllocation.agentCreatorDistribution, []);
  assert.equal(facts.syncGenesisRules.externalMarketFee.buyFeeBps, 50);
  assert.equal(facts.syncGenesisRules.externalMarketFee.sellFeeBps, 50);
  assert.equal(facts.syncGenesisRules.externalMarketFee.destination, 'protocol_market_pool');
  assert.equal(facts.onchainStatus, 'not yet created');
  const unassigned = currencyGenesisInfrastructureFacts({ config, requirement: { status: 'UNRESOLVED' },
    issuerAssignment: { ...issuerAssignment, issuerAgentId: '00000000-0000-4000-8000-000000000001' } });
  assert.equal(unassigned.tokenomicsManifestHash, null,
    'Tokenomics v1 must only be disclosed to the formally assigned MirrorTerra-01 issuer');
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
