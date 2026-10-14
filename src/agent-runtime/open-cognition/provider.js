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
  agentRequest = null, complexPlan = false } = {}, catalog = {}) {
  const strategic = ['initial','strategic_review','identity_revision','goal_conflict','major_failure','major_opportunity'];
  const tier = agentRequest === 'opus' || strategic.includes(trigger) || stakes === 'high'
    ? 'opus' : trigger === 'routine_environment' && agentRequest !== 'sonnet'
      && uncertainty !== 'high' && !complexPlan ? 'haiku' : 'sonnet';
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
  if (!response.ok) throw providerError('BAI_COMPLETION_HTTP_ERROR', response.status);
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
