import { MODEL_DAILY_BUDGET_NANO_USD, MODEL_DAILY_BUDGET_UNLIMITED, MODEL_DAILY_BUDGET_USD, nanoUsdToUsd }
  from './bai-pricing.js';
import { MAX_BAI_CALLS_PER_ROLLING_HOUR, nextAdmissionPossibleAt } from './bai-budget.js';

const SOURCES = ['openCognition','memorySelection','modelAnalysis','currencyGenesisAuthoring'];
const TIERS = ['haiku','sonnet','opus'];
const RELIABLE_COST_SOURCES = new Set(['usage_priced','provider_reported']);

function count(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function sumNano(rows) {
  return rows.reduce((sum, row) => sum + BigInt(row.effective_cost_nano_usd || 0), 0n);
}

function dollars(value) {
  return nanoUsdToUsd(value);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

function isHistoricalUnknown(row) {
  return Number(row.request_bytes) === 0 && row.cost_source === 'reservation';
}

export function projectBaiBudgetDiagnostics({ ledgerRows = [], activity = {}, states = [],
  deferredRows = [], worldMinute = 0, now = Date.now() } = {}) {
  const windowStart = now - 24 * 60 * 60_000;
  const windowRows = ledgerRows.filter((row) => {
    const created = new Date(row.created_at).getTime();
    return created > windowStart && created <= now;
  });
  const live = windowRows.filter((row) => row.status !== 'blocked');
  const known = live.filter((row) => RELIABLE_COST_SOURCES.has(row.cost_source));
  const historicalUnknown = live.filter(isHistoricalUnknown);
  const newCallReservations = live.filter((row) => row.cost_source === 'reservation'
    && !isHistoricalUnknown(row));
  const knownCostNano = sumNano(known);
  const newCallReservedNano = sumNano(newCallReservations);
  const unknownReserveNano = historicalUnknown.length ? MODEL_DAILY_BUDGET_NANO_USD : 0n;
  const committedOrReservedNano = knownCostNano + newCallReservedNano + unknownReserveNano;
  const nextBudgetAt = committedOrReservedNano >= MODEL_DAILY_BUDGET_NANO_USD
    ? nextAdmissionPossibleAt({ now, knownCalls: live.filter((row) => !isHistoricalUnknown(row)),
      unknownLatestAt: historicalUnknown.length
        ? historicalUnknown.reduce((latest, row) => new Date(row.created_at) > new Date(latest)
          ? row.created_at : latest, historicalUnknown[0].created_at) : null,
      reservationNanoUsd: 1n }) : null;
  const lastHourCalls = live.filter((row) => Number(row.request_bytes) > 0
    && new Date(row.created_at).getTime() > now - 60 * 60_000);
  const nextRateSlotAt = lastHourCalls.length >= MAX_BAI_CALLS_PER_ROLLING_HOUR
    ? new Date(Math.min(...lastHourCalls.map((row) => new Date(row.created_at).getTime()))
      + 60 * 60_000 + 1_000).toISOString() : null;
  const activeDeferred = deferredRows.filter((row) => !row.resolved_at
    && new Date(row.deferred_until).getTime() > now);
  const pendingStates = states.filter((state) => state.budget_deferred_until
    && new Date(state.budget_deferred_until).getTime() > now);
  const sourceCostNano = Object.fromEntries(SOURCES.map((source) => [source,
    sumNano(known.filter((row) => row.source === source))]));
  const tierCostNano = Object.fromEntries(TIERS.map((tier) => [tier,
    sumNano(known.filter((row) => row.tier === tier))]));
  const recent = windowRows.filter((row) => new Date(row.created_at).getTime() >= now - 15 * 60_000);
  const recentLive = recent.filter((row) => row.status !== 'blocked');
  const recentKnown = recentLive.filter((row) => RELIABLE_COST_SOURCES.has(row.cost_source));
  const recentCostUsd = dollars(sumNano(recentKnown));
  const recentCostComplete = recentKnown.length === recentLive.length;
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
      budgetUnlimited: MODEL_DAILY_BUDGET_UNLIMITED,
      knownCostUsd: dollars(knownCostNano),
      unknownCallCount: historicalUnknown.length,
      unknownReserveUsd: dollars(unknownReserveNano),
      newCallReservedUsd: dollars(newCallReservedNano),
      committedOrReservedUsd: dollars(committedOrReservedNano),
      remainingAdmissionUsd: dollars(committedOrReservedNano >= MODEL_DAILY_BUDGET_NANO_USD
        ? 0n : MODEL_DAILY_BUDGET_NANO_USD - committedOrReservedNano),
      haikuKnownCostUsd: dollars(tierCostNano.haiku),
      sonnetKnownCostUsd: dollars(tierCostNano.sonnet),
      opusKnownCostUsd: dollars(tierCostNano.opus),
      modelAnalysisKnownCostUsd: dollars(sourceCostNano.modelAnalysis),
      bySourceKnownCostUsd: Object.fromEntries(SOURCES.map((source) =>
        [source, dollars(sourceCostNano[source])])),
      calls: live.length,
      blockedByBudget: windowRows.filter((row) => row.status === 'blocked').length,
      inputTokens: live.reduce((sum, row) => sum + count(row.input_tokens), 0),
      outputTokens: live.reduce((sum, row) => sum + count(row.output_tokens), 0)
    },
    budget: {
      nextAdmissionPossibleAt: nextBudgetAt,
      blockedByBudgetUnique: deferredRows.filter((row) => row.reason === 'budget')
        .reduce((sum, row) => sum + count(row.blocked_count), 0),
      suppressedDuplicateBudgetAttempts: deferredRows.filter((row) => row.reason === 'budget')
        .reduce((sum, row) => sum + count(row.suppressed_count), 0)
    },
    rateLimit: {
      maxCallsPerRollingHour: MAX_BAI_CALLS_PER_ROLLING_HOUR,
      callsLastHour: lastHourCalls.length,
      remainingCallsThisHour: Math.max(0, MAX_BAI_CALLS_PER_ROLLING_HOUR - lastHourCalls.length),
      blockedByRateLimit: deferredRows.filter((row) => row.reason === 'rate_limit')
        .reduce((sum, row) => sum + count(row.blocked_count), 0),
      nextRateSlotAt
    },
    deferred: {
      pendingCurrentNeeds: pendingStates.length + activeDeferred.filter((row) =>
        ['modelAnalysis','currencyGenesisAuthoring'].includes(row.source)).length,
      oldestDeferredAt: activeDeferred.length ? activeDeferred.reduce((oldest, row) =>
        new Date(row.created_at) < new Date(oldest) ? row.created_at : oldest,
      activeDeferred[0].created_at) : null
    },
    callActivityLast15m: {
      deterministicGateChecks: count(activity.deterministic_gate_checks),
      providerAdmissionAttempts: recent.length
        + deferredRows.filter((row) => new Date(row.last_seen_at).getTime() >= now - 15 * 60_000
          && row.reason === 'rate_limit').reduce((sum, row) => sum + count(row.blocked_count), 0),
      providerRequestsStarted: recentLive.filter((row) => row.provider_started_at).length
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
      costCoverage: recentCostComplete ? 'complete' : 'partial',
      costPerWorldExecutionUsd: recentCostComplete ? ratio(recentCostUsd, worldExecutions) : null,
      costPerPlanStepUsd: recentCostComplete ? ratio(recentCostUsd, planStepsCompleted) : null
    }
  };
}
