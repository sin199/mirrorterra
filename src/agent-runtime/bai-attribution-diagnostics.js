import { nanoUsdToUsd } from './bai-pricing.js';

const KNOWN_COST = new Set(['usage_priced','provider_reported']);
const HIGH = new Set(['world_execution','plan_step_completed','plan_completed','tool_result_used']);
const PARTIAL = new Set(['plan_updated','replan_completed','grounding_succeeded',
  'memory_or_belief_updated','tool_result_cited','currency_authoring_persisted']);
const STABLE = new Set(['system_protocol','world_rules','output_schema']);
const round = (value) => Number(value.toFixed(6));
const ratio = (num, den) => den > 0 ? round(num / den) : null;
const dollars = (rows) => nanoUsdToUsd(rows.reduce((sum, row) =>
  sum + BigInt(row.effective_cost_nano_usd || 0), 0n));

export function classifyBaiCall(row, effects = []) {
  if (!row.correlation_id) return { value: 'unclassified', reason: 'historical_unlinked' };
  if (!row.provider_started_at) return { value: 'unclassified', reason: 'provider_not_started' };
  const types = new Set(effects.map((effect) => effect.effect_type));
  if ([...types].some((type) => HIGH.has(type))) return { value: 'highValue', reason: 'authoritative_or_used_effect' };
  if ([...types].some((type) => PARTIAL.has(type))) return { value: 'partialValue', reason: 'persisted_intermediate_effect' };
  if (['rejected','discarded','superseded','repair_input'].includes(row.application_status)) {
    return { value: 'wasted', reason: row.application_status };
  }
  if (row.status === 'failed') return { value: 'failed', reason: row.failure_code || 'provider_failure' };
  if (row.status === 'succeeded' && row.application_status === 'accepted') {
    return { value: 'noEffectYet', reason: 'accepted_awaiting_effect' };
  }
  return { value: 'unclassified', reason: 'application_result_unknown' };
}

function promptForCall(call, sections) {
  if (!sections.length) return null;
  const sectionTotals = Object.fromEntries(sections.map((section) => [section.section_name, {
    characters: Number(section.characters), bytes: Number(section.bytes),
    estimatedTokens: Number(section.estimated_tokens), contentHash: section.content_hash,
    duplicateHash: section.duplicate_hash,
    duplicateBytes: Number(section.duplicate_bytes) }]));
  const stableContextTokens = sections.filter((row) => STABLE.has(row.section_name))
    .reduce((sum, row) => sum + Number(row.estimated_tokens), 0);
  const dynamicContextTokens = sections.filter((row) => !STABLE.has(row.section_name))
    .reduce((sum, row) => sum + Number(row.estimated_tokens), 0);
  const duplicateTokensEstimate = Math.ceil(sections.reduce((sum, row) =>
    sum + Number(row.duplicate_bytes), 0) / 4);
  const otherBytes = Number(sectionTotals.other?.bytes || 0);
  const enough = call.prompt_metrics_complete === true && Number(call.request_bytes) > 0
    && otherBytes / Number(call.request_bytes) <= 0.1 && call.input_tokens != null;
  const avoidableInputTokensEstimate = enough ? duplicateTokensEstimate : null;
  return { totalInputTokens: call.input_tokens == null ? null : Number(call.input_tokens),
    stableContextTokens, dynamicContextTokens, duplicateTokensEstimate,
    providerCachedTokens: call.cached_input_tokens == null && call.cache_read_tokens == null
      ? null : Number(call.cached_input_tokens ?? call.cache_read_tokens),
    avoidableInputTokensEstimate,
    potentialReductionPercent: avoidableInputTokensEstimate == null
      ? null : ratio(100 * avoidableInputTokensEstimate, Number(call.input_tokens)),
    sectionTotals };
}

export function rollingBaiAttributionCalls(ledgerRows, now = Date.now()) {
  const start = now - 24 * 60 * 60_000;
  return ledgerRows.filter((row) => row.status !== 'blocked'
    && (row.provider_started_at || !row.correlation_id)
    && new Date(row.created_at).getTime() > start && new Date(row.created_at).getTime() <= now);
}

export function projectBaiAttributionDiagnostics({ ledgerRows = [], effectRows = [],
  sectionRows = [], now = Date.now(), requestedCallId = null } = {}) {
  const calls = rollingBaiAttributionCalls(ledgerRows, now);
  const scopedIds = new Set(calls.map((row) => row.id));
  const requestedOlder = requestedCallId && ledgerRows.find((row) => row.id === requestedCallId
    && !scopedIds.has(row.id));
  const effectsByCall = new Map();
  for (const effect of effectRows) {
    const list = effectsByCall.get(effect.model_call_id) || [];
    list.push(effect);
    effectsByCall.set(effect.model_call_id, list);
  }
  const sectionsByCall = new Map();
  for (const section of sectionRows) {
    const list = sectionsByCall.get(section.model_call_id) || [];
    list.push(section);
    sectionsByCall.set(section.model_call_id, list);
  }
  const allProjected = [...calls, ...(requestedOlder ? [requestedOlder] : [])].map((row) => {
    const evidence = effectsByCall.get(row.id) || [];
    return { modelCallId: row.id, createdAt: row.created_at, agentId: row.agent_id,
      source: row.source, trigger: row.trigger, tier: row.tier, requestedModel: row.model,
      returnedModel: row.returned_model, correlationId: row.correlation_id,
      providerRequestId: row.provider_request_id, providerResponseId: row.provider_response_id,
      goalId: row.goal_id, planId: row.plan_id, stepId: row.step_id,
      contextFingerprint: row.context_fingerprint,
      materialFingerprint: row.material_fingerprint,
      inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
      cacheReadTokens: row.cache_read_tokens == null ? null : Number(row.cache_read_tokens),
      cacheWriteTokens: row.cache_write_tokens == null ? null : Number(row.cache_write_tokens),
      cachedInputTokens: row.cached_input_tokens == null ? null : Number(row.cached_input_tokens),
      uncachedInputTokens: row.uncached_input_tokens == null ? null : Number(row.uncached_input_tokens),
      knownCostUsd: KNOWN_COST.has(row.cost_source) ? nanoUsdToUsd(BigInt(row.effective_cost_nano_usd)) : null,
      costSource: row.cost_source, status: row.status,
      httpStatus: row.http_status == null ? null : Number(row.http_status),
      providerErrorCode: row.provider_error_code || null,
      applicationStatus: row.application_status, applicationFailureCode: row.application_failure_code,
      ...classifyBaiCall(row, evidence),
      cognitionTurnIds: [...new Set(evidence.map((item) => item.cognition_turn_id).filter(Boolean))],
      worldEventIds: [...new Set(evidence.map((item) => item.world_event_id).filter(Boolean))],
      worldV7EventIds: [...new Set(evidence.map((item) => item.world_v7_event_id).filter(Boolean))],
      effects: [...new Set(evidence.map((item) => item.effect_type))],
      evidenceLinks: evidence.map((item) => ({ effectType: item.effect_type,
        cognitionTurnId: item.cognition_turn_id, goalId: item.goal_id,
        planId: item.plan_id, stepId: item.step_id, worldEventId: item.world_event_id,
        worldV7EventId: item.world_v7_event_id,
        toolAttemptId: item.tool_attempt_id, executionSource: item.execution_source })),
      promptEfficiency: promptForCall(row, sectionsByCall.get(row.id) || []) };
  });
  const projected = allProjected.filter((row) => scopedIds.has(row.modelCallId));
  const valuesByCall = new Map(projected.map((row) => [row.modelCallId, row.value]));
  const byValue = { highValue: 0, partialValue: 0, noEffectYet: 0, wasted: 0,
    failed: 0, unclassified: 0 };
  for (const call of projected) byValue[call.value] += 1;
  const scopedEffects = effectRows.filter((row) => scopedIds.has(row.model_call_id));
  const worldEvents = new Set(scopedEffects.filter((row) => row.effect_type === 'world_execution')
    .map((row) => row.world_event_id).filter(Boolean));
  const completedSteps = new Set(scopedEffects.filter((row) => row.effect_type === 'plan_step_completed')
    .map((row) => `${row.world_event_id}:${row.plan_id}:${row.step_id}`));
  const known = calls.filter((row) => KNOWN_COST.has(row.cost_source));
  const costFor = (value) => dollars(calls.filter((row) => KNOWN_COST.has(row.cost_source)
    && valuesByCall.get(row.id) === value));
  const totalTokensKnown = calls.every((row) => row.input_tokens != null && row.output_tokens != null);
  const tokenSum = calls.reduce((sum, row) => sum + Number(row.input_tokens || 0)
    + Number(row.output_tokens || 0), 0);
  const knownCostUsd = dollars(known);
  return { rolling24h: { callsByValue: byValue,
    effectiveness: { worldExecutionsAttributed: worldEvents.size,
      planStepsCompletedAttributed: completedSteps.size,
      groundingSucceededAttributed: new Set(scopedEffects.filter((row) =>
        row.effect_type === 'grounding_succeeded').map((row) => `${row.plan_id}:${row.step_id}`)).size,
      replansCompletedAttributed: new Set(scopedEffects.filter((row) =>
        row.effect_type === 'replan_completed').map((row) => row.cognition_turn_id)).size },
    cost: { knownCostUsd, costHighValueUsd: costFor('highValue'),
      costPartialValueUsd: costFor('partialValue'), costWastedUsd: costFor('wasted') },
    efficiency: { costPerWorldExecution: known.length === calls.length
        ? ratio(knownCostUsd, worldEvents.size) : null,
      costPerPlanStepCompleted: known.length === calls.length
        ? ratio(knownCostUsd, completedSteps.size) : null,
      tokensPerWorldExecution: totalTokensKnown ? ratio(tokenSum, worldEvents.size) : null,
      tokensPerPlanStepCompleted: totalTokensKnown ? ratio(tokenSum, completedSteps.size) : null,
      usefulCallRate: ratio(byValue.highValue + byValue.partialValue, calls.length) } },
    promptEfficiency: projected.at(-1)?.promptEfficiency || null,
    recentCalls: projected.slice(-12),
    call: requestedCallId ? allProjected.find((row) => row.modelCallId === requestedCallId) || null : null };
}
