import { createHash, randomUUID } from 'node:crypto';
import { baiAdmissionEstimate, baiPricedUsageNanoUsd, MODEL_DAILY_BUDGET_NANO_USD }
  from './bai-pricing.js';
import { safeProviderErrorCode } from './bai-attribution.js';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './client.js';
import { assertPlatformModelPrincipal, assertResearchInstitutionPrincipal, isModelPrincipalDenial } from './model-principal.js';

const SOURCES = new Set(['openCognition','memorySelection','modelAnalysis','currencyGenesisAuthoring']);
const positiveInt = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
export const MAX_BAI_CALLS_PER_ROLLING_HOUR = positiveInt(process.env.BAI_MAX_CALLS_PER_HOUR, 15);
export const MAX_BAI_CALLS_PER_AGENT_PER_ROLLING_HOUR = positiveInt(process.env.BAI_MAX_CALLS_PER_AGENT_PER_HOUR, 2);
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const EXPIRY_MARGIN_MS = 1_000;

function budgetError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function nonnegativeToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function reportedNanoUsd(value) {
  if (value === null || value === undefined || value === '') return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? BigInt(Math.ceil(cost * 1_000_000_000)) : null;
}

async function transaction(pool, task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await task(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function nextAdmissionPossibleAt({ now, knownCalls, unknownLatestAt, reservationNanoUsd }) {
  const known = knownCalls.map((row) => ({ time: new Date(row.created_at).getTime() + DAY_MS,
    cost: BigInt(row.effective_cost_nano_usd) })).filter((row) => row.time > now)
    .sort((left, right) => left.time - right.time);
  const unknownExpiry = unknownLatestAt ? new Date(unknownLatestAt).getTime() + DAY_MS : null;
  const candidates = [...new Set([...known.map((row) => row.time),
    ...(unknownExpiry && unknownExpiry > now ? [unknownExpiry] : [])])].sort((a, b) => a - b);
  let remainingKnown = known.reduce((sum, row) => sum + row.cost, 0n);
  let index = 0;
  for (const time of candidates) {
    while (index < known.length && known[index].time <= time) {
      remainingKnown -= known[index].cost;
      index += 1;
    }
    const unknownReserve = unknownExpiry && unknownExpiry > time ? MODEL_DAILY_BUDGET_NANO_USD : 0n;
    if (remainingKnown + unknownReserve + reservationNanoUsd <= MODEL_DAILY_BUDGET_NANO_USD) {
      return new Date(time + EXPIRY_MARGIN_MS).toISOString();
    }
  }
  return new Date(now + DAY_MS + EXPIRY_MARGIN_MS).toISOString();
}

async function rollingBudgetExposure(client, reservationNanoUsd = 1n) {
  const total = await client.query(`SELECT
      COALESCE(sum(effective_cost_nano_usd) FILTER
        (WHERE NOT (request_bytes=0 AND cost_source='reservation')),0)::text AS committed,
      count(*) FILTER (WHERE request_bytes=0 AND cost_source='reservation')::int AS unknown_calls,
      max(created_at) FILTER (WHERE request_bytes=0 AND cost_source='reservation') AS unknown_latest_at
    FROM bai_model_budget_calls
    WHERE created_at > now()-interval '24 hours' AND status<>'blocked'`);
  const committed = BigInt(total.rows[0].committed);
  // Historical calls with no trustworthy charge share one uncertainty reserve.
  const unknownReserve = Number(total.rows[0].unknown_calls) > 0
    ? MODEL_DAILY_BUDGET_NANO_USD : 0n;
  const exposure = committed + unknownReserve;
  const unknownLatestAt = total.rows[0].unknown_latest_at;
  const budgetEpoch = createHash('sha256').update(JSON.stringify([
    String(committed), unknownLatestAt ? new Date(unknownLatestAt).toISOString() : null
  ])).digest('hex');
  let nextAt = null;
  if (exposure + reservationNanoUsd > MODEL_DAILY_BUDGET_NANO_USD) {
    const known = await client.query(`SELECT created_at,effective_cost_nano_usd
      FROM bai_model_budget_calls
      WHERE created_at>now()-interval '24 hours' AND status<>'blocked'
        AND NOT (request_bytes=0 AND cost_source='reservation')
      ORDER BY created_at,id`);
    nextAt = nextAdmissionPossibleAt({ now: Date.now(), knownCalls: known.rows,
      unknownLatestAt, reservationNanoUsd });
  }
  return { exposure, nextAdmissionPossibleAt: nextAt, budgetEpoch };
}

async function rollingHourCalls(client, agentId = null) {
  const recent = await client.query(`SELECT created_at,agent_id FROM bai_model_budget_calls
    WHERE created_at>now()-interval '1 hour' AND request_bytes>0 AND status<>'blocked'
    ORDER BY created_at,id`);
  const globalNext = recent.rowCount >= MAX_BAI_CALLS_PER_ROLLING_HOUR
    ? new Date(new Date(recent.rows[0].created_at).getTime() + HOUR_MS + EXPIRY_MARGIN_MS).toISOString() : null;
  const agentCalls = agentId ? recent.rows.filter((row) => row.agent_id === agentId) : [];
  const agentNext = agentCalls.length >= MAX_BAI_CALLS_PER_AGENT_PER_ROLLING_HOUR
    ? new Date(new Date(agentCalls[0].created_at).getTime() + HOUR_MS + EXPIRY_MARGIN_MS).toISOString() : null;
  return { count: recent.rowCount, agentCount: agentCalls.length,
    nextRateSlotAt: [globalNext, agentNext].filter(Boolean).sort().at(-1) || null };
}

function requestNeed(input, budgetEpoch) {
  const materialFingerprint = String(input.materialFingerprint ||
    createHash('sha256').update(input.body).digest('hex'));
  const parts = [input.worldId || '', input.agentId || '', input.source,
    input.goalId || '', input.planId || '',
    input.stepId || '', materialFingerprint, budgetEpoch];
  return { needKey: createHash('sha256').update(JSON.stringify(parts)).digest('hex'),
    materialFingerprint, budgetEpoch };
}

async function deferNeed(client, input, { reason, deferredUntil, budgetEpoch }) {
  const need = requestNeed(input, budgetEpoch);
  await client.query(`UPDATE bai_model_deferred_needs SET resolved_at=now(),last_seen_at=now()
    WHERE world_id IS NOT DISTINCT FROM $1 AND agent_id IS NOT DISTINCT FROM $2
      AND material_fingerprint=$3 AND need_key<>$4 AND resolved_at IS NULL`,
  [input.worldId || null, input.agentId || null, need.materialFingerprint, need.needKey]);
  const existing = await client.query(`SELECT deferred_until,resolved_at FROM bai_model_deferred_needs
    WHERE need_key=$1 FOR UPDATE`, [need.needKey]);
  const suppressed = existing.rowCount && !existing.rows[0].resolved_at
    && new Date(existing.rows[0].deferred_until).getTime() > Date.now();
  if (suppressed) {
    await client.query(`UPDATE bai_model_deferred_needs
      SET suppressed_count=suppressed_count+1,last_seen_at=now() WHERE need_key=$1`, [need.needKey]);
  } else if (existing.rowCount) {
    await client.query(`UPDATE bai_model_deferred_needs SET blocked_count=blocked_count+1,
      deferred_until=$2,last_seen_at=now(),resolved_at=NULL WHERE need_key=$1`,
    [need.needKey, deferredUntil]);
  } else {
    await client.query(`INSERT INTO bai_model_deferred_needs(need_key,world_id,agent_id,source,
      goal_id,plan_id,step_id,material_fingerprint,budget_epoch,reason,deferred_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [need.needKey,
      input.worldId || null, input.agentId || null, input.source, input.goalId || null,
      input.planId || null, input.stepId || null, need.materialFingerprint,
      need.budgetEpoch, reason, deferredUntil]);
  }
  return { suppressed: Boolean(suppressed), needKey: need.needKey };
}


// tickfix2: the shared gateway used to stay "unsafe" for the life of the process after one admit
// or settle failure (10-23 07:49 UTC: 37 minutes with zero model calls until a restart).
//   * transient database errors in admit (deadlock, statement timeout, serialization, lock timeout,
//     lost connection) fail that one call only: admit runs in one transaction, so it rolled back and
//     left no reservation; if a COMMIT was lost after it landed, the lease simply expires and the
//     reserved row keeps counting at its reserved cost (existing expiry takeover, unchanged).
//   * any other admit failure, or a settle failure (a reservation may be unsettled; it keeps counting
//     at its reserved cost), still marks the gateway unsafe, but only for a cooldown
//     (MIRRORTERRA_BAI_BUDGET_UNSAFE_COOLDOWN_MS, default 60 s). The next call after the cooldown runs a
//     read-only self-check (guard row present, ledger readable); pass = clear, fail = restart the cooldown.
//   * disable() (budget history unavailable at start-up) stays permanent.
// Kill switch: MIRRORTERRA_BAI_BUDGET_SELF_HEAL=off in the env or in tickfix-flags.json
// (re-read at most every 15 s, no restart) = exactly the old behaviour.
export const BAI_SELF_HEAL_KEY = 'MIRRORTERRA_BAI_BUDGET_SELF_HEAL';
export const BAI_UNSAFE_COOLDOWN_KEY = 'MIRRORTERRA_BAI_BUDGET_UNSAFE_COOLDOWN_MS';
export const DEFAULT_BAI_UNSAFE_COOLDOWN_MS = 60_000;
// tickfix3: a settle that fails on a transient DB error (10-23: all pg pool "timeout exceeded when trying
// to connect", i.e. the settle transaction never started) is retried a bounded number of times before
// the gateway is marked unsafe. Kill switch MIRRORTERRA_BAI_SETTLE_RETRY=off (env or tickfix-flags.json).
export const BAI_SETTLE_RETRY_KEY = 'MIRRORTERRA_BAI_SETTLE_RETRY';
export const BAI_SETTLE_RETRY_MAX_KEY = 'MIRRORTERRA_BAI_SETTLE_RETRY_MAX';
export const BAI_SETTLE_RETRY_MIN_MS_KEY = 'MIRRORTERRA_BAI_SETTLE_RETRY_MIN_MS';
export const BAI_SETTLE_RETRY_MAX_MS_KEY = 'MIRRORTERRA_BAI_SETTLE_RETRY_MAX_MS';
export const DEFAULT_BAI_SETTLE_RETRY_MAX = 2;
export const DEFAULT_BAI_SETTLE_RETRY_MIN_MS = 1_000;
export const DEFAULT_BAI_SETTLE_RETRY_MAX_MS = 3_000;
const FLAG_KEYS = [BAI_SELF_HEAL_KEY, BAI_UNSAFE_COOLDOWN_KEY, BAI_SETTLE_RETRY_KEY, BAI_SETTLE_RETRY_MAX_KEY,
  BAI_SETTLE_RETRY_MIN_MS_KEY, BAI_SETTLE_RETRY_MAX_MS_KEY];
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;
const TRANSIENT_PG_CODES = new Set(['40P01', '57014', '40001', '55P03', '57P01', '57P02', '57P03', '53300']);
const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'ECONNABORTED']);
const TRANSIENT_MESSAGES = /connection terminated|timeout exceeded when trying to connect|connection timeout|client has encountered a connection error|terminating connection/i;

export function isTransientDbError(error) {
  const code = String(error?.code || '');
  if (TRANSIENT_PG_CODES.has(code) || code.startsWith('08') && code.length === 5) return true;
  if (TRANSIENT_NODE_CODES.has(code)) return true;
  return !code && TRANSIENT_MESSAGES.test(String(error?.message || ''));
}

function safeReasonCode(error) {
  const code = String(error?.code || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return code || 'UNCODED_ERROR';
}

export function createBaiSelfHealFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
  let cache = { at: -Infinity, values: {}, file: null };
  function fromFile() {
    const target = file || env?.MIRRORTERRA_TICKFIX_FLAGS_FILE || path.join(STATE_DIR, 'tickfix-flags.json');
    const t = now();
    if (cache.file === target && t - cache.at < FLAG_RELOAD_MS) return cache.values;
    const values = {};
    try {
      statSync(target);
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of FLAG_KEYS) {
          if (['string', 'number', 'boolean'].includes(typeof parsed[key])) values[key] = String(parsed[key]);
        }
      }
    } catch { /* missing or unreadable file = no overrides */ }
    cache = { at: t, values, file: target };
    return values;
  }
  function raw(key) {
    const values = fromFile();
    if (Object.hasOwn(values, key)) return values[key];
    if (env && env[key] !== undefined && env[key] !== '') return String(env[key]);
    return undefined;
  }
  return {
    selfHealEnabled() {
      const value = raw(BAI_SELF_HEAL_KEY);
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    },
    cooldownMs() {
      const value = Number(raw(BAI_UNSAFE_COOLDOWN_KEY));
      if (!Number.isFinite(value) || value <= 0) return DEFAULT_BAI_UNSAFE_COOLDOWN_MS;
      return Math.min(3_600_000, Math.max(5_000, Math.trunc(value)));
    },
    settleRetryEnabled() {
      const value = raw(BAI_SETTLE_RETRY_KEY);
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    },
    settleRetryMax() {
      const value = raw(BAI_SETTLE_RETRY_MAX_KEY);
      const count = Number(value);
      if (value === undefined || !Number.isFinite(count) || count < 0) return DEFAULT_BAI_SETTLE_RETRY_MAX;
      return Math.min(5, Math.trunc(count));
    },
    settleRetryDelayRangeMs() {
      const clamp = (value, fallback) => {
        const n = Number(value);
        return value === undefined || !Number.isFinite(n) || n < 0 ? fallback : Math.min(30_000, Math.max(100, Math.trunc(n)));
      };
      const min = clamp(raw(BAI_SETTLE_RETRY_MIN_MS_KEY), DEFAULT_BAI_SETTLE_RETRY_MIN_MS);
      const max = clamp(raw(BAI_SETTLE_RETRY_MAX_MS_KEY), DEFAULT_BAI_SETTLE_RETRY_MAX_MS);
      return { min: Math.min(min, max), max: Math.max(min, max) };
    }
  };
}

function defaultBudgetLog(event, fields) {
  try { console.warn(JSON.stringify({ event, ...fields })); } catch { /* logging must never throw */ }
}

export function createBaiBudgetGateway(pool, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('BAI_BUDGET_POOL_REQUIRED');
  let queue = Promise.resolve();
  let unsafe = false;
  let unsafeSince = null;
  let unsafeReason = null;
  let disabled = false;
  let healedCount = 0;
  let transientAdmitErrors = 0;
  let settleRetries = 0;
  let settleRecovered = 0;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const now = options.now || (() => Date.now());
  const log = options.log || defaultBudgetLog;
  const flags = options.flags || createBaiSelfHealFlags({ env: options.env || process.env,
    file: options.flagFile || null, now });

  function markUnsafe(phase, error) {
    const first = !unsafe;
    unsafe = true;
    unsafeSince = now();
    unsafeReason = `${phase}:${safeReasonCode(error)}`;
    if (first) log('bai_budget_unsafe_set', { phase, reason: safeReasonCode(error),
      selfHeal: !disabled && flags.selfHealEnabled(), cooldownMs: flags.cooldownMs() });
  }

  async function selfCheck() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout='5000ms'");
      const guard = await client.query('SELECT active_call_id,active_until FROM bai_model_budget_guard WHERE id=1');
      if (!guard.rowCount) throw budgetError('BAI_BUDGET_GUARD_MISSING');
      await client.query('SELECT id FROM bai_model_budget_calls ORDER BY created_at DESC LIMIT 1');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  // Returns true when the gateway may admit this call.
  async function ensureUsable() {
    if (!unsafe) return true;
    if (disabled || !flags.selfHealEnabled()) return false;
    if (now() - unsafeSince < flags.cooldownMs()) return false;
    try { await selfCheck(); }
    catch (error) {
      unsafeSince = now();
      log('bai_budget_selfcheck_failed', { reason: safeReasonCode(error), previous: unsafeReason });
      return false;
    }
    const unsafeForMs = now() - unsafeSince;
    log('bai_budget_unsafe_cleared', { reason: unsafeReason, unsafeForMs });
    unsafe = false;
    unsafeSince = null;
    unsafeReason = null;
    healedCount += 1;
    return true;
  }

  async function admit(input) {
    const { callId, worldId, agentId, source, tier, model, body, maxTokens, timeoutMs } = input;
    const estimate = baiAdmissionEstimate({ model, serializedBody: body, maxTokens });
    if (!SOURCES.has(source)) throw new TypeError('BAI_BUDGET_SOURCE_INVALID');
    return transaction(pool, async (client) => {
      if (input.institutionReview) await assertResearchInstitutionPrincipal(client, input);
      else await assertPlatformModelPrincipal(client, { worldId, agentId });
      const guard = await client.query(`SELECT active_call_id,active_until
        FROM bai_model_budget_guard WHERE id=1 FOR UPDATE`);
      if (!guard.rowCount) throw budgetError('BAI_BUDGET_GUARD_MISSING');
      if (guard.rows[0].active_call_id && new Date(guard.rows[0].active_until).getTime() > Date.now()) {
        throw budgetError('BAI_MODEL_CALL_BUSY');
      }
      const budget = await rollingBudgetExposure(client, estimate.reservedNanoUsd);
      const blocked = budget.nextAdmissionPossibleAt !== null;
      const rate = blocked ? null : await rollingHourCalls(client, agentId);
      if (blocked || rate.nextRateSlotAt) {
        const reason = blocked ? 'budget' : 'rate_limit';
        const retryAt = blocked ? budget.nextAdmissionPossibleAt : rate.nextRateSlotAt;
        const deferred = await deferNeed(client, input, {
          reason, deferredUntil: retryAt, budgetEpoch: budget.budgetEpoch });
        if (deferred.suppressed || !blocked) return { admitted: false,
          code: blocked ? 'MODEL_DAILY_BUDGET_EXCEEDED' : 'MODEL_HOURLY_RATE_LIMITED',
          retryAt, suppressed: deferred.suppressed, estimate };
      }
      await client.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
          request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
          effective_cost_nano_usd,cost_source,rolling24h_cost_nano_usd,correlation_id,trigger,
          goal_id,plan_id,step_id,context_fingerprint,material_fingerprint,prompt_metrics_complete,
          ab_cohort,fallback_from_model,fallback_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [callId, worldId || null, agentId || null, source, tier, model,
        blocked ? 'blocked' : 'reserved', estimate.requestBytes, estimate.estimatedInputTokens,
        maxTokens, String(blocked ? 0n : estimate.reservedNanoUsd),
        String(blocked ? 0n : estimate.reservedNanoUsd), blocked ? 'blocked' : 'reservation',
        String(budget.exposure + (blocked ? 0n : estimate.reservedNanoUsd)),
        input.correlationId || null, input.trigger || null, input.goalId || null,
        input.planId || null, input.stepId || null, input.contextFingerprint || null,
        input.materialFingerprint || null,
        input.promptMetrics?.complete ?? null,
        // modelab1 (migration 0033): A/B cohort and challenger fallback attribution.
        input.abCohort ? String(input.abCohort).slice(0, 40) : null,
        input.fallbackFromModel ? String(input.fallbackFromModel).slice(0, 160) : null,
        input.fallbackReason ? String(input.fallbackReason).slice(0, 80) : null]);
      if (blocked) return { admitted: false, code: 'MODEL_DAILY_BUDGET_EXCEEDED',
        retryAt: budget.nextAdmissionPossibleAt, suppressed: false, estimate };
      for (const section of input.promptMetrics?.rows || []) {
        await client.query(`INSERT INTO bai_model_prompt_sections(model_call_id,section_name,
            characters,bytes,estimated_tokens,content_hash,duplicate_hash,duplicate_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [callId, section.sectionName,
          section.characters, section.bytes, section.estimatedTokens, section.contentHash,
          section.duplicateHash, section.duplicateBytes]);
      }
      const admittedNeed = requestNeed(input, budget.budgetEpoch);
      await client.query(`UPDATE bai_model_deferred_needs SET resolved_at=now(),last_seen_at=now()
        WHERE world_id IS NOT DISTINCT FROM $1 AND agent_id IS NOT DISTINCT FROM $2
          AND material_fingerprint=$3 AND resolved_at IS NULL`,
      [worldId || null, agentId || null, admittedNeed.materialFingerprint]);
      await client.query(`UPDATE bai_model_budget_guard
        SET active_call_id=$1,active_until=now()+($2::int * interval '1 millisecond'),updated_at=now()
        WHERE id=1`, [callId, Math.max(1_000, timeoutMs) + 30_000]);
      return { admitted: true, estimate };
    });
  }

  async function settle({ callId, model, usage, failed, failureCode, providerMetadata = null,
    httpStatus = null, providerErrorCode = null }, { retry = false } = {}) {
    const inputTokens = nonnegativeToken(usage?.inputTokens ?? usage?.prompt_tokens);
    const outputTokens = nonnegativeToken(usage?.outputTokens ?? usage?.completion_tokens);
    const providerCost = reportedNanoUsd(usage?.providerReportedCostUsd ?? usage?.cost_usd);
    const usageCost = inputTokens !== null && outputTokens !== null
      ? baiPricedUsageNanoUsd(model, inputTokens, outputTokens, {
        cacheReadTokens: nonnegativeToken(usage?.cacheReadTokens),
        cacheWriteTokens: nonnegativeToken(usage?.cacheWriteTokens) }) : null;
    return transaction(pool, async (client) => {
      const guard = await client.query('SELECT active_call_id FROM bai_model_budget_guard WHERE id=1 FOR UPDATE');
      if (retry) {
        // tickfix3 idempotency: an earlier attempt may have committed even though its reply was lost.
        // Same lock order as below (guard, then call row). Only a row still 'reserved' is settled.
        const prior = await client.query(`SELECT status FROM bai_model_budget_calls WHERE id=$1 FOR UPDATE`, [callId]);
        if (!prior.rowCount) throw budgetError('BAI_BUDGET_CALL_MISSING');
        if (prior.rows[0].status !== 'reserved') return { alreadySettled: true };
      }
      if (guard.rows[0]?.active_call_id !== callId) throw budgetError('BAI_BUDGET_LEASE_LOST');
      const current = await client.query(`SELECT reserved_cost_nano_usd FROM bai_model_budget_calls
        WHERE id=$1 FOR UPDATE`, [callId]);
      if (!current.rowCount) throw budgetError('BAI_BUDGET_CALL_MISSING');
      const reserved = BigInt(current.rows[0].reserved_cost_nano_usd);
      const effective = providerCost !== null && usageCost !== null ? (providerCost > usageCost ? providerCost : usageCost)
        : providerCost ?? usageCost ?? reserved;
      const source = providerCost !== null ? 'provider_reported'
        : usageCost !== null ? 'usage_priced' : 'reservation';
      await client.query(`UPDATE bai_model_budget_calls SET status=$2,input_tokens=$3,output_tokens=$4,
          provider_cost_nano_usd=$5,effective_cost_nano_usd=$6,cost_source=$7,
          failure_code=$8,completed_at=now(),provider_request_id=$9,provider_response_id=$10,
          returned_model=$11,cache_read_tokens=$12,cache_write_tokens=$13,
          cached_input_tokens=$14,uncached_input_tokens=$15,
          http_status=$16,provider_error_code=$17
        WHERE id=$1`, [callId, failed ? 'failed' : 'succeeded', inputTokens, outputTokens,
        providerCost === null ? null : String(providerCost), String(effective), source,
        failureCode ? String(failureCode).slice(0, 100) : null,
        providerMetadata?.providerRequestId || null, providerMetadata?.providerResponseId || null,
        providerMetadata?.returnedModel || null, nonnegativeToken(usage?.cacheReadTokens),
        nonnegativeToken(usage?.cacheWriteTokens), nonnegativeToken(usage?.cachedInputTokens),
        nonnegativeToken(usage?.uncachedInputTokens),
        Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
        safeProviderErrorCode(providerErrorCode)]);
      await client.query(`UPDATE bai_model_budget_guard
        SET active_call_id=NULL,active_until=NULL,updated_at=now() WHERE id=1`);
      const committedOrReserved = (await rollingBudgetExposure(client)).exposure;
      await client.query(`UPDATE bai_model_budget_calls SET rolling24h_cost_nano_usd=$2 WHERE id=$1`,
        [callId, String(committedOrReserved)]);
      return { alreadySettled: false };
    });
  }

  // tickfix3: bounded retry of settle on transient DB errors only; the caller marks unsafe when it throws.
  async function settleWithRetry(args) {
    try { return await settle(args); }
    catch (firstError) {
      if (!flags.settleRetryEnabled() || !isTransientDbError(firstError)) throw firstError;
      const maxRetries = flags.settleRetryMax();
      let lastError = firstError;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        const { min, max } = flags.settleRetryDelayRangeMs();
        const delayMs = Math.round(min + (max - min) * Math.min(1, Math.max(0, random())));
        settleRetries += 1;
        log('bai_budget_settle_retry', { attempt, maxRetries, delayMs, reason: safeReasonCode(lastError) });
        await sleep(delayMs);
        try {
          const outcome = await settle(args, { retry: true });
          settleRecovered += 1;
          log('bai_budget_settle_recovered', { attempt, alreadySettled: Boolean(outcome?.alreadySettled),
            firstReason: safeReasonCode(firstError) });
          return outcome;
        } catch (error) {
          lastError = error;
          if (!isTransientDbError(error)) break;
        }
      }
      throw lastError;
    }
  }

  async function markProviderStarted(callId) {
    await pool.query(`UPDATE bai_model_budget_calls SET provider_started_at=now()
      WHERE id=$1 AND status='reserved'`, [callId]);
  }

  async function runNow(input, send, extractUsage) {
    if (!(await ensureUsable())) throw budgetError('BAI_BUDGET_UNAVAILABLE');
    const callId = input.callId || randomUUID();
    let admission;
    try { admission = await admit({ ...input, callId }); }
    catch (error) {
      if (!isModelPrincipalDenial(error)
          && error.code !== 'BAI_MODEL_CALL_BUSY' && error.code !== 'BAI_PRICE_UNAVAILABLE') {
        if (!disabled && flags.selfHealEnabled() && isTransientDbError(error)) {
          // Rolled back with the admit transaction: no reservation, nothing unsettled.
          transientAdmitErrors += 1;
          log('bai_budget_admit_transient', { reason: safeReasonCode(error) });
          throw budgetError('BAI_BUDGET_TRANSIENT', { dbCode: safeReasonCode(error) });
        }
        markUnsafe('admit', error);
      }
      throw error;
    }
    if (!admission.admitted) throw budgetError(admission.code, {
      nextAdmissionPossibleAt: admission.retryAt, suppressed: admission.suppressed });
    let result;
    let failure;
    let usage = null;
    try {
      await markProviderStarted(callId);
      result = await send();
      usage = extractUsage ? await extractUsage(result) : result?.usage;
      return result;
    } catch (error) {
      failure = error;
      usage = error?.usage || null;
      throw error;
    } finally {
      try { await settleWithRetry({ callId, model: input.model, usage,
        failed: Boolean(failure) || usage?.providerFailed === true,
        failureCode: failure || usage?.providerFailed === true
          ? failure?.code || 'BAI_COMPLETION_UNAVAILABLE' : null,
        providerMetadata: failure?.providerMetadata || result?.providerMetadata
          || usage?.providerMetadata || null,
        httpStatus: failure?.status ?? null,
        providerErrorCode: failure?.providerErrorCode ?? null }); }
      catch (error) {
        markUnsafe('settle', error);
        throw budgetError('BAI_BUDGET_SETTLEMENT_FAILED');
      }
    }
  }

  return {
    async recordApplicationResult(callId, status, failureCode = null) {
      await pool.query(`UPDATE bai_model_budget_calls
        SET application_status=$2,application_failure_code=$3 WHERE id=$1 AND provider_started_at IS NOT NULL`,
      [callId, status, failureCode ? String(failureCode).slice(0, 100) : null]);
    },
    runRequest(input, send, extractUsage = null) {
      const result = queue.then(() => runNow(input, send, extractUsage));
      queue = result.catch(() => {});
      return result;
    },
    async availability(agentId = null) {
      const client = await pool.connect();
      try {
        const budget = await rollingBudgetExposure(client);
        const rate = await rollingHourCalls(client, agentId);
        return { budgetAvailable: budget.nextAdmissionPossibleAt === null,
          nextAdmissionPossibleAt: budget.nextAdmissionPossibleAt,
          rateAvailable: !rate.nextRateSlotAt, nextRateSlotAt: rate.nextRateSlotAt };
      } finally { client.release(); }
    },
    disable() {
      disabled = true;
      unsafe = true;
      unsafeSince = now();
      unsafeReason = 'disabled:BAI_BUDGET_HISTORY_UNAVAILABLE';
    },
    get unsafe() { return unsafe; },
    status() {
      return { unsafe, unsafeSince: unsafeSince === null ? null : new Date(unsafeSince).toISOString(),
        unsafeReason, disabled, selfHeal: flags.selfHealEnabled(), cooldownMs: flags.cooldownMs(),
        healedCount, transientAdmitErrors, settleRetry: flags.settleRetryEnabled(),
        settleRetryMax: flags.settleRetryMax(), settleRetries, settleRecovered };
    }
  };
}

// Bring the prior rolling window into the new ledger before any new admission.
// Unknown historical charges are marked with zero row cost and a shared window reserve.
export async function backfillBaiBudgetHistory(pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT id FROM bai_model_budget_guard WHERE id=1 FOR UPDATE');
    await client.query(`UPDATE bai_model_budget_calls SET reserved_cost_nano_usd=0,
        effective_cost_nano_usd=0,rolling24h_cost_nano_usd=NULL
      WHERE request_bytes=0 AND cost_source='reservation'
        AND (reserved_cost_nano_usd<>0 OR effective_cost_nano_usd<>0
          OR rolling24h_cost_nano_usd IS NOT NULL)`);
    const cognition = await client.query(`SELECT id,world_id,agent_id,tier,model,trigger,status,failure_code,
        input_tokens,output_tokens,created_at,completed_at
      FROM world_agent_cognition_model_calls
      WHERE created_at > now()-interval '24 hours' AND status<>'cached' ORDER BY created_at,id`);
    for (const row of cognition.rows) {
      let cost = 0n;
      let costSource = 'reservation';
      const input = nonnegativeToken(row.input_tokens);
      const output = nonnegativeToken(row.output_tokens);
      if (input !== null && output !== null && input + output > 0) {
        try { cost = baiPricedNanoUsd(row.model, input, output); costSource = 'usage_priced'; }
        catch { /* Unknown historical price remains unknown, never fabricated. */ }
      }
      const source = row.trigger === 'memory_selection' ? 'memorySelection'
        : row.trigger === 'model_analysis' ? 'modelAnalysis' : 'openCognition';
      await client.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
          request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
          effective_cost_nano_usd,input_tokens,output_tokens,cost_source,failure_code,created_at,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,0,0,0,$8,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(id) DO NOTHING`, [row.id, row.world_id, row.agent_id, source, row.tier,
        row.model, row.status === 'succeeded' ? 'succeeded' : 'failed', String(cost), input, output,
        costSource, row.failure_code || null, row.created_at, row.completed_at]);
    }
    const authoring = await client.query(`SELECT world_id,agent_id,model,cost_microunits,
        metadata,created_at FROM world_infrastructure_usage_events
      WHERE provider='bai' AND resource_category='ai_inference'
        AND created_at > now()-interval '24 hours' ORDER BY created_at,id`);
    for (const row of authoring.rows) {
      const id = row.metadata?.callId;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) {
        throw budgetError('BAI_HISTORICAL_CALL_ID_MISSING');
      }
      const input = nonnegativeToken(row.metadata?.inputTokens);
      const output = nonnegativeToken(row.metadata?.outputTokens);
      let cost = row.cost_microunits !== null ? BigInt(row.cost_microunits) * 1_000n : 0n;
      let costSource = row.cost_microunits !== null ? 'provider_reported' : 'reservation';
      if (row.cost_microunits === null && input !== null && output !== null && input + output > 0) {
        try { cost = baiPricedNanoUsd(row.model, input, output); costSource = 'usage_priced'; }
        catch { /* Unknown historical price remains unknown, never fabricated. */ }
      }
      await client.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
          request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
          effective_cost_nano_usd,input_tokens,output_tokens,cost_source,created_at,completed_at)
        VALUES($1,$2,$3,'currencyGenesisAuthoring','other',$4,'succeeded',0,0,0,$5,$5,$6,$7,$8,$9,$9)
        ON CONFLICT(id) DO NOTHING`, [id, row.world_id, row.agent_id, row.model || 'unknown',
        String(cost), input, output, costSource, row.created_at]);
    }
  });
}
