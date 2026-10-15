import { randomUUID } from 'node:crypto';

const BAI_ORIGIN = 'https://api.b.ai/v1';
const MAX_CATALOG_BYTES = 512_000;
const MAX_COMPLETION_BYTES = 96_000;
const CLAUDE_MODEL_ID = /^claude-(haiku|sonnet|opus)(?:-|$)[a-z0-9.-]*$/i;

function modelVersion(id, tier) {
  const suffix = id.slice(`claude-${tier}`.length);
  return [...suffix.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function latestTierModel(ids, tier) {
  return ids.filter((id) => id.startsWith(`claude-${tier}-`) && modelVersion(id, tier).length)
    .sort((a, b) => {
      const left = modelVersion(a, tier);
      const right = modelVersion(b, tier);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
      }
      return b.localeCompare(a);
    })[0] || null;
}

function providerError(code, status = null) {
  return Object.assign(new Error(code), { code, status });
}

const ROLE_TIERS = Object.freeze({ memory: 'haiku', routine: 'haiku', planning: 'sonnet',
  execution: 'sonnet', strategic: 'opus' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeFailureCode(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (/insufficient[_ -]?(balance|credit)|balance[_ -]?insufficient|not enough credits/.test(text)) {
    return 'provider_insufficient_balance';
  }
  if (/model[_ -]?(not[_ -]?found|unsupported)|unsupported[_ -]?model/.test(text)) {
    return 'provider_model_unsupported';
  }
  return 'provider_request_failed';
}

async function providerErrorCode(response) {
  try {
    const body = await boundedJson(response, MAX_COMPLETION_BYTES);
    const error = body?.error;
    const code = safeFailureCode(error?.code || error?.type || error?.message || body?.code);
    if (code !== 'provider_request_failed') return code;
  } catch { /* The bounded response is diagnostic input only. */ }
  return 'provider_request_failed';
}

function callMetadata(input, model, tier, callId, correlationId) {
  const context = input.callContext && typeof input.callContext === 'object' ? input.callContext : {};
  return { id: callId, correlationId, agentId: context.agentId || null, tier, model,
    trigger: String(input.trigger || 'cognition').slice(0, 120),
    goalId: typeof context.goalId === 'string' ? context.goalId.slice(0, 120) : null,
    planId: typeof context.planId === 'string' ? context.planId.slice(0, 120) : null,
    stepId: typeof context.stepId === 'string' ? context.stepId.slice(0, 120) : null,
    cacheHit: context.cacheHit === true,
    memoryCandidates: Number.isInteger(context.memoryCandidates) ? context.memoryCandidates : null,
    memoryPrefiltered: Number.isInteger(context.memoryPrefiltered) ? context.memoryPrefiltered : null,
    memorySelected: Number.isInteger(context.memorySelected) ? context.memorySelected : null,
    groundingResult: typeof context.groundingResult === 'string' ? context.groundingResult.slice(0, 80) : null,
    executionResult: typeof context.executionResult === 'string' ? context.executionResult.slice(0, 80) : null };
}

// Provider credentials and transport stay behind this router. Callers use semantic
// tiers such as "execution" and receive normalized provider usage metadata.
export function createCognitionModelRouter({ apiKey, catalog, fetchImpl = fetch, onCall = null } = {}) {
  if (!catalog || typeof catalog !== 'object') throw providerError('BAI_MODEL_CATALOG_INVALID');
  return async function requestModel({ tier, messages, maxTokens = 3_000, timeoutMs = 45_000,
    trigger = 'cognition', callContext = {}, correlationId = null } = {}) {
    const actualTier = ROLE_TIERS[tier] || (['haiku','sonnet','opus'].includes(tier) ? tier : null);
    if (!actualTier || !catalog[actualTier]) throw providerError('BAI_MODEL_TIER_UNAVAILABLE');
    const model = catalog[actualTier];
    const callId = randomUUID();
    const linkedId = UUID.test(correlationId || '') ? correlationId : randomUUID();
    const metadata = callMetadata({ trigger, callContext }, model, actualTier, callId, linkedId);
    await onCall?.({ phase: 'started', ...metadata });
    let completion;
    try {
      completion = await completeBaiCognition({ apiKey, model, messages, maxTokens, timeoutMs, fetchImpl });
    } catch (error) {
      const code = safeFailureCode(error?.code || error?.message);
      await onCall?.({ phase: 'failed', ...metadata, failureCode: code });
      if (code === 'provider_insufficient_balance' || code === 'provider_model_unsupported') {
        throw providerError(code, error?.status || null);
      }
      throw error;
    }
    await onCall?.({ phase: 'succeeded', ...metadata, model: completion.model,
      inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens,
      totalTokens: completion.usage.totalTokens });
    return { ...completion, tier: actualTier, provider: 'bai', callId, correlationId: linkedId };
  };
}

async function boundedJson(response, maxBytes) {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw providerError('BAI_RESPONSE_TOO_LARGE', response.status);
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw providerError('BAI_RESPONSE_INVALID_JSON', response.status); }
}

export async function discoverBaiClaudeModels({ apiKey, fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw providerError('BAI_KEY_MISSING');
  let response;
  try {
    response = await fetchImpl(`${BAI_ORIGIN}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs)
    });
  } catch { throw providerError('BAI_CATALOG_UNAVAILABLE'); }
  if (!response.ok) throw providerError('BAI_CATALOG_HTTP_ERROR', response.status);
  const catalog = await boundedJson(response, MAX_CATALOG_BYTES);
  const available = new Set((Array.isArray(catalog.data) ? catalog.data : [])
    .filter((model) => typeof model?.id === 'string'
      && Array.isArray(model.supported_endpoint_types)
      && model.supported_endpoint_types.includes('openai'))
    .map((model) => model.id));
  const selected = Object.fromEntries(['haiku','sonnet','opus']
    .map((tier) => [tier, latestTierModel([...available], tier)]));
  if (!selected.sonnet || !selected.opus || !selected.haiku) {
    throw providerError('BAI_REQUIRED_CLAUDE_MODELS_UNAVAILABLE');
  }
  return Object.freeze({ ...selected, discoveredAt: new Date().toISOString(),
    availableClaudeIds: [...available].filter((id) => id.startsWith('claude-')).sort() });
}

export function routeCognition({ trigger = 'routine', stakes = 'low', uncertainty = 'low',
  agentRequest = null } = {}, catalog = {}) {
  const strategic = ['initial','strategic_review','identity_revision','goal_conflict','major_failure','major_opportunity'];
  const tier = agentRequest === 'opus' || strategic.includes(trigger) || stakes === 'high'
    ? 'opus' : trigger === 'routine_environment' && agentRequest !== 'sonnet'
      && uncertainty !== 'high' ? 'haiku' : 'sonnet';
  if (!catalog[tier]) throw providerError('BAI_MODEL_TIER_UNAVAILABLE');
  return { tier, model: catalog[tier] };
}

export async function completeBaiCognition({ apiKey, model, messages, fetchImpl = fetch,
  timeoutMs = 45_000, maxTokens = 3000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw providerError('BAI_KEY_MISSING');
  if (typeof model !== 'string' || !CLAUDE_MODEL_ID.test(model)) throw providerError('BAI_MODEL_NOT_APPROVED');
  if (!Array.isArray(messages) || messages.length < 2) throw providerError('BAI_MESSAGES_INVALID');
  let response;
  try {
    response = await fetchImpl(`${BAI_ORIGIN}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // Current Claude models reject temperature. The B.AI JSON schema option
      // does not consistently constrain Claude responses, so validate in code.
      body: JSON.stringify({ model, messages, max_tokens: maxTokens })
    });
  } catch { throw providerError('BAI_COMPLETION_UNAVAILABLE'); }
  if (!response.ok) throw providerError(await providerErrorCode(response), response.status);
  const envelope = await boundedJson(response, MAX_COMPLETION_BYTES);
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_COMPLETION_BYTES) {
    throw providerError('BAI_COMPLETION_CONTENT_INVALID');
  }
  let output;
  try { output = JSON.parse(content); }
  catch { throw providerError('BAI_COMPLETION_NOT_JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw providerError('BAI_COMPLETION_NOT_OBJECT');
  }
  return { output, model: envelope.model || model, usage: {
    inputTokens: Number(envelope?.usage?.prompt_tokens) || 0,
    outputTokens: Number(envelope?.usage?.completion_tokens) || 0,
    totalTokens: Number(envelope?.usage?.total_tokens) || 0
  } };
}
