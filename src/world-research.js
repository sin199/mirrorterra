// research1 (第二关 v1): the research society — rules and records. The engine holds the ledger, the evidence
// (per-day statistics, events), authorship and timestamps; residents only say things into these tables. The engine
// checks that every cited number exists and matches; it never judges whether a conclusion is true. Key conclusions
// are checkable claims (world_gambit_claims) that isolated skeptics may verify; consequences come from residents.
// Money: research SYNC is created only as pool-backed entitlements (see migration 0037 and payResearch below).
import { createHash } from 'node:crypto';
import { activeSyncResidentRewardPolicy } from './arc/sync-resident-rewards.js';
import { readSyncResidentRewardCapacity } from './arc/sync-resident-rewards.js';
import { researchFlag, researchNumber } from './research-flags.js';
import { exposeClaims, recordReputation, transferInternal } from './world-gambits.js';
import { readExternal2Policy, requireExternalOperator } from './external2.js';
import { lockMembersFirst } from './tick-lock-order.js';

export const RESEARCH_LEVER = 'research.call';
export const RESEARCH_PAYOUT_EVENT = 'world.research_payout';
export const JUDGES = Object.freeze(['method', 'value', 'boldness']);
export const CLAIM_METRICS = Object.freeze({
  place_visits: { kind: 'place', field: 'completions', agg: 'sum', about: 'completed actions at a place over the days' },
  place_peak_hour: { kind: 'place', field: 'peakHour', agg: 'max', about: 'most completed actions at a place in one world hour' },
  place_residents: { kind: 'place', field: 'residents', agg: 'max', about: 'distinct residents at a place in one day' },
  meals: { kind: 'food', field: 'meals', agg: 'sum', about: 'meals eaten in town over the days' },
  low_food_readings: { kind: 'food', field: 'lowFoodReadings', agg: 'sum', about: 'action completions with Food below 20' },
  food_stock: { kind: 'food', field: 'stockAtClose', agg: 'last', about: 'food-service stock units at the close of the last day' },
  town_actions: { kind: 'town', field: 'completions', agg: 'sum', about: 'completed actions in town over the days' }
});
export const CLAIM_OPS = Object.freeze(['gte', 'lte', 'eq']);
// Reputation deltas recorded as public facts (no engine rule reads them; residents react as they choose).
export const RESEARCH_TRUST = Object.freeze({ research_exposed: -25, research_exposer: 6, research_replicated: 3,
  research_replicator: 3, research_negative_result: 2, research_adopted: 4, plagiarism_exposed: -60, plagiarism_exposer: 8 });
export const REPORT_REF = /\bR(\d{1,9})\b/g;
export const RAW_PER_SYNC = 1_000_000n;
export const COGNITION_RESEARCH_BYTES = 1_500;
const MINUTES_PER_DAY = 1_440;

const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
export const shortText = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function invalid(code) { return Object.assign(new Error(code), { code }); }
function coded(code, statusCode = 409, extra = {}) { return Object.assign(new Error(code), { code, statusCode, ...extra }); }
const truthy = (value) => value === true || /^(true|yes|y|1)$/i.test(String(value ?? '').trim());
export const rawToSync = (raw) => Math.round(Number(big(raw)) / 1e4) / 100;
export function syncToRaw(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0n;
  return BigInt(Math.round(number * 100)) * 10_000n;   // 0.01 SYNC steps (multiple of 100 raw: weight has 3 decimals)
}
export const worldDay = (minute) => Math.max(0, Math.floor((Number(minute) || 0) / MINUTES_PER_DAY));

export function callCapRaw(env = process.env) { return BigInt(Math.round(researchNumber('MIRRORTERRA_RESEARCH_CALL_CAP_SYNC', env) * 100)) * 10_000n; }
export function monthlyCapRaw(env = process.env) { return BigInt(Math.round(researchNumber('MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC', env) * 100)) * 10_000n; }

// Calendar month of a real instant in Asia/Shanghai ("2026-10").
export function monthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

// ---- council lever (pure) -------------------------------------------------------------------------------
export const NO_CALL_VALUE = Object.freeze({ open: false });
export function researchCallValueValid(value, { capRaw = 5_000n * RAW_PER_SYNC } = {}) {
  if (!value || typeof value !== 'object') return false;
  if (value.open === false && Object.keys(value).length === 1) return true;
  const topic = shortText(value.topic, 120);
  const budget = big(value.budgetRaw);
  const horizon = Number(value.horizonDays);
  return topic.length >= 2 && budget > 0n && budget <= capRaw && budget % 10_000n === 0n
    && Number.isInteger(horizon) && horizon >= 1 && horizon <= 30 && (value.invited === undefined || value.invited === 'all');
}
// Luna's / an external agent's target -> the stored call value (or null).
export function researchCallFromTarget(target, { capRaw = 5_000n * RAW_PER_SYNC, defaultHorizon = 6 } = {}) {
  if (!target || typeof target !== 'object') return null;
  const topic = shortText(target.topic ?? target.subject, 120);
  const brief = shortText(target.brief ?? target.question ?? target.why ?? topic, 400);
  let budget = syncToRaw(target.budgetSync ?? target.budget);
  if (budget > capRaw) budget = capRaw;                // clamp to the per-call cap (config)
  const horizonInput = Number(target.horizonDays ?? target.horizon ?? defaultHorizon);
  const horizonDays = Math.min(30, Math.max(1, Math.round(Number.isFinite(horizonInput) ? horizonInput : defaultHorizon)));
  const value = { topic, brief: brief.length >= 3 ? brief : `Research call: ${topic}`, budgetRaw: budget.toString(), horizonDays,
    invited: 'all' };
  return researchCallValueValid(value, { capRaw }) ? value : null;
}
export function researchCallTitle(value) {
  return shortText(`Research call: ${shortText(value?.topic, 80)} (${rawToSync(value?.budgetRaw)} SYNC, ${value?.horizonDays} days)`, 160);
}
// Deterministic fallback vote on a research call (used only when a resident's Luna vote is missing).
export function researchCallStance({ value, openCalls = 0, monthRemainingRaw = null }) {
  if (openCalls > 0) return { stance: 'no', reason: 'A research call is already open; finish it first.' };
  if (monthRemainingRaw !== null && big(value?.budgetRaw) > big(monthRemainingRaw)) {
    return { stance: 'no', reason: 'This month\'s research budget cannot cover it.' };
  }
  return { stance: 'yes', reason: 'Studying this with cited data could help the town decide.' };
}

// ---- parsers (pure) -------------------------------------------------------------------------------------
const PATTERN_ID = /^QM\d{3}$/;
const patternIdsOf = (value) => (Array.isArray(value) ? value : []).map((item) => shortText(item, 6).toUpperCase())
  .filter((item) => PATTERN_ID.test(item)).slice(0, 6);
export function parseSubmission(output, { callBudgetRaw }) {
  if (!output || typeof output !== 'object') throw invalid('RESEARCH_OUTPUT_INVALID');
  const decision = shortText(output.decision ?? output.kind ?? (truthy(output.propose) ? 'proposal' : output.propose === undefined ? '' : 'decline'), 20).toLowerCase();
  const patternIds = patternIdsOf(output.patternIds);
  if (['decline', 'no', 'pass'].includes(decision)) {
    const argument = shortText(output.argument ?? output.reason ?? output.why, 1200);
    if (argument.length < 3) throw invalid('RESEARCH_DECLINE_NEEDS_ARGUMENT');
    return { kind: 'decline', argument, patternIds };
  }
  if (!['proposal', 'propose', 'yes'].includes(decision)) throw invalid('RESEARCH_DECISION_INVALID');
  const method = shortText(output.method, 1200);
  if (method.length < 3) throw invalid('RESEARCH_PROPOSAL_NEEDS_METHOD');
  let budget = syncToRaw(output.budgetSync ?? output.budget);
  if (budget <= 0n) throw invalid('RESEARCH_PROPOSAL_NEEDS_BUDGET');
  if (budget > big(callBudgetRaw)) budget = big(callBudgetRaw);
  const dataPlan = (Array.isArray(output.dataPlan ?? output.data) ? (output.dataPlan ?? output.data) : [])
    .map((item) => shortText(typeof item === 'string' ? item : JSON.stringify(item), 160)).filter(Boolean).slice(0, 8);
  return { kind: 'proposal', title: shortText(output.title, 160) || shortText(method, 80), method, dataPlan,
    budgetRaw: budget, patternIds };
}

export function parseJudgment(output) {
  if (!output || typeof output !== 'object') throw invalid('RESEARCH_JUDGE_OUTPUT_INVALID');
  const score = Number(output.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw invalid('RESEARCH_JUDGE_SCORE_INVALID');
  return { score: Math.round(score * 10) / 10, rationale: shortText(output.rationale ?? output.reason, 400) };
}

export function calibrate(judge, score, offset = 12) {
  if (score === null || score === undefined) return null;
  const value = judge === 'boldness' ? Number(score) + Number(offset || 0) : Number(score);
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}
// Combined score = mean of the calibrated scores of the judges that answered (null if none answered).
export function combinedScore(judgments = []) {
  const scores = judgments.map((row) => row.calibrated_score ?? row.calibratedScore).filter((value) => value !== null && value !== undefined)
    .map(Number);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
}

// Seeded, reproducible order (sha256 of seed + id).
export function seededOrder(items, seed) {
  return [...items].map((item) => ({ item, key: createHash('sha256').update(`${seed}:${item.id}`).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((entry) => entry.item);
}
export function awardSeed({ callId, worldMinute, ids = [] }) {
  return createHash('sha256').update(`research-award:${callId}:${Math.trunc(worldMinute)}:${[...ids].map(String).sort().join(',')}`).digest('hex');
}

// Funding: rank by combined score; the funding line is the score of the first proposal that no longer fits the
// budget. Proposals clearly above the band (line + margin) are funded by rank; proposals within ±margin of the
// line are funded in a seeded random order while the budget lasts (lottery); lottery off = strict rank order.
export function decideAwards({ proposals = [], budgetRaw, margin = 5, minScore = 50, lottery = true, seed }) {
  const eligible = proposals.filter((item) => item.score !== null && item.score !== undefined && Number(item.score) >= minScore)
    .map((item) => ({ ...item, score: Number(item.score), budgetRaw: big(item.budgetRaw) }));
  const ranked = [...eligible].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  let remaining = big(budgetRaw);
  let line = null;
  for (const item of ranked) {
    if (item.budgetRaw <= remaining) remaining -= item.budgetRaw;
    else { line = item.score; break; }
  }
  remaining = big(budgetRaw);
  const funded = [];
  const fund = (item, via) => { if (item.budgetRaw <= remaining) { remaining -= item.budgetRaw; funded.push({ id: item.id, amountRaw: item.budgetRaw, via, score: item.score }); return true; } return false; };
  if (line === null || !lottery) {
    for (const item of ranked) fund(item, 'rank');
    return { ranked: ranked.map((item) => ({ id: item.id, score: item.score })), line, band: [], draw: [], funded,
      remainingRaw: remaining };
  }
  const sure = ranked.filter((item) => item.score > line + margin);
  const band = ranked.filter((item) => Math.abs(item.score - line) <= margin);
  for (const item of sure) fund(item, 'rank');
  const draw = seededOrder(band, seed);
  for (const item of draw) fund(item, 'lottery');
  return { ranked: ranked.map((item) => ({ id: item.id, score: item.score })), line, band: band.map((item) => item.id),
    draw: draw.map((item) => item.id), funded, remainingRaw: remaining };
}

// Report schema: question, data sources, conclusions (each number cites evidence), applicable conditions.
export function parseCitationRef(ref) {
  const text = shortText(ref, 140);
  let match = /^S(\d{1,12})\.([A-Za-z][A-Za-z0-9_.]{0,80})$/.exec(text);
  if (match) return { kind: 'stat', id: Number(match[1]), field: match[2] };
  match = /^E(\d{1,15})\.([A-Za-z][A-Za-z0-9_.]{0,80})$/.exec(text);
  if (match) return { kind: 'event', id: Number(match[1]), field: match[2] };
  match = /^R(\d{1,9})$/.exec(text);
  if (match) return { kind: 'report', id: Number(match[1]), field: null };
  return null;
}
export function parseClaimSpec(item, { closedDay = null } = {}) {
  if (!item || typeof item !== 'object') return null;
  const metric = shortText(item.metric, 40).toLowerCase();
  if (!(metric in CLAIM_METRICS)) return null;
  const op = shortText(item.op, 6).toLowerCase().replace('>=', 'gte').replace('<=', 'lte').replace('==', 'eq').replace('=', 'eq');
  if (!CLAIM_OPS.includes(op)) return null;
  const value = Number(item.value);
  const fromDay = Math.trunc(Number(item.fromDay ?? item.day));
  const toDay = Math.trunc(Number(item.toDay ?? item.day ?? item.fromDay));
  if (!Number.isFinite(value) || !Number.isInteger(fromDay) || !Number.isInteger(toDay) || fromDay < 0 || toDay < fromDay || toDay - fromDay > 14) return null;
  if (closedDay !== null && fromDay > closedDay + 30) return null;
  const subject = CLAIM_METRICS[metric].kind === 'place' ? shortText(item.subject, 120) : CLAIM_METRICS[metric].kind;
  if (!subject) return null;
  return { metric, subject, fromDay, toDay, op, value };
}
export function parseReport(output, { closedDay = null } = {}) {
  if (!output || typeof output !== 'object') throw invalid('RESEARCH_REPORT_INVALID');
  const question = shortText(output.question, 400);
  if (question.length < 3) throw invalid('RESEARCH_REPORT_NEEDS_QUESTION');
  const dataSources = (Array.isArray(output.dataSources) ? output.dataSources : []).map((item) => shortText(item, 140)).filter(Boolean).slice(0, 12);
  const conclusions = (Array.isArray(output.conclusions) ? output.conclusions : []).slice(0, 8).map((item) => {
    const text = shortText(typeof item === 'string' ? item : item?.text, 500);
    const figures = (Array.isArray(item?.figures) ? item.figures : []).slice(0, 10).map((figure) => ({
      label: shortText(figure?.label, 80), value: typeof figure?.value === 'number' ? figure.value
        : Number.isFinite(Number(figure?.value)) ? Number(figure.value) : shortText(figure?.value, 80),
      cite: shortText(figure?.cite ?? figure?.citation, 140) })).filter((figure) => figure.cite);
    return { text, figures };
  }).filter((item) => item.text.length >= 3);
  if (!conclusions.length) throw invalid('RESEARCH_REPORT_NEEDS_CONCLUSIONS');
  const conditions = shortText(output.conditions ?? output.applicableConditions, 600) || 'Not stated.';
  const resultKind = ['positive', 'negative', 'inconclusive', 'replication'].includes(String(output.result).toLowerCase())
    ? String(output.result).toLowerCase() : 'inconclusive';
  const claims = (Array.isArray(output.claims) ? output.claims : []).slice(0, 4).map((item) => parseClaimSpec(item, { closedDay })).filter(Boolean);
  const reportCites = (Array.isArray(output.cites) ? output.cites : []).map((ref) => parseCitationRef(ref)).filter((ref) => ref?.kind === 'report').slice(0, 6);
  return { question, dataSources, conclusions, conditions, resultKind, claims, reportCites };
}
// Numbers written in conclusion text that no figure of that conclusion cites (the report is still stored).
export function countUncitedNumbers(conclusions = []) {
  let count = 0;
  for (const item of conclusions) {
    const cited = new Set((item.figures || []).map((figure) => String(figure.value)));
    for (const match of String(item.text || '').matchAll(/(?<![A-Za-z#])\d+(?:\.\d+)?/g)) {
      const number = match[0];
      if (!cited.has(number) && ![...cited].some((value) => Number(value) === Number(number))) count += 1;
    }
  }
  return count;
}
export function pickField(object, field) {
  let value = object;
  for (const key of String(field || '').split('.')) {
    if (value === null || value === undefined || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
export function valuesMatch(cited, actual) {
  if (actual === undefined || actual === null || typeof actual === 'object') return false;
  if (typeof actual === 'number' || (typeof cited === 'number' && Number.isFinite(Number(actual)))) {
    const a = Number(actual), c = Number(cited);
    return Number.isFinite(a) && Number.isFinite(c) && Math.abs(a - c) <= Math.max(0.01, Math.abs(a) * 0.001);
  }
  return String(cited).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

// Claim truth from the engine's day statistics (pure). rowsByDay: Map(day -> stats object for the subject).
export function evaluateMetric(metric, rowsByDay, { fromDay, toDay }) {
  const spec = CLAIM_METRICS[metric];
  if (!spec) return undefined;
  const values = [];
  for (let day = fromDay; day <= toDay; day += 1) {
    if (!rowsByDay.has(day)) return undefined;          // a day of the window is not closed (or not recorded)
    const value = Number(rowsByDay.get(day)?.[spec.field] ?? 0);
    values.push(Number.isFinite(value) ? value : 0);
  }
  if (!values.length) return undefined;
  if (spec.agg === 'sum') return values.reduce((a, b) => a + b, 0);
  if (spec.agg === 'max') return Math.max(...values);
  return values.at(-1);
}
export function judgeResearchClaim(claim, actual) {
  if (actual === undefined || actual === null) return { verification: 'unverifiable', truth: null };
  const value = Number(claim.value);
  const ok = claim.op === 'gte' ? actual >= value : claim.op === 'lte' ? actual <= value
    : Math.abs(actual - value) <= Math.max(1, Math.abs(actual) * 0.05);
  return { verification: ok ? 'true' : 'false', truth: actual };
}

// Isolation (pure): any recorded tie with the author in the window disqualifies the verifier.
export function isolationVerdict({ transfers = 0, commitments = 0, alliances = 0, voteSwaps = 0, self = false }) {
  const ties = { transfers: Number(transfers) || 0, commitments: Number(commitments) || 0, alliances: Number(alliances) || 0,
    voteSwaps: Number(voteSwaps) || 0 };
  return { isolated: !self && Object.values(ties).every((value) => value === 0), self: Boolean(self), ...ties };
}
export function reportRefsIn(text) {
  return [...new Set([...String(text || '').matchAll(REPORT_REF)].map((match) => Number(match[1])))];
}

// ---- DB helpers ----------------------------------------------------------------------------------------
export async function researchReady(db) {
  const row = await db.query(`SELECT to_regclass('public.world_research_calls') IS NOT NULL AS ready`);
  return Boolean(row.rows[0]?.ready);
}
export async function worldMinuteOf(db, worldId) {
  return Number((await db.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || 0;
}
export async function isExternal(db, worldId, agentId) {
  const row = await db.query(`SELECT 1 FROM world_external_residents WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  return row.rowCount > 0;
}
// Visitor-Hark is operated by MirrorTerra itself (our own Hark): never an independent participant.
export async function nonIndependent(db, agentId) {
  const row = await db.query(`SELECT name FROM agents WHERE id=$1`, [agentId]);
  return /^visitor-hark$/i.test(String(row.rows[0]?.name || ''));
}
async function insertEvent(client, { worldId, actorId, type, actionId, data }) {
  const row = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING RETURNING id`,
  [worldId, actorId, type, JSON.stringify(data), String(actionId).slice(0, 180)]);
  return row.rows[0]?.id ? Number(row.rows[0].id) : null;
}

// Research SYNC created this calendar month (all research payouts, internal and external).
export async function monthPaidRaw(db, worldId, key = monthKey()) {
  const row = await db.query(`SELECT COALESCE(sum(amount_raw),0)::text AS v FROM world_research_payouts WHERE world_id=$1 AND month_key=$2`,
    [worldId, key]);
  return big(row.rows[0]?.v);
}

async function latestCapacitySnapshot(db, worldId) {
  const row = await db.query(`SELECT epoch_index::text AS "epochIndex",epoch_start::text AS "epochStart",
      economy_quota_raw::text AS "economyQuotaRaw",onchain_pool_balance_raw::text AS "onchainPoolBalanceRaw"
    FROM arc_sync_reward_capacity_snapshots WHERE world_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1`, [worldId]);
  return row.rows[0] || null;
}

// The one place research SYNC is created: payout row -> event -> queued contribution -> pending entitlement, in the
// caller's transaction (savepoint). Refused (nothing written) when: grants switched off, external and external grants
// off, over the monthly cap, over the epoch/pool capacity, or any trigger refuses.
export async function payResearch(client, { worldId, agentId, sourceType, kind, amountRaw, payoutKey, callId = null, grantId = null,
  verificationId = null, worldMinutes, env = process.env, now = new Date() }) {
  let amount = big(amountRaw) / 100n * 100n;
  if (amount <= 0n) return { paid: false, reason: 'ZERO_AMOUNT' };
  if (!researchFlag('MIRRORTERRA_RESEARCH_GRANTS', env)) return { paid: false, reason: 'RESEARCH_GRANTS_OFF' };
  const external = await isExternal(client, worldId, agentId);
  if (external && !researchFlag('MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS', env)) return { paid: false, reason: 'RESEARCH_EXTERNAL_GRANTS_OFF' };
  if (external) {
    const policy = await readExternal2Policy(client);
    const strict = sourceType==='research_grant' ? policy.research_rewards : policy.verification_rewards;
    if (strict) {
      try { await requireExternalOperator(client, { worldId, agentId }); }
      catch (error) { return { paid: false, reason: error.code }; }
      if (sourceType==='research_grant' && kind==='grant_upfront') return { paid: false, reason: 'EXTERNAL_RESEARCH_AWAITING_ADOPTION' };
      await lockMembersFirst(client, worldId, { agentIds: [agentId] });
    }
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`research-payout:${worldId}`]);
  const prior = await client.query(`SELECT id::text AS id,amount_raw::text AS amount FROM world_research_payouts WHERE world_id=$1 AND payout_key=$2`,
    [worldId, payoutKey]);
  if (prior.rowCount) return { paid: false, duplicate: true, payoutId: prior.rows[0].id };
  const key = monthKey(now);
  const used = await monthPaidRaw(client, worldId, key);
  const cap = monthlyCapRaw(env);
  if (used + amount > cap) return { paid: false, reason: 'RESEARCH_MONTHLY_CAP', monthKey: key, usedRaw: used.toString(), capRaw: cap.toString() };
  const snapshot = await latestCapacitySnapshot(client, worldId);
  if (!snapshot) return { paid: false, reason: 'RESEARCH_NO_CAPACITY_SNAPSHOT' };
  const capacity = await readSyncResidentRewardCapacity(client, worldId, snapshot);
  if (amount > capacity.remainingRaw) return { paid: false, reason: 'RESEARCH_POOL_CAPACITY', remainingRaw: capacity.remainingRaw.toString() };
  const policy = activeSyncResidentRewardPolicy(env);
  const rawPerWeight = big(policy.policy.conversion.syncRawPerRewardWeightUnit);
  amount = amount / (rawPerWeight / 1000n) * (rawPerWeight / 1000n);    // weight keeps 3 decimals exactly
  if (amount <= 0n) return { paid: false, reason: 'ZERO_AMOUNT' };
  const weightMilli = amount * 1000n / rawPerWeight;
  const weight = `${weightMilli / 1000n}.${String(weightMilli % 1000n).padStart(3, '0')}`;
  await client.query('SAVEPOINT research_payout');
  try {
    const payout = await client.query(`INSERT INTO world_research_payouts(world_id,payout_key,agent_id,source_type,kind,call_id,grant_id,
        verification_id,amount_raw,month_key,external,world_minute) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12) RETURNING id::text AS id`,
    [worldId, payoutKey, agentId, sourceType, kind, callId, grantId, verificationId, amount.toString(), key, external, Math.trunc(worldMinutes)]);
    const payoutId = payout.rows[0].id;
    const eventId = await insertEvent(client, { worldId, actorId: agentId, type: RESEARCH_PAYOUT_EVENT, actionId: `research-payout:${payoutId}`,
      data: { payoutId, kind, sourceType, amountRaw: amount.toString(), callId, grantId, verificationId, external, worldMinutes: Math.trunc(worldMinutes) } });
    const contribution = await client.query(`INSERT INTO arc_sync_resident_reward_contributions(world_id,agent_id,source_type,source_event_id,
        source_entity_id,reward_weight,policy_version,policy_hash) VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8) RETURNING id,status`,
    [worldId, agentId, sourceType, eventId, payoutId, weight, policy.version, policy.hash]);
    if (contribution.rows[0].status !== 'queued') throw coded('RESEARCH_CONTRIBUTION_NOT_QUEUED');
    await client.query(`INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id,contribution_id,epoch_index,policy_version,
        policy_hash,sync_amount_raw,status) VALUES($1,$2,$3,$4,$5,$6,$7::numeric,'pending')`,
    [worldId, agentId, contribution.rows[0].id, snapshot.epochIndex, policy.version, policy.hash, amount.toString()]);
    await client.query(`UPDATE arc_sync_resident_reward_contributions SET status='accrued',epoch_index=$3,decision_reason=NULL,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='queued'`, [worldId, contribution.rows[0].id, snapshot.epochIndex]);
    await client.query('RELEASE SAVEPOINT research_payout');
    return { paid: true, payoutId, amountRaw: amount.toString(), external, monthKey: key };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT research_payout');
    await client.query('RELEASE SAVEPOINT research_payout');
    return { paid: false, reason: shortText(error?.code || error?.message || 'RESEARCH_PAYOUT_REFUSED', 120) };
  }
}

// ---- calls -----------------------------------------------------------------------------------------------
export async function openCallCount(db, worldId) {
  return Number((await db.query(`SELECT count(*)::int AS n FROM world_research_calls WHERE world_id=$1 AND status IN ('open','judging','awarded')`,
    [worldId])).rows[0]?.n) || 0;
}
export async function createResearchCallFromProposal(client, { worldId, proposal, worldMinutes, env = process.env }) {
  const value = proposal.proposed_value || proposal.value;
  if (!researchCallValueValid(value, { capRaw: callCapRaw(env) }) || value.open === false) return { created: false, reason: 'RESEARCH_CALL_VALUE_INVALID' };
  if (await openCallCount(client, worldId) >= Math.max(1, researchNumber('MIRRORTERRA_RESEARCH_MAX_OPEN_CALLS', env))) {
    return { created: false, reason: 'RESEARCH_CALL_ALREADY_OPEN' };
  }
  const minute = Math.trunc(worldMinutes);
  const window = Math.max(60, researchNumber('MIRRORTERRA_RESEARCH_PROPOSAL_WINDOW_MINUTES', env));
  const proposalsClose = minute + Math.min(window, Math.max(60, Math.floor(value.horizonDays * MINUTES_PER_DAY / 3)));
  const reportsDue = Math.max(proposalsClose + 60, minute + value.horizonDays * MINUTES_PER_DAY);
  const proposer = proposal.proposer_agent_id || proposal.proposerAgentId;
  const row = await client.query(`INSERT INTO world_research_calls(world_id,proposal_id,proposer_agent_id,topic,brief,budget_raw,horizon_days,
      invited_agent_ids,fee_raw,opened_world_minute,proposals_close_world_minute,reports_due_world_minute)
    VALUES($1,$2,$3,$4,$5,$6::numeric,$7,NULL,$8::numeric,$9,$10,$11) ON CONFLICT (world_id,proposal_id) DO NOTHING RETURNING id::text AS id`,
  [worldId, proposal.id, proposer, shortText(value.topic, 120), shortText(value.brief || value.topic, 400), String(value.budgetRaw),
    value.horizonDays, String(Math.trunc(researchNumber('MIRRORTERRA_RESEARCH_FEE_RAW', env))), minute, proposalsClose, reportsDue]);
  if (!row.rowCount) return { created: false, reason: 'RESEARCH_CALL_EXISTS' };
  await insertEvent(client, { worldId, actorId: proposer, type: 'world.research_call', actionId: `research-call:${row.rows[0].id}`,
    data: { callId: row.rows[0].id, proposalId: proposal.id, topic: value.topic, budgetRaw: String(value.budgetRaw),
      horizonDays: value.horizonDays, worldMinutes: minute } });
  return { created: true, callId: row.rows[0].id, proposalsClose, reportsDue };
}

export async function readCall(db, { worldId, callId }) {
  const row = await db.query(`SELECT id::text AS id,topic,brief,budget_raw::text AS "budgetRaw",horizon_days AS "horizonDays",status,
      fee_raw::text AS "feeRaw",invited_agent_ids::text[] AS invited,opened_world_minute::text AS opened,
      proposals_close_world_minute::text AS "proposalsClose",reports_due_world_minute::text AS "reportsDue",proposer_agent_id::text AS proposer
    FROM world_research_calls WHERE world_id=$1 AND id=$2`, [worldId, callId]);
  const call = row.rows[0];
  return call ? { ...call, opened: Number(call.opened), proposalsClose: Number(call.proposalsClose), reportsDue: Number(call.reportsDue) } : null;
}
export function invitedTo(call, agentId) { return !call.invited || call.invited.includes(agentId); }

// A proposal (fee paid to the treasury first; refused when unpayable) or a decline (free). One per resident per call.
export async function submitResearch(client, { worldId, call, agentId, parsed, source = 'llm', model = null, worldMinutes }) {
  if (call.status !== 'open' || worldMinutes >= call.proposalsClose) throw coded('RESEARCH_CALL_NOT_ACCEPTING');
  if (!invitedTo(call, agentId)) throw coded('RESEARCH_NOT_INVITED', 403);
  const external = await isExternal(client, worldId, agentId);
  const nonIndep = await nonIndependent(client, agentId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`research-submit:${call.id}:${agentId}`]);
  const prior = await client.query(`SELECT id FROM world_research_submissions WHERE world_id=$1 AND call_id=$2 AND agent_id=$3`, [worldId, call.id, agentId]);
  if (prior.rowCount) throw coded('RESEARCH_ALREADY_SUBMITTED');
  let feeEntryId = null;
  if (parsed.kind === 'proposal' && big(call.feeRaw) > 0n) {
    await client.query('SAVEPOINT research_fee');
    try {
      const fee = await client.query(`INSERT INTO world_sync_treasury_entries(world_id,entry_key,kind,from_agent_id,to_agent_id,amount_raw,reason,actor,
          source_ref,world_day,world_minute) VALUES($1,$2,'research_fee',$3,NULL,$4::numeric,$5,'research_society',$6,$7,$8) RETURNING id::text AS id`,
      [worldId, `research-fee:${call.id}:${agentId}`, agentId, String(call.feeRaw), shortText(`Research proposal fee: ${call.topic}`, 240),
        `research_call:${call.id}`, worldDay(worldMinutes), Math.trunc(worldMinutes)]);
      feeEntryId = fee.rows[0].id;
      await client.query('RELEASE SAVEPOINT research_fee');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT research_fee');
      await client.query('RELEASE SAVEPOINT research_fee');
      throw coded('RESEARCH_FEE_UNPAYABLE');
    }
  }
  const row = await client.query(`INSERT INTO world_research_submissions(world_id,call_id,agent_id,kind,title,method,data_plan,budget_raw,argument,
      pattern_ids,fee_entry_id,source,external,non_independent,model,world_minute)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::numeric,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id::text AS id`,
  [worldId, call.id, agentId, parsed.kind, parsed.kind === 'proposal' ? parsed.title : null, parsed.kind === 'proposal' ? parsed.method : null,
    JSON.stringify(parsed.dataPlan || []), parsed.kind === 'proposal' ? parsed.budgetRaw.toString() : null,
    parsed.kind === 'decline' ? parsed.argument : null, parsed.patternIds || [], feeEntryId, source, external, nonIndep, model,
    Math.trunc(worldMinutes)]);
  await insertEvent(client, { worldId, actorId: agentId, type: `world.research_${parsed.kind}`, actionId: `research-submission:${row.rows[0].id}`,
    data: { callId: call.id, submissionId: row.rows[0].id, kind: parsed.kind, source, worldMinutes: Math.trunc(worldMinutes) } });
  return { submissionId: row.rows[0].id, kind: parsed.kind, feePaid: Boolean(feeEntryId), external, nonIndependent: nonIndep };
}

export async function recordJudgment(client, { worldId, submissionId, judge, judged = null, failureCode = null, model = null, worldMinutes, env = process.env }) {
  const offset = researchNumber('MIRRORTERRA_RESEARCH_BOLDNESS_OFFSET', env);
  await client.query(`INSERT INTO world_research_judgments(world_id,submission_id,judge,score,calibrated_score,rationale,saw_reputation,failure_code,
      model,world_minute) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9) ON CONFLICT (world_id,submission_id,judge) DO NOTHING`,
  [worldId, submissionId, judge, judged ? judged.score : null, judged ? calibrate(judge, judged.score, offset) : null,
    judged ? judged.rationale || null : null, judged ? null : String(failureCode || 'RESEARCH_JUDGE_FAILED').slice(0, 80), model,
    Math.trunc(worldMinutes)]);
}

// Award a call whose judging is complete: ranking, line, lottery (seeded and recorded), grants, upfront tranche.
export async function awardCall(client, { worldId, callId, worldMinutes, env = process.env, now = new Date() }) {
  const call = await readCall(client, { worldId, callId });
  if (!call || !['open', 'judging'].includes(call.status)) return { awarded: false, reason: 'RESEARCH_CALL_NOT_AWARDABLE' };
  const rows = await client.query(`SELECT s.id::text AS id,s.agent_id::text AS agent,s.budget_raw::text AS "budgetRaw",s.external,
      COALESCE(json_agg(json_build_object('judge',j.judge,'calibrated_score',j.calibrated_score,'score',j.score)) FILTER (WHERE j.id IS NOT NULL),'[]') AS judgments
    FROM world_research_submissions s LEFT JOIN world_research_judgments j ON j.world_id=s.world_id AND j.submission_id=s.id
    WHERE s.world_id=$1 AND s.call_id=$2 AND s.kind='proposal' GROUP BY s.id ORDER BY s.id`, [worldId, callId]);
  const externalGrants = researchFlag('MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS', env);
  const proposals = rows.rows.map((row) => ({ id: row.id, agent: row.agent, budgetRaw: row.budgetRaw, external: row.external,
    score: combinedScore(row.judgments), judgments: row.judgments })).filter((row) => externalGrants || !row.external);
  const seed = awardSeed({ callId, worldMinute: worldMinutes, ids: proposals.map((row) => row.id) });
  const margin = researchNumber('MIRRORTERRA_RESEARCH_LOTTERY_MARGIN', env);
  const lottery = researchFlag('MIRRORTERRA_RESEARCH_LOTTERY', env);
  const decision = decideAwards({ proposals, budgetRaw: call.budgetRaw, margin, minScore: researchNumber('MIRRORTERRA_RESEARCH_MIN_SCORE', env),
    lottery, seed });
  const minute = Math.trunc(worldMinutes);
  const upfrontPct = BigInt(Math.min(100, Math.max(0, Math.round(researchNumber('MIRRORTERRA_RESEARCH_UPFRONT_PCT', env)))));
  const grants = [];
  let fundedRaw = 0n;
  for (const item of decision.funded) {
    const proposal = proposals.find((row) => row.id === item.id);
    const grant = await client.query(`INSERT INTO world_research_grants(world_id,call_id,submission_id,agent_id,amount_raw,via,score,external,
        report_due_world_minute,world_minute) VALUES($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$10) RETURNING id::text AS id`,
    [worldId, callId, item.id, proposal.agent, item.amountRaw.toString(), item.via, item.score, proposal.external, call.reportsDue, minute]);
    const grantId = grant.rows[0].id;
    const upfront = item.amountRaw * upfrontPct / 100n;
    const paid = upfront > 0n ? await payResearch(client, { worldId, agentId: proposal.agent, sourceType: 'research_grant', kind: 'grant_upfront',
      amountRaw: upfront, payoutKey: `research-grant-upfront:${grantId}`, callId, grantId, worldMinutes: minute, env, now }) : { paid: false, reason: 'NO_UPFRONT' };
    fundedRaw += item.amountRaw;
    await insertEvent(client, { worldId, actorId: proposal.agent, type: 'world.research_grant', actionId: `research-grant:${grantId}`,
      data: { callId, grantId, submissionId: item.id, amountRaw: item.amountRaw.toString(), via: item.via, score: item.score,
        upfrontPaid: paid.paid, upfrontReason: paid.reason || null, worldMinutes: minute } });
    grants.push({ grantId, agentId: proposal.agent, amountRaw: item.amountRaw.toString(), via: item.via, upfront: paid });
  }
  await client.query(`INSERT INTO world_research_awards(world_id,call_id,funding_line,lottery_margin,lottery_enabled,seed,ranked,lottery,funded_raw,world_minute)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::numeric,$10)`,
  [worldId, callId, decision.line, margin, lottery, seed, JSON.stringify(decision.ranked),
    JSON.stringify({ band: decision.band, draw: decision.draw, funded: decision.funded.map((item) => ({ id: item.id, via: item.via })) }),
    fundedRaw.toString(), minute]);
  await client.query(`UPDATE world_research_calls SET status=$3,awarded_world_minute=$4 WHERE world_id=$1 AND id=$2`,
    [worldId, callId, grants.length ? 'awarded' : 'closed', minute]);
  if (!grants.length) await client.query(`UPDATE world_research_calls SET closed_world_minute=$3 WHERE world_id=$1 AND id=$2 AND closed_world_minute IS NULL`,
    [worldId, callId, minute]);
  return { awarded: true, grants, line: decision.line, band: decision.band, draw: decision.draw, seed };
}

// ---- engine-held evidence --------------------------------------------------------------------------------
// Day marks bound event scans; a day's statistics are computed once, after the day closed (+30 world minutes).
export async function markAndCloseDays(client, { worldId, worldMinutes }) {
  const day = worldDay(worldMinutes);
  await client.query(`INSERT INTO world_research_day_marks(world_id,world_day,first_event_id)
    SELECT $1,$2,COALESCE((SELECT max(id) FROM world_events),0)+1 ON CONFLICT DO NOTHING`, [worldId, day]);
  const due = await client.query(`SELECT m.world_day::int AS day,m.first_event_id::text AS first,n.first_event_id::text AS next
    FROM world_research_day_marks m JOIN world_research_day_marks n ON n.world_id=m.world_id AND n.world_day=m.world_day+1
    WHERE m.world_id=$1 AND m.world_day<$2 AND ($3::bigint >= (m.world_day+1)*1440+30)
      AND NOT EXISTS (SELECT 1 FROM world_research_day_stats s WHERE s.world_id=m.world_id AND s.world_day=m.world_day AND s.kind='town')
    ORDER BY m.world_day DESC LIMIT 1`, [worldId, day, Math.trunc(worldMinutes)]);
  const target = due.rows[0];
  if (!target) return { closed: null };
  const from = Math.max(0, Number(target.first) - 3_000), to = Number(target.next) + 3_000;
  const lo = target.day * MINUTES_PER_DAY, hi = lo + MINUTES_PER_DAY;
  const events = await client.query(`SELECT actor_id::text AS actor,data->>'action' AS action,data->>'place' AS place,
      (data->>'worldMinutes')::numeric AS minute,(data->'needs'->>'food')::numeric AS food
    FROM world_events WHERE world_id=$1 AND id BETWEEN $2 AND $3 AND event_type='world.action_completed'
      AND (data->>'worldMinutes') ~ '^[0-9]+(\\.[0-9]+)?$' AND (data->>'worldMinutes')::numeric >= $4 AND (data->>'worldMinutes')::numeric < $5`,
  [worldId, from, to, lo, hi]);
  const stock = await client.query(`SELECT COALESCE(sum(stock_units),0)::int AS stock,count(*)::int AS services FROM world_business_services
    WHERE world_id=$1 AND service_type='food_service'`, [worldId]).catch(() => ({ rows: [{ stock: 0, services: 0 }] }));
  const stats = buildDayStats(events.rows, { stockAtClose: Number(stock.rows[0]?.stock) || 0, foodServices: Number(stock.rows[0]?.services) || 0 });
  const minute = Math.trunc(worldMinutes);
  await client.query(`INSERT INTO world_research_day_stats(world_id,world_day,kind,subject,stats,created_world_minute)
    VALUES($1,$2,'town','town',$3::jsonb,$4) ON CONFLICT DO NOTHING`, [worldId, target.day, JSON.stringify(stats.town), minute]);
  await client.query(`INSERT INTO world_research_day_stats(world_id,world_day,kind,subject,stats,created_world_minute)
    VALUES($1,$2,'food','food',$3::jsonb,$4) ON CONFLICT DO NOTHING`, [worldId, target.day, JSON.stringify(stats.food), minute]);
  for (const place of stats.places) {
    await client.query(`INSERT INTO world_research_day_stats(world_id,world_day,kind,subject,stats,created_world_minute)
      VALUES($1,$2,'place',$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`, [worldId, target.day, place.subject, JSON.stringify(place.stats), minute]);
  }
  return { closed: target.day, events: events.rowCount, places: stats.places.length };
}
// Pure: day statistics from that day's action completions.
export function buildDayStats(rows = [], { stockAtClose = 0, foodServices = 0, topPlaces = 12 } = {}) {
  const places = new Map();
  const actors = new Set();
  let meals = 0, low = 0;
  for (const row of rows) {
    actors.add(row.actor);
    if (row.action === 'eat') meals += 1;
    if (row.food !== null && row.food !== undefined && Number(row.food) < 20) low += 1;
    const name = shortText(row.place, 120);
    if (!name) continue;
    const entry = places.get(name) || { completions: 0, residents: new Set(), hours: new Map(), meals: 0 };
    entry.completions += 1;
    entry.residents.add(row.actor);
    if (row.action === 'eat') entry.meals += 1;
    const hour = Math.floor((Number(row.minute) % MINUTES_PER_DAY) / 60);
    entry.hours.set(hour, (entry.hours.get(hour) || 0) + 1);
    places.set(name, entry);
  }
  const placeRows = [...places.entries()].sort((a, b) => b[1].completions - a[1].completions || a[0].localeCompare(b[0])).slice(0, topPlaces)
    .map(([subject, entry]) => {
      const peak = [...entry.hours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || [0, 0];
      return { subject, stats: { completions: entry.completions, residents: entry.residents.size, peakHour: peak[1], peakHourOfDay: peak[0],
        meals: entry.meals } };
    });
  return { town: { completions: rows.length, residents: actors.size, places: places.size },
    food: { meals, lowFoodReadings: low, stockAtClose, foodServices }, places: placeRows };
}
export async function evidencePack(db, { worldId, days = 3, placesPerDay = 6 }) {
  const rows = await db.query(`SELECT id::text AS id,world_day::int AS day,kind,subject,stats FROM world_research_day_stats
    WHERE world_id=$1 AND world_day >= (SELECT COALESCE(max(world_day),0) FROM world_research_day_stats WHERE world_id=$1)-$2+1
    ORDER BY world_day DESC,kind,(stats->>'completions')::numeric DESC NULLS LAST,id`, [worldId, days]);
  const perDay = new Map();
  const out = [];
  for (const row of rows.rows) {
    if (row.kind === 'place') {
      const n = perDay.get(row.day) || 0;
      if (n >= placesPerDay) continue;
      perDay.set(row.day, n + 1);
    }
    out.push({ ref: `S${row.id}`, day: row.day, kind: row.kind, subject: row.subject, stats: row.stats });
  }
  return out;
}
export async function closedDay(db, worldId) {
  const row = await db.query(`SELECT max(world_day)::int AS d FROM world_research_day_stats WHERE world_id=$1 AND kind='town'`, [worldId]);
  return row.rows[0]?.d ?? null;
}

// ---- reports -----------------------------------------------------------------------------------------------
async function resolveCitation(db, worldId, ref) {
  if (ref.kind === 'stat') {
    const row = await db.query(`SELECT stats FROM world_research_day_stats WHERE world_id=$1 AND id=$2`, [worldId, ref.id]);
    return row.rowCount ? { exists: true, value: pickField(row.rows[0].stats, ref.field) } : { exists: false };
  }
  if (ref.kind === 'event') {
    const row = await db.query(`SELECT id,event_type,data,actor_id::text AS actor FROM world_events WHERE world_id=$1 AND id=$2`, [worldId, ref.id]);
    if (!row.rowCount) return { exists: false };
    const event = row.rows[0];
    const field = ref.field.startsWith('data.') ? ref.field.slice(5) : ref.field;
    return { exists: true, value: ref.field === 'event_type' ? event.event_type : pickField(event.data, field) };
  }
  const row = await db.query(`SELECT id FROM world_research_reports WHERE world_id=$1 AND id=$2 AND status='published'`, [worldId, ref.id]);
  return { exists: row.rowCount > 0, value: null };
}
export async function verifyCitations(db, { worldId, conclusions = [], reportCites = [] }) {
  const results = [];
  for (const conclusion of conclusions) {
    for (const figure of conclusion.figures || []) {
      const ref = parseCitationRef(figure.cite);
      if (!ref || ref.kind === 'report') { results.push({ ref: ref || { kind: 'stat', id: 0, field: shortText(figure.cite, 120) || null }, cited: figure.value, actual: null, status: 'missing' }); continue; }
      const found = await resolveCitation(db, worldId, ref);
      const status = !found.exists || found.value === undefined ? 'missing' : valuesMatch(figure.value, found.value) ? 'verified' : 'mismatch';
      results.push({ ref, cited: figure.value, actual: found.value ?? null, status });
    }
  }
  for (const ref of reportCites) {
    const found = await resolveCitation(db, worldId, ref);
    results.push({ ref, cited: null, actual: null, status: found.exists ? 'verified' : 'missing' });
  }
  return results;
}

export async function fileReport(client, { worldId, grantId, parsed, source = 'llm', model = null, worldMinutes, env = process.env, now = new Date() }) {
  const grant = (await client.query(`SELECT g.id::text AS id,g.call_id::text AS call,g.agent_id::text AS agent,g.amount_raw::text AS amount,g.status,
      g.report_due_world_minute::text AS due,g.external FROM world_research_grants g WHERE g.world_id=$1 AND g.id=$2 FOR UPDATE`, [worldId, grantId])).rows[0];
  if (!grant) throw coded('RESEARCH_GRANT_UNKNOWN', 404);
  if (grant.status !== 'active') throw coded('RESEARCH_GRANT_NOT_ACTIVE');
  if (Math.trunc(worldMinutes) > Number(grant.due)) throw coded('RESEARCH_REPORT_PAST_DUE');
  const results = await verifyCitations(client, { worldId, conclusions: parsed.conclusions, reportCites: parsed.reportCites });
  const verified = results.filter((item) => item.status === 'verified').length;
  const failed = results.length - verified;
  const uncited = countUncitedNumbers(parsed.conclusions);
  const nonIndep = await nonIndependent(client, grant.agent);
  const conclusionsJson = [...parsed.conclusions.map((item) => ({ text: item.text, figures: item.figures })), { claims: parsed.claims }];
  const report = await client.query(`INSERT INTO world_research_reports(world_id,call_id,grant_id,author_agent_id,question,data_sources,conclusions,
      conditions,result_kind,citations_verified,citations_failed,uncited_numbers,source,external,non_independent,model,filed_world_minute)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id::text AS id`,
  [worldId, grant.call, grant.id, grant.agent, parsed.question, JSON.stringify(parsed.dataSources),
    JSON.stringify(conclusionsJson),
    parsed.conditions, parsed.resultKind, verified, failed, uncited, source, grant.external, nonIndep, model, Math.trunc(worldMinutes)]);
  const reportId = report.rows[0].id;
  let ordinal = 0;
  for (const item of results) {
    await client.query(`INSERT INTO world_research_citations(world_id,report_id,ordinal,ref_kind,ref_id,field,cited_value,actual_value,status)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [worldId, reportId, ordinal, item.ref.kind, Math.max(0, Number(item.ref.id) || 0),
      item.ref.field || null, JSON.stringify(item.cited ?? null), JSON.stringify(item.actual ?? null), item.status]);
    ordinal += 1;
  }
  await client.query(`UPDATE world_research_grants SET status='reported' WHERE world_id=$1 AND id=$2`, [worldId, grant.id]);
  // Final tranche only for a report whose citations all check out (at least one); a negative result is paid the same.
  let final = { paid: false, reason: failed ? 'CITATIONS_FAILED' : verified ? null : 'NO_VERIFIED_CITATION' };
  if (!failed && verified > 0) {
    const paidSoFar = big((await client.query(`SELECT COALESCE(sum(amount_raw),0)::text AS v FROM world_research_payouts WHERE world_id=$1 AND grant_id=$2`,
      [worldId, grant.id])).rows[0]?.v);
    const rest = big(grant.amount) - paidSoFar;
    if (rest > 0n) final = await payResearch(client, { worldId, agentId: grant.agent, sourceType: 'research_grant', kind: 'grant_final', amountRaw: rest,
      payoutKey: `research-grant-final:${grant.id}`, callId: grant.call, grantId: grant.id, worldMinutes, env, now });
  }
  await insertEvent(client, { worldId, actorId: grant.agent, type: 'world.research_report_filed', actionId: `research-report:${reportId}`,
    data: { reportId, grantId: grant.id, callId: grant.call, citationsVerified: verified, citationsFailed: failed, uncitedNumbers: uncited,
      resultKind: parsed.resultKind, finalPaid: final.paid, worldMinutes: Math.trunc(worldMinutes) } });
  return { reportId, citationsVerified: verified, citationsFailed: failed, uncitedNumbers: uncited, final };
}

export function reportClaims(conclusionsJson) {
  const tail = Array.isArray(conclusionsJson) ? conclusionsJson.find((item) => item && Array.isArray(item.claims)) : null;
  return tail ? tail.claims : [];
}
export function reportConclusions(conclusionsJson) {
  return Array.isArray(conclusionsJson) ? conclusionsJson.filter((item) => item && typeof item.text === 'string') : [];
}

// 汇报会: every K world days the filed reports become visible to all residents; their key conclusions become
// checkable claims (world_gambit_claims, context research_report:<id>).
export async function runConference(client, { worldId, worldMinutes, env = process.env }) {
  const every = Math.max(1, Math.round(researchNumber('MIRRORTERRA_RESEARCH_CONFERENCE_EVERY_DAYS', env)));
  const day = worldDay(worldMinutes);
  if (day % every !== 0) return null;
  const done = await client.query(`SELECT 1 FROM world_research_conferences WHERE world_id=$1 AND world_day=$2`, [worldId, day]);
  if (done.rowCount) return null;
  const filed = await client.query(`SELECT id::text AS id,author_agent_id::text AS author,conclusions FROM world_research_reports
    WHERE world_id=$1 AND status='filed' ORDER BY id FOR UPDATE`, [worldId]);
  const minute = Math.trunc(worldMinutes);
  let claims = 0;
  for (const report of filed.rows) {
    await client.query(`UPDATE world_research_reports SET status='published',published_world_minute=$3,conference_day=$4 WHERE world_id=$1 AND id=$2`,
      [worldId, report.id, minute, day]);
    for (const claim of reportClaims(report.conclusions)) {
      await client.query(`INSERT INTO world_gambit_claims(world_id,gambit_id,context_ref,agent_id,fact_key,subject_ref,claimed_value,verifiable,
          verification,created_world_minute) VALUES($1,NULL,$2,$3,'research_claim',$4,$5::jsonb,true,'unverified',$6)`,
      [worldId, `research_report:${report.id}`, report.author, shortText(`${claim.metric}:${claim.subject}`, 180), JSON.stringify(claim), minute]);
      claims += 1;
    }
  }
  await client.query(`INSERT INTO world_research_conferences(world_id,world_day,published_count,world_minute) VALUES($1,$2,$3,$4)`,
    [worldId, day, filed.rowCount, minute]);
  if (filed.rowCount) {
    const governor = (await client.query(`SELECT author_agent_id AS a FROM world_research_reports WHERE world_id=$1 AND id=$2`, [worldId, filed.rows[0].id])).rows[0].a;
    await insertEvent(client, { worldId, actorId: governor, type: 'world.research_conference', actionId: `research-conference:${day}`,
      data: { worldDay: day, published: filed.rows.map((row) => Number(row.id)), claims, worldMinutes: minute } });
  }
  return { day, published: filed.rowCount, claims };
}

// ---- verification by isolated skeptics -----------------------------------------------------------------------
export async function isolationOf(db, { worldId, verifierId, authorId, worldMinutes, env = process.env }) {
  if (verifierId === authorId) return isolationVerdict({ self: true });
  const since = Math.trunc(worldMinutes - Math.max(0, researchNumber('MIRRORTERRA_RESEARCH_ISOLATION_DAYS', env)) * MINUTES_PER_DAY);
  const [transfers, commitments, alliances] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM arc_sync_internal_transfers WHERE world_id=$1 AND world_minute>=$4
      AND ((from_agent_id=$2 AND to_agent_id=$3) OR (from_agent_id=$3 AND to_agent_id=$2))`, [worldId, verifierId, authorId, since]),
    db.query(`SELECT count(*) FILTER (WHERE kind<>'vote_stance')::int AS n,count(*) FILTER (WHERE kind='vote_stance')::int AS votes
      FROM world_gambit_commitments WHERE world_id=$1 AND created_world_minute>=$4
      AND ((agent_id=$2 AND counterparty_agent_id=$3) OR (agent_id=$3 AND counterparty_agent_id=$2))`, [worldId, verifierId, authorId, since]),
    // world_gambits keeps opened_world_minute (0034); no .catch: inside the step transaction a failed query aborts
    // the transaction anyway, and swallowing it would report a non-isolated skeptic as isolated.
    db.query(`SELECT count(*)::int AS n FROM world_gambits WHERE world_id=$1 AND opened_world_minute>=$4
      AND status IN ('accepted','settled') AND ((initiator_agent_id=$2 AND $3=ANY(counterpart_agent_ids))
        OR (initiator_agent_id=$3 AND $2=ANY(counterpart_agent_ids)))`, [worldId, verifierId, authorId, since])
  ]);
  return isolationVerdict({ transfers: transfers.rows[0]?.n, commitments: commitments.rows[0]?.n, voteSwaps: commitments.rows[0]?.votes,
    alliances: alliances.rows[0]?.n });
}

// A skeptic asks to check a published claim; isolation is checked now and recorded either way. The result comes
// back after the gambit verification delay (world time). Not-yet-checkable windows are refused, never locked.
export async function requestVerification(client, { worldId, claimId, verifierId, source = 'llm', worldMinutes, env = process.env }) {
  if (!researchFlag('MIRRORTERRA_RESEARCH_VERIFICATION', env)) throw coded('RESEARCH_VERIFICATION_OFF');
  const claim = (await client.query(`SELECT c.id,c.agent_id::text AS author,c.fact_key,c.claimed_value,c.verification,c.context_ref,c.subject_ref
    FROM world_gambit_claims c WHERE c.world_id=$1 AND c.id=$2`, [worldId, claimId])).rows[0];
  if (!claim || !['research_claim', 'research_authorship'].includes(claim.fact_key)) throw coded('RESEARCH_CLAIM_UNKNOWN', 404);
  if (claim.verification !== 'unverified') throw coded('RESEARCH_CLAIM_ALREADY_VERIFIED');
  const reportId = Number(String(claim.context_ref || claim.subject_ref || '').split(':')[1]);
  const report = (await client.query(`SELECT id,author_agent_id::text AS author,status FROM world_research_reports WHERE world_id=$1 AND id=$2`,
    [worldId, reportId])).rows[0];
  if (!report || report.status !== 'published') throw coded('RESEARCH_REPORT_NOT_PUBLISHED');
  if (claim.fact_key === 'research_claim') {
    const closed = await closedDay(client, worldId);
    if (closed === null || Number(claim.claimed_value?.toDay) > closed) throw coded('RESEARCH_CLAIM_NOT_DUE');
  }
  const isolation = await isolationOf(client, { worldId, verifierId, authorId: claim.author, worldMinutes, env });
  const pending = await client.query(`SELECT 1 FROM world_research_verifications WHERE world_id=$1 AND claim_id=$2 AND status='pending'`, [worldId, claimId]);
  if (pending.rowCount) throw coded('RESEARCH_CLAIM_BEING_VERIFIED');
  const minute = Math.trunc(worldMinutes);
  const delay = Math.max(0, researchNumber('MIRRORTERRA_RESEARCH_VERIFY_DELAY_MINUTES', env));
  const row = await client.query(`INSERT INTO world_research_verifications(world_id,report_id,claim_id,verifier_agent_id,kind,isolation,status,
      requested_world_minute,due_world_minute,settled_world_minute,source) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
    ON CONFLICT (world_id,claim_id,verifier_agent_id) DO NOTHING RETURNING id::text AS id`,
  [worldId, reportId, claimId, verifierId, claim.fact_key === 'research_claim' ? 'claim' : 'authorship', JSON.stringify(isolation),
    isolation.isolated ? 'pending' : 'ineligible', minute, minute + (isolation.isolated ? delay : 0), isolation.isolated ? null : minute, source]);
  if (!row.rowCount) throw coded('RESEARCH_ALREADY_REQUESTED');
  return { verificationId: row.rows[0].id, isolated: isolation.isolated, isolation, dueWorldMinute: minute + delay };
}

async function researchActual(db, { worldId, claim }) {
  const value = claim.claimed_value || {};
  if (claim.fact_key === 'research_authorship') {
    const reportId = Number(String(claim.subject_ref || '').split(':')[1]);
    const row = await db.query(`SELECT author_agent_id::text AS author FROM world_research_reports WHERE world_id=$1 AND id=$2`, [worldId, reportId]);
    return row.rowCount ? { authorship: row.rows[0].author } : undefined;
  }
  const spec = CLAIM_METRICS[value.metric];
  if (!spec) return undefined;
  const rows = await db.query(`SELECT world_day::int AS day,stats FROM world_research_day_stats WHERE world_id=$1 AND kind=$2 AND subject=$3
    AND world_day BETWEEN $4 AND $5`, [worldId, spec.kind, spec.kind === 'place' ? value.subject : spec.kind, value.fromDay, value.toDay]);
  const closedRows = await db.query(`SELECT world_day::int AS day FROM world_research_day_stats WHERE world_id=$1 AND kind='town'
    AND world_day BETWEEN $2 AND $3`, [worldId, value.fromDay, value.toDay]);
  const byDay = new Map(closedRows.rows.map((row) => [row.day, {}]));   // a closed day without the place = 0 at that place
  for (const row of rows.rows) byDay.set(row.day, row.stats);
  return evaluateMetric(value.metric, byDay, value);
}

// Settle due verifications through the gambit claim record: verification set once on world_gambit_claims, the same
// verification_fee (verifier -> author, only when true), claim_true/claim_false reactions, exposeClaims() for a false
// one, plus the research consequences (reputation facts, verification reward for exposure / first replication).
export async function settleDueVerifications(client, { worldId, worldMinutes, env = process.env, limit = 10, now = new Date() }) {
  const due = await client.query(`SELECT v.id::text AS id,v.claim_id::text AS claim,v.verifier_agent_id::text AS verifier,v.report_id::text AS report,v.kind
    FROM world_research_verifications v WHERE v.world_id=$1 AND v.status='pending' AND v.due_world_minute<=$2 ORDER BY v.due_world_minute,v.id
    LIMIT $3 FOR UPDATE SKIP LOCKED`, [worldId, Math.trunc(worldMinutes), limit]);
  const minute = Math.trunc(worldMinutes);
  const feeRaw = big(Math.trunc(researchNumber('MIRRORTERRA_RESEARCH_VERIFY_FEE_RAW', env)));
  const settled = [];
  for (const row of due.rows) {
    const claim = (await client.query(`SELECT id,agent_id::text AS agent_id,fact_key,subject_ref,claimed_value,verification,context_ref
      FROM world_gambit_claims WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, row.claim])).rows[0];
    if (!claim || claim.verification !== 'unverified') {
      await client.query(`UPDATE world_research_verifications SET status='unverifiable',settled_world_minute=$3,outcome=$4::jsonb WHERE world_id=$1 AND id=$2`,
        [worldId, row.id, minute, JSON.stringify({ reason: 'claim_already_verified' })]);
      settled.push({ id: row.id, status: 'unverifiable' });
      continue;
    }
    const actual = await researchActual(client, { worldId, claim });
    const judged = claim.fact_key === 'research_authorship'
      ? (actual === undefined ? { verification: 'unverifiable', truth: null }
        : { verification: actual.authorship === claim.agent_id ? 'true' : 'false', truth: actual })
      : judgeResearchClaim(claim.claimed_value, actual);
    await client.query(`UPDATE world_gambit_claims SET verification=$3,verified_by_agent_id=$4,verified_world_minute=$5,truth=$6::jsonb
      WHERE world_id=$1 AND id=$2`, [worldId, claim.id, judged.verification, row.verifier, minute, JSON.stringify(judged.truth ?? null)]);
    let feePaid = false, reward = null, exposed = [];
    if (judged.verification === 'true' && feeRaw > 0n) {
      feePaid = Boolean(await transferInternal(client, { worldId, fromAgentId: row.verifier, toAgentId: claim.agent_id, amountRaw: feeRaw,
        kind: 'verification_fee', actionId: `research-verify-fee:${claim.id}:${row.verifier}`, sourceRef: `claim:${claim.id}`, worldMinutes: minute }));
    }
    if (judged.verification === 'true' || judged.verification === 'false') {
      await recordReputation(client, { worldId, agentId: claim.agent_id, observerAgentId: row.verifier,
        kind: judged.verification === 'true' ? 'claim_true' : 'claim_false', deltaTrust: judged.verification === 'true' ? 2 : -6,
        detail: { claimId: Number(claim.id), fact: claim.fact_key, feePaid, research: true }, worldMinutes: minute });
    }
    const plagiarism = claim.fact_key === 'research_authorship';
    if (judged.verification === 'false') {
      exposed = await exposeClaims(client, { worldId, claimIds: [claim.id], exposerId: row.verifier, gambitId: null, worldMinutes: minute });
      await recordReputation(client, { worldId, agentId: claim.agent_id, observerAgentId: row.verifier,
        kind: plagiarism ? 'plagiarism_exposed' : 'research_exposed', deltaTrust: plagiarism ? RESEARCH_TRUST.plagiarism_exposed : RESEARCH_TRUST.research_exposed,
        detail: { claimId: Number(claim.id), reportId: Number(row.report), claimed: claim.claimed_value, truth: judged.truth }, worldMinutes: minute });
      await recordReputation(client, { worldId, agentId: row.verifier, kind: plagiarism ? 'plagiarism_exposer' : 'research_exposer',
        deltaTrust: plagiarism ? RESEARCH_TRUST.plagiarism_exposer : RESEARCH_TRUST.research_exposer,
        detail: { claimId: Number(claim.id), reportId: Number(row.report), subject: claim.agent_id }, worldMinutes: minute });
      const amount = big(Math.trunc(researchNumber('MIRRORTERRA_RESEARCH_EXPOSURE_REWARD_RAW', env)));
      if (amount > 0n) reward = await payResearch(client, { worldId, agentId: row.verifier, sourceType: 'research_verification', kind: 'verification_exposure',
        amountRaw: amount, payoutKey: `research-verify-exposure:${row.id}`, verificationId: Number(row.id), worldMinutes: minute, env, now });
    } else if (judged.verification === 'true' && !plagiarism) {
      // A confirmed replication is a contribution: reputation for both; the first confirming verifier is rewarded.
      await recordReputation(client, { worldId, agentId: claim.agent_id, observerAgentId: row.verifier, kind: 'research_replicated',
        deltaTrust: RESEARCH_TRUST.research_replicated, detail: { claimId: Number(claim.id), reportId: Number(row.report) }, worldMinutes: minute });
      await recordReputation(client, { worldId, agentId: row.verifier, kind: 'research_replicator', deltaTrust: RESEARCH_TRUST.research_replicator,
        detail: { claimId: Number(claim.id), reportId: Number(row.report) }, worldMinutes: minute });
      const amount = big(Math.trunc(researchNumber('MIRRORTERRA_RESEARCH_REPLICATION_REWARD_RAW', env)));
      if (amount > 0n) reward = await payResearch(client, { worldId, agentId: row.verifier, sourceType: 'research_verification', kind: 'verification_replication',
        amountRaw: amount, payoutKey: `research-verify-replication:${claim.id}`, verificationId: Number(row.id), worldMinutes: minute, env, now });
    }
    await client.query(`UPDATE world_research_verifications SET status=$3,settled_world_minute=$4,outcome=$5::jsonb,reward_payout_id=$6
      WHERE world_id=$1 AND id=$2`, [worldId, row.id, judged.verification, minute,
      JSON.stringify({ truth: judged.truth ?? null, feePaid, exposed: exposed.length > 0, reward: reward ? { paid: reward.paid, reason: reward.reason || null } : null }),
      reward?.paid ? reward.payoutId : null]);
    settled.push({ id: row.id, status: judged.verification, feePaid, exposed: exposed.length > 0, rewardPaid: Boolean(reward?.paid) });
  }
  return settled;
}

// Plagiarism is not forbidden: a resident may claim authorship of any published report. That is a checkable claim.
export async function claimAuthorship(client, { worldId, reportId, agentId, worldMinutes, env = process.env }) {
  if (!researchFlag('MIRRORTERRA_RESEARCH_PLAGIARISM', env)) throw coded('RESEARCH_PLAGIARISM_OFF');
  const report = (await client.query(`SELECT id FROM world_research_reports WHERE world_id=$1 AND id=$2 AND status='published'`, [worldId, reportId])).rows[0];
  if (!report) throw coded('RESEARCH_REPORT_NOT_PUBLISHED', 404);
  const prior = await client.query(`SELECT id FROM world_gambit_claims WHERE world_id=$1 AND agent_id=$2 AND fact_key='research_authorship' AND subject_ref=$3`,
    [worldId, agentId, `report:${reportId}`]);
  if (prior.rowCount) return { claimId: Number(prior.rows[0].id), duplicate: true };
  const row = await client.query(`INSERT INTO world_gambit_claims(world_id,gambit_id,context_ref,agent_id,fact_key,subject_ref,claimed_value,verifiable,
      verification,created_world_minute) VALUES($1,NULL,$2,$3,'research_authorship',$4,$5::jsonb,true,'unverified',$6) RETURNING id`,
  [worldId, `research_report:${reportId}`, agentId, `report:${reportId}`, JSON.stringify({ author: 'me', reportId: Number(reportId) }), Math.trunc(worldMinutes)]);
  await insertEvent(client, { worldId, actorId: agentId, type: 'world.research_authorship_claim', actionId: `research-authorship:${reportId}`,
    data: { reportId: Number(reportId), claimId: Number(row.rows[0].id), worldMinutes: Math.trunc(worldMinutes) } });
  return { claimId: Number(row.rows[0].id) };
}

// ---- adoption -----------------------------------------------------------------------------------------------
// Counts only a plan step that (a) references a published report (R<id>) by another author, and (b) has authoritative
// execution evidence: a world.action_completed event of the adopter carrying cognitionExecution for that plan/step.
export async function scanAdoptions(client, { worldId, env = process.env, limit = 20 }) {
  if (!researchFlag('MIRRORTERRA_RESEARCH_ADOPTION', env)) return { recorded: 0 };
  await settleExternalAdoptedResearch(client, { worldId, env, limit });
  const published = await client.query(`SELECT id::int AS id,author_agent_id::text AS author,published_world_minute::text AS at
    FROM world_research_reports WHERE world_id=$1 AND status='published'`, [worldId]);
  if (!published.rowCount) return { recorded: 0 };
  const byId = new Map(published.rows.map((row) => [row.id, row]));
  const states = await client.query(`SELECT agent_id::text AS agent,goals,plans FROM world_agent_cognition_state WHERE world_id=$1`, [worldId]);
  let recorded = 0;
  for (const state of states.rows) {
    for (const plan of Array.isArray(state.plans) ? state.plans : []) {
      for (const step of Array.isArray(plan?.steps) ? plan.steps : []) {
        const evidence = step?.executionEvidence;
        if (!evidence?.success || !Number.isFinite(Number(evidence.eventId))) continue;
        const refs = reportRefsIn(`${step.description || ''} ${step.intent || ''}`).filter((id) => byId.has(id));
        if (!refs.length) continue;
        for (const reportId of refs) {
          const report = byId.get(reportId);
          if (report.author === state.agent || Number(evidence.worldMinute) < Number(report.at)) continue;
          const exists = await client.query(`SELECT 1 FROM world_research_adoptions WHERE world_id=$1 AND report_id=$2 AND adopter_agent_id=$3 AND event_id=$4`,
            [worldId, reportId, state.agent, evidence.eventId]);
          if (exists.rowCount) continue;
          const event = (await client.query(`SELECT id,data FROM world_events WHERE world_id=$1 AND id=$2 AND actor_id=$3 AND event_type='world.action_completed'`,
            [worldId, evidence.eventId, state.agent])).rows[0];
          const execution = event?.data?.cognitionExecution;
          if (!event || execution?.planId !== plan.id || execution?.stepId !== step.stepId || event.data.status !== 'completed') continue;
          await client.query(`INSERT INTO world_research_adoptions(world_id,report_id,adopter_agent_id,goal_id,plan_id,step_id,step_text,action,event_id,
              model_call_id,world_minute) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [worldId, reportId, state.agent, shortText(plan.goalId, 160) || null, shortText(plan.id, 160), shortText(step.stepId, 160),
            shortText(step.description || step.intent, 400), shortText(execution.action, 60) || null, Number(event.id),
            shortText(execution.modelCallId, 80) || null, Math.trunc(Number(evidence.worldMinute) || 0)]);
          await recordReputation(client, { worldId, agentId: report.author, observerAgentId: state.agent, kind: 'research_adopted',
            deltaTrust: RESEARCH_TRUST.research_adopted, detail: { reportId, planId: plan.id, stepId: step.stepId, eventId: Number(event.id) },
            worldMinutes: Math.trunc(Number(evidence.worldMinute) || 0) });
          recorded += 1;
          if (recorded >= limit) return { recorded };
        }
      }
    }
  }
  return { recorded };
}

export async function settleExternalAdoptedResearch(client, { worldId, env = process.env, limit = 20 }) {
  if (!(await readExternal2Policy(client)).research_rewards) return [];
  const due = await client.query(`SELECT g.id,g.call_id,g.agent_id,g.amount_raw::text AS amount_raw,
      COALESCE((SELECT sum(p.amount_raw) FROM world_research_payouts p WHERE p.world_id=g.world_id AND p.grant_id=g.id),0)::text AS paid_raw
    FROM world_research_grants g JOIN world_external_residents e ON e.world_id=g.world_id AND e.agent_id=g.agent_id
    JOIN world_research_reports r ON r.world_id=g.world_id AND r.grant_id=g.id
    WHERE g.world_id=$1 AND r.status='published' AND r.citations_verified>0 AND r.citations_failed=0 AND r.uncited_numbers=0
      AND EXISTS (SELECT 1 FROM world_research_adoptions a WHERE a.world_id=r.world_id AND a.report_id=r.id
        AND mirrorterra_external_independent_pair(r.world_id,r.author_agent_id,a.adopter_agent_id))
      AND NOT EXISTS (SELECT 1 FROM world_external_contribution_receipts c WHERE c.world_id=g.world_id AND c.kind='research' AND c.source_ref=g.id::text)
    ORDER BY g.created_at,g.id LIMIT $2`, [worldId, Math.max(1, Math.min(100, limit))]);
  const minute = await worldMinuteOf(client, worldId);
  const results = [];
  for (const grant of due.rows) {
    const remaining = big(grant.amount_raw)-big(grant.paid_raw);
    if (remaining<=0n) continue;
    results.push(await payResearch(client, { worldId, agentId: grant.agent_id, sourceType: 'research_grant', kind: 'grant_final',
      amountRaw: remaining, payoutKey: `research-external-adopted:${grant.id}`, callId: grant.call_id, grantId: grant.id,
      worldMinutes: minute, env }));
  }
  return results;
}

// ---- lifecycle ----------------------------------------------------------------------------------------------
export async function closeDueCalls(client, { worldId, worldMinutes }) {
  const minute = Math.trunc(worldMinutes);
  const lapsed = await client.query(`UPDATE world_research_grants SET status='lapsed' WHERE world_id=$1 AND status='active'
    AND report_due_world_minute<$2 RETURNING id`, [worldId, minute]);
  const closed = await client.query(`UPDATE world_research_calls SET status='closed',closed_world_minute=$2 WHERE world_id=$1
    AND status='awarded' AND reports_due_world_minute<$2 AND NOT EXISTS (SELECT 1 FROM world_research_grants g WHERE g.world_id=world_research_calls.world_id
      AND g.call_id=world_research_calls.id AND g.status='active') RETURNING id`, [worldId, minute]);
  return { lapsed: lapsed.rowCount, closed: closed.rowCount };
}

// ---- reads: cognition context and public library -------------------------------------------------------------
async function nameMap(db, worldId) {
  const rows = await db.query(`SELECT m.agent_id::text AS id,a.name FROM world_members m JOIN agents a ON a.id=m.agent_id WHERE m.world_id=$1`, [worldId]);
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}
export async function readCognitionResearch(db, { worldId, agentId, limit = 4 }) {
  const reports = await db.query(`SELECT r.id::int AS id,r.author_agent_id::text AS author,r.question,r.conclusions,r.conditions,r.result_kind,
      r.citations_failed,(SELECT count(*)::int FROM world_research_adoptions a WHERE a.world_id=r.world_id AND a.report_id=r.id) AS adopted
    FROM world_research_reports r WHERE r.world_id=$1 AND r.status='published' ORDER BY r.published_world_minute DESC,r.id DESC LIMIT $2`, [worldId, limit]);
  const open = await db.query(`SELECT topic,status FROM world_research_calls WHERE world_id=$1 AND status IN ('open','judging','awarded')
    ORDER BY opened_world_minute DESC LIMIT 1`, [worldId]);
  if (!reports.rowCount && !open.rowCount) return null;
  const names = await nameMap(db, worldId);
  const block = { note: 'City library (published at the last 汇报会). Reports may exaggerate; numbers cite engine evidence. To act on a report, put its ref (e.g. R12) in the plan step description; it counts as adopted only if that step executes.',
    openCall: open.rows[0] ? `${open.rows[0].topic} (${open.rows[0].status})` : null,
    reports: reports.rows.map((row) => ({ ref: `R${row.id}`, by: row.author === agentId ? 'you' : names.get(row.author) || 'someone',
      question: shortText(row.question, 120), finding: shortText(reportConclusions(row.conclusions)[0]?.text, 160),
      conditions: shortText(row.conditions, 80), result: row.result_kind, adoptedBy: row.adopted, citationProblems: row.citations_failed })) };
  while (JSON.stringify(block).length > COGNITION_RESEARCH_BYTES && block.reports.length) block.reports.pop();
  return block;
}

const labelOf = (names, id, nonIndep) => `${names.get(id) || 'resident'}${nonIndep ? ' (non-independent: operated by MirrorTerra)' : ''}`;
export async function readPublicResearch(db, { worldId, limit = 8 }) {
  const [counts, calls, reports, verifications, adoptions, month] = await Promise.all([
    db.query(`SELECT (SELECT count(*) FROM world_research_calls WHERE world_id=$1)::int AS calls,
        (SELECT count(*) FROM world_research_submissions WHERE world_id=$1 AND kind='proposal')::int AS proposals,
        (SELECT count(*) FROM world_research_submissions WHERE world_id=$1 AND kind='decline')::int AS declines,
        (SELECT count(*) FROM world_research_grants WHERE world_id=$1)::int AS grants,
        (SELECT COALESCE(sum(amount_raw),0) FROM world_research_grants WHERE world_id=$1)::text AS granted_raw,
        (SELECT count(*) FROM world_research_reports WHERE world_id=$1 AND status='published')::int AS reports,
        (SELECT count(*) FROM world_research_reports WHERE world_id=$1 AND status='filed')::int AS awaiting_conference,
        (SELECT count(*) FROM world_research_citations WHERE world_id=$1)::int AS citations,
        (SELECT count(*) FROM world_research_verifications WHERE world_id=$1)::int AS verifications,
        (SELECT count(*) FROM world_research_verifications WHERE world_id=$1 AND status='false')::int AS exposures,
        (SELECT count(*) FROM world_research_adoptions WHERE world_id=$1)::int AS adoptions,
        (SELECT max(world_day) FROM world_research_conferences WHERE world_id=$1)::int AS last_conference_day`, [worldId]),
    db.query(`SELECT c.id::text AS id,c.topic,c.brief,c.budget_raw::text AS budget,c.horizon_days,c.status,c.proposer_agent_id::text AS proposer,
        c.opened_world_minute::text AS opened,(SELECT count(*) FROM world_research_submissions s WHERE s.world_id=c.world_id AND s.call_id=c.id AND s.kind='proposal')::int AS proposals,
        (SELECT count(*) FROM world_research_submissions s WHERE s.world_id=c.world_id AND s.call_id=c.id AND s.kind='decline')::int AS declines,
        a.funding_line,a.lottery
      FROM world_research_calls c LEFT JOIN world_research_awards a ON a.world_id=c.world_id AND a.call_id=c.id
      WHERE c.world_id=$1 ORDER BY c.opened_world_minute DESC LIMIT $2`, [worldId, limit]),
    db.query(`SELECT r.id::int AS id,r.author_agent_id::text AS author,r.question,r.conclusions,r.conditions,r.result_kind,r.citations_verified,
        r.citations_failed,r.uncited_numbers,r.non_independent,r.published_world_minute::text AS published,
        (SELECT count(*) FROM world_research_adoptions a WHERE a.world_id=r.world_id AND a.report_id=r.id)::int AS adoptions
      FROM world_research_reports r WHERE r.world_id=$1 AND r.status='published' ORDER BY r.published_world_minute DESC,r.id DESC LIMIT $2`, [worldId, limit]),
    db.query(`SELECT v.report_id::int AS report,v.verifier_agent_id::text AS verifier,v.kind,v.status,v.isolation,v.settled_world_minute::text AS at
      FROM world_research_verifications v WHERE v.world_id=$1 ORDER BY v.id DESC LIMIT $2`, [worldId, limit]),
    db.query(`SELECT a.report_id::int AS report,a.adopter_agent_id::text AS adopter,a.action,a.step_text,a.world_minute::text AS at
      FROM world_research_adoptions a WHERE a.world_id=$1 ORDER BY a.id DESC LIMIT $2`, [worldId, limit]),
    db.query(`SELECT COALESCE(sum(amount_raw),0)::text AS v FROM world_research_payouts WHERE world_id=$1 AND month_key=$2`, [worldId, monthKey()])
  ]);
  const names = await nameMap(db, worldId);
  const c = counts.rows[0];
  return {
    counts: { calls: c.calls, proposals: c.proposals, declines: c.declines, grants: c.grants, grantedSync: rawToSync(c.granted_raw),
      reports: c.reports, awaitingConference: c.awaiting_conference, citations: c.citations, verifications: c.verifications,
      exposures: c.exposures, adoptions: c.adoptions, lastConferenceDay: c.last_conference_day, researchSyncThisMonth: rawToSync(month.rows[0]?.v) },
    calls: calls.rows.map((row) => ({ topic: row.topic, brief: shortText(row.brief, 160), budgetSync: rawToSync(row.budget), horizonDays: row.horizon_days,
      status: row.status, proposer: names.get(row.proposer) || 'resident', proposals: row.proposals, declines: row.declines,
      fundingLine: row.funding_line === null ? null : Number(row.funding_line), lotteryDraws: Array.isArray(row.lottery?.draw) ? row.lottery.draw.length : 0 })),
    reports: reports.rows.map((row) => ({ ref: `R${row.id}`, author: labelOf(names, row.author, row.non_independent), question: shortText(row.question, 160),
      finding: shortText(reportConclusions(row.conclusions)[0]?.text, 200), conditions: shortText(row.conditions, 120), result: row.result_kind,
      citations: { verified: row.citations_verified, failed: row.citations_failed }, uncitedNumbers: row.uncited_numbers, adoptions: row.adoptions })),
    verifications: verifications.rows.map((row) => ({ report: `R${row.report}`, verifier: names.get(row.verifier) || 'resident', kind: row.kind,
      status: row.status, isolated: Boolean(row.isolation?.isolated) })),
    adoptions: adoptions.rows.map((row) => ({ report: `R${row.report}`, adopter: names.get(row.adopter) || 'resident', action: row.action,
      step: shortText(row.step_text, 120) }))
  };
}
export const HISTORY_TYPES = Object.freeze(['calls', 'proposals', 'declines', 'grants', 'reports', 'citations', 'verifications', 'adoptions']);
export async function readResearchHistory(db, { worldId, type, page = 1, pageSize = 20 }) {
  if (!HISTORY_TYPES.includes(type)) throw coded('RESEARCH_HISTORY_TYPE_INVALID', 400);
  const size = Math.min(50, Math.max(1, Math.trunc(pageSize)));
  const offset = (Math.max(1, Math.trunc(page)) - 1) * size;
  const names = await nameMap(db, worldId);
  const queries = {
    calls: `SELECT topic,brief,budget_raw::text AS budget,horizon_days AS "horizonDays",status,opened_world_minute::text AS opened FROM world_research_calls WHERE world_id=$1 ORDER BY opened_world_minute DESC`,
    proposals: `SELECT s.call_id::text AS call,s.agent_id::text AS agent,s.title,s.method,s.budget_raw::text AS budget,s.non_independent,s.world_minute::text AS at FROM world_research_submissions s WHERE s.world_id=$1 AND s.kind='proposal' ORDER BY s.id DESC`,
    declines: `SELECT s.call_id::text AS call,s.agent_id::text AS agent,s.argument,s.non_independent,s.world_minute::text AS at FROM world_research_submissions s WHERE s.world_id=$1 AND s.kind='decline' ORDER BY s.id DESC`,
    grants: `SELECT g.agent_id::text AS agent,g.amount_raw::text AS amount,g.via,g.score,g.status,g.world_minute::text AS at FROM world_research_grants g WHERE g.world_id=$1 ORDER BY g.world_minute DESC,g.id`,
    reports: `SELECT r.id::int AS id,r.author_agent_id::text AS agent,r.question,r.result_kind,r.status,r.non_independent,r.filed_world_minute::text AS filed FROM world_research_reports r WHERE r.world_id=$1 AND r.status='published' ORDER BY r.id DESC`,
    citations: `SELECT c.report_id::int AS report,c.ref_kind,c.ref_id::text AS ref,c.field,c.cited_value,c.actual_value,c.status FROM world_research_citations c JOIN world_research_reports r ON r.world_id=c.world_id AND r.id=c.report_id AND r.status='published' WHERE c.world_id=$1 ORDER BY c.id DESC`,
    verifications: `SELECT v.report_id::int AS report,v.verifier_agent_id::text AS agent,v.kind,v.status,v.isolation,v.requested_world_minute::text AS at FROM world_research_verifications v WHERE v.world_id=$1 ORDER BY v.id DESC`,
    adoptions: `SELECT a.report_id::int AS report,a.adopter_agent_id::text AS agent,a.plan_id,a.step_id,a.action,a.event_id::text AS event,a.world_minute::text AS at FROM world_research_adoptions a WHERE a.world_id=$1 ORDER BY a.id DESC`
  };
  const rows = await db.query(`${queries[type]} LIMIT ${size + 1} OFFSET ${offset}`, [worldId]);
  const items = rows.rows.slice(0, size).map((row) => {
    const out = { ...row };
    if (row.agent) { out.resident = labelOf(names, row.agent, row.non_independent); delete out.agent; delete out.non_independent; }
    if (row.budget) { out.budgetSync = rawToSync(row.budget); delete out.budget; }
    if (row.amount) { out.amountSync = rawToSync(row.amount); delete out.amount; }
    if (row.id !== undefined && type === 'reports') { out.ref = `R${row.id}`; delete out.id; }
    if (row.report !== undefined) out.report = `R${row.report}`;
    return out;
  });
  return { type, page: Math.max(1, Math.trunc(page)), pageSize: size, hasMore: rows.rows.length > size, items };
}
export async function readCitationGraph(db, { worldId, limit = 60 }) {
  const edges = await db.query(`SELECT c.report_id::int AS source,c.ref_id::int AS target FROM world_research_citations c
    JOIN world_research_reports r ON r.world_id=c.world_id AND r.id=c.report_id AND r.status='published'
    WHERE c.world_id=$1 AND c.ref_kind='report' AND c.status='verified' ORDER BY c.id DESC LIMIT $2`, [worldId, limit]);
  const adopt = await db.query(`SELECT report_id::int AS report,count(*)::int AS n FROM world_research_adoptions WHERE world_id=$1 GROUP BY report_id`, [worldId]);
  const nodes = new Set();
  for (const edge of edges.rows) { nodes.add(edge.source); nodes.add(edge.target); }
  return { nodes: [...nodes].map((id) => ({ ref: `R${id}`, adoptions: adopt.rows.find((row) => row.report === id)?.n || 0 })),
    edges: edges.rows.map((edge) => ({ from: `R${edge.source}`, to: `R${edge.target}` })) };
}
