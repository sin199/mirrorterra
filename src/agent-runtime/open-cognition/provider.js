import { randomUUID } from 'node:crypto';
import { measurePromptSections, safeBaiEnvelopeMetadata, safeProviderErrorCode }
  from '../bai-attribution.js';
import { baiModelPrice } from '../bai-pricing.js';
import { lunaQuotaBackoff } from './quota-backoff.js';
import { challengerFallbackReason, MODEL_AB_MIN_OUTPUT_TOKENS } from './model-ab.js';

const BAI_ORIGIN = 'https://api.b.ai/v1';
export const CLAUDE_CASING_HINT = 'Respond with one json object that uses exactly the key names and letter case of the requested schema (for example camelCase keys such as selfModelUpdate or targetBindingMode, and lowercase values such as active or semantic where the schema shows them in lowercase). Do not convert keys or values to upper case.';
const MAX_CATALOG_BYTES = 512_000;
const MAX_COMPLETION_BYTES = 96_000;
const CLAUDE_MODEL_ID = /^claude-(haiku|sonnet|opus)(?:-|$)[a-z0-9.-]*$/i;
export const DEFAULT_OPEN_COGNITION_MODEL = 'gpt-6-luna';

export function configuredCognitionCatalog(model = process.env.OPEN_COGNITION_MODEL || DEFAULT_OPEN_COGNITION_MODEL) {
  if (model !== DEFAULT_OPEN_COGNITION_MODEL && !CLAUDE_MODEL_ID.test(model)) {
    throw providerError('BAI_MODEL_NOT_APPROVED');
  }
  baiModelPrice(model, 0);
  if (model === DEFAULT_OPEN_COGNITION_MODEL) {
    return Object.freeze({ haiku: model, sonnet: model, opus: model,
      discoveredAt: new Date().toISOString() });
  }
  return null; // Explicit Claude configuration uses provider discovery.
}

export function selectConfiguredClaudeCatalog(catalog, model) {
  const tier = CLAUDE_MODEL_ID.exec(model)?.[1]?.toLowerCase();
  if (!tier || !catalog?.availableClaudeIds?.includes(model)) {
    throw providerError('BAI_CONFIGURED_CLAUDE_MODEL_UNAVAILABLE');
  }
  return Object.freeze({ ...catalog, haiku: model, sonnet: model, opus: model });
}

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
  if (text.includes('model_daily_budget_exceeded')) return 'MODEL_DAILY_BUDGET_EXCEEDED';
  if (text.includes('model_hourly_rate_limited')) return 'MODEL_HOURLY_RATE_LIMITED';
  if (text.includes('bai_budget_')) return 'BAI_BUDGET_UNAVAILABLE';
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
    const providerCode = safeProviderErrorCode(error?.code)
      || safeProviderErrorCode(error?.type) || safeProviderErrorCode(body?.code);
    const metadata = safeBaiEnvelopeMetadata(body, response.headers);
    return Object.assign(providerError(code, response.status), {
      usage: { ...metadata.usage, providerFailed: true }, providerMetadata: metadata,
      providerErrorCode: providerCode });
  } catch { /* The bounded response is diagnostic input only. */ }
  return providerError('provider_request_failed', response.status);
}

function callMetadata(input, model, tier, callId, correlationId) {
  const context = input.callContext && typeof input.callContext === 'object' ? input.callContext : {};
  return { id: callId, correlationId, agentId: context.agentId || null, tier, model,
    trigger: String(input.trigger || 'cognition').slice(0, 120),
    goalId: typeof context.goalId === 'string' ? context.goalId.slice(0, 120) : null,
    planId: typeof context.planId === 'string' ? context.planId.slice(0, 120) : null,
    stepId: typeof context.stepId === 'string' ? context.stepId.slice(0, 120) : null,
    cacheHit: context.cacheHit === true,
    contextFingerprint: typeof context.contextFingerprint === 'string'
      ? context.contextFingerprint.slice(0, 128) : null,
    memoryCandidates: Number.isInteger(context.memoryCandidates) ? context.memoryCandidates : null,
    memoryPrefiltered: Number.isInteger(context.memoryPrefiltered) ? context.memoryPrefiltered : null,
    memorySelected: Number.isInteger(context.memorySelected) ? context.memorySelected : null,
    groundingResult: typeof context.groundingResult === 'string' ? context.groundingResult.slice(0, 80) : null,
    executionResult: typeof context.executionResult === 'string' ? context.executionResult.slice(0, 80) : null };
}

// Provider credentials and transport stay behind this router. Callers use semantic
// tiers such as "execution" and receive normalized provider usage metadata.
// modelab1: modelAb (from createModelAbRouting in model-ab.js) assigns each resident's calls to its cohort
// model. Without it (default null) the router behaves exactly as before.
export function createCognitionModelRouter({ apiKey, catalog, fetchImpl = fetch, onCall = null,
  budgetGateway = null, worldId = null, quotaBackoff = lunaQuotaBackoff, modelAb = null } = {}) {
  if (!catalog || typeof catalog !== 'object') throw providerError('BAI_MODEL_CATALOG_INVALID');
  async function requestModel(input = {}) {
    const { tier, messages, maxTokens = 3_000, timeoutMs = 45_000,
      trigger = 'cognition', callContext = {}, correlationId = null, promptSections = {},
      jsonRepairAttempt = false, forceModel = null, fallback = null } = input;
    const actualTier = ROLE_TIERS[tier] || (['haiku','sonnet','opus'].includes(tier) ? tier : null);
    if (!actualTier || !catalog[actualTier]) throw providerError('BAI_MODEL_TIER_UNAVAILABLE');
    const baseModel = catalog[actualTier];
    const assignment = modelAb && !forceModel ? modelAb.resolve(callContext?.agentId || null, baseModel) : null;
    const model = forceModel || assignment?.model || baseModel;
    const abCohort = fallback?.cohort ?? assignment?.cohort ?? input.abCohort ?? null;
    // A challenger call (the resident's cohort model differs from the catalog model) has its own quota
    // breaker and falls back once to the catalog model (Luna) on a provider failure.
    const challenger = Boolean(modelAb) && model !== baseModel;
    const breaker = challenger ? (modelAb.backoff || null) : quotaBackoff;
    const fallbackToControl = (reason) => requestModel({ ...input, forceModel: baseModel,
      jsonRepairAttempt: false, abCohort,
      fallback: { from: model, reason: String(reason).slice(0, 80), cohort: abCohort } });
    if (challenger) {
      try { breaker?.check(); } catch { return fallbackToControl('challenger_backoff'); }
      const bytes = Buffer.byteLength(JSON.stringify(messages || []), 'utf8');
      if (bytes > modelAb.maxPromptBytes()) return fallbackToControl('prompt_over_100k_guard');
    } else {
      // skillwork (fix 4): while a provider quota backoff is active, fail fast before the budget gateway.
      quotaBackoff?.check();
    }
    // modelab1: claude-haiku-5.5 spends hidden completion tokens before its answer (prod smoke: a council
    // vote used all 700 tokens and was cut off, finish_reason=length), so challenger calls get at least
    // MODEL_AB_MIN_OUTPUT_TOKENS. Luna calls keep their exact maxTokens.
    const effectiveMaxTokens = challenger ? Math.max(maxTokens, MODEL_AB_MIN_OUTPUT_TOKENS) : maxTokens;
    const callId = randomUUID();
    const linkedId = UUID.test(correlationId || '') ? correlationId : randomUUID();
    const metadata = callMetadata({ trigger, callContext }, model, actualTier, callId, linkedId);
    metadata.abCohort = abCohort;
    metadata.fallbackFromModel = fallback?.from || null;
    metadata.fallbackReason = fallback?.reason || null;
    let providerStarted = false;
    let completion;
    try {
      // B.AI only accepts json_object when a non-system message mentions "json";
      // system text does not count, so add a one-line hint when none does.
      const jsonFormat = model === DEFAULT_OPEN_COGNITION_MODEL;
      const requestMessages = jsonFormat && !messages.some((message) => message.role !== 'system'
        && /json/i.test(String(message.content || '')))
        ? [...messages, { role: 'user', content: 'Respond with one json object.' }]
        // modelab1: claude-haiku-5.5 answered long prompts with UPPER-CASED keys and enum values
        // (prod smoke 2026-10-22); ask for the schema's exact casing. Luna requests are unchanged.
        : challenger ? [...messages, { role: 'user', content: CLAUDE_CASING_HINT }] : messages;
      const serializedBody = JSON.stringify({ model, messages: requestMessages, max_tokens: effectiveMaxTokens,
        ...(jsonFormat ? { response_format: { type: 'json_object' } } : {}) });
      const promptMetrics = measurePromptSections(serializedBody, {
        system_protocol: messages.filter((message) => message.role === 'system')
          .map((message) => message.content).join('\n'), ...promptSections });
      metadata.contextFingerprint ||= promptMetrics.requestHash;
      const execute = async () => {
        await onCall?.({ phase: 'started', ...metadata });
        providerStarted = true;
        return completeBaiCognition({ apiKey, model, messages, maxTokens: effectiveMaxTokens,
          timeoutMs, fetchImpl, serializedBody });
      };
      completion = budgetGateway ? await budgetGateway.runRequest({ callId, worldId,
        agentId: metadata.agentId, source: trigger === 'memory_selection' ? 'memorySelection'
          : trigger === 'model_analysis' ? 'modelAnalysis' : 'openCognition',
        goalId: metadata.goalId, planId: metadata.planId, stepId: metadata.stepId,
        materialFingerprint: callContext.materialFingerprint || null,
        contextFingerprint: callContext.contextFingerprint || promptMetrics.requestHash,
        correlationId: linkedId, trigger, promptMetrics,
        abCohort, fallbackFromModel: metadata.fallbackFromModel, fallbackReason: metadata.fallbackReason,
        tier: actualTier, model, body: serializedBody, maxTokens: effectiveMaxTokens, timeoutMs }, execute)
        : await execute();
    } catch (error) {
      if (providerStarted) breaker?.onFailure(error);
      const code = ['BAI_COMPLETION_NOT_JSON','BAI_COMPLETION_NOT_OBJECT',
        'BAI_COMPLETION_CONTENT_INVALID'].includes(error?.code)
        ? error.code : safeFailureCode(error?.code || error?.message);
      if (providerStarted) await onCall?.({ phase: 'failed', ...metadata, failureCode: code,
        httpStatus: error?.status ?? null, providerErrorCode: error?.providerErrorCode ?? null,
        inputTokens: error?.usage?.inputTokens, outputTokens: error?.usage?.outputTokens,
        totalTokens: error?.usage?.totalTokens,
        providerMetadata: error?.providerMetadata || null });
      if (providerStarted && ['BAI_COMPLETION_NOT_JSON','BAI_COMPLETION_NOT_OBJECT',
        'BAI_COMPLETION_CONTENT_INVALID'].includes(error?.code)) {
        await budgetGateway?.recordApplicationResult?.(callId, 'rejected', error.code);
        await onCall?.({ phase: 'application', id: callId, applicationStatus: 'rejected',
          applicationFailureCode: error.code });
      }
      if (challenger) {
        const reason = challengerFallbackReason(error, { providerStarted });
        if (reason) return fallbackToControl(reason);
      }
      if (!jsonRepairAttempt && ['BAI_COMPLETION_NOT_JSON','BAI_COMPLETION_NOT_OBJECT'].includes(error?.code)) {
        return requestModel({ tier, messages: [...messages,
          { role: 'user', content: 'The prior response could not be parsed as one JSON object. Return one complete valid JSON object matching the requested schema.' }],
        maxTokens, timeoutMs, trigger, callContext, correlationId, promptSections,
        jsonRepairAttempt: true, forceModel: model, fallback, abCohort });
      }
      if (code === 'provider_insufficient_balance' || code === 'provider_model_unsupported') {
        throw providerError(code, error?.status || null);
      }
      throw error;
    }
    breaker?.onSuccess();
    await onCall?.({ phase: 'succeeded', ...metadata, model: completion.model,
      inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens,
      totalTokens: completion.usage.totalTokens, providerMetadata: completion.providerMetadata });
    return { ...completion, tier: actualTier, provider: 'bai', callId, correlationId: linkedId,
      requestedModel: model, abCohort, fallbackFrom: fallback?.from || null,
      fallbackReason: fallback?.reason || null };
  }
  requestModel.recordApplicationResult = async (callId, status, failureCode = null) => {
    try {
      await budgetGateway?.recordApplicationResult?.(callId, status, failureCode);
      await onCall?.({ phase: 'application', id: callId, applicationStatus: status,
        applicationFailureCode: failureCode });
    } catch {
      await onCall?.({ phase: 'telemetry_error', id: callId });
    }
  };
  return requestModel;
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
  timeoutMs = 45_000, maxTokens = 3000, serializedBody = null } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw providerError('BAI_KEY_MISSING');
  if (typeof model !== 'string' || (model !== DEFAULT_OPEN_COGNITION_MODEL && !CLAUDE_MODEL_ID.test(model))) {
    throw providerError('BAI_MODEL_NOT_APPROVED');
  }
  baiModelPrice(model, 0);
  if (!Array.isArray(messages) || messages.length < 2) throw providerError('BAI_MESSAGES_INVALID');
  let response;
  try {
    response = await fetchImpl(`${BAI_ORIGIN}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // Current Claude models reject temperature. The B.AI JSON schema option
      // does not consistently constrain Claude responses, so validate in code.
      body: serializedBody || JSON.stringify({ model, messages, max_tokens: maxTokens })
    });
  } catch { throw providerError('BAI_COMPLETION_UNAVAILABLE'); }
  if (!response.ok) throw await providerErrorCode(response);
  const envelope = await boundedJson(response, MAX_COMPLETION_BYTES);
  const providerMetadata = safeBaiEnvelopeMetadata(envelope, response.headers);
  const invalid = (code) => Object.assign(providerError(code, response.status), {
    usage: providerMetadata.usage, providerMetadata });
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_COMPLETION_BYTES) {
    throw invalid('BAI_COMPLETION_CONTENT_INVALID');
  }
  let output;
  try { output = parseCompletionObject(content); }
  catch { throw invalid('BAI_COMPLETION_NOT_JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw invalid('BAI_COMPLETION_NOT_OBJECT');
  }
  if (model !== DEFAULT_OPEN_COGNITION_MODEL) output = normalizeShoutedObject(output, messages);
  return { output, model: providerMetadata.returnedModel || model,
    usage: providerMetadata.usage, providerMetadata };
}

export function parseCompletionObject(content) {
  const trimmed = String(content).trim();
  try { return JSON.parse(trimmed); } catch { /* Bounded recovery below. */ }
  const unwrapped = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  if (unwrapped) {
    try { return JSON.parse(unwrapped); } catch { /* Try first complete object. */ }
  }
  const candidate = unwrapped || trimmed;
  const start = candidate.indexOf('{');
  if (start < 0) throw new SyntaxError('JSON_OBJECT_MISSING');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return JSON.parse(candidate.slice(start, index + 1));
  }
  throw new SyntaxError('JSON_OBJECT_INCOMPLETE');
}

// modelab1: claude-haiku-5.5 sometimes returns a long-prompt answer with every key and enum value upper-cased
// ({"IDS":[...]}, {"PLANUPDATES":[{"STATUS":"ACTIVE","TARGETBINDINGMODE":"SEMANTIC"}]}). Only when the
// top-level keys are ALL upper case and unknown to the prompt, map each key back to the prompt's own key
// with the same letters, and lower-case the values of the lowercase enum fields. Free text, ids and
// upper-case vocabularies (category, projectType) are left alone. Luna output is never touched.
const LOWERCASE_ENUM_FIELDS = new Set(['status','horizon','targetBindingMode','actionType','targetType','type',
  'decision','capability','operation','tier','requestModel','stance','blockedReason','kind','mode','unit']);
const SHOUTED_KEY = /^[A-Z][A-Z0-9_]*$/;
const SHOUTED_VALUE = /^[A-Z][A-Z0-9_-]*$/;

function promptKeyDictionary(messages) {
  const keys = new Map();
  const text = (Array.isArray(messages) ? messages : []).map((message) => String(message?.content || '')).join('\n');
  for (const match of text.matchAll(/\\?"([A-Za-z][A-Za-z0-9_]{0,63})\\?"\s*:/g)) {
    const upper = match[1].toUpperCase();
    const known = keys.get(upper);
    if (known === undefined) keys.set(upper, match[1]);
    else if (known !== match[1] && known !== null) keys.set(upper, null); // ambiguous: never guess
  }
  return { keys, text };
}

export function isShoutedObject(output, messages = []) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const names = Object.keys(output).filter((key) => /[A-Za-z]/.test(key));
  if (!names.length || !names.every((key) => SHOUTED_KEY.test(key) && /[A-Z]{2}/.test(key))) return false;
  const { keys } = promptKeyDictionary(messages);
  // Shouted only when the prompt itself does not use these upper-case keys.
  return names.some((key) => keys.get(key) && keys.get(key) !== key);
}

export function normalizeShoutedObject(output, messages = []) {
  if (!isShoutedObject(output, messages)) return output;
  const { keys } = promptKeyDictionary(messages);
  const walk = (value, field = null) => {
    if (Array.isArray(value)) return value.map((item) => walk(item, field));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const name = SHOUTED_KEY.test(key) && keys.get(key) ? keys.get(key) : key;
        return [name, walk(item, name)];
      }));
    }
    if (typeof value === 'string' && LOWERCASE_ENUM_FIELDS.has(field) && SHOUTED_VALUE.test(value)) return value.toLowerCase();
    return value;
  };
  return walk(output);
}
