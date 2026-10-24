// modelab1: per-resident model A/B test (claude-haiku-5.5 vs gpt-6-luna) for open cognition, memory
// selection, model analysis and council deliberation. Every resident keeps ONE model for every kind of
// call (a stable cohort keyed by agent id, not a per-call coin flip), so the residents' behaviour can be
// compared by model. The split balances the roles: the governor (MirrorTerra-01) and the two busiest
// builders (08: 24 awards, 09: 16 awards as of 2026-10-22) are not in the same group.
//
//   haiku cohort: MirrorTerra-01 (governor), 03, 05, 07, 08   builder awards 2+9+5+24 = 40
//   luna  cohort: MirrorTerra-02, 04, 06, 09, 10              builder awards 4+4+13+16+1 = 38
//
// Residents outside the map (external residents such as Visitor-Hark) keep the configured model.
// Kill switch MIRRORTERRA_MODEL_AB=off|0|false|disabled: everyone uses gpt-6-luna again (old behaviour).
// A haiku call that fails at the provider (quota, 429, unavailable, timeout, HTTP error), or that is
// skipped by the haiku quota backoff or the long-prompt guard, is retried once on gpt-6-luna and the
// Luna call is recorded with fallback_from_model / fallback_reason (bai_model_budget_calls, 0033).
import { createQuotaBackoff } from './quota-backoff.js';

export const MODEL_AB_CONTROL = 'gpt-6-luna';
export const MODEL_AB_CHALLENGER = 'claude-haiku-5.5';
export const MODEL_AB_TEST_ID = 'modelab1';

const HAIKU = MODEL_AB_CHALLENGER;
const LUNA = MODEL_AB_CONTROL;
export const MODEL_AB_COHORTS = Object.freeze({
  'f952ef0a-001f-408e-8e5d-684b63f133ac': { name: 'MirrorTerra-01', model: HAIKU, role: 'governor' },
  '3b331e3d-88c9-4080-adf1-0fedc13b52ae': { name: 'MirrorTerra-02', model: LUNA, role: 'resident' },
  '57c09d40-df32-4293-af2f-653b85c6244a': { name: 'MirrorTerra-03', model: HAIKU, role: 'resident' },
  '559191b8-b469-46ad-962e-b0627cb8e8db': { name: 'MirrorTerra-04', model: LUNA, role: 'resident' },
  'f667acff-2c2e-4481-b732-e3fbea562013': { name: 'MirrorTerra-05', model: HAIKU, role: 'builder' },
  '745df3f0-e36e-4350-827d-cb945b872b71': { name: 'MirrorTerra-06', model: LUNA, role: 'builder' },
  'f29f61e4-9757-4b1c-a1b8-2da4fca62bae': { name: 'MirrorTerra-07', model: HAIKU, role: 'resident' },
  '012fdab2-73a6-4655-9aba-f29c1892a84e': { name: 'MirrorTerra-08', model: HAIKU, role: 'builder' },
  '3cd80db6-ad3d-41a0-bb62-04c4e5720cd8': { name: 'MirrorTerra-09', model: LUNA, role: 'builder' },
  '46015f3f-d58c-4e0f-8bd6-bdb2afc3da91': { name: 'MirrorTerra-10', model: LUNA, role: 'resident' }
});

// B.AI bills claude-haiku-5.5 prompts above 100k tokens at 5x ($0.50/$2.50 per 1M). Prod Luna prompts peaked
// at 70,047 Luna tokens (7 days to 2026-10-22), but haiku counts ~2.6 bytes per token on these prompts
// (prod smoke: a 379,347-byte scheduled cognition prompt = 145,530 haiku tokens; a 117,808-byte memory
// selection = 39,204). So a haiku call whose messages exceed this many bytes (~92k haiku tokens) goes to
// Luna instead (fallback_reason prompt_over_100k_guard).
// Override with MIRRORTERRA_MODEL_AB_MAX_PROMPT_BYTES (clamped 20k-2M).
export const MODEL_AB_DEFAULT_MAX_PROMPT_BYTES = 240_000;
// claude-haiku-5.5 spends hidden completion tokens before answering; challenger calls get at least this.
export const MODEL_AB_MIN_OUTPUT_TOKENS = 2_000;

export function modelAbEnabled(env = process.env) {
  const value = String(env?.MIRRORTERRA_MODEL_AB ?? 'on').trim().toLowerCase();
  return !['off', '0', 'false', 'disabled', 'no'].includes(value);
}

export function modelAbMaxPromptBytes(env = process.env) {
  const value = Number(env?.MIRRORTERRA_MODEL_AB_MAX_PROMPT_BYTES);
  if (!Number.isFinite(value) || value <= 0) return MODEL_AB_DEFAULT_MAX_PROMPT_BYTES;
  return Math.min(2_000_000, Math.max(20_000, Math.round(value)));
}

const cohortLabel = (model) => (model === HAIKU ? 'haiku' : model === LUNA ? 'luna' : null);

// The assignment for one call. baseModel is the model the router would use without the test; the test
// only applies on top of the default Luna catalog (an explicit OPEN_COGNITION_MODEL=claude-* wins).
export function resolveCohortModel(agentId, { env = process.env, baseModel = LUNA, cohorts = MODEL_AB_COHORTS } = {}) {
  if (baseModel !== LUNA || !modelAbEnabled(env)) return { model: baseModel, cohort: null };
  const entry = typeof agentId === 'string' ? cohorts[agentId.toLowerCase()] : null;
  if (!entry) return { model: baseModel, cohort: null };
  return { model: entry.model, cohort: cohortLabel(entry.model) };
}

// Fallback only for provider-side failures of the challenger. Budget/rate/lease codes are not model
// failures (Luna would hit the same gate) and parse failures stay attributed to the model that wrote
// them (they go through the router's existing one-shot JSON repair on the same model).
const NO_FALLBACK = new Set(['MODEL_DAILY_BUDGET_EXCEEDED', 'MODEL_HOURLY_RATE_LIMITED', 'BAI_MODEL_CALL_BUSY',
  'BAI_BUDGET_UNAVAILABLE', 'BAI_BUDGET_SETTLEMENT_FAILED', 'BAI_BUDGET_LEASE_LOST', 'BAI_BUDGET_CALL_MISSING',
  'BAI_BUDGET_GUARD_MISSING', 'BAI_PRICE_UNAVAILABLE', 'BAI_KEY_MISSING', 'BAI_MESSAGES_INVALID',
  'BAI_COMPLETION_NOT_JSON', 'BAI_COMPLETION_NOT_OBJECT', 'LUNA_QUOTA_BACKOFF']);

export function challengerFallbackReason(error, { providerStarted = false } = {}) {
  const code = String(error?.code || '');
  if (!providerStarted || NO_FALLBACK.has(code) || code.startsWith('BAI_BUDGET_')) return null;
  const status = Number(error?.status);
  const text = `${error?.providerErrorCode || ''} ${code}`.toLowerCase();
  if (status === 429) return 'challenger_429';
  if (/insufficient_user_quota|insufficient_balance|quota/.test(text)) return 'challenger_quota';
  if (code === 'provider_model_unsupported') return 'challenger_unavailable';
  if (code === 'BAI_COMPLETION_CONTENT_INVALID') return 'challenger_content_invalid';
  if (Number.isFinite(status) && status >= 400) return `challenger_http_${Math.trunc(status)}`;
  return 'challenger_unavailable';
}

// The challenger's own quota breaker: a haiku 429 must never pause Luna (and so the control cohort).
export const challengerQuotaBackoff = createQuotaBackoff({
  log: (item) => console.warn(JSON.stringify({ ...item, event: 'model_ab_challenger_backoff', model: HAIKU,
    change: item.event }))
});

export function modelAbStatus(env = process.env) {
  const enabled = modelAbEnabled(env);
  return { testId: MODEL_AB_TEST_ID, enabled, control: LUNA, challenger: HAIKU,
    maxPromptBytes: modelAbMaxPromptBytes(env),
    cohorts: Object.fromEntries(Object.values(MODEL_AB_COHORTS).map((entry) => [entry.name,
      enabled ? cohortLabel(entry.model) : 'luna'])),
    challengerBackoff: challengerQuotaBackoff.status() };
}

// The routing object a model router takes as `modelAb`. Reads the kill switch on every call.
export function createModelAbRouting({ env = process.env, cohorts = MODEL_AB_COHORTS,
  backoff = challengerQuotaBackoff } = {}) {
  return Object.freeze({
    resolve: (agentId, baseModel) => resolveCohortModel(agentId, { env, baseModel, cohorts }),
    maxPromptBytes: () => modelAbMaxPromptBytes(env),
    backoff
  });
}
