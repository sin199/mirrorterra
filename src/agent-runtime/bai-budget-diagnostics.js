import { MODEL_DAILY_BUDGET_USD, nanoUsdToUsd } from './bai-pricing.js';

const SOURCES = ['openCognition','memorySelection','modelAnalysis','currencyGenesisAuthoring'];
const TIERS = ['haiku','sonnet','opus'];

function count(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function dollars(value) {
  return nanoUsdToUsd(BigInt(value || 0));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

export function projectBaiBudgetDiagnostics({ ledgerRows = [], activity = {}, states = [],
  worldMinute = 0 } = {}) {
  const live = ledgerRows.filter((row) => row.status !== 'blocked');
  const spentUsd = live.reduce((sum, row) => sum + dollars(row.effective_cost_nano_usd), 0);
  const sourceCostUsd = Object.fromEntries(SOURCES.map((source) => [source,
    live.filter((row) => row.source === source).reduce((sum, row) =>
      sum + dollars(row.effective_cost_nano_usd), 0)]));
  const tierCost = Object.fromEntries(TIERS.map((tier) => [tier,
    live.filter((row) => row.tier === tier).reduce((sum, row) =>
      sum + dollars(row.effective_cost_nano_usd), 0)]));
  const recent = ledgerRows.filter((row) => new Date(row.created_at).getTime() >= Date.now() - 15 * 60_000);
  const recentLive = recent.filter((row) => row.status !== 'blocked');
  const recentCost = recentLive.reduce((sum, row) => sum + dollars(row.effective_cost_nano_usd), 0);
  const recentTokens = recentLive.reduce((sum, row) =>
    sum + count(row.input_tokens) + count(row.output_tokens), 0);
  const planStepsCompleted = states.reduce((sum, state) => sum
    + (Array.isArray(state.plans) ? state.plans : []).reduce((planSum, plan) => planSum
      + (Array.isArray(plan.steps) ? plan.steps : []).filter((step) =>
        step.executionEvidence?.success === true
        && Number(step.executionEvidence.worldMinute) > Number(worldMinute) - 15).length, 0), 0);
  const worldExecutions = count(activity.world_executions);
  return {
    rolling24h: {
      budgetUsd: MODEL_DAILY_BUDGET_USD,
      spentUsd: Number(spentUsd.toFixed(9)),
      remainingUsd: Number(Math.max(0, MODEL_DAILY_BUDGET_USD - spentUsd).toFixed(9)),
      haikuCostUsd: Number(tierCost.haiku.toFixed(9)),
      sonnetCostUsd: Number(tierCost.sonnet.toFixed(9)),
      opusCostUsd: Number(tierCost.opus.toFixed(9)),
      modelAnalysisCostUsd: Number(sourceCostUsd.modelAnalysis.toFixed(9)),
      bySourceUsd: Object.fromEntries(SOURCES.map((source) =>
        [source, Number(sourceCostUsd[source].toFixed(9))])),
      calls: live.length,
      blockedByBudget: ledgerRows.filter((row) => row.status === 'blocked').length,
      inputTokens: live.reduce((sum, row) => sum + count(row.input_tokens), 0),
      outputTokens: live.reduce((sum, row) => sum + count(row.output_tokens), 0),
      unpricedReservations: live.filter((row) => row.cost_source === 'reservation').length
    },
    last15m: {
      haikuCalls: recentLive.filter((row) => row.tier === 'haiku').length,
      sonnetCalls: recentLive.filter((row) => row.tier === 'sonnet').length,
      opusCalls: recentLive.filter((row) => row.tier === 'opus').length,
      inputTokens: recentLive.reduce((sum, row) => sum + count(row.input_tokens), 0),
      outputTokens: recentLive.reduce((sum, row) => sum + count(row.output_tokens), 0),
      cacheHits: count(activity.cache_hits),
      replanCompleted: count(activity.replan_completed),
      groundingSucceeded: count(activity.grounding_succeeded),
      worldExecutions,
      planStepsCompleted,
      tokensPerWorldExecution: ratio(recentTokens, worldExecutions),
      costPerWorldExecutionUsd: ratio(recentCost, worldExecutions),
      costPerPlanStepUsd: ratio(recentCost, planStepsCompleted)
    }
  };
}
