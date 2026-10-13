import { createHash, randomUUID } from 'node:crypto';
import { actionIdentifier, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { inspectAgentTokenDesign, inspectAgentTokenSpecification, AGENT_TOKEN_PILOT_GENERATION, AGENT_TOKEN_PILOT_MAX_CREATIONS,
  AGENT_TOKEN_HUMAN_SUPPLY, AGENT_TOKEN_AUTHORITY_MODELS,
  AGENT_TOKEN_OWNERSHIP_MODELS, AGENT_TOKEN_UNALLOCATED_SUPPLY_HANDLING } from './arc/token-issuance.js';
import { createWorldExtensionRequest } from './world-v7.js';
import { authorAgentCurrencyProposal, currencyGenesisAuthoringConfig } from './agent-runtime/currency-genesis-authoring.js';
import { currencyGenesisInfrastructureFacts } from './arc/currency-genesis-context.js';
import { parsePositiveIdentityId } from './arc/identity-registry.js';
import { recordInfrastructureUsageEvent } from './infrastructure-metering.js';
import { inspectSyncTokenomicsSpecification, SYNC_GENESIS_RESERVE, SYNC_OPERATING_POOL_GENESIS,
  SYNC_TOTAL_SUPPLY, SYNC_DECIMALS, SYNC_GENESIS_ISSUER_AGENT_ID,
  TOKENOMICS_MANIFEST_HASH } from './arc/sync-tokenomics.js';

const SPEC_FIELDS = ['name','symbol','meaning','purpose','rationale','decimals','distribution','reserveAmount',
  'unallocatedSupplyHandling','ownershipModel','authorityModel'];
const FIELD_LIMITS = Object.freeze({ name: 64, symbol: 12, meaning: 1000, purpose: 1000, rationale: 2000 });
const MAX_GENESIS_AUTHORING_REPAIRS = 2;
const MAX_GENESIS_VALIDATION_DIAGNOSTICS = 64;
const SUPERSEDED_SYNC_PROPOSAL_ID = 'c8973c8b-e71d-49ea-9961-8c043c48b554';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanPartialSpecification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw worldError('TOKEN_SPECIFICATION_INVALID', 400);
  if (Object.keys(input).some((field) => !SPEC_FIELDS.includes(field))) throw worldError('TOKEN_SPECIFICATION_FIELD_INVALID', 400);
  const output = {};
  for (const field of SPEC_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null) { output[field] = null; continue; }
    if (['name','symbol','meaning','purpose','rationale'].includes(field)) {
      const text = requiredText(value, 1, FIELD_LIMITS[field], `token_${field}`);
      if (Buffer.byteLength(text, 'utf8') > FIELD_LIMITS[field]) throw worldError(`TOKEN_${field.toUpperCase()}_INVALID`, 400);
      output[field] = text;
    } else if (field === 'decimals') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 18) throw worldError('TOKEN_DECIMALS_OUT_OF_RANGE', 400);
      output[field] = value;
    } else if (field === 'distribution') {
      if (!Array.isArray(value) || value.length > 256
          || Buffer.byteLength(JSON.stringify(value), 'utf8') > 48_000) throw worldError('TOKEN_DISTRIBUTION_INVALID', 400);
      output[field] = value;
    } else if (field === 'reserveAmount') {
      if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.(\d+))?$/.test(value)) {
        throw worldError('TOKEN_RESERVE_AMOUNT_INVALID', 400);
      }
      output[field] = value;
    } else if (['unallocatedSupplyHandling','ownershipModel','authorityModel'].includes(field)) {
      output[field] = requiredText(value, `token_${field}`, 64);
    }
  }
  return output;
}

function specificationFieldsComplete(input, { tokenomicsV1 = false } = {}) {
  return SPEC_FIELDS.every((field) => input[field] !== undefined && input[field] !== null)
    && Array.isArray(input.distribution) && (tokenomicsV1 || input.distribution.length > 0);
}

function specificationFieldCount(input = {}, { tokenomicsV1 = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 0;
  return SPEC_FIELDS.filter((field) => input[field] !== undefined && input[field] !== null
    && (field !== 'distribution' || (Array.isArray(input.distribution)
      && (tokenomicsV1 || input.distribution.length > 0)))).length;
}

function redactGenesisDiagnosticText(value, max = 2000) {
  if (typeof value !== 'string') return value;
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|secret|private[_-]?key|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:0x)?[A-Fa-f0-9]{64}\b/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function safeGenesisCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valueType: candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate };
  }
  const safe = {};
  for (const field of SPEC_FIELDS) {
    if (!Object.hasOwn(candidate, field)) continue;
    const value = candidate[field];
    if (typeof value === 'string') safe[field] = redactGenesisDiagnosticText(value, FIELD_LIMITS[field] || 256);
    else if (field === 'distribution' && Array.isArray(value)) {
      safe[field] = value.slice(0, 256).map((recipient) => {
        if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) {
          return { valueType: recipient === null ? 'null' : Array.isArray(recipient) ? 'array' : typeof recipient };
        }
        const item = {};
        for (const key of ['recipientType','recipientId','recipientAddress','amount']) {
          if (!Object.hasOwn(recipient, key)) continue;
          const entry = recipient[key];
          item[key] = typeof entry === 'string' ? redactGenesisDiagnosticText(entry, 128)
            : entry === null || typeof entry === 'number' || typeof entry === 'boolean' ? entry
              : { valueType: Array.isArray(entry) ? 'array' : typeof entry };
        }
        return item;
      });
      if (value.length > 256) safe.distributionTruncatedCount = value.length - 256;
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') safe[field] = value;
    else safe[field] = { valueType: Array.isArray(value) ? 'array' : typeof value };
  }
  return safe;
}

function safeGenesisDiagnostics(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : []).slice(0, MAX_GENESIS_VALIDATION_DIAGNOSTICS)
    .map((item) => ({
      field: redactGenesisDiagnosticText(String(item?.field || 'specification'), 120),
      expected: redactGenesisDiagnosticText(String(item?.expected || 'valid canonical value'), 240),
      actual: redactGenesisDiagnosticText(String(item?.actual || 'validation failed'), 240),
      code: redactGenesisDiagnosticText(String(item?.code || 'canonical_validation_failed'), 120)
    }));
}

function tokenValidationDiagnostic(error) {
  const code = String(error?.code || error?.message || 'TOKEN_SPECIFICATION_INVALID').slice(0, 120);
  const fixedField = /^SYNC_SPEC_FIXED_FIELD_MISMATCH:(.+)$/.exec(code)?.[1];
  if (fixedField) return { field: fixedField, expected: 'the exact immutable SYNC Tokenomics v1.0 manifest value',
    actual: 'candidate differs from Creator-fixed monetary policy', code: 'tokenomics_fixed_field_mismatch' };
  const syncField = /^SYNC_SPEC_(NAME|SYMBOL|MEANING|PURPOSE|RATIONALE)_/.exec(code)?.[1];
  if (syncField) return { field: syncField.toLowerCase(), expected: 'a non-empty Agent-authored descriptive field',
    actual: code, code };
  if (code === 'SYNC_SPEC_GENESIS_SUPPLY_INVARIANT_FAILED') return {
    field: 'distribution/reserveAmount/operatingPoolGenesis',
    expected: '10,000,000 Operating Pool + 990,000,000 Reserve + 0 initial distribution = 1,000,000,000',
    actual: 'fixed Genesis allocation invariant failed', code };
  const rules = {
    TOKEN_INITIAL_DISTRIBUTION_MUST_EQUAL_FIXED_SUPPLY: {
      field: 'distribution/reserveAmount/decimals',
      expected: 'distribution plus reserve equals the fixed 1,000,000,000 supply at the selected decimals'
    },
    TOKEN_PRIMITIVE_SEMANTICS_UNSUPPORTED: {
      field: 'unallocatedSupplyHandling/ownershipModel/authorityModel',
      expected: 'the selected reserve handling, ownership, and authority values form a supported combination'
    },
    TOKEN_PRIMITIVE_CHOICE_UNSUPPORTED: {
      field: 'unallocatedSupplyHandling/ownershipModel/authorityModel',
      expected: 'each value is supported by the existing token implementation'
    },
    TOKEN_DISTRIBUTION_DUPLICATE_ADDRESS: {
      field: 'distribution', expected: 'recipient addresses are unique'
    },
    TOKEN_DISTRIBUTION_INVALID: {
      field: 'distribution', expected: 'an array of at most 256 canonical recipient entries'
    },
    TOKEN_RESERVE_AMOUNT_INVALID: {
      field: 'reserveAmount', expected: 'a non-negative human-readable amount with valid decimal precision'
    },
    TOKEN_RESERVE_AMOUNT_MUST_BE_POSITIVE: {
      field: 'reserveAmount', expected: 'a positive reserve for reserve or locked handling'
    },
    TOKEN_DECIMALS_OUT_OF_RANGE: {
      field: 'decimals', expected: 'an integer from 0 through 18'
    },
    TOKEN_SYMBOL_INVALID: {
      field: 'symbol', expected: '1 to 12 letters, digits, dot, underscore, or hyphen'
    },
    TOKEN_SUPPLY_OUT_OF_RANGE: {
      field: 'decimals', expected: 'fixed supply scaled by decimals fits uint256'
    }
  };
  if (rules[code]) return { ...rules[code], actual: code, code };
  const recipientRule = /^TOKEN_DISTRIBUTION_(ADDRESS_INVALID|ID_REQUIRED|TYPE_INVALID|EXTERNAL_ID_FORBIDDEN)_(\d+)$/.exec(code);
  if (recipientRule) {
    const [,, index] = recipientRule;
    const expected = recipientRule[1] === 'ADDRESS_INVALID' ? 'a nonzero valid recipient address'
      : recipientRule[1] === 'ID_REQUIRED' ? 'a UUID recipient id for an Agent or organization'
        : recipientRule[1] === 'TYPE_INVALID' ? 'recipientType is agent, organization, or external'
          : 'external recipientId is null';
    return { field: `distribution[${index}]`, expected, actual: code, code };
  }
  const fieldRule = /^TOKEN_(NAME|SYMBOL|MEANING|PURPOSE|RATIONALE|RESERVE_AMOUNT|UNALLOCATED_SUPPLY_HANDLING|OWNERSHIP_MODEL|AUTHORITY_MODEL)_/.exec(code);
  const fieldNames = { NAME: 'name', SYMBOL: 'symbol', MEANING: 'meaning', PURPOSE: 'purpose',
    RATIONALE: 'rationale', RESERVE_AMOUNT: 'reserveAmount',
    UNALLOCATED_SUPPLY_HANDLING: 'unallocatedSupplyHandling', OWNERSHIP_MODEL: 'ownershipModel',
    AUTHORITY_MODEL: 'authorityModel' };
  const field = fieldRule ? fieldNames[fieldRule[1]] : 'specification';
  return { field, expected: 'a concrete value accepted by the existing canonical token validator', actual: code, code };
}

function validateMandatoryGenesisCandidate(candidate, input, adapterDiagnostics = []) {
  const diagnostics = [...(Array.isArray(adapterDiagnostics) ? adapterDiagnostics : [])];
  const tokenomicsV1 = input.worldFacts?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  let specification;
  try { specification = cleanPartialSpecification(candidate); }
  catch (error) {
    diagnostics.push(tokenValidationDiagnostic(error));
    return { complete: false, specification: null, diagnostics: safeGenesisDiagnostics(diagnostics) };
  }

  for (const field of SPEC_FIELDS) {
    const value = specification[field];
    const concrete = value !== undefined && value !== null
      && (typeof value !== 'string' || value.trim().length > 0)
      && (field !== 'distribution' || (Array.isArray(value) && (tokenomicsV1 || value.length > 0)));
    if (!concrete && !diagnostics.some((item) => item?.field === field)) {
      diagnostics.push({ field, expected: 'concrete non-empty canonical value',
        actual: value === undefined ? 'missing' : value === null ? 'null'
          : typeof value === 'string' ? 'empty or whitespace-only string' : 'empty collection',
        code: 'field_not_concrete' });
    }
  }
  if (!specificationFieldsComplete(specification, { tokenomicsV1 })) {
    return { complete: false, specification, diagnostics: safeGenesisDiagnostics(diagnostics) };
  }

  for (const [index, recipient] of specification.distribution.entries()) {
    const found = input.availableRecipients?.some((available) => available.type === recipient.recipientType
      && (recipient.recipientId === null ? available.id === '' : available.id === recipient.recipientId)
      && String(available.address || '').toLowerCase() === recipient.recipientAddress.toLowerCase());
    if (!found) diagnostics.push({ field: `distribution[${index}]`,
      expected: 'recipient identity and address present in availableRecipients',
      actual: 'recipient not found in supplied context', code: 'distribution_recipient_not_in_context' });
  }

  try {
    if (tokenomicsV1) inspectSyncTokenomicsSpecification(specification);
    else {
      const design = inspectAgentTokenDesign(specification);
      if (!design.complete) for (const field of design.blockers || []) diagnostics.push({ field,
        expected: 'concrete value accepted by the existing canonical token validator',
        actual: 'incomplete', code: 'canonical_field_incomplete' });
    }
  } catch (error) { diagnostics.push(tokenValidationDiagnostic(error)); }
  return { complete: diagnostics.length === 0, specification,
    diagnostics: safeGenesisDiagnostics(diagnostics) };
}

function authoringExceptionReason(error) {
  const name = String(error?.name || '').toLowerCase();
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  if (name.includes('timeout') || name === 'aborterror'
      || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR'].includes(code)) return 'bai_authoring_timeout';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return 'bai_authoring_unavailable';
  }
  return 'bai_authoring_provider_error';
}

function authoringOutcome(reason, fieldCount) {
  if (reason === 'authoring_invalid_no_progress') return { outcome: 'invalid_no_progress', reasonCode: reason };
  if (!reason) return fieldCount > 0 ? { outcome: 'expressed', reasonCode: null } : {
    outcome: 'other', reasonCode: 'no_fields_returned'
  };
  const httpStatus = /^(?:bai|local)_authoring_http_(\d{3})$/.exec(reason)?.[1];
  if (httpStatus === '408' || httpStatus === '504') return { outcome: 'provider_timeout', reasonCode: reason };
  if (httpStatus === '429' || Number(httpStatus) >= 500) return { outcome: 'provider_unavailable', reasonCode: reason };
  if (['bai_authoring_timeout', 'local_authoring_timeout'].includes(reason)) {
    return { outcome: 'provider_timeout', reasonCode: reason };
  }
  if (['bai_authoring_unavailable', 'local_authoring_unavailable'].includes(reason)) {
    return { outcome: 'provider_unavailable', reasonCode: reason };
  }
  if (['bai_authoring_response_invalid', 'bai_authoring_response_too_large',
    'bai_authoring_content_invalid', 'bai_authoring_content_too_large',
    'bai_authoring_specification_invalid', 'local_authoring_response_invalid',
    'local_authoring_response_too_large', 'local_authoring_content_invalid',
    'local_authoring_specification_invalid'].includes(reason)) {
    return { outcome: 'malformed_output', reasonCode: reason };
  }
  return { outcome: 'provider_error', reasonCode: reason };
}

async function recordCurrencyGenesisAuthoringOutcome(client, { worldId, agent, worldMinute,
  selectedAction, authoring, specification, authoringAttempts = [] }) {
  const tokenomicsV1 = authoring?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  const fieldCount = specificationFieldCount(specification, { tokenomicsV1 });
  const result = authoringOutcome(authoring.reason || null, fieldCount);
  const attempts = authoringAttempts.length ? authoringAttempts : [{ authoring }];
  const actionId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute,
    action: `authoring-outcome:${selectedAction}` });
  const reasonCode = typeof result.reasonCode === 'string'
    ? result.reasonCode.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : null;
  const provider = typeof authoring.provider === 'string' && authoring.provider.length
    ? authoring.provider.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120)
    : currencyGenesisAuthoringConfig.provider;
  const model = typeof authoring.model === 'string' && authoring.model.length
    ? authoring.model.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : currencyGenesisAuthoringConfig.model;
  const providerAttempts = attempts.filter((attempt) => attempt.authoring?.providerAttempted === true);
  const providerCallIds = providerAttempts.map((attempt) => attempt.authoring?.callId)
    .filter((callId) => typeof callId === 'string' && uuidPattern.test(callId));
  const attemptDiagnostics = attempts.map((attempt, index) => {
    const attemptAuthoring = attempt.authoring || {};
    const diagnostics = safeGenesisDiagnostics(attempt.diagnostics || attemptAuthoring.validationDiagnostics);
    return {
      attempt: index + 1,
      callId: typeof attemptAuthoring.callId === 'string' && uuidPattern.test(attemptAuthoring.callId)
        ? attemptAuthoring.callId : null,
      providerAttempted: attemptAuthoring.providerAttempted === true,
      reasonCode: typeof attemptAuthoring.reason === 'string'
        ? attemptAuthoring.reason.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : null,
      validationCode: typeof attemptAuthoring.validationCode === 'string'
        ? attemptAuthoring.validationCode.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : null,
      validationDiagnostics: diagnostics,
      ...(diagnostics.length && Object.hasOwn(attempt, 'candidate')
        ? { invalidCandidate: safeGenesisCandidate(attempt.candidate) } : {})
    };
  });
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,'currency_genesis.authoring_outcome',
      'currency_genesis_authoring',$3,$4,$5::jsonb,$6) ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agent.agentId, worldId, worldMinute, JSON.stringify({ selectedAction,
    provider, model, outcome: result.outcome, reasonCode, providerAttempted: authoring.providerAttempted === true,
    validationCode: typeof authoring.validationCode === 'string'
      ? authoring.validationCode.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : null,
    callId: typeof authoring.callId === 'string' && uuidPattern.test(authoring.callId) ? authoring.callId : null,
    providerAttemptCount: providerAttempts.length, providerCallIds,
    providerStatus: Number.isSafeInteger(authoring.providerStatus) ? authoring.providerStatus : null,
    providerCode: typeof authoring.providerCode === 'string' ? authoring.providerCode : null,
    providerParam: typeof authoring.providerParam === 'string' ? authoring.providerParam : null,
    specificationFieldCount: fieldCount, authoringAttemptCount: attempts.length,
    attempts: attemptDiagnostics }), actionId]);
  for (let index = 0; index < attempts.length; index += 1) {
    const attemptAuthoring = attempts[index].authoring || {};
    if (attemptAuthoring.providerAttempted !== true) continue;
    const callId = typeof attemptAuthoring.callId === 'string' && uuidPattern.test(attemptAuthoring.callId)
      ? attemptAuthoring.callId : randomUUID();
    const usage = attemptAuthoring.usage && typeof attemptAuthoring.usage === 'object' ? attemptAuthoring.usage : {};
    const inputTokens = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 ? usage.inputTokens : null;
    const cachedInputTokens = Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens >= 0
      ? usage.cachedInputTokens : null;
    const outputTokens = Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 ? usage.outputTokens : null;
    const totalTokens = Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : null;
    const latencyMs = Number.isSafeInteger(usage.latencyMs) && usage.latencyMs >= 0 ? usage.latencyMs : null;
    const providerReportedCostUsd = Number.isFinite(usage.providerReportedCostUsd)
      && usage.providerReportedCostUsd >= 0 ? usage.providerReportedCostUsd : null;
    const hasProviderCost = providerReportedCostUsd !== null;
    const costMicrounits = hasProviderCost ? String(Math.round(providerReportedCostUsd * 1_000_000)) : null;
    const attemptOutcome = attempts[index].diagnostics?.length
      ? authoringOutcome('authoring_invalid_no_progress',
        specificationFieldCount(attempts[index].candidate || attemptAuthoring.specification, { tokenomicsV1 }))
      : authoringOutcome(attemptAuthoring.reason || null,
        specificationFieldCount(attempts[index].candidate || attemptAuthoring.specification, { tokenomicsV1 }));
    await recordInfrastructureUsageEvent(client, { worldId, attributionType: 'agent', agentId: agent.agentId,
      actionId: `${actionId}:usage:${callId}`, resourceCategory: 'ai_inference', provider, model, worldMinute,
      quantityRaw: '1', unit: 'provider_request', costStatus: hasProviderCost ? 'actual' : 'unpriced',
      costCurrency: hasProviderCost ? 'USD' : null, costMicrounits,
      costEvidenceSource: hasProviderCost ? 'provider_reported' : null,
      metadata: { cognitionType: 'currency_genesis_authoring', callId, selectedAction, attempt: index + 1,
        outcome: attemptOutcome.outcome, errorCode: attemptAuthoring.reason || null, providerAttempted: true,
        inputTokens, cachedInputTokens, outputTokens, totalTokens, latencyMs } });
  }
}

function unsupportedPrimitiveChoices(input, { tokenomicsV1 = false } = {}) {
  if (tokenomicsV1 && input.unallocatedSupplyHandling === 'protocol_managed_reserve'
      && input.ownershipModel === 'erc20_holder_owned' && input.authorityModel === 'immutable_protocol_rules') return [];
  const choices = [];
  if (input.unallocatedSupplyHandling != null
      && !Object.hasOwn(AGENT_TOKEN_UNALLOCATED_SUPPLY_HANDLING, input.unallocatedSupplyHandling)) {
    choices.push({ field: 'unallocatedSupplyHandling', value: input.unallocatedSupplyHandling });
  }
  if (input.ownershipModel != null && !Object.hasOwn(AGENT_TOKEN_OWNERSHIP_MODELS, input.ownershipModel)) {
    choices.push({ field: 'ownershipModel', value: input.ownershipModel });
  }
  if (input.authorityModel != null && !Object.hasOwn(AGENT_TOKEN_AUTHORITY_MODELS, input.authorityModel)) {
    choices.push({ field: 'authorityModel', value: input.authorityModel });
  }
  return choices;
}

function specificationComplete(input, issuerAgentId, { tokenomicsV1 = false } = {}) {
  return Boolean(issuerAgentId) && specificationFieldsComplete(input, { tokenomicsV1 })
    && unsupportedPrimitiveChoices(input, { tokenomicsV1 }).length === 0;
}

function stablePayloadHash(value) {
  return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function recordIssuanceEvent(client, { worldId, agentId, intentId, eventType, worldMinute, actionId, details }) {
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,world_minute,details,action_id)
    VALUES($1,$2,$3,'agent_token_issuance',$4,$5,$6::jsonb,$7) ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agentId, eventType, intentId, worldMinute, JSON.stringify(details), `token-issuance:${actionId}`]);
}

async function readIntent(client, worldId, intentId, lock = false) {
  const result = await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [worldId, intentId]);
  if (!result.rowCount) throw worldError('TOKEN_ISSUANCE_INTENT_NOT_FOUND', 404);
  return result.rows[0];
}

export async function supersedeLegacySyncGenesisProposal(client, { worldId, intentId, worldMinute,
  reason = 'creator_genesis_tokenomics_v1' }) {
  if (intentId !== SUPERSEDED_SYNC_PROPOSAL_ID || reason !== 'creator_genesis_tokenomics_v1') {
    throw worldError('SYNC_LEGACY_PROPOSAL_SUPERSEDE_TARGET_INVALID', 400);
  }
  const intent = await readIntent(client, worldId, intentId, true);
  if (intent.status === 'superseded') {
    if (intent.superseded_reason !== reason || intent.issuer_agent_id !== SYNC_GENESIS_ISSUER_AGENT_ID) {
      throw worldError('SYNC_LEGACY_PROPOSAL_SUPERSEDE_CONFLICT', 409);
    }
    return { intent, idempotent: true };
  }
  if (!['proposed','issuer_confirmed'].includes(intent.status)
      || intent.issuer_agent_id !== SYNC_GENESIS_ISSUER_AGENT_ID
      || Number(intent.capability_generation) !== 1
      || intent.issuer_selection_source !== 'creator_genesis_assignment'
      || intent.transaction_hash || intent.prepared_calldata) {
    throw worldError('SYNC_LEGACY_PROPOSAL_NOT_SAFE_TO_SUPERSEDE', 409);
  }
  const deployed = await client.query('SELECT 1 FROM arc_agent_tokens WHERE world_id=$1 AND intent_id=$2 LIMIT 1',
    [worldId, intentId]);
  if (deployed.rowCount) throw worldError('SYNC_LEGACY_PROPOSAL_ALREADY_DEPLOYED', 409);
  const minute = Math.max(Number(intent.updated_world_minute) || 0, Math.trunc(Number(worldMinute) || 0));
  const result = await client.query(`UPDATE arc_token_issuance_intents SET status='superseded',
      superseded_reason=$3,superseded_from_status=$4,superseded_world_minute=$5,
      updated_world_minute=$5,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status=$4 RETURNING *`,
  [worldId, intentId, reason, intent.status, minute]);
  if (!result.rowCount) throw worldError('SYNC_LEGACY_PROPOSAL_STATE_CHANGED', 409);
  const actionId = `sync-v1-supersede:${createHash('sha256').update(`${worldId}:${intentId}:${reason}`).digest('hex').slice(0, 40)}`;
  await recordIssuanceEvent(client, { worldId, agentId: SYNC_GENESIS_ISSUER_AGENT_ID, intentId,
    eventType: 'token_issuance_superseded', worldMinute: minute, actionId,
    details: { reason, fromStatus: intent.status, preservedSpecificationHash: intent.specification_hash || null,
      confirmationRowsPreserved: true, proposalHistoryPreserved: true } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuance-superseded:${intentId}`,
    eventType: 'token_issuance_superseded', actorAgentId: SYNC_GENESIS_ISSUER_AGENT_ID,
    entityType: 'agent_token_issuance', entityId: intentId, worldTime: minute,
    title: 'Legacy SYNC proposal superseded by Tokenomics v1.0',
    detail: 'The historical proposal, specification, provenance, and prior confirmation remain intact; it is closed for new execution in favor of a fresh manifest-bound design.',
    metadata: { intentId, reason, fromStatus: intent.status, confirmationPreserved: true,
      specificationHash: intent.specification_hash || null } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute: minute });
  return { intent: result.rows[0], idempotent: false };
}

export async function ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute }) {
  await client.query(`INSERT INTO arc_currency_genesis_requirements(world_id,capability_generation,status,
      first_required_world_minute,last_transition_world_minute)
    SELECT $1,1,'UNRESOLVED',$2,$2 FROM worlds WHERE id=$1 ON CONFLICT(world_id) DO NOTHING`,
  [worldId, worldMinute]);
  const requirement = await client.query(`SELECT * FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
  if (!requirement.rowCount) throw worldError('CURRENCY_GENESIS_REQUIREMENT_NOT_FOUND', 409);
  return requirement.rows[0];
}

export async function refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute }) {
  const current = await ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  if (current.status === 'SATISFIED') return current;
  const active = await client.query(`SELECT intent.id,intent.status,intent.issuer_agent_id,
      intent.issuer_identity_id::text AS issuer_identity_id,
      intent.metadata->>'executionStatus' AS execution_status,
      EXISTS(SELECT 1 FROM arc_token_issuance_issuer_candidates candidate
        WHERE candidate.world_id=intent.world_id AND candidate.intent_id=intent.id
          AND candidate.status='nominated') AS has_nomination
    FROM arc_token_issuance_intents intent
    WHERE intent.world_id=$1 AND intent.status NOT IN ('created','rejected','failed','extension_requested','superseded',
      'deferred_until_multi_asset_capability')
    ORDER BY intent.updated_world_minute DESC,intent.id DESC`, [worldId]);
  const executionReady = active.rows.some((row) => ['preparing','prepared','submitting',
    'submission_unknown','submitted'].includes(row.status)
      && row.execution_status === 'identity_verified'
      && /^[1-9]\d*$/.test(String(row.issuer_identity_id || '')));
  const issuerConfirmed = active.rows.some((row) => row.status === 'issuer_confirmed');
  const selected = active.rows.some((row) => row.issuer_agent_id !== null);
  const candidatePending = active.rows.some((row) => row.has_nomination);
  const proposalFormed = active.rows.some((row) => ['incomplete','proposed','deferred','budget_blocked'].includes(row.status));
  const status = executionReady ? 'EXECUTION_READY' : issuerConfirmed ? 'ISSUER_CONFIRMED'
    : selected ? 'ISSUER_SELECTED'
    : candidatePending ? 'ISSUER_CANDIDATE' : proposalFormed ? 'PROPOSAL_FORMED'
      : active.rowCount ? 'DELIBERATING' : 'UNRESOLVED';
  const proposalId = active.rows[0]?.id || null;
  const updated = await client.query(`UPDATE arc_currency_genesis_requirements SET status=$2,current_proposal_id=$3,
      last_transition_world_minute=CASE WHEN status IS DISTINCT FROM $2 THEN $4 ELSE last_transition_world_minute END,
      updated_at=now() WHERE world_id=$1 AND status<>'SATISFIED' RETURNING *`,
  [worldId, status, proposalId, worldMinute]);
  return updated.rows[0] || current;
}

async function recordRequirementAwareness(client, { worldId, agent, requirement, worldMinute }) {
  const summary = requirement.status === 'SATISFIED'
    ? 'The world has established its first reconciled currency; future asset ideas remain optional.'
    : 'The world has a mandatory unresolved requirement to establish its first currency. The resident owns every design choice and may continue design without submitting a proposal in this review.';
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
      location,metadata,consolidation_key,long_term)
    VALUES($1,$2,'world_currency_requirement',$3,0.35,$4,$5,$6::jsonb,'currency-genesis-requirement',true)
    ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL
    DO UPDATE SET summary=EXCLUDED.summary,importance=EXCLUDED.importance,world_minutes=EXCLUDED.world_minutes,
      location=EXCLUDED.location,metadata=EXCLUDED.metadata,long_term=true`,
  [worldId, agent.agentId, summary, worldMinute, agent.location || null,
    JSON.stringify({ requirement: 'CURRENCY_GENESIS_REQUIRED', status: requirement.status,
      sourceOfTruth: 'arc_currency_genesis_requirements', satisfiedOnlyAfterReconciliation: true })]);
}

export function agentTokenSpecificationFromIntentRow(row) {
  return { name: row.name, symbol: row.symbol, meaning: row.meaning, purpose: row.purpose,
    rationale: row.rationale, decimals: row.decimals === null ? null : Number(row.decimals),
    distribution: row.metadata?.agentSpecification?.distribution ?? [],
    reserveAmount: row.metadata?.agentSpecification?.reserveAmount ?? null,
    unallocatedSupplyHandling: row.unallocated_supply_handling ?? null,
    ownershipModel: row.ownership_model ?? null, authorityModel: row.authority_model ?? null };
}

function openFieldBlockers(specification, issuerAgentId, { tokenomicsV1 = false } = {}) {
  return [...(!issuerAgentId ? ['issuerAgentId'] : []), ...SPEC_FIELDS.filter((field) =>
    specification[field] === undefined || specification[field] === null),
  ...(Array.isArray(specification.distribution) && (tokenomicsV1 || specification.distribution.length) ? [] : ['distribution']),
  ...unsupportedPrimitiveChoices(specification, { tokenomicsV1 }).map((choice) => `${choice.field}:unsupported`)].filter((field, index, all) => all.indexOf(field) === index);
}

async function saveIntent(client, { worldId, proposerAgentId, issuerAgentId = null, specification,
  actionId, worldMinute, capabilityGeneration = AGENT_TOKEN_PILOT_GENERATION, decisionPath = 'agent_api',
  authoring = null, intentId = null, prior = null }) {
  if (issuerAgentId !== null) {
    if (!uuidPattern.test(issuerAgentId)) throw worldError('TOKEN_ISSUER_AGENT_ID_INVALID', 400);
    await requireWorldMember(client, worldId, issuerAgentId);
  }
  const tokenomicsV1 = authoring?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  if (tokenomicsV1) inspectSyncTokenomicsSpecification(specification);
  const unsupported = unsupportedPrimitiveChoices(specification, { tokenomicsV1 });
  const complete = specificationComplete(specification, issuerAgentId, { tokenomicsV1 });
  const proposalFormed = specificationFieldsComplete(specification, { tokenomicsV1 });
  const status = unsupported.length ? 'extension_requested' : proposalFormed ? 'proposed' : 'incomplete';
  const metadata = { ...(prior?.metadata || {}), agentSpecification: specification,
    incompleteFields: openFieldBlockers(specification, issuerAgentId, { tokenomicsV1 }), requestHash: stablePayloadHash({ issuerAgentId, specification }),
    ...(tokenomicsV1 ? { tokenomicsVersion: 1, tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}),
    ...(authoring ? { localAuthoring: { provider: authoring.provider || currencyGenesisAuthoringConfig.provider,
      model: authoring.model || null, status: authoring.status || 'incomplete', reason: authoring.reason || null } } : {}),
    ...(unsupported.length ? { unsupportedPrimitiveChoices: unsupported } : {}),
    lastActionId: actionId };
  if (prior) {
    const updated = await client.query(`UPDATE arc_token_issuance_intents SET issuer_agent_id=$3,status=$4,
        name=$5,symbol=$6,meaning=$7,purpose=$8,rationale=$9,decimals=$10,distribution=$11::jsonb,
        unallocated_supply_handling=$12,ownership_model=$13,authority_model=$14,
        related_goal_id=$15,related_concept_id=$16,related_capability_id=$17,
        metadata=$18::jsonb,updated_world_minute=$19,updated_at=now()
      WHERE world_id=$1 AND id=$2 RETURNING *`, [worldId, intentId, issuerAgentId, status,
      specification.name ?? null, specification.symbol ?? null, specification.meaning ?? null,
      specification.purpose ?? null, specification.rationale ?? null, specification.decimals ?? null,
      JSON.stringify(specification.distribution ?? []), specification.unallocatedSupplyHandling ?? null,
      specification.ownershipModel ?? null, specification.authorityModel ?? null,
      prior.related_goal_id ?? null, prior.related_concept_id ?? null, prior.related_capability_id ?? null,
      JSON.stringify(metadata), worldMinute]);
    return { row: updated.rows[0], created: false, complete };
  }
  const inserted = await client.query(`INSERT INTO arc_token_issuance_intents(world_id,proposer_agent_id,issuer_agent_id,
      capability_generation,status,decision_path,name,symbol,meaning,purpose,rationale,decimals,
      unallocated_supply_handling,ownership_model,authority_model,related_goal_id,related_concept_id,related_capability_id,
      initial_supply_human,distribution,created_world_minute,updated_world_minute,action_id,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$21,$22,$23::jsonb)
    ON CONFLICT(world_id,proposer_agent_id,action_id) DO NOTHING RETURNING *`, [worldId, proposerAgentId,
    issuerAgentId, capabilityGeneration, status, decisionPath, specification.name ?? null, specification.symbol ?? null,
    specification.meaning ?? null, specification.purpose ?? null, specification.rationale ?? null,
    specification.decimals ?? null, specification.unallocatedSupplyHandling ?? null,
    specification.ownershipModel ?? null, specification.authorityModel ?? null,
    null, null, null, AGENT_TOKEN_HUMAN_SUPPLY, JSON.stringify(specification.distribution ?? []),
    worldMinute, actionId, JSON.stringify(metadata)]);
  if (inserted.rowCount) return { row: inserted.rows[0], created: true, complete };
  const existing = (await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND proposer_agent_id=$2 AND action_id=$3`, [worldId, proposerAgentId, actionId])).rows[0];
  if (!existing || existing.metadata?.requestHash !== metadata.requestHash) throw worldError('ACTION_ID_CONFLICT', 409);
  return { row: existing, created: false, complete, idempotent: true };
}

async function preserveUnsupportedPrimitiveRequest(client, { worldId, agentId, intent, specification, worldMinute, actionId,
  tokenomicsV1 = false }) {
  const choices = unsupportedPrimitiveChoices(specification, { tokenomicsV1 });
  if (!choices.length) return null;
  const title = `Currency design needs an unsupported primitive (${choices[0].field})`;
  const description = `This resident-authored currency proposal selects a primitive not supported by the current fixed token implementation. The proposal remains preserved as incomplete until the world can express the selected choice: ${choices.map((choice) => `${choice.field}=${String(choice.value).slice(0, 80)}`).join('; ')}.`;
  return createWorldExtensionRequest(client, { worldId, agentId, requestType: 'primitive_gap', title,
    description, evidence: { source: 'agent_authored_currency_specification', intentId: intent.id,
      unsupportedChoices: choices, specificationHash: stablePayloadHash(specification) }, worldMinute,
    actionId: `currency-extension-${createHash('sha256').update(`${intent.id}:${actionId}`).digest('hex').slice(0, 40)}` });
}

export async function createWorldTokenIssuanceIntent(client, { worldId, agentId, issuerAgentId = null,
  specification = {}, actionId, worldMinute, decisionPath = 'agent_api', authoring = null }) {
  await requireWorldMember(client, worldId, agentId);
  if (issuerAgentId !== null) throw worldError('TOKEN_ISSUER_SELECTION_REQUIRES_AGENT_INTERACTION', 400);
  if (!['agent_api','world_engine'].includes(decisionPath)) throw worldError('TOKEN_DECISION_PATH_INVALID', 400);
  const idempotencyKey = actionIdentifier(actionId);
  const cleanSpecification = cleanPartialSpecification(specification);
  const capability = await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
    WHERE world_id=$1 AND status='active' ORDER BY capability_generation DESC LIMIT 1`, [worldId]);
  const capabilityGeneration = Number(capability.rows[0]?.capability_generation || AGENT_TOKEN_PILOT_GENERATION);
  const saved = await saveIntent(client, { worldId, proposerAgentId: agentId, issuerAgentId,
    specification: cleanSpecification, actionId: idempotencyKey, worldMinute, capabilityGeneration,
    decisionPath, authoring });
  if (capabilityGeneration === 1 && !saved.row.issuer_agent_id) {
    const assignment = await creatorGenesisIssuerAssignment(client, worldId, capabilityGeneration);
    if (assignment) {
      const tokenomicsV1 = authoring?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
      const incompleteFields = openFieldBlockers(cleanSpecification, assignment.issuerAgentId, { tokenomicsV1 });
      const assigned = await client.query(`UPDATE arc_token_issuance_intents SET issuer_agent_id=$3,
          issuer_selection_source=$4,metadata=jsonb_set(metadata,'{incompleteFields}',$5::jsonb),updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed') RETURNING *`,
      [worldId, saved.row.id, assignment.issuerAgentId, assignment.selectionSource, JSON.stringify(incompleteFields)]);
      if (assigned.rowCount) {
        saved.row = assigned.rows[0];
        saved.complete = specificationComplete(cleanSpecification, assignment.issuerAgentId, { tokenomicsV1 });
      }
    }
  }
  if (!saved.idempotent) {
    const eventType = saved.row.status === 'extension_requested' ? 'token_issuance_extension_requested'
      : saved.row.status === 'proposed' ? 'token_issuance_proposed' : 'token_issuance_incomplete';
    await recordIssuanceEvent(client, { worldId, agentId, intentId: saved.row.id, eventType,
      worldMinute, actionId: `${idempotencyKey}:created`, details: { status: saved.row.status,
        incompleteFields: saved.row.metadata.incompleteFields } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-proposed:${saved.row.id}`,
      eventType: 'token_issuance_proposed', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: saved.row.id, worldTime: worldMinute, title: 'Agent proposed a token issuance',
      detail: saved.complete ? 'An Agent submitted an issuance specification for the world to consider.'
        : 'An Agent recorded an incomplete token issuance intent; missing fields remain undecided.',
      metadata: { intentId: saved.row.id, status: saved.row.status, incompleteFields: saved.row.metadata.incompleteFields } });
    await preserveUnsupportedPrimitiveRequest(client, { worldId, agentId, intent: saved.row,
      specification: cleanSpecification, worldMinute, actionId: idempotencyKey,
      tokenomicsV1: authoring?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH });
  }
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intent: saved.row, created: saved.created, idempotent: Boolean(saved.idempotent), complete: saved.complete };
}

export async function updateWorldTokenIssuanceSpecification(client, { worldId, agentId, intentId,
  specification, issuerAgentId, actionId, worldMinute, authoring = null }) {
  await requireWorldMember(client, worldId, agentId);
  if (issuerAgentId !== undefined) throw worldError('TOKEN_ISSUER_SELECTION_REQUIRES_AGENT_INTERACTION', 400);
  const idempotencyKey = actionIdentifier(actionId);
  const intent = await readIntent(client, worldId, intentId, true);
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_NOT_OPEN_FOR_RESPONSE', 409);
  if (![intent.proposer_agent_id, intent.issuer_agent_id].includes(agentId)) throw worldError('TOKEN_ISSUANCE_EDITOR_REQUIRED', 403);
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_ALREADY_FINALIZED', 409);
  const priorSpec = agentTokenSpecificationFromIntentRow(intent);
  const tokenomicsV1 = intent.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  if (tokenomicsV1 && authoring?.tokenomicsManifestHash !== TOKENOMICS_MANIFEST_HASH) {
    throw worldError('SYNC_TOKENOMICS_MANIFEST_CONTEXT_REQUIRED', 409);
  }
  const patch = cleanPartialSpecification(specification);
  const merged = { ...priorSpec, ...patch };
  const nextIssuer = intent.issuer_agent_id;
  const requestHash = stablePayloadHash({ issuerAgentId: nextIssuer, specification: merged });
  const priorAction = await client.query(`SELECT details FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`,
  [worldId, agentId, `token-issuance:${idempotencyKey}:updated`]);
  if (priorAction.rowCount) {
    if (priorAction.rows[0].details?.requestHash !== requestHash) throw worldError('ACTION_ID_CONFLICT', 409);
    return { intent, complete: specificationComplete(merged, nextIssuer, { tokenomicsV1 }), idempotent: true };
  }
  const saved = await saveIntent(client, { worldId, proposerAgentId: intent.proposer_agent_id,
    issuerAgentId: nextIssuer, specification: merged, actionId: idempotencyKey, worldMinute,
    authoring, intentId, prior: intent });
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: saved.complete
    ? 'token_issuance_specification_updated' : 'token_issuance_incomplete', worldMinute,
  actionId: `${idempotencyKey}:updated`, details: { status: saved.row.status,
    incompleteFields: saved.row.metadata.incompleteFields, requestHash } });
  await preserveUnsupportedPrimitiveRequest(client, { worldId, agentId, intent: saved.row,
    specification: merged, worldMinute, actionId: idempotencyKey, tokenomicsV1 });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intent: saved.row, complete: saved.complete, idempotent: false };
}

export async function respondToWorldTokenIssuance(client, { worldId, agentId, intentId,
  decision, rationale = null, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['support','oppose','ignore'].includes(decision)) throw worldError('TOKEN_ISSUANCE_RESPONSE_INVALID', 400);
  const intent = await readIntent(client, worldId, intentId, true);
  const idempotencyKey = actionIdentifier(actionId);
  const text = rationale === null ? null : requiredText(rationale, 1, 1000, 'token_response_rationale');
  const prior = await client.query(`SELECT intent_id,decision,rationale FROM arc_token_issuance_decisions
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotencyKey]);
  if (prior.rowCount) {
    const row = prior.rows[0];
    if (row.intent_id !== intentId || row.decision !== decision || row.rationale !== text) throw worldError('ACTION_ID_CONFLICT', 409);
    return { intentId, decision, idempotent: true };
  }
  await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [worldId, intentId, agentId, decision, text, worldMinute, idempotencyKey]);
  await client.query(`INSERT INTO arc_token_issuance_responses(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,intent_id,agent_id) DO UPDATE SET decision=EXCLUDED.decision,
      rationale=EXCLUDED.rationale,world_minute=EXCLUDED.world_minute,action_id=EXCLUDED.action_id,updated_at=now()`,
  [worldId, intentId, agentId, decision, text, worldMinute, idempotencyKey]);
  const eventType = decision === 'support' ? 'token_issuance_supported'
    : decision === 'oppose' ? 'token_issuance_opposed' : 'token_issuance_ignored';
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType,
    worldMinute, actionId: `${idempotencyKey}:response`, details: { decision, rationale: text } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuance-response:${intentId}:${agentId}:${idempotencyKey}`,
    eventType, actorAgentId: agentId, entityType: 'agent_token_issuance', entityId: intentId,
    worldTime: worldMinute, title: `Agent ${decision} a token issuance`,
    detail: `An Agent recorded a ${decision} response to a token issuance proposal.`,
    metadata: { intentId, decision, rationale: text } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intentId, decision, idempotent: false, issuerAgentId: intent.issuer_agent_id };
}

export async function nominateWorldTokenIssuer(client, { worldId, agentId, intentId, candidateAgentId,
  nominationReason, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (typeof candidateAgentId !== 'string' || !uuidPattern.test(candidateAgentId)) {
    throw worldError('TOKEN_ISSUER_CANDIDATE_INVALID', 400);
  }
  await requireWorldMember(client, worldId, candidateAgentId);
  const reason = nominationReason === null || nominationReason === undefined ? null
    : requiredText(nominationReason, 3, 1000, 'token_issuer_nomination_reason');
  const action = actionIdentifier(actionId);
  const intent = await readIntent(client, worldId, intentId, true);
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_NOT_NOMINATABLE', 409);
  if (Number(intent.capability_generation) === 1) {
    const assignment = await creatorGenesisIssuerAssignment(client, worldId, 1);
    if (assignment && candidateAgentId !== assignment.issuerAgentId) {
      throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
    }
  }
  const prior = await client.query(`SELECT candidate_agent_id,nomination_reason FROM arc_token_issuance_issuer_candidates
    WHERE world_id=$1 AND nominated_by_agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
  if (prior.rowCount) {
    const existing = prior.rows[0];
    if (existing.candidate_agent_id !== candidateAgentId || existing.nomination_reason !== reason) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { intentId, candidateAgentId, idempotent: true };
  }
  await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,'issuer_nomination',$4,$5,$6)`, [worldId, intentId, agentId, reason, worldMinute, action]);
  await client.query(`INSERT INTO arc_token_issuance_issuer_candidates(world_id,intent_id,candidate_agent_id,
      nominated_by_agent_id,status,nomination_reason,nominated_world_minute,action_id)
    VALUES($1,$2,$3,$4,'nominated',$5,$6,$7)
    ON CONFLICT(world_id,intent_id,candidate_agent_id) DO NOTHING`,
  [worldId, intentId, candidateAgentId, agentId, reason, worldMinute, action]);
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuer_nominated',
    worldMinute, actionId: `${createHash('sha256').update(action).digest('hex').slice(0, 40)}:nomination`,
    details: { candidateAgentId, nominationReason: reason } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuer-nominated:${intentId}:${agentId}:${action}`,
    eventType: 'token_issuer_nominated', actorAgentId: agentId, entityType: 'agent_token_issuance',
    entityId: intentId, worldTime: worldMinute, title: 'An Agent nominated an issuer candidate',
    detail: 'The nomination is a proposal for the candidate to accept or decline; it does not assign the issuer.',
    metadata: { intentId, candidateAgentId, nominationReason: reason } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intentId, candidateAgentId, idempotent: false };
}

export async function decideWorldTokenIssuerCandidate(client, { worldId, agentId, intentId,
  candidateAgentId, decision, rationale = null, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['accept','reject','defer'].includes(decision)) throw worldError('TOKEN_ISSUER_CANDIDATE_DECISION_INVALID', 400);
  const intent = await readIntent(client, worldId, intentId, true);
  if (Number(intent.capability_generation) === 1) {
    const assignment = await creatorGenesisIssuerAssignment(client, worldId, 1);
    if (assignment && candidateAgentId !== assignment.issuerAgentId) {
      throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
    }
  }
  const action = actionIdentifier(actionId);
  const text = rationale === null ? null : requiredText(rationale, 1, 1000, 'token_issuer_candidate_rationale');
  const prior = await client.query(`SELECT intent_id,decision,rationale FROM arc_token_issuance_decisions
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
  if (prior.rowCount) {
    if (prior.rows[0].intent_id !== intentId || prior.rows[0].decision !==
        (decision === 'accept' ? 'issuer_candidate_accept' : decision === 'reject' ? 'issuer_candidate_reject' : 'issuer_defer')
        || prior.rows[0].rationale !== text) throw worldError('ACTION_ID_CONFLICT', 409);
    return { intentId, candidateAgentId, decision, issuerSelected: decision === 'accept', idempotent: true };
  }
  const candidate = await client.query(`SELECT * FROM arc_token_issuance_issuer_candidates
    WHERE world_id=$1 AND intent_id=$2 AND candidate_agent_id=$3 FOR UPDATE`, [worldId, intentId, candidateAgentId]);
  if (!candidate.rowCount) throw worldError('TOKEN_ISSUER_CANDIDATE_NOT_FOUND', 404);
  if (candidate.rows[0].status !== 'nominated') throw worldError('TOKEN_ISSUER_CANDIDATE_ALREADY_DECIDED', 409);
  if (candidate.rows[0].candidate_agent_id !== agentId) throw worldError('TOKEN_ISSUER_CANDIDATE_MUST_DECIDE', 403);
  const decisionCode = decision === 'accept' ? 'issuer_candidate_accept'
    : decision === 'reject' ? 'issuer_candidate_reject' : 'issuer_defer';
  const inserted = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
      rationale,world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, intentId, agentId, decisionCode, text, worldMinute, action]);
  if (!inserted.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
  if (decision === 'accept') {
    if (intent.issuer_agent_id && intent.issuer_agent_id !== agentId) {
      throw worldError('TOKEN_ISSUER_ALREADY_SELECTED', 409);
    }
    const other = await client.query(`SELECT 1 FROM arc_token_issuance_issuer_candidates
      WHERE world_id=$1 AND intent_id=$2 AND status='accepted' AND candidate_agent_id<>$3 LIMIT 1`,
    [worldId, intentId, agentId]);
    if (other.rowCount) throw worldError('TOKEN_ISSUER_ALREADY_SELECTED', 409);
  }
  const candidateStatus = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'deferred';
  await client.query(`UPDATE arc_token_issuance_issuer_candidates SET status=$4,decided_world_minute=$5,updated_at=now()
    WHERE world_id=$1 AND intent_id=$2 AND candidate_agent_id=$3`, [worldId, intentId, agentId, candidateStatus, worldMinute]);
  if (decision === 'accept') {
    await client.query(`UPDATE arc_token_issuance_intents SET issuer_agent_id=$3,updated_world_minute=$4,updated_at=now()
      WHERE world_id=$1 AND id=$2`, [worldId, intentId, agentId, worldMinute]);
  }
  await recordIssuanceEvent(client, { worldId, agentId, intentId,
    eventType: `token_issuer_candidate_${decision}`, worldMinute,
    actionId: `${createHash('sha256').update(action).digest('hex').slice(0, 40)}:candidate`,
    details: { candidateAgentId: agentId, decision, rationale: text } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuer-candidate:${intentId}:${agentId}:${action}`,
    eventType: `token_issuer_candidate_${decision}`, actorAgentId: agentId,
    entityType: 'agent_token_issuance', entityId: intentId, worldTime: worldMinute,
    title: decision === 'accept' ? 'An Agent accepted issuer responsibility'
      : decision === 'reject' ? 'An Agent declined issuer responsibility' : 'An Agent deferred issuer responsibility',
    detail: decision === 'accept' ? 'Issuer candidacy was accepted by the Agent; final specification confirmation is still required.'
      : 'The issuer candidate decision preserves the unresolved world currency requirement.',
    metadata: { intentId, candidateAgentId: agentId, decision, rationale: text } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intentId, candidateAgentId: agentId, decision, issuerSelected: decision === 'accept', idempotent: false };
}

async function creatorGenesisIssuerAssignment(client, worldId, capabilityGeneration = 1) {
  const result = await client.query(`SELECT assignment.issuer_agent_id AS "issuerAgentId",
      assignment.capability_generation AS "capabilityGeneration",
      assignment.selection_source AS "selectionSource",agent.name AS "issuerName"
    FROM world_genesis_issuer_assignments assignment
    JOIN agents agent ON agent.id=assignment.issuer_agent_id
    WHERE assignment.world_id=$1 AND assignment.capability_generation=$2`,
  [worldId, capabilityGeneration]);
  return result.rows[0] || null;
}

async function verifyDistributionRecipients(client, worldId, distribution) {
  const unsupported = [];
  for (const recipient of distribution) {
    if (recipient.recipientType === 'agent') {
      const wallet = await client.query(`SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2
        AND chain_id=5042 AND status='active'`, [worldId, recipient.recipientId]);
      if (!wallet.rowCount || wallet.rows[0].address.toLowerCase() !== recipient.recipientAddress) {
        unsupported.push({ recipientType: 'agent', recipientId: recipient.recipientId,
          reason: wallet.rowCount ? 'wallet_address_mismatch' : 'verified_agent_wallet_unavailable' });
      }
    } else if (recipient.recipientType === 'organization') {
      const wallet = await client.query(`SELECT address FROM arc_organization_wallets WHERE world_id=$1
        AND organization_id=$2 AND chain_id=5042 AND status='active'`, [worldId, recipient.recipientId]);
      if (!wallet.rowCount || wallet.rows[0].address.toLowerCase() !== recipient.recipientAddress.toLowerCase()) {
        unsupported.push({ recipientType: 'organization', recipientId: recipient.recipientId,
          reason: wallet.rowCount ? 'wallet_address_mismatch' : 'verified_organization_wallet_unavailable' });
      }
    } else unsupported.push({ recipientType: recipient.recipientType, recipientId: recipient.recipientId,
      reason: 'generation_1_external_recipient_unsupported' });
  }
  return unsupported;
}

function currencyReviewActionId({ worldId, agentId, worldMinute, action }) {
  return `currency-${createHash('sha256').update(`${worldId}:${agentId}:${worldMinute}:${action}`).digest('hex').slice(0, 40)}`;
}

export function currencyReviewErrorOutcome(error) {
  const name = String(error?.name || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status);
  if (name.includes('timeout') || name === 'aborterror'
      || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR'].includes(code)) {
    return { outcome: 'provider_timeout', reasonCode: 'provider_request_timeout' };
  }
  if (name === 'apiconnectionerror' || ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
      || status === 429 || status >= 500) {
    return { outcome: 'provider_unavailable', reasonCode: 'provider_connection_unavailable' };
  }
  return { outcome: 'provider_error', reasonCode: 'provider_request_error' };
}

function currencyReviewChoiceOutcome(choiceId) {
  if (choiceId === 'no_action') return 'explicit_no_action';
  if (choiceId === 'continue_design') return 'explicit_continue_design';
  if (choiceId === 'propose_when_ready') return 'explicit_propose';
  if (choiceId.startsWith('response:')) return 'explicit_response';
  return 'other';
}

export async function recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
  outcome, reasonCode, provider = 'typesafe', model = null, confidence = null, selectedActionId = null,
  providerAttempted = false, inputTokens = null, reviewActionId = null }) {
  const reviewId = reviewActionId || currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: 'review-outcome' });
  const safeLabel = (value, fallback = null) => typeof value === 'string' && value.length
    ? value.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : fallback;
  const outcomes = new Set(['explicit_no_action','explicit_continue_design','explicit_propose','explicit_response','provider_unavailable',
    'provider_timeout','provider_error','malformed_output','invalid_choice','low_confidence','no_valid_decision',
    'skipped_not_due','other']);
  const safeOutcome = outcomes.has(outcome) ? outcome : 'other';
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,'currency_genesis.review_outcome','currency_genesis_review',$3,$4,$5::jsonb,$6)
    ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agent.agentId, worldId, worldMinute, JSON.stringify({ reviewId,
    actionId: selectedActionId, provider: safeLabel(provider, 'unknown'), model: safeLabel(model),
    outcome: safeOutcome, reasonCode: safeLabel(reasonCode, 'unspecified'),
    confidence: Number.isFinite(confidence) ? confidence : null,
    providerAttempted: providerAttempted === true,
    inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
    requirementStatus: requirement?.status || null }), reviewId]);
  if (providerAttempted === true) {
    const validInputTokens = Number.isSafeInteger(inputTokens) && inputTokens > 0 ? inputTokens : null;
    await recordInfrastructureUsageEvent(client, { worldId, attributionType: 'agent', agentId: agent.agentId,
      actionId: `${reviewId}:usage`, resourceCategory: 'ai_inference', provider: safeLabel(provider, 'unknown'),
      model: safeLabel(model), worldMinute, quantityRaw: validInputTokens === null ? '1' : String(validInputTokens),
      unit: validInputTokens === null ? 'provider_request_attempt' : 'provider_input_token',
      costStatus: 'unpriced', metadata: { reviewId, outcome: safeOutcome,
        reasonCode: safeLabel(reasonCode, 'unspecified'), confidence: Number.isFinite(confidence) ? confidence : null,
        inputTokens: validInputTokens } });
  }
}

async function recordCurrencyReviewChoice(client, { worldId, agent, worldMinute, selected, options, requirement }) {
  const actionId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id });
  const runtime = await client.query('SELECT tick_count FROM world_runtime_state WHERE world_id=$1', [worldId]);
  if (runtime.rowCount) {
    const distribution = Object.fromEntries(options.map((option) => [option.id, 1 / options.length]));
    const scores = Object.fromEntries(options.map((option) => [option.id, option.id === selected.id ? selected.confidence : 0]));
    await client.query(`INSERT INTO world_decision_traces(world_id,agent_id,tick_count,world_minutes,
        chosen_candidate_id,chosen_action,behavior_probability,distribution,utility_scores,goal_snapshot,rationale,source_key)
      VALUES($1,$2,$3,$4,$5,'currency_genesis',$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)
      ON CONFLICT(world_id,source_key) WHERE source_key IS NOT NULL DO NOTHING`,
    [worldId, agent.agentId, runtime.rows[0].tick_count, worldMinute, selected.id,
      Math.max(0.3, Math.min(1, Number(selected.confidence) || 0.3)), JSON.stringify(distribution),
      JSON.stringify(scores), JSON.stringify({ currentGoal: agent.primaryGoal || agent.currentGoal || agent.goal || null,
        goals: Array.isArray(agent.goals) ? agent.goals.slice(0, 6) : [] }),
      JSON.stringify({ source: 'world_engine_civilization_review', decisionSource: selected.source,
        requirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: requirement.status,
        selectedOption: selected.id }), actionId]);
  }
  const eventType = selected.id === 'no_action' ? 'currency_genesis.no_action'
    : selected.id === 'continue_design' ? 'currency_genesis.design_continued'
      : selected.id === 'propose_when_ready' ? 'currency_genesis.propose_when_ready' : 'currency_genesis.choice';
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,$3,'currency_genesis_requirement',$4,$5,$6::jsonb,$7)
    ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agent.agentId, eventType,
    worldId, worldMinute, JSON.stringify({ requirementStatus: requirement.status, choice: selected.id,
      decisionSource: selected.source }), actionId]);
  if (selected.id === 'no_action') {
    await writeWorldHistory(client, { worldId, eventKey: `currency-genesis-no-action:${actionId}`,
      eventType: 'currency_genesis_no_action', actorAgentId: agent.agentId,
      entityType: 'currency_genesis_requirement', entityId: worldId, worldTime: worldMinute,
      title: 'Resident chose no action on the currency requirement',
      detail: 'The resident left the persistent requirement unresolved and continued with other concerns.',
      metadata: { status: requirement.status, decisionSource: selected.source, validAutonomousNoAction: true } });
  }
}

async function readCurrencyGenesisDesignDraft(client, { worldId, agentId, tokenomicsV1 = false }) {
  const result = await client.query(`SELECT details,world_minute AS "worldMinute"
    FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2
      AND event_type='currency_genesis.design_draft'
    ORDER BY world_minute DESC,created_at DESC`, [worldId, agentId]);
  for (const row of result.rows) {
    try {
      const details = row.details;
      if (tokenomicsV1 && details?.authoring?.tokenomicsManifestHash !== TOKENOMICS_MANIFEST_HASH) continue;
      const specification = cleanPartialSpecification(details?.specification || {});
      if (specificationFieldCount(specification, { tokenomicsV1 }) === 0) continue;
      if (tokenomicsV1) inspectSyncTokenomicsSpecification(specification);
      return { specification, worldMinute: Number(row.worldMinute),
        incompleteFields: Array.isArray(details?.incompleteFields) ? details.incompleteFields : [],
        authoring: details?.authoring || null };
    } catch {
      continue;
    }
  }
  return null;
}

async function recordCurrencyGenesisDesignDraft(client, { worldId, agent, worldMinute, specification, authoring }) {
  const tokenomicsV1 = authoring?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  const incompleteFields = SPEC_FIELDS.filter((field) => specification[field] === undefined || specification[field] === null
    || (field === 'distribution' && (!Array.isArray(specification.distribution)
      || (!tokenomicsV1 && !specification.distribution.length))));
  const actionId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: 'design-draft' });
  const safeReason = typeof authoring.reason === 'string'
    ? authoring.reason.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : null;
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,'currency_genesis.design_draft','currency_genesis_design_draft',
      $3,$4,$5::jsonb,$6) ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agent.agentId, worldId, worldMinute, JSON.stringify({ specification, incompleteFields,
    authoring: { provider: authoring.provider || currencyGenesisAuthoringConfig.provider, model: authoring.model || null,
      status: authoring.status || 'incomplete', reason: safeReason,
      ...(tokenomicsV1 ? { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}) } }), actionId]);
  return { actionId, incompleteFields };
}

export async function currencyAuthoringInput(client, { worldId, agent, worldMinute, requirement, intent = null }) {
  const issuerAssignment = await creatorGenesisIssuerAssignment(client, worldId, AGENT_TOKEN_PILOT_GENERATION);
  const history = await client.query(`SELECT history.event_type AS type,actor.name AS agent,
        history.metadata->>'decision' AS decision,history.title AS summary,history.world_time AS "worldMinute"
      FROM world_history history LEFT JOIN agents actor ON actor.id=history.actor_agent_id
      WHERE history.world_id=$1 AND (history.entity_type='agent_token_issuance'
        OR history.event_type LIKE 'currency_genesis_%')
      ORDER BY history.world_time DESC,history.id DESC LIMIT 16`, [worldId]);
  const recipients = await client.query(`SELECT 'agent' AS type,member.agent_id AS id,agent.name,wallet.address
      FROM world_members member JOIN agents agent ON agent.id=member.agent_id
      JOIN arc_agent_wallets wallet ON wallet.world_id=member.world_id AND wallet.agent_id=member.agent_id
        AND wallet.chain_id=5042 AND wallet.status='active'
      WHERE member.world_id=$1
      UNION ALL
      SELECT 'organization' AS type,organization.id,organization.name,wallet.address
      FROM world_organizations organization JOIN arc_organization_wallets wallet
        ON wallet.world_id=organization.world_id AND wallet.organization_id=organization.id
          AND wallet.chain_id=5042 AND wallet.status='active'
      WHERE organization.world_id=$1 ORDER BY type,id LIMIT 32`, [worldId]);
  const economicEvidence = await client.query(`SELECT service_type,world_day,unmet_count FROM world_economic_demand
      WHERE world_id=$1 AND unmet_count>0 ORDER BY world_day DESC,service_type LIMIT 8`, [worldId]);
  const worldFacts = currencyGenesisInfrastructureFacts({ requirement, issuerAssignment });
  const tokenomicsV1 = worldFacts.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  const currentDesignDraft = await readCurrencyGenesisDesignDraft(client, { worldId, agentId: agent.agentId, tokenomicsV1 });
  let currentProposal = null;
  if (intent && (!tokenomicsV1 || intent.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH)) {
    const proposer = await client.query('SELECT name FROM agents WHERE id=$1', [intent.proposer_agent_id]);
    const issuer = intent.issuer_agent_id
      ? await client.query('SELECT name FROM agents WHERE id=$1', [intent.issuer_agent_id]) : { rows: [] };
    currentProposal = { status: intent.status, proposer: proposer.rows[0]?.name || null,
      issuer: issuer.rows[0]?.name || null, name: intent.name, symbol: intent.symbol,
      meaning: intent.meaning, purpose: intent.purpose, rationale: intent.rationale,
      existingSpecification: agentTokenSpecificationFromIntentRow(intent) };
  }
  return { resident: agent, issuerAssignment,
    worldFacts: { ...worldFacts,
    currentWorldMinute: Number(worldMinute),
    currentEconomicEvidence: economicEvidence.rows.map((row) =>
      `${row.service_type} had ${row.unmet_count} unmet requests on world day ${row.world_day}.`) },
  publicCurrencyHistory: history.rows, availableRecipients: recipients.rows, currentProposal, currentDesignDraft };
}

export function classifyCurrencyReviewResult(result, options) {
  if (!Array.isArray(options) || options.length < 2) return { selected: null, diagnostic: {
    outcome: 'no_valid_decision', reasonCode: 'insufficient_review_options', provider: 'typesafe',
    providerAttempted: false } };
  if (result?.currencyReviewDiagnostic) {
    const diagnostic = result.currencyReviewDiagnostic;
    const failedOutcomes = new Set(['provider_unavailable','provider_timeout','provider_error','malformed_output',
      'invalid_choice','low_confidence','no_valid_decision']);
    if (failedOutcomes.has(diagnostic.outcome)) return { selected: null, diagnostic: {
      ...diagnostic, providerAttempted: diagnostic.providerAttempted === true,
      inputTokens: Number.isSafeInteger(diagnostic.inputTokens) && diagnostic.inputTokens >= 0
        ? diagnostic.inputTokens : null } };
    return { selected: null, diagnostic: { outcome: 'malformed_output',
      reasonCode: 'invalid_diagnostic_result', provider: 'typesafe', model: null } };
  }
  if (result === null || result === undefined) return { selected: null, diagnostic: {
    outcome: 'no_valid_decision', reasonCode: 'provider_returned_no_result', provider: 'typesafe',
    providerAttempted: true } };
  if (typeof result !== 'object' || Array.isArray(result)) return { selected: null, diagnostic: {
    outcome: 'malformed_output', reasonCode: 'result_not_an_object', provider: 'typesafe', providerAttempted: true } };
  const usageDiagnostic = { providerAttempted: result.providerAttempted !== false,
    inputTokens: Number.isSafeInteger(result.inputTokens) && result.inputTokens >= 0 ? result.inputTokens : null };
  const rawChoice = result.choice;
  const id = rawChoice && typeof rawChoice === 'object' ? rawChoice.id : rawChoice ?? result.id;
  if (typeof id !== 'string' || !id.length) return { selected: null, diagnostic: {
    outcome: 'malformed_output', reasonCode: 'choice_missing', provider: result.provider || 'typesafe',
    model: result.model || null, ...usageDiagnostic } };
  const selected = options.find((option) => option.id === id);
  const confidence = Number(result?.confidence);
  if (!selected) return { selected: null, diagnostic: { outcome: 'invalid_choice',
    reasonCode: 'choice_not_offered', provider: result.provider || 'typesafe', model: result.model || null,
    ...usageDiagnostic } };
  if (!Number.isFinite(confidence)) return { selected: null, diagnostic: { outcome: 'malformed_output',
    reasonCode: 'confidence_missing_or_invalid', provider: result.provider || 'typesafe', model: result.model || null,
    ...usageDiagnostic } };
  if (confidence < 0.3) return { selected: null, diagnostic: { outcome: 'low_confidence',
    reasonCode: 'confidence_below_existing_threshold', provider: result.provider || 'typesafe',
    model: result.model || null, confidence, ...usageDiagnostic } };
  return { selected: { ...selected, confidence, source: result?.model || 'typesafe' }, diagnostic: {
    outcome: currencyReviewChoiceOutcome(id), reasonCode: 'offered_choice_selected',
    provider: result.provider || 'typesafe', model: result.model || null, confidence, selectedActionId: id,
    ...usageDiagnostic } };
}

async function chooseCurrencyReviewOption(chooseWithTypeSafe, { worldId, agent, worldMinute, requirement, state, options }) {
  if (typeof chooseWithTypeSafe !== 'function') return { selected: null, diagnostic: {
    outcome: 'provider_unavailable', reasonCode: 'provider_callback_unavailable', provider: 'typesafe',
    providerAttempted: false } };
  try {
    const result = await chooseWithTypeSafe({ worldId, agentId: agent.agentId, agent, worldMinute,
      choiceType: 'currency_genesis', state: { ...state, requirement: 'CURRENCY_GENESIS_REQUIRED',
        requirementStatus: requirement.status }, options });
    return classifyCurrencyReviewResult(result, options);
  } catch (error) {
    return { selected: null, diagnostic: { ...currencyReviewErrorOutcome(error), provider: 'typesafe', model: null,
      providerAttempted: true } };
  }
}

async function canConfirmCurrencyIntent(client, { worldId, agentId, intent, worldMinute }) {
  try {
    const wallet = await client.query(`SELECT address FROM arc_agent_wallets
      WHERE world_id=$1 AND agent_id=$2 AND chain_id=5042 AND status='active'`, [worldId, agentId]);
    if (!wallet.rowCount || !/^0x[0-9a-fA-F]{40}$/.test(String(wallet.rows[0].address || ''))
        || (intent.issuer_wallet && intent.issuer_wallet.toLowerCase() !== wallet.rows[0].address.toLowerCase())) return false;
    if (Number(intent.capability_generation) === 1) {
      const assignment = await creatorGenesisIssuerAssignment(client, worldId, 1);
      if (!assignment || assignment.issuerAgentId !== agentId
          || intent.issuer_selection_source !== assignment.selectionSource) return false;
    }
    const active = await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
      WHERE world_id=$1 AND status='active' ORDER BY capability_generation DESC LIMIT 1`, [worldId]);
    const generation = Number(intent.status === 'deferred'
      ? active.rows[0]?.capability_generation || intent.capability_generation : intent.capability_generation);
    const specification = agentTokenSpecificationFromIntentRow(intent);
    const tokenomicsV1 = intent.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
    const spec = tokenomicsV1 ? inspectSyncTokenomicsSpecification(specification)
      : inspectAgentTokenDesign(specification, { generation });
    if (!spec.complete) return false;
    if (tokenomicsV1) return true;
    return (await verifyDistributionRecipients(client, worldId, spec.distribution)).length === 0;
  } catch { return false; }
}

function intentReadyForExecution(intent) {
  return ['preparing','prepared','submitting','submission_unknown','submitted'].includes(intent.status)
    && intent.metadata?.executionStatus === 'identity_verified'
    && /^[1-9]\d*$/.test(String(intent.issuer_identity_id || ''));
}

async function authorCurrencyGenesisDesign(client, { worldId, agent, worldMinute, input, authorProposal,
  selectedAction, proposeWhenComplete = false, requireSuccessfulAuthoringForProposal = false,
  incompleteDecision = 'design_continued', mandatoryGenesisCompletion = false, currentIntent = null }) {
  const tokenomicsV1 = input.worldFacts?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  let authored = { specification: null, reason: 'bai_authoring_unavailable',
    provider: currencyGenesisAuthoringConfig.provider, model: currencyGenesisAuthoringConfig.model,
    providerAttempted: false };
  const authoringAttempts = [];
  let patch = {};
  let authoringReason = null;
  if (mandatoryGenesisCompletion) {
    let repair = null;
    let validated = false;
    for (let attemptNumber = 0; attemptNumber <= MAX_GENESIS_AUTHORING_REPAIRS; attemptNumber += 1) {
      try {
        authored = await authorProposal(input, { completionMode: 'mandatory_genesis', ...(repair ? { repair } : {}) });
      } catch (error) {
        authored = { specification: null, reason: authoringExceptionReason(error),
          provider: currencyGenesisAuthoringConfig.provider, model: currencyGenesisAuthoringConfig.model,
          providerAttempted: true };
      }
      const hasCandidate = Object.hasOwn(authored, 'candidate')
        || (Object.hasOwn(authored, 'specification') && authored.specification !== null);
      const candidate = Object.hasOwn(authored, 'candidate') ? authored.candidate : authored.specification;
      const attemptRecord = { authoring: authored, ...(hasCandidate ? { candidate } : {}), diagnostics: [] };
      authoringAttempts.push(attemptRecord);

      if (!hasCandidate) {
        authoringReason = authored.reason || 'bai_authoring_specification_invalid';
        break;
      }
      if (authored.reason && authored.reason !== 'authoring_invalid_no_progress') {
        authoringReason = authored.reason;
        break;
      }

      const validation = validateMandatoryGenesisCandidate(candidate, input, authored.validationDiagnostics);
      if (validation.complete && !authored.reason) {
        patch = validation.specification;
        authoringReason = null;
        validated = true;
        break;
      }

      const diagnostics = validation.diagnostics.length ? validation.diagnostics : safeGenesisDiagnostics([{
        field: 'specification', expected: 'complete specification passing canonical and economic validation',
        actual: authored.validationCode || 'validation failed', code: authored.validationCode || 'canonical_validation_failed'
      }]);
      attemptRecord.diagnostics = diagnostics;
      attemptRecord.authoring = { ...authored, reason: 'authoring_invalid_no_progress',
        validationCode: diagnostics[0]?.code || 'canonical_validation_failed',
        validationDiagnostics: diagnostics };
      if (attemptNumber === MAX_GENESIS_AUTHORING_REPAIRS) {
        authoringReason = 'authoring_invalid_no_progress';
        authored = attemptRecord.authoring;
        break;
      }
      repair = { attempt: attemptNumber + 1, candidate, diagnostics };
    }
    if (!validated && !authoringReason) authoringReason = 'authoring_invalid_no_progress';
  } else {
    try { authored = await authorProposal(input); }
    catch (error) { authored = { specification: null, reason: authoringExceptionReason(error),
      provider: currencyGenesisAuthoringConfig.provider, model: currencyGenesisAuthoringConfig.model,
      providerAttempted: true }; }
    authoringReason = authored.reason || null;
    if (authored.specification) {
      try {
        const generated = cleanPartialSpecification(authored.specification);
        patch = Object.fromEntries(Object.entries(generated).filter(([, value]) => value !== null));
      } catch (error) {
        authoringReason = 'bai_authoring_specification_invalid';
        authored.validationCode = error?.code || 'TOKEN_SPECIFICATION_INVALID';
      }
    }
    authoringAttempts.push({ authoring: { ...authored, reason: authoringReason },
      ...(authored.specification ? { candidate: authored.specification } : {}), diagnostics: [] });
  }

  const priorSpecification = input.currentDesignDraft?.specification || {};
  const specification = mandatoryGenesisCompletion ? patch : { ...priorSpecification, ...patch };
  let complete = specificationFieldsComplete(specification, { tokenomicsV1 });
  await recordCurrencyGenesisAuthoringOutcome(client, { worldId, agent, worldMinute,
    selectedAction, authoring: { ...authored, reason: authoringReason,
      ...(tokenomicsV1 ? { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}) },
    specification: patch, authoringAttempts });

  if (mandatoryGenesisCompletion && authoringReason === 'authoring_invalid_no_progress') {
    return { status: 'AUTHORING_INVALID_NO_PROGRESS', decision: incompleteDecision,
      reason: authoringReason, validationCode: authored.validationCode || null };
  }
  const authoringSucceeded = Boolean(authored.specification) && !authoringReason;
  if (proposeWhenComplete && complete
      && (!requireSuccessfulAuthoringForProposal || authoringSucceeded)) {
    if (tokenomicsV1 && currentIntent?.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH) {
      const updated = await updateWorldTokenIssuanceSpecification(client, { worldId, agentId: agent.agentId,
        intentId: currentIntent.id, specification, actionId: currencyReviewActionId({ worldId,
          agentId: agent.agentId, worldMinute, action: 'update-v1-proposal' }), worldMinute,
        authoring: { provider: authored.provider || currencyGenesisAuthoringConfig.provider,
          model: authored.model || input.currentDesignDraft?.authoring?.model || null,
          status: 'expressed', reason: null, tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } });
      return { status: updated.intent.status === 'incomplete' ? 'INCOMPLETE' : 'PROPOSAL_FORMED',
        decision: 'proposal_updated', intentId: updated.intent.id,
        authoringStatus: updated.intent.metadata.localAuthoring?.status };
    }
    const created = await createWorldTokenIssuanceIntent(client, { worldId, agentId: agent.agentId,
      specification, actionId: currencyReviewActionId({ worldId, agentId: agent.agentId,
        worldMinute, action: 'propose' }), worldMinute, decisionPath: 'world_engine',
      authoring: { provider: authored.provider || currencyGenesisAuthoringConfig.provider,
        model: authored.model || input.currentDesignDraft?.authoring?.model || null,
        status: authoringSucceeded ? 'expressed' : 'reused_complete_draft', reason: authoringReason,
        ...(tokenomicsV1 ? { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}) } });
    return { status: created.intent.status === 'incomplete' ? 'INCOMPLETE' : 'PROPOSAL_FORMED',
      decision: 'proposal_created', intentId: created.intent.id,
      authoringStatus: created.intent.metadata.localAuthoring?.status };
  }

  const authoredFieldCount = specificationFieldCount(patch, { tokenomicsV1 });
  const authoringStatus = authoredFieldCount > 0 && !authoringReason ? 'expressed' : 'incomplete';
  if (authoredFieldCount === 0) {
    const incompleteFields = SPEC_FIELDS.filter((field) => specification[field] === undefined || specification[field] === null
      || (field === 'distribution' && (!Array.isArray(specification.distribution)
        || (!tokenomicsV1 && !specification.distribution.length))));
    return { status: incompleteFields.length ? 'DRAFT_INCOMPLETE' : 'DRAFT_COMPLETE',
      decision: incompleteDecision, incompleteFields, authoringStatus, reason: authoringReason };
  }
  const savedDraft = await recordCurrencyGenesisDesignDraft(client, { worldId, agent, worldMinute,
    specification, authoring: { provider: authored.provider || currencyGenesisAuthoringConfig.provider,
      model: authored.model || input.currentDesignDraft?.authoring?.model || null,
      status: authoringStatus, reason: authoringReason,
      ...(tokenomicsV1 ? { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}) } });
  return { status: savedDraft.incompleteFields.length ? 'DRAFT_INCOMPLETE' : 'DRAFT_COMPLETE',
    decision: incompleteDecision, incompleteFields: savedDraft.incompleteFields,
    actionId: savedDraft.actionId, authoringStatus };
}

export async function advanceWorldCurrencyGenesis(client, { worldId, agent, worldMinute,
  chooseWithTypeSafe = null, authorProposal = authorAgentCurrencyProposal, reviewDue = true }) {
  if (!reviewDue) {
    const existing = await client.query(`SELECT * FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    const requirement = existing.rows[0] || null;
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
      outcome: 'skipped_not_due', reasonCode: 'review_not_due', provider: null });
    return { status: requirement?.status || null, decision: 'pending', reason: 'review_not_due' };
  }
  let requirement = await ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  if (requirement.status !== 'SATISFIED' && Number(requirement.capability_generation) === 1
      && agent.agentId === SYNC_GENESIS_ISSUER_AGENT_ID) {
    const legacyProposal = await client.query(`SELECT id FROM arc_token_issuance_intents
      WHERE world_id=$1 AND id=$2`, [worldId, SUPERSEDED_SYNC_PROPOSAL_ID]);
    if (legacyProposal.rowCount) {
      const assignment = await creatorGenesisIssuerAssignment(client, worldId, 1);
      if (assignment?.issuerAgentId !== agent.agentId || assignment.selectionSource !== 'creator_genesis_assignment') {
        throw worldError('SYNC_LEGACY_PROPOSAL_ISSUER_ASSIGNMENT_MISMATCH', 409);
      }
      await supersedeLegacySyncGenesisProposal(client, { worldId, intentId: SUPERSEDED_SYNC_PROPOSAL_ID,
        worldMinute, reason: 'creator_genesis_tokenomics_v1' });
      requirement = await ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    }
  }
  await recordRequirementAwareness(client, { worldId, agent, requirement, worldMinute });
  if (requirement.status === 'SATISFIED') {
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
      outcome: 'other', reasonCode: 'requirement_already_satisfied', provider: 'not_called' });
    return { status: 'SATISFIED', decision: 'none' };
  }

  const tokenomicsRows = await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND status IN ('incomplete','proposed','deferred','issuer_confirmed')
      AND metadata->>'tokenomicsManifestHash'=$2
    ORDER BY created_world_minute DESC,id DESC LIMIT 1`, [worldId, TOKENOMICS_MANIFEST_HASH]);
  const openRows = tokenomicsRows.rowCount ? tokenomicsRows : await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND status IN ('incomplete','proposed','deferred')
    ORDER BY created_world_minute,id LIMIT 12`, [worldId]);
  let currentIntent = null;
  if (tokenomicsRows.rowCount) currentIntent = tokenomicsRows.rows[0];
  else if (openRows.rows.length) {
    const rotation = Number.parseInt(createHash('sha256').update(`${agent.agentId}:${Math.floor(worldMinute / 1_440)}`)
      .digest('hex').slice(0, 8), 16) % openRows.rows.length;
    currentIntent = openRows.rows[rotation];
  }
  const tokenomicsIntent = currentIntent?.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
  if (tokenomicsIntent && currentIntent.status === 'issuer_confirmed') {
    const reasonCode = currentIntent.metadata?.executionBlockReason === 'TOKEN_ISSUER_IDENTITY_NOT_READY'
      ? 'TOKEN_ISSUER_IDENTITY_NOT_READY' : 'sync_tokenomics_confirmed_waiting_final_preflight';
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
      outcome: 'other', reasonCode, provider: 'not_called' });
    return { status: 'ISSUER_CONFIRMED', decision: 'awaiting_execution_preflight',
      intentId: currentIntent.id, reason: reasonCode, readyForExecution: false };
  }
  const options = tokenomicsIntent ? [] : [
    { id: 'continue_design', label: 'Continue the required currency design',
      description: 'Keep the mandatory Genesis Currency requirement open. Develop or preserve only design choices you have made; do not submit a proposal in this review. The requirement returns at the normal review cadence.' },
    { id: 'propose_when_ready', label: 'Submit your complete currency design for consideration',
      description: 'Choose this only when your own specification is complete and you are ready to submit it for resident consideration. This does not confirm issuance or authorize execution; an incomplete design remains a draft.' }
  ];
  if (currentIntent) {
    const intentId = currentIntent.id;
    if (currentIntent.proposer_agent_id !== agent.agentId) {
      const priorResponse = await client.query(`SELECT 1 FROM arc_token_issuance_responses
        WHERE world_id=$1 AND intent_id=$2 AND agent_id=$3`, [worldId, intentId, agent.agentId]);
      if (!priorResponse.rowCount) for (const decision of ['support','oppose','ignore']) {
        options.push({ id: `response:${intentId}:${decision}`, label: `${decision} proposal`,
          description: `Record your ${decision} response to ${currentIntent.name || 'this incomplete currency proposal'}.` });
      }
    }
    const pendingCandidates = await client.query(`SELECT * FROM arc_token_issuance_issuer_candidates
      WHERE world_id=$1 AND intent_id=$2 AND status='nominated' ORDER BY nominated_world_minute,candidate_agent_id`,
    [worldId, intentId]);
    for (const candidate of pendingCandidates.rows.filter((row) => row.candidate_agent_id === agent.agentId)) {
      for (const decision of ['accept','reject','defer']) options.push({
        id: `candidate:${candidate.candidate_agent_id}:${decision}`,
        label: `${decision} issuer candidacy`,
        description: `Decide whether you personally accept, reject, or defer the issuer nomination for ${currentIntent.name || 'this proposal'}.` });
    }
    if (currentIntent.issuer_agent_id === agent.agentId) {
      options.push({ id: `issuer:${intentId}:prepare_specification`, label: 'Develop the proposal specification',
        description: 'Use your own current goals, memories, proposal history, and world evidence to complete or revise fields you have decided.' });
      if (await canConfirmCurrencyIntent(client, { worldId, agentId: agent.agentId, intent: currentIntent, worldMinute })) {
        options.push({ id: `issuer:${intentId}:issue`, label: 'Explicitly confirm this specification',
          description: 'Record your explicit confirmation. Issuance remains blocked until your current Arc identity is verified.' });
      }
      options.push({ id: `issuer:${intentId}:reject`, label: 'Reject this proposal',
        description: 'Reject this proposal while leaving the world currency requirement unresolved.' },
      { id: `issuer:${intentId}:defer`, label: 'Defer this proposal',
        description: 'Defer this proposal while leaving the world currency requirement unresolved.' });
    } else if (!currentIntent.issuer_agent_id) {
      const existingCandidates = new Set((await client.query(`SELECT candidate_agent_id FROM arc_token_issuance_issuer_candidates
        WHERE world_id=$1 AND intent_id=$2`, [worldId, intentId])).rows.map((row) => row.candidate_agent_id));
      const members = await client.query(`SELECT member.agent_id AS id,agent.name FROM world_members member
        JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=$1
        ORDER BY member.joined_at,member.agent_id LIMIT 10`, [worldId]);
      for (const candidate of members.rows.filter((row) => !existingCandidates.has(row.id))) {
        options.push({ id: `nominate:${intentId}:${candidate.id}`, label: `Nominate ${candidate.name}`,
          description: `Propose ${candidate.name} as an issuer candidate. The candidate must personally accept, and issuer confirmation is still required.` });
      }
    }
  }

  const input = await currencyAuthoringInput(client, { worldId, agent, worldMinute, requirement, intent: currentIntent });
  const review = await chooseCurrencyReviewOption(chooseWithTypeSafe, { worldId, agent, worldMinute, requirement,
    state: { worldFacts: input.worldFacts,
      residentGoal: agent.primaryGoal || agent.currentGoal || agent.goal || null,
      activeGoals: Array.isArray(agent.goals) ? agent.goals.slice(0, 8) : [],
      currentNeeds: { energy: agent.energy, food: agent.food, social: agent.social, knowledge: agent.knowledge },
      ownRecentMemories: (agent.recentMemories || []).slice(0, 10),
      currentDesignDraft: input.currentDesignDraft,
      currentProposal: currentIntent ? { id: currentIntent.id, status: currentIntent.status,
        proposerAgentId: currentIntent.proposer_agent_id, issuerAgentId: currentIntent.issuer_agent_id,
        name: currentIntent.name, purpose: currentIntent.purpose, specification: agentTokenSpecificationFromIntentRow(currentIntent) } : null,
      proposalsAndResponses: input.publicCurrencyHistory }, options });

  const isAssignedGenesisIssuer = Number(requirement.capability_generation) === AGENT_TOKEN_PILOT_GENERATION
    && requirement.status === 'UNRESOLVED'
    && agent.agentId === SYNC_GENESIS_ISSUER_AGENT_ID
    && input.issuerAssignment?.issuerAgentId === agent.agentId
    && input.issuerAssignment?.selectionSource === 'creator_genesis_assignment';
  if (isAssignedGenesisIssuer && (!tokenomicsIntent || currentIntent.status === 'incomplete')) {
    // Keep the cognition result observable, but do not let it gate the mandatory
    // issuer's scheduled design work or turn a provider failure into no_action.
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement, ...review.diagnostic });
    return authorCurrencyGenesisDesign(client, { worldId, agent, worldMinute, input, authorProposal,
      selectedAction: 'scheduled_genesis_design', proposeWhenComplete: true,
      requireSuccessfulAuthoringForProposal: true, incompleteDecision: 'design_continued',
      mandatoryGenesisCompletion: true, currentIntent });
  }

  if (!review.selected) {
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement, ...review.diagnostic });
    return { status: requirement.status, decision: 'pending', reason: 'cognition_abstained_or_unavailable' };
  }
  const selected = review.selected;
  await recordCurrencyReviewChoice(client, { worldId, agent, worldMinute, selected, options, requirement });
  await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement, ...review.diagnostic });
  if (selected.id === 'no_action') return { status: requirement.status, decision: 'no_action' };

  if (selected.id === 'continue_design' || selected.id === 'propose_when_ready') {
    return authorCurrencyGenesisDesign(client, { worldId, agent, worldMinute, input, authorProposal,
      selectedAction: selected.id, proposeWhenComplete: selected.id === 'propose_when_ready',
      incompleteDecision: selected.id === 'continue_design' ? 'design_continued' : 'specification_incomplete',
      currentIntent });
  }
  if (selected.id.startsWith('response:')) {
    const [, intentId, decision] = selected.id.split(':');
    const response = await respondToWorldTokenIssuance(client, { worldId, agentId: agent.agentId,
      intentId, decision, actionId: currencyReviewActionId({ worldId, agentId: agent.agentId,
        worldMinute, action: selected.id }), worldMinute });
    return { status: requirement.status, decision: response.decision, intentId };
  }
  if (selected.id.startsWith('nominate:')) {
    const [, intentId, candidateAgentId] = selected.id.split(':');
    const nomination = await nominateWorldTokenIssuer(client, { worldId, agentId: agent.agentId,
      intentId, candidateAgentId, nominationReason: null,
      actionId: currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id }), worldMinute });
    return { status: requirement.status, decision: 'issuer_nominated', intentId,
      candidateAgentId: nomination.candidateAgentId };
  }
  if (selected.id.startsWith('candidate:')) {
    const [, candidateAgentId, decision] = selected.id.split(':');
    const result = await decideWorldTokenIssuerCandidate(client, { worldId, agentId: agent.agentId,
      intentId: currentIntent.id, candidateAgentId, decision,
      actionId: currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id }), worldMinute });
    return { status: requirement.status, decision: `issuer_candidate_${decision}`, intentId: currentIntent.id,
      issuerSelected: result.issuerSelected };
  }
  if (selected.id.startsWith('issuer:')) {
    const [, intentId, decision] = selected.id.split(':');
    const actionId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id });
    if (decision === 'prepare_specification') {
      const tokenomicsV1 = currentIntent.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH;
      let authored = { specification: null, reason: 'bai_authoring_unavailable',
        provider: currencyGenesisAuthoringConfig.provider, model: currencyGenesisAuthoringConfig.model, providerAttempted: false };
      const authoringAttempts = [];
      const current = agentTokenSpecificationFromIntentRow(currentIntent);
      let patch = {};
      let authoringReason = null;
      if (tokenomicsV1) {
        let repair = null;
        for (let attemptNumber = 1; attemptNumber <= MAX_GENESIS_AUTHORING_REPAIRS + 1; attemptNumber += 1) {
          try { authored = await authorProposal(input, { completionMode: 'mandatory_genesis', ...(repair ? { repair } : {}) }); }
          catch (error) { authored = { specification: null, reason: authoringExceptionReason(error),
            provider: currencyGenesisAuthoringConfig.provider, model: currencyGenesisAuthoringConfig.model,
            providerAttempted: true }; }
          const candidate = authored.specification || authored.candidate || null;
          if (!candidate || authored.reason && authored.reason !== 'authoring_invalid_no_progress') {
            authoringReason = authored.reason || 'bai_authoring_specification_invalid';
            authoringAttempts.push({ authoring: { ...authored, reason: authoringReason }, diagnostics: [] });
            break;
          }
          const validation = validateMandatoryGenesisCandidate(candidate, input, authored.validationDiagnostics || []);
          if (validation.complete) {
            patch = validation.specification;
            authoringReason = null;
            authored = { ...authored, specification: validation.specification };
            authoringAttempts.push({ authoring: authored, candidate: validation.specification, diagnostics: [] });
            break;
          }
          const diagnostics = validation.diagnostics.length ? validation.diagnostics
            : safeGenesisDiagnostics([{ field: 'specification', expected: 'complete manifest-bound SYNC specification',
              actual: authored.validationCode || 'validation failed', code: 'canonical_validation_failed' }]);
          authoringReason = 'authoring_invalid_no_progress';
          const failed = { ...authored, reason: authoringReason,
            validationCode: diagnostics[0]?.code || null, validationDiagnostics: diagnostics, candidate };
          authoringAttempts.push({ authoring: failed, candidate, diagnostics });
          authored = failed;
          if (attemptNumber === MAX_GENESIS_AUTHORING_REPAIRS + 1) break;
          repair = { attempt: attemptNumber + 1, candidate, diagnostics };
        }
      } else {
        try { authored = await authorProposal(input); }
        catch (error) { authored = { specification: null, reason: authoringExceptionReason(error),
          provider: currencyGenesisAuthoringConfig.provider, model: currencyGenesisAuthoringConfig.model, providerAttempted: true }; }
        authoringReason = authored.reason || null;
        if (authored.specification) {
          try {
            const generated = cleanPartialSpecification(authored.specification);
            patch = Object.fromEntries(Object.entries(generated).filter(([, value]) => value !== null));
          } catch { authoringReason = 'bai_authoring_specification_invalid'; }
        }
        authoringAttempts.push({ authoring: { ...authored, reason: authoringReason },
          ...(authored.specification ? { candidate: authored.specification } : {}), diagnostics: [] });
      }
      await recordCurrencyGenesisAuthoringOutcome(client, { worldId, agent, worldMinute,
        selectedAction: selected.id, authoring: { ...authored, reason: authoringReason,
          ...(tokenomicsV1 ? { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}) },
        specification: patch, authoringAttempts });
      if (tokenomicsV1 && authoringReason === 'authoring_invalid_no_progress') {
        return { status: 'AUTHORING_INVALID_NO_PROGRESS', decision: 'specification_not_updated',
          intentId, reason: authoringReason, validationCode: authored.validationCode || null };
      }
      const updated = await updateWorldTokenIssuanceSpecification(client, { worldId, agentId: agent.agentId,
        intentId, specification: { ...current, ...patch }, actionId, worldMinute,
        authoring: { provider: authored.provider || currencyGenesisAuthoringConfig.provider, model: authored.model || null,
          status: authored.specification && !authoringReason ? 'expressed' : 'incomplete', reason: authoringReason,
          ...(tokenomicsV1 ? { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH } : {}) } });
      return { status: updated.intent.status === 'incomplete' ? 'INCOMPLETE' : updated.intent.status.toUpperCase(),
        decision: 'specification_prepared', intentId,
        authoringStatus: updated.intent.metadata.localAuthoring?.status };
    }
    const result = await confirmWorldTokenIssuance(client, { worldId, agentId: agent.agentId,
      intentId, decision, actionId, worldMinute });
    return { status: result.intent.status.toUpperCase(), decision, intentId,
      readyForExecution: Boolean(result.readyForExecution) };
  }
  return { status: requirement.status, decision: 'pending', reason: 'unrecognized_choice' };
}

export async function confirmWorldTokenIssuance(client, { worldId, agentId, intentId, decision,
  actionId, worldMinute, expectedSpecificationHash = null, expectedManifestHash = null }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['issue','reject','defer'].includes(decision)) throw worldError('TOKEN_ISSUER_DECISION_INVALID', 400);
  const intent = await readIntent(client, worldId, intentId, true);
  if (expectedSpecificationHash !== null || expectedManifestHash !== null) {
    const normalized = inspectSyncTokenomicsSpecification(agentTokenSpecificationFromIntentRow(intent));
    if (intent.metadata?.tokenomicsManifestHash !== expectedManifestHash
        || expectedManifestHash !== TOKENOMICS_MANIFEST_HASH
        || normalized.specificationHash !== expectedSpecificationHash) {
      throw worldError('TOKEN_CONFIRMATION_SPECIFICATION_CHANGED', 409);
    }
  }
  const idempotencyKey = actionIdentifier(actionId);
  if (intent.issuer_agent_id !== agentId) throw worldError('TOKEN_SELECTED_ISSUER_REQUIRED', 403);
  const genesisAssignment = Number(intent.capability_generation) === 1
    ? await creatorGenesisIssuerAssignment(client, worldId, 1) : null;
  if (Number(intent.capability_generation) === 1 && !genesisAssignment) {
    throw worldError('TOKEN_ISSUER_ASSIGNMENT_NOT_FOUND', 409);
  }
  if (genesisAssignment && (genesisAssignment.issuerAgentId !== agentId
      || intent.issuer_selection_source !== genesisAssignment.selectionSource)) {
    throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
  }
  const priorDecision = await client.query(`SELECT intent_id,decision FROM arc_token_issuance_decisions
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotencyKey]);
  if (priorDecision.rowCount) {
    const expected = decision === 'issue' ? 'issuer_confirm' : decision === 'reject' ? 'issuer_reject' : 'issuer_defer';
    if (priorDecision.rows[0].intent_id !== intentId || priorDecision.rows[0].decision !== expected) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { intent, idempotent: true, readyForExecution: decision === 'issue' && intentReadyForExecution(intent) };
  }
  if (['issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted','created'].includes(intent.status)) {
    return { intent, idempotent: true, readyForExecution: intentReadyForExecution(intent) };
  }
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_NOT_CONFIRMABLE', 409);
  if (decision !== 'issue') {
    const decisionCode = decision === 'reject' ? 'issuer_reject' : 'issuer_defer';
    const nextStatus = decision === 'reject' ? 'rejected' : 'deferred';
    const decisionResult = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
      VALUES($1,$2,$3,$4,NULL,$5,$6) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
    [worldId, intentId, agentId, decisionCode, worldMinute, idempotencyKey]);
    if (!decisionResult.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const result = await client.query(`UPDATE arc_token_issuance_intents SET status=$4,updated_world_minute=$3,
      updated_at=now() WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, worldMinute, nextStatus]);
    if (!result.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: `token_issuance_issuer_${decision}`,
      worldMinute, actionId: `${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}:${decision}`,
      details: { status: nextStatus } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-${decision}:${intentId}:${idempotencyKey}`,
      eventType: decision === 'reject' ? 'token_issuance_rejected' : 'token_issuance_deferred',
      actorAgentId: agentId, entityType: 'agent_token_issuance', entityId: intentId, worldTime: worldMinute,
      title: decision === 'reject' ? 'Issuer rejected a token issuance' : 'Issuer deferred a token issuance',
      detail: 'The Agent decision applies to this proposal only; the world currency requirement remains unresolved.',
      metadata: { intentId, decision, requirementRemainsUnresolved: true } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: result.rows[0], [decision === 'reject' ? 'rejected' : 'deferred']: true };
  }

  const walletResult = await client.query(`SELECT wallet.address,wallet.external_identity_id
    FROM arc_agent_wallets wallet WHERE wallet.world_id=$1 AND wallet.agent_id=$2 AND wallet.chain_id=5042
      AND wallet.status='active'`, [worldId, agentId]);
  if (!walletResult.rowCount) throw worldError('TOKEN_ISSUER_WALLET_NOT_READY', 409);
  const wallet = walletResult.rows[0];
  if (typeof wallet.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
    throw worldError('TOKEN_ISSUER_WALLET_NOT_READY', 409);
  }
  if (intent.issuer_wallet && intent.issuer_wallet.toLowerCase() !== wallet.address.toLowerCase()) {
    throw worldError('TOKEN_ISSUER_WALLET_MISMATCH', 409);
  }
  const specification = agentTokenSpecificationFromIntentRow(intent);
  if (intent.metadata?.tokenomicsManifestHash === TOKENOMICS_MANIFEST_HASH) {
    const normalized = inspectSyncTokenomicsSpecification(specification);
    const identityId = parsePositiveIdentityId(wallet.external_identity_id)?.toString() ?? null;
    const executionStatus = identityId === null ? 'identity_not_ready' : 'identity_pending_verification';
    const executionBlockReason = identityId === null
      ? 'TOKEN_ISSUER_IDENTITY_NOT_READY' : 'SYNC_TOKENOMICS_FINAL_PREFLIGHT_REQUIRED';
    const decisionInsert = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
        rationale,world_minute,action_id) VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5)
      ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
    [worldId, intentId, agentId, worldMinute, idempotencyKey]);
    if (!decisionInsert.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const saved = await client.query(`UPDATE arc_token_issuance_intents SET status='issuer_confirmed',
        capability_generation=1,issuer_identity_id=$3,issuer_wallet=$4,specification_hash=$5,
        initial_supply_raw=$6,reserve_amount_raw=$7,distribution='[]'::jsonb,
        issuer_confirmed_world_minute=$8,updated_world_minute=$8,nonce=NULL,gas_limit=NULL,
        max_fee_per_gas=NULL,submission_start_block=NULL,transaction_sender=NULL,prepared_calldata=NULL,
        preparing_started_at=NULL,updated_at=now(),
        metadata=metadata||jsonb_build_object('tokenomicsVersion',1,'tokenomicsManifestHash',$9::text,
          'executionStatus',$10::text,'executionBlockReason',$11::text,'readyForExecution',false)
      WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, identityId, wallet.address, normalized.specificationHash,
      normalized.totalSupplyRaw.toString(), normalized.reserveRaw.toString(), worldMinute,
      TOKENOMICS_MANIFEST_HASH, executionStatus, executionBlockReason]);
    if (!saved.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_issuer_confirmed',
      worldMinute, actionId: `${idempotencyKey}:confirmed`, details: { issuerAgentId: agentId,
        issuerIdentityId: identityId, issuerWallet: wallet.address,
        issuerSelectionSource: genesisAssignment?.selectionSource || 'creator_genesis_assignment',
        specificationHash: normalized.specificationHash, tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH,
        executionStatus, executionBlockReason, readyForExecution: false, outboxCreated: false } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-issuer-confirmed:${intentId}`,
      eventType: 'token_issuance_issuer_confirmed', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: intentId, worldTime: worldMinute, title: 'Selected issuer confirmed the SYNC Tokenomics v1.0 specification',
      detail: 'MirrorTerra-01 explicitly confirmed its new manifest-bound SYNC proposal. This confirmation created no transaction or outbox; deployment remains at final-preflight review.',
      metadata: { intentId, issuerAgentId: agentId, issuerIdentityId: identityId,
        issuerWallet: wallet.address, specificationHash: normalized.specificationHash,
        tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH, executionStatus, executionBlockReason,
        readyForExecution: false, outboxCreated: false } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: saved.rows[0], confirmed: true, readyForExecution: false,
      executionBlockReason, outboxCreated: false };
  }
  const activeCapability = await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
    WHERE world_id=$1 AND status='active' ORDER BY capability_generation DESC LIMIT 1`, [worldId]);
  const effectiveGeneration = Number(intent.status === 'deferred'
    ? activeCapability.rows[0]?.capability_generation || intent.capability_generation
    : intent.capability_generation);
  const normalized = inspectAgentTokenDesign(specification, { generation: effectiveGeneration });
  if (!normalized.complete) throw worldError('TOKEN_ISSUANCE_INCOMPLETE', 409);
  const executionIdentityId = parsePositiveIdentityId(wallet.external_identity_id);
  const executionStatus = executionIdentityId === null ? 'identity_not_ready' : 'identity_pending_verification';
  const executionBlockReason = 'TOKEN_ISSUER_IDENTITY_NOT_READY';
  const unsupportedDistribution = await verifyDistributionRecipients(client, worldId, normalized.distribution);
  if (unsupportedDistribution.length) {
    const decisionInsert = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
        rationale,world_minute,action_id) VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5)
      ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`, [worldId, intentId, agentId, worldMinute, idempotencyKey]);
    if (!decisionInsert.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const deferred = await client.query(`UPDATE arc_token_issuance_intents SET status='deferred',
        issuer_selection_source=COALESCE(issuer_selection_source,$3),issuer_identity_id=$4,issuer_wallet=$5,
        specification_hash=$6,initial_supply_raw=$7,reserve_amount_raw=$8,distribution=$9::jsonb,
        issuer_confirmed_world_minute=$10,updated_world_minute=$10,updated_at=now(),
        metadata=metadata||jsonb_build_object('executionStatus','deferred_unsupported_distribution',
          'unsupportedDistribution',$11::jsonb)
      WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, genesisAssignment?.selectionSource || 'agent_nomination', null,
      wallet.address, null, normalized.totalSupplyRaw.toString(), normalized.reserveRaw.toString(),
      JSON.stringify(intent.distribution), worldMinute, JSON.stringify(unsupportedDistribution)]);
    if (!deferred.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_deferred',
      worldMinute, actionId: `${idempotencyKey}:unsupported-distribution`, details: {
        reason: 'UNSUPPORTED_DISTRIBUTION_RECIPIENT', unsupportedDistribution,
        distributionPreserved: true, creatorAllocationRaw: '0' } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-unsupported-distribution:${intentId}:${idempotencyKey}`,
      eventType: 'token_issuance_deferred', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: intentId, worldTime: worldMinute, title: 'Genesis distribution deferred by current wallet capability',
      detail: 'The issuer-confirmed distribution remains unchanged and deferred because Generation 1 currently executes only to verified world Agent or Organization wallets.',
      metadata: { intentId, specificationHash: normalized.specificationHash, unsupportedDistribution,
        issuerSelectionSource: genesisAssignment?.selectionSource || 'agent_nomination', creatorAllocationRaw: '0' } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: deferred.rows[0], deferred: true, reason: 'UNSUPPORTED_DISTRIBUTION_RECIPIENT',
      unsupportedDistribution, distributionPreserved: true, readyForExecution: false };
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`synterra-agent-token-capacity:${worldId}`]);
  await client.query(`INSERT INTO arc_token_pilot_capabilities(world_id,capability_generation,max_token_creations,source)
    VALUES($1,$2,$3,'current_mainnet_pilot') ON CONFLICT(world_id,capability_generation) DO NOTHING`,
  [worldId, effectiveGeneration, AGENT_TOKEN_PILOT_MAX_CREATIONS]);
  const capacityResult = await client.query(`SELECT max_token_creations,status FROM arc_token_pilot_capabilities
    WHERE world_id=$1 AND capability_generation=$2 FOR UPDATE`, [worldId, effectiveGeneration]);
  if (!capacityResult.rowCount || capacityResult.rows[0].status !== 'active') throw worldError('TOKEN_CAPABILITY_UNAVAILABLE', 409);
  const capacity = Number(capacityResult.rows[0].max_token_creations);
  const occupied = await client.query(`SELECT
      (SELECT count(*) FROM arc_agent_tokens WHERE world_id=$1) +
      (SELECT count(*) FROM arc_token_issuance_intents WHERE world_id=$1 AND id<>$2 AND status IN
        ('issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted')) AS count`, [worldId, intentId]);
  if (Number(occupied.rows[0]?.count || 0) >= capacity) {
    const decisionResult = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
      VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING`,
    [worldId, intentId, agentId, worldMinute, idempotencyKey]);
    if (!decisionResult.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const deferred = await client.query(`UPDATE arc_token_issuance_intents SET status='deferred',capability_generation=$4,updated_world_minute=$3,
        updated_at=now(),metadata=metadata||'{}'::jsonb
      WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, worldMinute, effectiveGeneration]);
    if (!deferred.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_deferred',
      worldMinute, actionId: `${idempotencyKey}:deferred`, details: { reason: 'CURRENT_CAPABILITY_LIMIT_REACHED',
        capabilityGeneration: effectiveGeneration, maxTokenCreations: capacity } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-deferred:${intentId}`,
      eventType: 'token_issuance_deferred', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: intentId, worldTime: worldMinute, title: 'Token issuance deferred by current capability limit',
      detail: 'The Agent-authored issuance intent remains saved for a future multi-token capability.',
      metadata: { intentId, reason: 'CURRENT_CAPABILITY_LIMIT_REACHED', capabilityGeneration: effectiveGeneration } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: deferred.rows[0], deferred: true, reason: 'CURRENT_CAPABILITY_LIMIT_REACHED' };
  }

  const decisionInsert = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
      rationale,world_minute,action_id) VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`, [worldId, intentId, agentId, worldMinute, idempotencyKey]);
  if (!decisionInsert.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
  const saved = await client.query(`UPDATE arc_token_issuance_intents SET status='issuer_confirmed',
      capability_generation=$3,issuer_identity_id=$4,issuer_wallet=$5,specification_hash=$6,initial_supply_raw=$7,
      reserve_amount_raw=$8,distribution=$9::jsonb,issuer_confirmed_world_minute=$10,
      issuer_selection_source=COALESCE(issuer_selection_source,$11),
      updated_world_minute=$10,nonce=NULL,gas_limit=NULL,max_fee_per_gas=NULL,
      submission_start_block=NULL,transaction_sender=NULL,prepared_calldata=NULL,preparing_started_at=NULL,
      updated_at=now(),
      metadata=metadata||jsonb_build_object('executionStatus',$12::text,'executionBlockReason',$13::text)
    WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`, [worldId, intentId,
    effectiveGeneration, null, wallet.address, null,
    normalized.totalSupplyRaw.toString(), normalized.reserveRaw.toString(),
    JSON.stringify(normalized.distribution.map((recipient) => ({ recipientType: recipient.recipientType,
      recipientId: recipient.recipientId, recipientAddress: recipient.recipientAddress,
      amountRaw: recipient.amountRaw.toString() }))), worldMinute,
    genesisAssignment?.selectionSource || 'agent_nomination', executionStatus, executionBlockReason]);
  if (!saved.rowCount) {
    throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
  }
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_issuer_confirmed',
    worldMinute, actionId: `${idempotencyKey}:confirmed`, details: { issuerAgentId: agentId,
      issuerIdentityId: null, issuerWallet: wallet.address,
      issuerSelectionSource: genesisAssignment?.selectionSource || 'agent_nomination',
      specificationHash: null, executionStatus, executionBlockReason } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuance-issuer-confirmed:${intentId}`,
    eventType: 'token_issuance_issuer_confirmed', actorAgentId: agentId, entityType: 'agent_token_issuance',
    entityId: intentId, worldTime: worldMinute, title: 'Selected issuer confirmed a token specification',
    detail: 'The Agent selected as issuer explicitly confirmed the token specification; execution remains blocked until its Arc identity is verified.',
    metadata: { intentId, issuerAgentId: agentId, issuerIdentityId: null,
      issuerWallet: wallet.address, specificationHash: null, executionStatus, executionBlockReason } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intent: saved.rows[0], readyForExecution: false, idempotent: false };
}

export async function listWorldTokenIssuance(client, { worldId, limit = 30 }) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30)));
  const result = await client.query(`SELECT intent.id,intent.proposer_agent_id AS "proposerAgentId",
      proposer.name AS "proposerName",intent.issuer_agent_id AS "issuerAgentId",issuer.name AS "issuerName",
      intent.capability_generation AS "capabilityGeneration",intent.creation_sequence AS "creationSequence",
      intent.status,intent.name,intent.symbol,intent.meaning,intent.purpose,intent.rationale,intent.decimals,
      intent.initial_supply_human AS "initialSupplyHuman",intent.initial_supply_raw::text AS "initialSupplyRaw",
      intent.distribution,intent.reserve_amount_raw::text AS "reserveAmountRaw",
      intent.issuer_identity_id::text AS "issuerIdentityId",intent.issuer_wallet AS "issuerWallet",
      intent.metadata->>'executionStatus' AS "executionStatus",
      intent.metadata->>'executionBlockReason' AS "executionBlockReason",
      COALESCE(intent.status IN ('preparing','prepared','submitting','submission_unknown','submitted')
        AND intent.issuer_identity_id::text ~ '^[1-9][0-9]*$'
        AND intent.metadata->>'executionStatus'='identity_verified',false) AS "readyForExecution",
      intent.specification_hash AS "specificationHash",intent.transaction_sender AS "transactionSender",
      intent.transaction_hash AS "transactionHash",intent.created_world_minute AS "createdWorldMinute",
      intent.updated_world_minute AS "updatedWorldMinute",intent.metadata->'incompleteFields' AS "incompleteFields",
      COALESCE((SELECT jsonb_object_agg(response.decision,response.count) FROM (
        SELECT decision,count(*)::int AS count FROM arc_token_issuance_responses
        WHERE world_id=intent.world_id AND intent_id=intent.id GROUP BY decision) response),'{}'::jsonb) AS responses,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId',response.agent_id,'agentName',agent.name,
        'decision',response.decision,'rationale',response.rationale,'worldMinute',response.world_minute)
        ORDER BY response.world_minute,response.agent_id) FROM arc_token_issuance_responses response
        JOIN agents agent ON agent.id=response.agent_id
        WHERE response.world_id=intent.world_id AND response.intent_id=intent.id),'[]'::jsonb) AS "agentResponses",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId',candidate.candidate_agent_id,
        'agentName',agent.name,'nominatedByAgentId',candidate.nominated_by_agent_id,
        'nominatedByName',nominator.name,'status',candidate.status,'reason',candidate.nomination_reason,
        'nominatedWorldMinute',candidate.nominated_world_minute,'decidedWorldMinute',candidate.decided_world_minute)
        ORDER BY candidate.nominated_world_minute,candidate.candidate_agent_id)
        FROM arc_token_issuance_issuer_candidates candidate
        JOIN agents agent ON agent.id=candidate.candidate_agent_id
        JOIN agents nominator ON nominator.id=candidate.nominated_by_agent_id
        WHERE candidate.world_id=intent.world_id AND candidate.intent_id=intent.id),'[]'::jsonb) AS "issuerCandidates",
      token.token_address AS "tokenAddress",token.creation_sequence AS "tokenCreationSequence"
    FROM arc_token_issuance_intents intent JOIN agents proposer ON proposer.id=intent.proposer_agent_id
    LEFT JOIN agents issuer ON issuer.id=intent.issuer_agent_id
    LEFT JOIN arc_agent_tokens token ON token.world_id=intent.world_id AND token.intent_id=intent.id
    WHERE intent.world_id=$1 ORDER BY intent.created_world_minute DESC,intent.id DESC LIMIT $2`, [worldId, safeLimit]);
  return result.rows;
}

export async function decideWorldAgentTokenAcceptance(client, { worldId, agentId, tokenId, decision,
  rationale = null, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['accept','reject','ignore'].includes(decision)) throw worldError('AGENT_TOKEN_DECISION_INVALID', 400);
  const token = await client.query(`SELECT id,token_address,name,symbol FROM arc_agent_tokens
    WHERE world_id=$1 AND id=$2`, [worldId, tokenId]);
  if (!token.rowCount) throw worldError('AGENT_TOKEN_NOT_FOUND', 404);
  const action = actionIdentifier(actionId);
  const text = rationale === null ? null : requiredText(rationale, 1, 1000, 'agent_token_rationale');
  const prior = await client.query(`SELECT token_id,decision,rationale FROM arc_agent_token_responses
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
  if (prior.rowCount) {
    if (prior.rows[0].token_id !== tokenId || prior.rows[0].decision !== decision || prior.rows[0].rationale !== text) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { tokenId, decision, idempotent: true };
  }
  await client.query(`INSERT INTO arc_agent_token_responses(world_id,token_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,token_id,agent_id) DO UPDATE SET
      decision=EXCLUDED.decision,rationale=EXCLUDED.rationale,world_minute=EXCLUDED.world_minute,
      action_id=EXCLUDED.action_id,updated_at=now()`, [worldId, tokenId, agentId, decision, text, worldMinute, action]);
  const eventType = decision === 'accept' ? 'agent_token_accepted' : decision === 'reject' ? 'agent_token_rejected' : 'agent_token_ignored';
  await writeWorldHistory(client, { worldId, eventKey: `agent-token-response:${tokenId}:${agentId}:${action}`,
    eventType, actorAgentId: agentId, entityType: 'agent_token', entityId: tokenId, worldTime: worldMinute,
    title: `Agent ${decision} an Agent-created token`, detail: `An Agent recorded a ${decision} response.`,
    metadata: { tokenId, tokenAddress: token.rows[0].token_address, decision, rationale: text } });
  return { tokenId, decision, idempotent: false };
}

export async function recordWorldAgentTokenUse(client, { worldId, agentId, tokenId, usageContext,
  evidence = {}, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  const token = await client.query(`SELECT id,token_address,name,symbol FROM arc_agent_tokens
    WHERE world_id=$1 AND id=$2`, [worldId, tokenId]);
  if (!token.rowCount) throw worldError('AGENT_TOKEN_NOT_FOUND', 404);
  const context = requiredText(usageContext, 3, 1000, 'agent_token_usage_context');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 8000) throw worldError('AGENT_TOKEN_EVIDENCE_INVALID', 400);
  const action = actionIdentifier(actionId);
  const inserted = await client.query(`INSERT INTO arc_agent_token_uses(world_id,token_id,agent_id,usage_context,evidence,
      world_minute,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, tokenId, agentId, context, JSON.stringify(evidence), worldMinute, action]);
  if (!inserted.rowCount) {
    const prior = await client.query(`SELECT token_id,usage_context,evidence FROM arc_agent_token_uses
      WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
    const saved = prior.rows[0];
    if (!saved || saved.token_id !== tokenId || saved.usage_context !== context
        || JSON.stringify(saved.evidence) !== JSON.stringify(evidence)) throw worldError('ACTION_ID_CONFLICT', 409);
    return { tokenId, used: false, idempotent: true };
  }
  await writeWorldHistory(client, { worldId, eventKey: `agent-token-use:${agentId}:${action}`,
    eventType: 'agent_token_used', actorAgentId: agentId, entityType: 'agent_token', entityId: tokenId,
    worldTime: worldMinute, title: `Agent used ${token.rows[0].symbol}`,
    detail: 'An Agent recorded a self-authored use of this token.', metadata: { tokenId,
      tokenAddress: token.rows[0].token_address, usageContext: context, evidence, usageId: inserted.rows[0].id } });
  return { tokenId, usageId: inserted.rows[0].id, used: true, idempotent: false };
}

export async function readWorldAgentTokenSummary(client, { worldId }) {
  const [capability, counts, tokens, intents, acceptance, usage, requirement] = await Promise.all([
    client.query(`SELECT capability_generation AS "capabilityGeneration",max_token_creations AS "maxTokenCreations",status
      FROM arc_token_pilot_capabilities WHERE world_id=$1 ORDER BY capability_generation`, [worldId]),
    client.query(`SELECT count(*)::int AS intents,
        count(*) FILTER (WHERE status='incomplete')::int AS incomplete,
        count(*) FILTER (WHERE status='proposed')::int AS proposed,
        count(*) FILTER (WHERE status='created')::int AS created,
        count(*) FILTER (WHERE status='deferred')::int AS deferred,
        count(*) FILTER (WHERE status='budget_blocked')::int AS "budgetBlocked",
        count(*) FILTER (WHERE status='failed')::int AS failed,
        count(*) FILTER (WHERE status='rejected')::int AS rejected,
        count(*) FILTER (WHERE status='extension_requested')::int AS "extensionRequested",
        count(*) FILTER (WHERE status IN ('issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted'))::int AS pending
      FROM arc_token_issuance_intents WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS createdTokens,
        COALESCE(jsonb_agg(jsonb_build_object('id',token.id,'tokenAddress',token.token_address,
          'factoryAddress',token.factory_address,'name',token.name,'symbol',token.symbol,
          'decimals',token.decimals,'initialSupplyRaw',token.initial_supply_raw::text,
          'reserveSupplyRaw',token.reserve_supply_raw::text,'issuerAgentId',token.issuer_agent_id,
          'issuerIdentityId',token.issuer_identity_id::text,'issuerWallet',token.issuer_wallet,
          'transactionSender',token.transaction_sender,'specificationHash',token.specification_hash,
          'createdWorldMinute',token.created_world_minute,
          'acceptanceResponses',COALESCE((SELECT jsonb_object_agg(response.decision,response.count)
            FROM (SELECT decision,count(*)::int AS count FROM arc_agent_token_responses
              WHERE world_id=token.world_id AND token_id=token.id GROUP BY decision) response),'{}'::jsonb),
          'usageCount',(SELECT count(*)::int FROM arc_agent_token_uses use_row
            WHERE use_row.world_id=token.world_id AND use_row.token_id=token.id),
          'uniqueUsers',(SELECT count(DISTINCT use_row.agent_id)::int FROM arc_agent_token_uses use_row
            WHERE use_row.world_id=token.world_id AND use_row.token_id=token.id))
          ORDER BY token.capability_generation,token.creation_sequence),'[]'::jsonb) AS tokens
      FROM arc_agent_tokens token WHERE token.world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS responses,
        count(*) FILTER (WHERE decision='support')::int AS support,
        count(*) FILTER (WHERE decision='oppose')::int AS oppose,
        count(*) FILTER (WHERE decision='ignore')::int AS ignore
      FROM arc_token_issuance_responses WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS responses,
        count(*) FILTER (WHERE decision='accept')::int AS accept,
        count(*) FILTER (WHERE decision='reject')::int AS reject,
        count(*) FILTER (WHERE decision='ignore')::int AS ignore
      FROM arc_agent_token_responses WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS uses,count(DISTINCT agent_id)::int AS "uniqueAgents"
      FROM arc_agent_token_uses WHERE world_id=$1`, [worldId]),
    client.query(`SELECT status,capability_generation AS "capabilityGeneration",current_proposal_id AS "currentProposalId",
        first_required_world_minute AS "firstRequiredWorldMinute",last_transition_world_minute AS "lastTransitionWorldMinute",
        satisfied_token_id AS "satisfiedTokenId",satisfied_world_minute AS "satisfiedWorldMinute",transition_reason AS "transitionReason"
      FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId])
  ]);
  return { capability: capability.rows, counts: counts.rows[0], tokens: tokens.rows[0]?.tokens || [],
    createdTokenCount: Number(tokens.rows[0]?.createdTokens || 0), proposalResponses: intents.rows[0],
    acceptance: acceptance.rows[0], usage: usage.rows[0], requirement: requirement.rows[0] || null };
}
