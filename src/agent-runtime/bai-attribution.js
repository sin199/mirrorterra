import { createHash } from 'node:crypto';

export const PROMPT_SECTION_NAMES = Object.freeze([
  'system_protocol','world_rules','agent_identity','self_model','goal','plan','plan_history',
  'memories','relationships','economic_state','world_state','world_delta','affordances',
  'capabilities','tool_schemas','other_agents','execution_results','output_schema','other'
]);

const hash = (value) => createHash('sha256').update(value).digest('hex');

// Called only after the final request body exists. Values stay in memory; returned rows contain no content.
export function measurePromptSections(serializedBody, sections = {}) {
  if (typeof serializedBody !== 'string') throw new TypeError('BAI_SERIALIZED_BODY_REQUIRED');
  const seen = new Map();
  const rows = PROMPT_SECTION_NAMES.filter((name) => name !== 'other').map((sectionName) => {
    const value = sections[sectionName];
    const content = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    const characters = [...content].length;
    const bytes = Buffer.byteLength(content, 'utf8');
    const contentHash = bytes ? hash(content) : null;
    const duplicateHash = contentHash && seen.has(contentHash) ? contentHash : null;
    if (contentHash) seen.set(contentHash, sectionName);
    return { sectionName, characters, bytes, estimatedTokens: bytes ? Math.ceil(bytes / 4) : 0,
      contentHash, duplicateHash, duplicateBytes: duplicateHash ? bytes : 0 };
  });
  const requestBytes = Buffer.byteLength(serializedBody, 'utf8');
  const accountedBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const otherBytes = Math.max(0, requestBytes - accountedBytes);
  const otherCharacters = Math.max(0, [...serializedBody].length
    - rows.reduce((sum, row) => sum + row.characters, 0));
  rows.push({ sectionName: 'other', characters: otherCharacters, bytes: otherBytes,
    estimatedTokens: otherBytes ? Math.ceil(otherBytes / 4) : 0,
    contentHash: null, duplicateHash: null, duplicateBytes: 0 });
  return { rows, requestBytes, complete: accountedBytes <= requestBytes,
    requestHash: hash(serializedBody) };
}

export function safeBaiEnvelopeMetadata(envelope, headers = null) {
  const usage = envelope?.usage && typeof envelope.usage === 'object' ? envelope.usage : {};
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const nonnegative = (...values) => {
    for (const value of values) {
      if (value == null || value === '') continue;
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 0) return number;
    }
    return null;
  };
  const safeId = (value) => typeof value === 'string' && /^[\w./:-]{1,160}$/.test(value) ? value : null;
  const providerRequestId = safeId(headers?.get?.('x-request-id')) || safeId(headers?.get?.('request-id'));
  return { providerRequestId, providerResponseId: safeId(envelope?.id),
    returnedModel: safeId(envelope?.model),
    usage: { inputTokens: nonnegative(usage.prompt_tokens, usage.input_tokens),
      outputTokens: nonnegative(usage.completion_tokens, usage.output_tokens),
      totalTokens: nonnegative(usage.total_tokens),
      cacheReadTokens: nonnegative(details.cache_read_input_tokens,
        usage.cache_read_input_tokens, usage.cache_read_tokens),
      cacheWriteTokens: nonnegative(details.cache_creation_input_tokens,
        usage.cache_creation_input_tokens, usage.cache_write_tokens),
      cachedInputTokens: nonnegative(details.cached_tokens, usage.cached_input_tokens),
      uncachedInputTokens: nonnegative(details.uncached_tokens, usage.uncached_input_tokens),
      providerReportedCostUsd: usage.cost_usd == null || usage.cost_usd === ''
        ? null : Number.isFinite(Number(usage.cost_usd)) && Number(usage.cost_usd) >= 0
          ? Number(usage.cost_usd) : null } };
}
