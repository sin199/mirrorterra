// council3: the council thinks with Luna. At each council session every resident makes a real Luna
// (open cognition LLM, gpt-6-luna through the existing B.AI provider path, budget gateway, rate limits
// and json hint) call to decide whether to propose and what (bounded levers only) and, in a second
// call, how to vote on every open proposal, each with a short reason. MirrorTerra-01 commissions
// public works through Luna, and residents bid on them through Luna. The deterministic fallback is
// used ONLY when a Luna call fails, times out or returns unusable output; every decision records its
// source (llm or fallback) in world_council_deliberations.
//
// Why the earlier open-cognition path never chose council actions (prod: 0 of 40 votes, 0 of 4
// proposals): council_vote/council_propose were only extra entries in a resident's advertised
// affordances. A resident's LLM plan steps are natural-language intents ("study at the library") that
// the grounding call maps onto ONE affordance matching that intent; the planner was never asked a
// council question, an affordance change does not wake cognition (only material changes do), and a
// proposal is open for ~5 real minutes per world day (10:00-15:00, 1 world minute = 1 real second)
// before the 13:00 fallback voted for everyone. So no plan ever grounded onto a council action. This
// module asks the council question directly, once per resident per session, outside the world tick.
import { createCognitionModelRouter, configuredCognitionCatalog, DEFAULT_OPEN_COGNITION_MODEL }
  from './agent-runtime/open-cognition/provider.js';
import { createModelAbRouting } from './agent-runtime/open-cognition/model-ab.js';
import { worldCalendar } from './world-environment.js';
import { computeDrives } from './world-skill-library.js';
import { COUNCIL_GOVERNOR_ID, COUNCIL_SESSION_CLOSE_HOUR, castCouncilVote, councilProposalOptions,
  createCouncilProposal, deterministicStance, formatLeverValue, formatSyncAmount, leverLabel, proposalOnCooldown,
  readEconomyStats, readProposalCooldowns } from './council.js';
import { GUIDANCE_MODES, LEVER_BOUNDS, LEVER_KEYS, MINUTES_PER_WORLD_DAY, SYNC_RAW_PER_SYNC, councilEnabled, defaultLeverValue,
  leverValueValid, readCouncilPolicies, readTreasuryBalance, readTreasuryEscrow, worldDayOf } from './treasury.js';
import { qianmenCouncilEnabled } from './gambit-flags.js';
import { patternIndex, selectScenePatterns, validPatternIds } from './agent-runtime/qianmen-scenes.js';
import { personalLeverImpact } from './council-stakes.js';
import { gambitsReady, insertClaims, parseClaim } from './world-gambits.js';
import { RESEARCH_LEVER, callCapRaw, monthPaidRaw, monthlyCapRaw, openCallCount, rawToSync, researchCallFromTarget, researchReady }
  from './world-research.js';
import { researchCouncilEnabled, researchNumber } from './research-flags.js';
import { MAX_ACTIVE_CONTRACTS, NOT_CAPACITY_SKIP, NO_BUILDER_CAPACITY, PUBLIC_WORKS_GOVERNOR_ID, PUBLIC_WORK_CATALOG, buildingSpec,
  bidSkill, builderCapacity, commissionCapacity, commissionPublicWork, fallbackCommission, recordNoCapacitySkip, heuristicBid,
  placePublicWorkBid, publicWorksReady, readCompletedPublicWorks, readPublicWorks,
  readPublicWorksNeeds, recordDeliberation } from './public-works.js';

export const PROPOSE_START_HOUR = 9;      // Luna proposal calls 09:00-11:00 (world time)
export const PROPOSE_DEADLINE_HOUR = 11;  // after this the in-tick fallback may propose (only if no Luna round ran)
export const VOTE_DEADLINE_HOUR = 14;     // Luna votes until 14:00; then the in-tick fallback fills missing votes
export const COMMISSION_COOLDOWN_MINUTES = 120;
export const LUNA_TIMEOUT_MS = 30_000;
export const LUNA_MAX_TOKENS = 700;
export const DELIBERATION_TRIGGER = 'council_deliberation';

const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
const shortText = (value, max = 200) => String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const sync = (raw) => Number(big(raw)) / 1e6;
const round2 = (value) => Math.round(Number(value) * 100) / 100;
function invalid(code) { return Object.assign(new Error(code), { code }); }

// ---- levers as Luna sees them -----------------------------------------------------------------------
// council4: 87 proposals failed LUNA_TARGET_OUT_OF_BOUNDS on 2026-10-20. Luna now sees each lever's exact
// allowed range and its current value in the same unit it must answer in, and near-miss answers are
// clamped into range (boundedValueFromTarget) instead of rejected.
export function leverRange(lever) {
  if (lever.startsWith('tax.')) return { unit: 'percent', min: LEVER_BOUNDS.tax.min / 100, max: LEVER_BOUNDS.tax.max / 100 };
  if (lever.startsWith('multiplier.')) return { unit: 'multiplier', min: LEVER_BOUNDS.multiplier.min / 1000, max: 1 };
  if (lever.startsWith('price.')) return { unit: 'multiplier', min: LEVER_BOUNDS.price.min / 1000, max: LEVER_BOUNDS.price.max / 1000 };
  if (lever.startsWith('good.')) return { unit: 'SYNC', min: Number(LEVER_BOUNDS.good.min) / 1e6, max: Number(LEVER_BOUNDS.good.max) / 1e6 };
  return { unit: 'mode', options: GUIDANCE_MODES.filter((mode) => ['balanced','public_works','save'].includes(mode)) };
}
export function leverTargetOf(lever, value) {
  const current = value || defaultLeverValue(lever);
  if (lever.startsWith('tax.')) return Number(current?.bps || 0) / 100;
  if (lever.startsWith('multiplier.') || lever.startsWith('price.')) return Number(current?.milli || 1000) / 1000;
  if (lever.startsWith('good.')) return current?.offered === false ? null : Number(current?.priceRaw || 0) / 1e6;
  return current?.mode || 'balanced';
}
export function leverChoices(policies = {}, blocked = new Set()) {
  return LEVER_KEYS.filter((lever) => !blocked.has(lever)).map((lever) => {
    const current = formatLeverValue(lever, policies[lever]);
    const range = leverRange(lever);
    const target = lever.startsWith('tax.') ? `percent ${range.min}-${range.max}`
      : lever.startsWith('multiplier.') ? `multiplier ${range.min}-${range.max} (above 1 is not allowed: the treasury pays no bonuses)`
        : lever.startsWith('price.') ? `multiplier ${range.min}-${range.max}`
          : lever.startsWith('good.') ? `SYNC price ${range.min}-${range.max}, or null to stop offering it (goods are bought from the treasury)`
            : '"balanced", "public_works" or "save" (save = commission only what the treasury can pay twice over)';
    return { lever, label: leverLabel(lever), current, currentTarget: leverTargetOf(lever, policies[lever]),
      allowedRange: range.unit === 'mode' ? range.options : [range.min, range.max], unit: range.unit, target };
  });
}

// Pure: Luna's "target" for a lever -> the bounded stored value (or null when out of bounds).
export function valueFromTarget(lever, target) {
  if (!LEVER_KEYS.includes(lever)) return null;
  let value = null;
  if (lever.startsWith('tax.')) value = { bps: Math.round(Number(target) * 100) };
  else if (lever.startsWith('multiplier.')) {
    const milli = Math.round(Number(target) * 1000);
    value = milli > 1000 ? null : { milli };
  } else if (lever.startsWith('price.')) value = { milli: Math.round(Number(target) * 1000) };
  else if (lever.startsWith('good.')) {
    if (target === null || target === false || /^(null|none|not offered|stop|no)$/i.test(String(target).trim())) value = { offered: false };
    else {
      const raw = BigInt(Math.round(Number(target) * 100)) * 10_000n;
      value = raw > 0n ? { priceRaw: raw.toString() } : null;
    }
  } else if (lever === 'treasury.guidance') {
    const mode = String(target || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    value = GUIDANCE_MODES.includes(mode) ? { mode } : null;
  }
  return value && leverValueValid(lever, value) ? value : null;
}

// Pure: like valueFromTarget, but a near miss (a finite number within 2x of the nearest bound) is
// clamped into the allowed range. Returns { value, clamped } or null (not a number, far out of range,
// unknown mode). A multiplier above 1 clamps to 1 (no treasury bonus).
export function boundedValueFromTarget(lever, target) {
  const exact = valueFromTarget(lever, target);
  if (exact) return { value: exact, clamped: false };
  const range = leverRange(lever);
  if (range.unit === 'mode' || target === null || target === undefined || target === '') return null;
  const number = Number(typeof target === 'string' ? target.replace(/[%x×\s]|sync/gi, '') : target);
  if (!Number.isFinite(number) || number <= 0 && range.min > 0) return null;
  if (number > range.max * 2 || (range.min > 0 && number < range.min / 2)) return null;
  const clampedTarget = Math.min(range.max, Math.max(range.min, number));
  const value = valueFromTarget(lever, clampedTarget);
  return value ? { value, clamped: clampedTarget !== number } : null;
}

// ---- context ---------------------------------------------------------------------------------------
export function economyContext({ stats, policies, treasuryRaw = 0n, escrowRaw = 0n, openProposals = [], decisions = [],
  works = [], completed = [], needs = [], deliberationTotals = null }) {
  const income = big(stats?.incomeTotalRaw);
  return {
    lastWorldDay: {
      incomeBySource: Object.fromEntries(Object.entries(stats?.incomeBySourceRaw || {}).map(([key, value]) => [key,
        `${formatSyncAmount(value)}${income > 0n ? ` (${Math.round(Number(big(value) * 1000n / income) / 10)}%)` : ''}`])),
      incomeTotal: formatSyncAmount(stats?.incomeTotalRaw), spending: formatSyncAmount(stats?.spendingTotalRaw),
      taxesCollected: formatSyncAmount(stats?.taxesCollectedRaw), treasurySpent: formatSyncAmount(stats?.treasurySpentRaw),
      skillOutputsByDrive: stats?.outputsByDrive || {}
    },
    balances: { median: formatSyncAmount(stats?.medianBalanceRaw), richest: formatSyncAmount(stats?.maxBalanceRaw),
      allResidents: formatSyncAmount(stats?.totalBalanceRaw) },
    treasury: { balance: formatSyncAmount(treasuryRaw), reservedForConstruction: formatSyncAmount(escrowRaw),
      free: formatSyncAmount(big(treasuryRaw) > big(escrowRaw) ? big(treasuryRaw) - big(escrowRaw) : 0n),
      rule: 'The treasury never hands out money. It only pays residents who build public works, per construction milestone. Its only income is council taxes and purchases of council-approved goods. When it is near zero nothing gets built until taxes or goods sales bring revenue.' },
    policies: Object.fromEntries(LEVER_KEYS.filter((lever) => lever.startsWith('tax.') || lever.startsWith('good.')
      || JSON.stringify(policies?.[lever]) !== JSON.stringify(lever === 'treasury.guidance' ? { mode: 'balanced' } : { milli: 1000 }))
      .map((lever) => [leverLabel(lever), formatLeverValue(lever, policies?.[lever])])),
    openProposals: openProposals.map((proposal, index) => ({ id: `P${index + 1}`, title: proposal.title, reason: proposal.reason,
      votesSoFar: (proposal.voters || []).length })),
    recentDecisions: decisions.slice(0, 4).map((row) => ({ title: row.title, outcome: row.status, yes: row.yes_count, no: row.no_count })),
    publicWorks: {
      underWay: works.map((work) => ({ name: work.name, kind: work.kind, status: work.status, price: formatSyncAmount(work.price_raw),
        builder: work.builder_name || null, progress: `${work.progress}%`, bids: work.bid_count })),
      built: completed.map((work) => ({ name: work.name, kind: work.kind, level: work.level })),
      worldNeeds: needs.slice(0, 5).map((need) => ({ project: need.name, kind: need.kind, price: formatSyncAmount(need.baseRaw),
        effect: need.effect }))
    },
    ...(deliberationTotals ? { councilMinds: deliberationTotals } : {})
  };
}

export function residentContext(resident, { skills = {}, busyBuilding = null } = {}) {
  const drives = computeDrives(resident.state || {});
  const topDrives = Object.entries(drives).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
  return { name: resident.name, balance: formatSyncAmount(resident.balanceRaw), incomeLastWorldDay: formatSyncAmount(resident.incomeRaw),
    incomeBySource: Object.fromEntries(Object.entries(resident.incomeBySourceRaw || {}).map(([key, value]) => [key, formatSyncAmount(value)])),
    ownsBusinesses: resident.ownedServiceTypes || [], strongestDrives: topDrives,
    skills: Object.fromEntries(Object.entries(skills).map(([key, value]) => [key, Math.round(Number(value) || 0)])),
    needs: { energy: resident.state?.energy, food: resident.state?.food, social: resident.state?.social, fun: resident.state?.fun },
    goal: resident.state?.goal || 'balanced', ...(busyBuilding ? { currentlyBuilding: busyBuilding } : {}) };
}

const SYSTEM = (name) => `You are ${name}, a resident of MirrorTerra and one of the ten members of its economic council at the Central Bank. Think for yourself, from your own situation and from the town's economy. The treasury never hands out money: it only pays residents for building public works (roads, parks, a market hall, a clinic, a school, bridges, expansions), per construction milestone. Its only income is council taxes and purchases of council-approved goods. Quorum is 6 of 10, a simple majority passes, a passed change starts the next world day. Keep every reason short, concrete and in your own voice. Respond with one json object only.`;

// gambit1 P1 (MIRRORTERRA_QIANMEN_COUNCIL): the Qianmen tools block added to a council call. Without it
// (switch off) every message below is byte-for-byte the modelab1 message.
export function qianmenToolsFor(scene, seed) {
  const pick = selectScenePatterns({ scene, seed, limit: 4 });
  return { note: 'In-world thinking tools (千门108局). Use any pattern by id; you may bluff, make claims, and say something different from what you do. Other residents can check claims and react.',
    candidates: pick.candidates.map((item) => ({ id: item.id, name: item.name, nameEn: item.nameEn, play: item.play, counters: item.counters })),
    all108: patternIndex() };
}
const QIANMEN_ANSWER = { patternIds: ['QM### you used (optional, up to 6)'], publicLine: 'optional: what you say publicly (max 200 chars)' };

// research1 (MIRRORTERRA_RESEARCH_COUNCIL): the research-call option added to the proposal call. Without it (switch
// off, a call already open, or the lever busy) the message is byte-for-byte the pre-research1 message.
const RESEARCH_ANSWER_NOTE = 'or, for lever "research.call", target = {"topic": "...", "brief": "the question", "budgetSync": number, "horizonDays": 1-30}';
export function proposeMessages({ resident, context, levers, suggestions, cooldowns = [], qianmen = null, research = null }) {
  if (research) {
    const messages = proposeMessages({ resident, context, levers, suggestions, cooldowns, qianmen });
    const body = JSON.parse(messages[1].content);
    body.researchCall = research;
    body.answerJsonSchema = { ...body.answerJsonSchema, lever: `${body.answerJsonSchema.lever}, or "research.call"`,
      target: `${body.answerJsonSchema.target}; ${RESEARCH_ANSWER_NOTE}` };
    return [messages[0], { role: 'user', content: JSON.stringify(body) }];
  }
  return [{ role: 'system', content: SYSTEM(resident.name) }, { role: 'user', content: JSON.stringify({
    task: 'Council session (proposals). Decide whether YOU want to propose one change to a council lever today, and which. Proposing is optional: say no if nothing should change or another open proposal already covers it. Consider that public works only get built when the treasury has revenue. The target MUST be inside that lever\'s allowedRange, in its unit (currentTarget is today\'s value in the same unit) and different from currentTarget. Do not repeat a change the council recently rejected (onCooldown).',
    you: resident, economy: context, availableLevers: levers,
    onCooldown: cooldowns.map((cooldown) => ({ lever: cooldown.lever, label: leverLabel(cooldown.lever),
      rejectedChange: cooldown.direction === 1 ? 'raise' : cooldown.direction === -1 ? 'lower' : `set to ${formatLeverValue(cooldown.lever, cooldown.value)}`,
      rejections: cooldown.rejections, untilWorldDay: cooldown.untilWorldDay })),
    dataDrivenSuggestions: suggestions.map((option) => ({ lever: option.lever, change: `${leverLabel(option.lever)} → ${formatLeverValue(option.lever, option.value)}`, why: option.reason,
      ...(qianmen ? { yourStake: option.yourStake } : {}) })),
    ...(qianmen ? { qianmen } : {}),
    answerJsonSchema: { propose: 'true|false', lever: 'one availableLevers.lever or null', target: 'a number (or mode) inside that lever\'s allowedRange, in its unit, or null', reason: 'one short sentence (max 160 chars)',
      ...(qianmen ? QIANMEN_ANSWER : {}) }
  }) }];
}

export function voteMessages({ resident, context, proposals, stakes = null, qianmen = null }) {
  return [{ role: 'system', content: SYSTEM(resident.name) }, { role: 'user', content: JSON.stringify({
    task: 'Council session (votes). Vote yes or no on EVERY open proposal below, each with your own short reason.',
    you: resident, economy: context,
    proposals: proposals.map((proposal, index) => ({ id: `P${index + 1}`, title: proposal.title, proposerReason: proposal.reason,
      ...(stakes ? { yourStake: stakes[index] || null } : {}) })),
    ...(qianmen ? { qianmen } : {}),
    answerJsonSchema: { votes: [{ id: 'P1', stance: 'yes|no', reason: 'one short sentence (max 160 chars)', ...(qianmen ? { patternIds: ['QM###'] } : {}) }] }
  }) }];
}

export function commissionMessages({ governor, context, needs, freeRaw, guidance }) {
  return [{ role: 'system', content: `${SYSTEM(governor.name)} You are also the governor of the Central Bank: you commission public works for the town.` },
    { role: 'user', content: JSON.stringify({
      task: 'Decide whether to commission ONE public work now from what the town lacks, and at what price. The whole price is reserved from the treasury\'s free balance now and paid to the winning builder per milestone (25/50/75/100%). Residents bid; the lowest credible bid (adjusted for skill) wins and must build it with work sessions at the site. You may wait for more revenue. Only the listed projects can be commissioned: each one is backed by measured resident demand (see why: visits vs capacity, homeless residents, trips); a building that residents do not use is never listed.',
      governor: governor, economy: context, treasuryFree: formatSyncAmount(freeRaw), guidance,
      projects: needs.map((need) => ({ project: need.projectKey, name: need.name, kind: need.kind, why: need.reason, effect: need.effect,
        priceRangeSync: [round2(sync(need.minRaw)), round2(sync(need.maxRaw))], suggestedPriceSync: round2(sync(need.baseRaw)),
        affordable: big(need.minRaw) <= big(freeRaw) })),
      answerJsonSchema: { commission: 'true|false', project: 'one projects.project or null', priceSync: 'number within its priceRangeSync and at most treasuryFree', reason: 'one short sentence (max 160 chars)' }
    }) }];
}

export function bidMessages({ resident, context, work, skillValue, busy, sessionsEstimate, buildSkills = null, qianmen = null, rivals = null }) {
  // skillwork: with library scoring the tender explains the real skill rule (O*NET construction/repair
  // skill levels) and the fairness rule, and shows the resident's own relevant skills.
  const skillRule = buildSkills
    ? `adjusted for your real construction/repair skills (your O*NET skill-library levels in building, repairing, inspecting and similar work: buildSkillScore 0-100; recent winners in this category and residents already holding a contract are ranked lower so work spreads)`
    : `adjusted for skill (more ${work.required_skill} skill counts in your favour)`;
  const lowSkill = buildSkills ? 'with no construction/repair skill at all' : `with almost no ${work.required_skill} skill`;
  return [{ role: 'system', content: SYSTEM(resident.name) }, { role: 'user', content: JSON.stringify({
    task: `Public works tender: ${work.name}. Decide whether to bid to build it and your price. You would have to walk to the site and do about ${sessionsEstimate} construction work sessions; you are paid 25% of your price at each milestone. The lowest credible bid wins, ${skillRule}. Bids below 40% of the price, by a resident without building capacity (already ${MAX_ACTIVE_CONTRACTS} contracts, an idle contract, or a contract not yet started), or ${lowSkill} are not credible. A contract you leave idle is warned and then given to another bidder.`,
    you: resident, economy: context,
    tender: { name: work.name, kind: work.kind, effect: (work.work_type === 'repair' ? 'Repair: restores the building to full condition.' : null)
      || buildingSpec(work.building_type || work.kind)?.effect || PUBLIC_WORK_CATALOG[work.kind]?.effect, maxPriceSync: round2(sync(work.price_raw)),
      requiredSkill: work.required_skill, yourSkill: Math.round(skillValue), youAreBusyBuilding: busy, bidsSoFar: work.bid_count,
      ...(buildSkills ? { workType: work.work_type || null, yourBuildSkillScore: Math.round(skillValue), yourBuildSkills: buildSkills } : {}) },
    ...(qianmen ? { qianmen, rivalsSaidPublicly: rivals || [] } : {}),
    answerJsonSchema: { bid: 'true|false', priceSync: 'number up to maxPriceSync', reason: 'one short sentence (max 160 chars)',
      ...(qianmen ? { ...QIANMEN_ANSWER, claims: [{ fact: 'build_skill|active_contracts|wins_count|balance|private', value: 'what you claim (true or not); others may check it' }] } : {}) }
  }) }];
}

// ---- parsers (pure) ---------------------------------------------------------------------------------
const truthy = (value) => value === true || /^(true|yes|y|1)$/i.test(String(value ?? '').trim());
export function parseProposal(output, { blocked = new Set(), policies = null, cooldowns = [], research = null } = {}) {
  if (!output || typeof output !== 'object') throw invalid('LUNA_OUTPUT_INVALID');
  const reason = shortText(output.reason, 200);
  if (!truthy(output.propose)) return { propose: false, reason: reason || 'No change needed today.' };
  const lever = String(output.lever || '').trim();
  if (lever === RESEARCH_LEVER) {
    if (!research) throw invalid('LUNA_LEVER_INVALID');
    const value = researchCallFromTarget(output.target ?? output.value ?? null, { capRaw: research.capRaw, defaultHorizon: research.defaultHorizon });
    if (!value) throw invalid('LUNA_TARGET_OUT_OF_BOUNDS');
    if (reason.length < 3) throw invalid('LUNA_REASON_MISSING');
    return { propose: true, lever, value, reason };
  }
  if (!LEVER_KEYS.includes(lever)) throw invalid('LUNA_LEVER_INVALID');
  if (blocked.has(lever)) throw invalid('LUNA_LEVER_BUSY');
  const bounded = boundedValueFromTarget(lever, output.target ?? output.value ?? null);
  if (!bounded) throw invalid('LUNA_TARGET_OUT_OF_BOUNDS');
  const { value } = bounded;
  if (reason.length < 3) throw invalid('LUNA_REASON_MISSING');
  if (policies) {
    const previous = policies[lever] || defaultLeverValue(lever);
    if (JSON.stringify(previous) === JSON.stringify(value)) throw invalid('LUNA_TARGET_NO_CHANGE');
    if (proposalOnCooldown({ lever, previous, value }, cooldowns)) throw invalid('LUNA_PROPOSAL_COOLDOWN');
  }
  return { propose: true, lever, value, reason, ...(bounded.clamped ? { clamped: true } : {}) };
}

export function parseVotes(output, proposals = []) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.votes)) throw invalid('LUNA_OUTPUT_INVALID');
  const result = new Map();
  for (const vote of output.votes) {
    const index = Number(String(vote?.id || '').replace(/^P/i, '')) - 1;
    const proposal = proposals[index];
    const stance = String(vote?.stance || '').trim().toLowerCase();
    const reason = shortText(vote?.reason, 200);
    if (!proposal || !['yes','no'].includes(stance) || reason.length < 3 || result.has(proposal.id)) continue;
    result.set(proposal.id, { stance, reason });
  }
  return result;
}

export function parseCommission(output, needs = [], freeRaw = 0n) {
  if (!output || typeof output !== 'object') throw invalid('LUNA_OUTPUT_INVALID');
  const reason = shortText(output.reason, 200);
  if (!truthy(output.commission)) return { commission: false, reason: reason || 'Waiting for more revenue.' };
  const need = needs.find((item) => item.projectKey === String(output.project || '').trim());
  if (!need) throw invalid('LUNA_PROJECT_INVALID');
  const raw = BigInt(Math.max(0, Math.round(Number(output.priceSync) * 100))) * 10_000n;
  if (raw <= 0n) throw invalid('LUNA_PRICE_INVALID');
  if (raw < big(need.minRaw) || raw > big(need.maxRaw)) throw invalid('LUNA_PRICE_OUT_OF_RANGE');
  if (raw > big(freeRaw)) throw invalid('LUNA_PRICE_UNFUNDED');
  return { commission: true, projectKey: need.projectKey, priceRaw: raw, reason: reason.length >= 3 ? reason : need.reason };
}

export function parseBid(output, work) {
  if (!output || typeof output !== 'object') throw invalid('LUNA_OUTPUT_INVALID');
  const reason = shortText(output.reason, 200);
  if (!truthy(output.bid)) return { bid: false, reason: reason || 'Not bidding.' };
  const raw = BigInt(Math.max(0, Math.round(Number(output.priceSync) * 100))) * 10_000n;
  if (raw <= 0n) throw invalid('LUNA_PRICE_INVALID');
  return { bid: true, bidRaw: raw > big(work.price_raw) ? big(work.price_raw) : raw, reason: reason.length >= 3 ? reason : 'My bid.' };
}

// ---- one Luna call --------------------------------------------------------------------------------
export async function callLuna(requestModel, { messages, agentId, phase, timeoutMs = LUNA_TIMEOUT_MS, now = () => Date.now() }) {
  const started = now();
  try {
    const completion = await requestModel({ tier: 'routine', messages, maxTokens: LUNA_MAX_TOKENS, timeoutMs,
      trigger: DELIBERATION_TRIGGER, callContext: { agentId, goalId: `council:${phase}` } });
    return { ok: true, output: completion.output, latencyMs: now() - started, callId: completion.callId || null,
      model: completion.requestedModel || completion.model || null, abCohort: completion.abCohort || null,
      fallbackFrom: completion.fallbackFrom || null };
  } catch (error) {
    return { ok: false, failureCode: String(error?.code || error?.message || 'LUNA_CALL_FAILED').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80),
      latencyMs: now() - started };
  }
}

// modelab1: which model wrote a council decision, stored in the existing decision jsonb (no schema change).
// Only added when the A/B test assigned the call, so non-test decisions keep their exact old shape.
export function modelTag(call) {
  if (!call?.ok || !call.abCohort) return {};
  return { model: call.model, abCohort: call.abCohort, ...(call.fallbackFrom ? { modelFallbackFrom: call.fallbackFrom } : {}) };
}

// ---- state readers ----------------------------------------------------------------------------------
async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '20s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function readOpenProposalRows(db, worldId) {
  const rows = await db.query(`SELECT proposal.id::text AS id,proposal.lever_key,proposal.title,proposal.reason,
      proposal.previous_value,proposal.proposed_value,proposal.closes_world_minute::text AS closes_world_minute,
      COALESCE((SELECT jsonb_agg(vote.agent_id::text) FROM world_council_votes vote
        WHERE vote.world_id=proposal.world_id AND vote.proposal_id=proposal.id),'[]'::jsonb) AS voters
    FROM world_council_proposals proposal WHERE proposal.world_id=$1 AND proposal.status='open'
    ORDER BY proposal.opened_world_minute,proposal.id`, [worldId]);
  return rows.rows.map((row) => ({ ...row, closesWorldMinute: Number(row.closes_world_minute),
    voters: Array.isArray(row.voters) ? row.voters : [] }));
}

async function readBlocked(db, { worldId, worldDay }) {
  const result = await db.query(`SELECT lever_key FROM world_council_proposals WHERE world_id=$1 AND status='open'
    UNION SELECT lever_key FROM world_council_policy_history WHERE world_id=$1 AND action='enacted' AND effective_world_day>=$2`,
  [worldId, worldDay + 1]);
  return new Set(result.rows.map((row) => row.lever_key));
}

async function readSkills(db, { worldId, agentId }) {
  const rows = await db.query(`SELECT skill_name,skill_value::float8 AS value FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agentId]);
  return Object.fromEntries(rows.rows.map((row) => [row.skill_name, Number(row.value) || 0]));
}

// Shared economy snapshot, cached per world hour (the stats query reads a world day of rewards).
function createSnapshotCache() {
  let cached = null;
  return async function snapshot(pool, { worldId, worldMinutes, force = false }) {
    const hour = Math.floor(worldMinutes / 60);
    if (!force && cached && cached.hour === hour) return cached.value;
    const stats = await readEconomyStats(pool, { worldId });
    const policies = await readCouncilPolicies(pool, { worldId, worldDay: worldDayOf(worldMinutes) });
    cached = { hour, value: { stats, policies } };
    return cached.value;
  };
}

async function contextFor(pool, { worldId, worldMinutes, stats, policies }) {
  const [treasuryRaw, escrowRaw, openProposals, decisions, works, completed, needs] = [
    await readTreasuryBalance(pool, worldId), await readTreasuryEscrow(pool, worldId), await readOpenProposalRows(pool, worldId),
    (await pool.query(`SELECT title,status,yes_count,no_count FROM world_council_proposals WHERE world_id=$1 AND status<>'open'
      ORDER BY decided_world_minute DESC NULLS LAST,id LIMIT 4`, [worldId])).rows,
    await readPublicWorks(pool, { worldId }), await readCompletedPublicWorks(pool, { worldId }),
    await readPublicWorksNeeds(pool, { worldId, stats })];
  return { treasuryRaw, escrowRaw, openProposals, needs,
    context: economyContext({ stats, policies, treasuryRaw, escrowRaw, openProposals, decisions, works, completed, needs }), works };
}

const councilHourOf = (worldMinutes) => worldCalendar(Math.trunc(worldMinutes)).hour;
const todaysCloseMinute = (worldMinutes) => worldDayOf(worldMinutes) * MINUTES_PER_WORLD_DAY + COUNCIL_SESSION_CLOSE_HOUR * 60;

function designatedProposer(residents, worldDay) {
  const members = residents.map((resident) => resident.agentId);
  if (worldDay % 2 === 0 && members.includes(COUNCIL_GOVERNOR_ID)) return COUNCIL_GOVERNOR_ID;
  const others = members.filter((id) => id !== COUNCIL_GOVERNOR_ID);
  return (others.length ? others : members)[Math.floor(worldDay / 2) % Math.max(1, others.length || members.length)];
}

// ---- the deliberation step (one decision per call) ------------------------------------------------
// Picks the most urgent pending decision (votes > proposals > bids > commission), makes one Luna call
// outside any transaction, then writes the result (or the fallback) in a short transaction.
export async function councilDeliberationStep(pool, { worldId, requestModel, env = process.env, snapshot,
  timeoutMs = LUNA_TIMEOUT_MS, now = () => Date.now() }) {
  if (!councilEnabled(env) || String(env?.MIRRORTERRA_COUNCIL_LUNA ?? 'on').toLowerCase() === 'off') return null;
  if (!await publicWorksReady(pool)) return null;
  const worldMinutes = Number((await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]))
    .rows[0]?.world_minutes) || 0;
  const day = worldDayOf(worldMinutes);
  const hour = councilHourOf(worldMinutes);
  const { stats, policies } = await snapshot(pool, { worldId, worldMinutes });
  // external1: Luna decides only for the original residents. External residents decide through their own
  // AI over the signed API (src/external-api.js); silent ones get the safe in-tick fallback (abstain/none).
  const residents = stats.councilResidents || (stats.residents || []).filter((resident) => !resident.external);
  if (!residents.length) return null;
  const proposeDone = new Set((await pool.query(`SELECT DISTINCT agent_id::text AS agent_id FROM world_council_deliberations
    WHERE world_id=$1 AND world_day=$2 AND phase='propose'`, [worldId, day])).rows.map((row) => row.agent_id));

  // 1. Votes on proposals closing today (until 14:00; also as soon as everyone has proposed).
  const everyoneProposed = residents.every((resident) => proposeDone.has(resident.agentId));
  if (hour < VOTE_DEADLINE_HOUR && (hour >= PROPOSE_DEADLINE_HOUR || (hour >= PROPOSE_START_HOUR && everyoneProposed))) {
    const open = (await readOpenProposalRows(pool, worldId)).filter((proposal) => proposal.closesWorldMinute <= todaysCloseMinute(worldMinutes));
    for (const resident of residents) {
      const pending = open.filter((proposal) => !proposal.voters.includes(resident.agentId));
      if (pending.length) return deliberateVotes(pool, { worldId, requestModel, resident, proposals: pending, stats, policies,
        worldMinutes, timeoutMs, now, env });
    }
  }
  // 2. Proposals (09:00-11:00): each resident decides once per world day.
  if (hour >= PROPOSE_START_HOUR && hour < PROPOSE_DEADLINE_HOUR) {
    const resident = residents.find((item) => !proposeDone.has(item.agentId));
    if (resident) return deliberateProposal(pool, { worldId, requestModel, resident, stats, policies, worldMinutes, timeoutMs, now,
      designated: designatedProposer(residents, day) === resident.agentId, residents, env });
  }
  // 3. Bids on open tenders.
  for (const work of await readPublicWorks(pool, { worldId, statuses: ['bidding'] })) {
    if (Number(work.bidding_closes_world_minute) <= worldMinutes + 2) continue;
    const decided = new Set((await pool.query(`SELECT agent_id::text AS id FROM world_public_work_bids WHERE work_id=$1
      UNION SELECT agent_id::text FROM world_council_deliberations WHERE world_id=$2 AND phase='bid' AND work_id=$1`,
    [work.id, worldId])).rows.map((row) => row.id));
    const resident = residents.find((item) => item.agentId !== PUBLIC_WORKS_GOVERNOR_ID && !decided.has(item.agentId));
    if (resident) return deliberateBid(pool, { worldId, requestModel, resident, work, stats, policies, worldMinutes, timeoutMs, now, env });
  }
  // 4. Commission (01), when nothing is out to tender and the free balance can pay a needed project.
  if (String(env?.MIRRORTERRA_PUBLIC_WORKS ?? 'on').toLowerCase() !== 'off') {
    // growth1: an open repair tender does not block a demand-gated build/expansion commission.
    const bidding = await pool.query(`SELECT 1 FROM world_public_works work LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
      WHERE work.world_id=$1 AND work.status='bidding' AND COALESCE(meta.work_type,'build')<>'repair' LIMIT 1`, [worldId]);
    const recent = await pool.query(`SELECT 1 FROM world_council_deliberations WHERE world_id=$1 AND phase='commission'
      AND world_minute > $2 AND ${NOT_CAPACITY_SKIP} LIMIT 1`, [worldId, worldMinutes - COMMISSION_COOLDOWN_MINUTES]);
    if (!bidding.rowCount && !recent.rowCount) {
      const free = (await readTreasuryBalance(pool, worldId)) - (await readTreasuryEscrow(pool, worldId));
      const needs = await readPublicWorksNeeds(pool, { worldId, stats });
      const reserve = policies['treasury.guidance']?.mode === 'save' ? 2n : 1n;
      if (needs.some((need) => big(need.minRaw) * reserve <= free)) {
        // No Luna call when no builder could take the contract: the tender would only be cancelled.
        const capacity = commissionCapacity(residents, await readPublicWorks(pool, { worldId, statuses: ['building'] }), worldMinutes);
        if (!capacity.hasCapacity) {
          const recorded = await inTransaction(pool, (client) => recordNoCapacitySkip(client, { worldId, worldMinutes,
            agentId: COUNCIL_GOVERNOR_ID, capacity, origin: 'luna' }));
          return recorded ? { phase: 'commission', source: 'fallback', failureCode: NO_BUILDER_CAPACITY, skipped: true,
            eligible: capacity.eligible, commissioned: null } : null;
        }
        return deliberateCommission(pool, { worldId, requestModel, stats, policies, worldMinutes, timeoutMs, now,
          needs, freeRaw: free > 0n ? free : 0n, reserve });
      }
    }
  }
  return null;
}

// research1: offered only when the research council switch is on, the tables exist, no call is open and the lever
// is free. Suggested topics come from the engine's latest day statistics (residents choose the topic themselves).
export async function researchOption(pool, { worldId, blocked = new Set(), env = process.env }) {
  if (!researchCouncilEnabled(env) || blocked.has(RESEARCH_LEVER) || !await researchReady(pool)) return null;
  if (await openCallCount(pool, worldId) > 0) return null;
  const capRaw = callCapRaw(env);
  const remaining = monthlyCapRaw(env) - await monthPaidRaw(pool, worldId);
  if (remaining <= 0n) return null;
  const stats = await pool.query(`SELECT kind,subject,stats,world_day FROM world_research_day_stats WHERE world_id=$1
    AND world_day=(SELECT max(world_day) FROM world_research_day_stats WHERE world_id=$1) ORDER BY kind,(stats->>'peakHour')::numeric DESC NULLS LAST LIMIT 4`, [worldId]);
  const topics = [];
  const busiest = stats.rows.find((row) => row.kind === 'place');
  const food = stats.rows.find((row) => row.kind === 'food');
  if (busiest) topics.push(`公共设施拥挤 / crowding: ${busiest.subject} peaked at ${busiest.stats.peakHour} actions in one hour (world day ${busiest.world_day})`);
  if (food) topics.push(`餐饮供给 / food supply: ${food.stats.meals} meals, ${food.stats.lowFoodReadings} low-food readings, stock ${food.stats.stockAtClose} (world day ${food.world_day})`);
  return { capRaw, defaultHorizon: Math.round(researchNumber('MIRRORTERRA_RESEARCH_DEFAULT_HORIZON_DAYS', env)),
    prompt: { note: 'You may instead propose a research call (研究征集): the council funds residents to study a question with the town\'s data. Grants are drawn from the SYNC Operating Pool as ledger entitlements; residents earn only by building the world. Proposers pay a small fee; three judges score proposals; reports must cite engine evidence. Only one call is open at a time.',
      budgetCapSync: rawToSync(capRaw), researchBudgetLeftThisMonthSync: rawToSync(remaining < capRaw ? remaining : capRaw),
      suggestedTopics: topics, howTo: 'lever "research.call", target {"topic","brief","budgetSync","horizonDays"}' } };
}

async function deliberateProposal(pool, { worldId, requestModel, resident, stats, policies, worldMinutes, timeoutMs, now,
  designated, env = process.env }) {
  const p1 = qianmenCouncilEnabled(env);
  const day = worldDayOf(worldMinutes);
  const blocked = await readBlocked(pool, { worldId, worldDay: day });
  const { context } = await contextFor(pool, { worldId, worldMinutes, stats, policies });
  const skills = await readSkills(pool, { worldId, agentId: resident.agentId });
  const cooldowns = await readProposalCooldowns(pool, { worldId, worldDay: day });
  const options = councilProposalOptions({ stats, policies, blockedLevers: blocked, limit: 4, cooldowns });
  const suggestions = p1 ? options.map((option) => ({ ...option, yourStake: personalLeverImpact(resident, { lever_key: option.lever,
    previous_value: policies[option.lever] || defaultLeverValue(option.lever), proposed_value: option.value }, stats) })) : options;
  const research = await researchOption(pool, { worldId, blocked, env }).catch(() => null);
  const call = await callLuna(requestModel, { messages: proposeMessages({ resident: residentContext(resident, { skills }), context,
    levers: leverChoices(policies, blocked), suggestions, cooldowns, qianmen: p1 ? qianmenToolsFor('council_vote', `${resident.agentId}:${day}:propose`) : null,
    research: research ? research.prompt : null }),
  agentId: resident.agentId, phase: 'propose', timeoutMs, now });
  let decision = null, failureCode = call.ok ? null : call.failureCode;
  if (call.ok) {
    try { decision = parseProposal(call.output, { blocked, policies, cooldowns, research }); } catch (error) { failureCode = error.code; }
  }
  return inTransaction(pool, async (client) => {
    const minute = Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || worldMinutes;
    if (decision) {
      let proposal = null, error = null;
      if (decision.propose) {
        proposal = await createCouncilProposal(client, { worldId, proposerAgentId: resident.agentId, lever: decision.lever,
          value: decision.value, reason: decision.reason, source: 'cognition', worldMinutes: minute }).catch((err) => { error = err.code || err.message; return null; });
      }
      await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'propose', agentId: resident.agentId, source: 'llm',
        latencyMs: call.latencyMs, failureCode: error, proposalId: proposal?.proposalId || null,
        decision: { propose: decision.propose, lever: decision.lever || null, value: decision.value || null, created: Boolean(proposal),
          ...(decision.clamped ? { clamped: true } : {}), ...modelTag(call), ...(p1 ? qianmenTag(call.output) : {}) },
        reason: decision.reason });
      return { phase: 'propose', agentId: resident.agentId, source: 'llm', latencyMs: call.latencyMs, propose: decision.propose,
        lever: decision.lever || null, title: proposal?.title || null, reason: decision.reason, error };
    }
    // Fallback (Luna failed): the day's designated proposer proposes the heuristic's best option; others pass.
    let proposal = null;
    if (designated) {
      const opened = await client.query(`SELECT count(*)::int AS n FROM world_council_proposals WHERE world_id=$1 AND opened_world_day=$2`,
        [worldId, day]);
      const [option] = councilProposalOptions({ stats, policies, blockedLevers: await readBlocked(client, { worldId, worldDay: day }), limit: 1,
        cooldowns: await readProposalCooldowns(client, { worldId, worldDay: day }) });
      if (option && !Number(opened.rows[0].n)) {
        proposal = await createCouncilProposal(client, { worldId, proposerAgentId: resident.agentId, lever: option.lever,
          value: option.value, reason: option.reason, source: 'session_fallback', worldMinutes: minute }).catch(() => null);
      }
    }
    await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'propose', agentId: resident.agentId, source: 'fallback',
      latencyMs: call.latencyMs, failureCode, proposalId: proposal?.proposalId || null,
      decision: { propose: Boolean(proposal), lever: proposal?.lever || null, designated,
        ...(call.ok && call.output && typeof call.output === 'object' ? { lunaLever: shortText(call.output.lever, 60) || null,
          lunaTarget: shortText(JSON.stringify(call.output.target ?? null), 40) } : {}), ...modelTag(call) },
      reason: proposal?.reason || 'Fallback: no proposal.' });
    return { phase: 'propose', agentId: resident.agentId, source: 'fallback', failureCode, latencyMs: call.latencyMs,
      propose: Boolean(proposal), title: proposal?.title || null };
  });
}

async function deliberateVotes(pool, { worldId, requestModel, resident, proposals, stats, policies, worldMinutes, timeoutMs, now, env = process.env }) {
  const p1 = qianmenCouncilEnabled(env);
  const { context } = await contextFor(pool, { worldId, worldMinutes, stats, policies });
  const skills = await readSkills(pool, { worldId, agentId: resident.agentId });
  const call = await callLuna(requestModel, { messages: voteMessages({ resident: residentContext(resident, { skills }), context, proposals,
    ...(p1 ? { stakes: proposals.map((proposal) => personalLeverImpact(resident, proposal, stats)),
      qianmen: qianmenToolsFor('council_vote', `${resident.agentId}:${worldDayOf(worldMinutes)}:vote`) } : {}) }),
  agentId: resident.agentId, phase: 'vote', timeoutMs, now });
  let votes = new Map(), failureCode = call.ok ? null : call.failureCode;
  if (call.ok) {
    try { votes = parseVotes(call.output, proposals); } catch (error) { failureCode = error.code; }
  }
  return inTransaction(pool, async (client) => {
    const minute = Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || worldMinutes;
    const cast = [];
    for (const proposal of proposals) {
      const llm = votes.get(proposal.id);
      const fallback = llm ? null : deterministicStance({ proposal, resident, stats });
      const choice = llm || fallback;
      const result = await castCouncilVote(client, { worldId, proposalId: proposal.id, agentId: resident.agentId, stance: choice.stance,
        reason: choice.reason, source: llm ? 'cognition' : 'session_fallback', worldMinutes: minute }).catch(() => null);
      if (!result || result.duplicate) continue; // closed meanwhile, or the 14:00 fallback already voted
      await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'vote', agentId: resident.agentId,
        source: llm ? 'llm' : 'fallback', latencyMs: call.latencyMs, failureCode: llm ? null : (failureCode || 'LUNA_VOTE_MISSING'),
        proposalId: proposal.id, decision: { stance: choice.stance, ...modelTag(call),
          ...(p1 && llm ? qianmenTag((call.output?.votes || []).find((vote) => Number(String(vote?.id || '').replace(/^P/i, '')) - 1 === proposals.indexOf(proposal))) : {}) },
        reason: choice.reason });
      cast.push({ title: proposal.title, stance: choice.stance, reason: choice.reason, source: llm ? 'llm' : 'fallback' });
    }
    return { phase: 'vote', agentId: resident.agentId, source: call.ok && !failureCode ? 'llm' : 'fallback', failureCode,
      latencyMs: call.latencyMs, votes: cast };
  });
}

async function deliberateBid(pool, { worldId, requestModel, resident, work, stats, policies, worldMinutes, timeoutMs, now, env = process.env }) {
  const { context } = await contextFor(pool, { worldId, worldMinutes, stats, policies });
  const skills = await readSkills(pool, { worldId, agentId: resident.agentId });
  const legacySkill = Number(skills[work.required_skill]) || 0;
  // skillwork (fix 2): the LLM sees, and the heuristic fallback uses, the same library-based score.
  const judged = await bidSkill(pool, { worldId, agentId: resident.agentId, work, env, inTransaction: false });
  const skillValue = judged.skillValue;
  const buildSkills = judged.scored ? judged.scored.top.slice(0, 4).map((skill) => `${skill.name || skill.skillId} L${skill.level}`) : null;
  const building = await readPublicWorks(pool, { worldId, statuses: ['building'] });
  const held = building.filter((item) => item.builder_agent_id === resident.agentId);
  const busyRow = { rows: held.map((item) => ({ name: item.name })) };
  const busy = !builderCapacity(resident.agentId, building, worldMinutes).hasCapacity;
  const sessionsEstimate = Math.ceil(100 / (12 + Math.floor(legacySkill / 10)));
  const p1 = qianmenCouncilEnabled(env);
  const claimsReady = p1 && await gambitsReady(pool);
  const rivals = p1 ? await readTenderRivals(pool, { worldId, workId: work.id, claimsReady }) : null;
  const call = await callLuna(requestModel, { messages: bidMessages({ resident: residentContext(resident, { skills,
    busyBuilding: busyRow.rows[0]?.name || null }), context, work, skillValue, busy, sessionsEstimate, buildSkills,
  ...(p1 ? { qianmen: qianmenToolsFor('tender_bid', `${resident.agentId}:${work.id}`), rivals } : {}) }),
  agentId: resident.agentId, phase: 'bid', timeoutMs, now });
  let decision = null, failureCode = call.ok ? null : call.failureCode;
  if (call.ok) {
    try { decision = parseBid(call.output, work); } catch (error) { failureCode = error.code; }
  }
  return inTransaction(pool, async (client) => {
    const minute = Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || worldMinutes;
    let placed = null, error = null;
    const source = decision ? 'llm' : 'fallback';
    const bidRaw = decision?.bid ? decision.bidRaw : decision ? null
      : heuristicBid({ agentId: resident.agentId, priceRaw: work.price_raw, skillValue, balanceRaw: resident.balanceRaw,
        medianBalanceRaw: stats.medianBalanceRaw, workKey: work.project_key });
    const reason = decision ? decision.reason : buildSkills
      ? `Heuristic bid: build skill ${Math.round(skillValue)} (${buildSkills.slice(0, 2).join(', ') || 'no construction skills yet'}).`.slice(0, 240)
      : `Heuristic bid: skill ${Math.round(skillValue)} in ${work.required_skill}.`;
    if (bidRaw) placed = await placePublicWorkBid(client, { worldId, workId: work.id, agentId: resident.agentId, bidRaw, reason,
      source: decision ? 'llm' : 'heuristic', worldMinutes: minute, env }).catch((err) => { error = err.code || err.message; return null; });
    let claimIds = [];
    if (p1 && decision && claimsReady) {
      const claims = bidClaims(call.output, resident.agentId);
      if (claims.length) claimIds = await insertClaims(client, { worldId, contextRef: `tender:${work.id}`, claims, worldMinutes: minute });
    }
    await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'bid', agentId: resident.agentId, source,
      latencyMs: call.latencyMs, failureCode: failureCode || error, workId: work.id,
      decision: { bid: Boolean(placed), bidRaw: placed?.bidRaw || null, credible: placed?.credible ?? null, ...modelTag(call),
        ...(p1 && decision ? { ...qianmenTag(call.output), ...(claimIds.length ? { claimIds } : {}) } : {}) }, reason });
    return { phase: 'bid', agentId: resident.agentId, work: work.name, source, failureCode: failureCode || error, latencyMs: call.latencyMs,
      bid: placed ? { bidRaw: placed.bidRaw, credible: placed.credible } : null, reason };
  });
}

async function deliberateCommission(pool, { worldId, requestModel, stats, policies, worldMinutes, timeoutMs, now, needs, freeRaw, reserve }) {
  const governor = stats.residents.find((resident) => resident.agentId === COUNCIL_GOVERNOR_ID) || { name: 'MirrorTerra-01', agentId: COUNCIL_GOVERNOR_ID };
  const { context } = await contextFor(pool, { worldId, worldMinutes, stats, policies });
  const spendable = freeRaw / reserve;
  const call = await callLuna(requestModel, { messages: commissionMessages({ governor: residentContext(governor), context, needs,
    freeRaw: spendable, guidance: policies['treasury.guidance']?.mode || 'balanced' }),
  agentId: COUNCIL_GOVERNOR_ID, phase: 'commission', timeoutMs, now });
  let decision = null, failureCode = call.ok ? null : call.failureCode;
  if (call.ok) {
    try { decision = parseCommission(call.output, needs, spendable); } catch (error) { failureCode = error.code; }
  }
  return inTransaction(pool, async (client) => {
    const minute = Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || worldMinutes;
    let commissioned = null, error = null;
    const pick = decision ? (decision.commission ? decision : null) : fallbackCommission({ needs, freeRaw: spendable });
    if (pick) commissioned = await commissionPublicWork(client, { worldId, worldMinutes: minute, projectKey: pick.projectKey,
      priceRaw: pick.priceRaw, reason: pick.reason, source: decision ? 'governor_llm' : 'governor_fallback', stats })
      .catch((err) => { error = err.code || err.message; return null; });
    await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'commission', agentId: COUNCIL_GOVERNOR_ID,
      source: decision ? 'llm' : 'fallback', latencyMs: call.latencyMs, failureCode: failureCode || error,
      workId: commissioned?.workId || null, decision: { commission: Boolean(commissioned), projectKey: pick?.projectKey || null,
        priceRaw: commissioned?.priceRaw || null, ...modelTag(call) }, reason: decision?.reason || pick?.reason || 'Fallback: nothing affordable.' });
    return { phase: 'commission', source: decision ? 'llm' : 'fallback', failureCode: failureCode || error, latencyMs: call.latencyMs,
      commissioned: commissioned ? { name: commissioned.name, priceRaw: commissioned.priceRaw } : null,
      reason: decision?.reason || pick?.reason || null };
  });
}

// gambit1 P1 helpers (only used when MIRRORTERRA_QIANMEN_COUNCIL is on).
export function qianmenTag(output) {
  if (!output || typeof output !== 'object') return {};
  const patternIds = validPatternIds(output.patternIds ?? output.patterns ?? []);
  const publicLine = shortText(output.publicLine, 240);
  return patternIds.length || publicLine ? { qianmen: { patternIds, ...(publicLine ? { publicLine } : {}) } } : {};
}

const NO_REFS = { residents: new Map(), byId: new Map(), tenders: new Map(), proposals: new Map(), outputs: new Map(),
  capabilities: new Map(), contracts: new Map(), claims: new Map() };
export function bidClaims(output, agentId) {
  const claims = [];
  for (const item of Array.isArray(output?.claims) ? output.claims.slice(0, 4) : []) {
    if (!['build_skill', 'active_contracts', 'wins_count', 'balance', 'private'].includes(String(item?.fact || '').toLowerCase())) continue;
    try { claims.push(parseClaim({ ...item, subject: null }, { refs: NO_REFS, agentId })); } catch { /* malformed claim: dropped */ }
  }
  return claims;
}

async function readTenderRivals(pool, { worldId, workId, claimsReady }) {
  const lines = await pool.query(`SELECT a.name,d.decision->'qianmen'->>'publicLine' AS line FROM world_council_deliberations d
    JOIN agents a ON a.id=d.agent_id WHERE d.world_id=$1 AND d.work_id=$2 AND d.phase='bid' AND d.decision->'qianmen'->>'publicLine' IS NOT NULL
    ORDER BY d.world_minute LIMIT 9`, [worldId, workId]);
  const claims = claimsReady ? await pool.query(`SELECT a.name,c.fact_key,c.claimed_value,c.verification FROM world_gambit_claims c
    JOIN agents a ON a.id=c.agent_id WHERE c.world_id=$1 AND c.context_ref=$2 ORDER BY c.id LIMIT 12`, [worldId, `tender:${workId}`]) : { rows: [] };
  const byName = new Map();
  for (const row of lines.rows) byName.set(row.name, { resident: row.name, said: row.line, claims: [] });
  for (const row of claims.rows) {
    const entry = byName.get(row.name) || { resident: row.name, claims: [] };
    entry.claims.push({ fact: row.fact_key, claimed: row.claimed_value, checked: row.verification });
    byName.set(row.name, entry);
  }
  return [...byName.values()];
}

// ---- worker -----------------------------------------------------------------------------------------
export function createCouncilModelRouter({ apiKey, budgetGateway, worldId, fetchImpl = fetch,
  model = process.env.OPEN_COGNITION_MODEL || DEFAULT_OPEN_COGNITION_MODEL, modelAb = undefined }) {
  const catalog = configuredCognitionCatalog(model);
  if (!catalog) throw invalid('COUNCIL_LUNA_REQUIRES_LUNA_MODEL');
  // modelab1: the same per-resident cohort model as open cognition (kill switch MIRRORTERRA_MODEL_AB).
  return createCognitionModelRouter({ apiKey, catalog, fetchImpl, worldId, budgetGateway,
    modelAb: modelAb === undefined ? createModelAbRouting() : modelAb });
}

export function startCouncilDeliberationWorker(pool, { worldId, apiKey = process.env.BAI_API_KEY, budgetGateway = null,
  isOwner = () => true, onError = () => {}, onDecision = () => {}, intervalMs = 3_000, fetchImpl = fetch, env = process.env,
  model = process.env.OPEN_COGNITION_MODEL || DEFAULT_OPEN_COGNITION_MODEL } = {}) {
  if (!worldId || !apiKey || !budgetGateway) return { running: false, reason: 'world_provider_or_gateway_missing', stop: async () => {},
    getStatus: () => ({ running: false }) };
  let requestModel;
  try { requestModel = createCouncilModelRouter({ apiKey, budgetGateway, worldId, fetchImpl, model }); }
  catch (error) { return { running: false, reason: error.code || 'router_failed', stop: async () => {}, getStatus: () => ({ running: false }) }; }
  const snapshot = createSnapshotCache();
  let stopped = false, timer = null, inFlight = null;
  const counts = { llm: 0, fallback: 0, errors: 0, last: null };
  const schedule = (ms) => { if (!stopped) timer = setTimeout(cycle, ms); };
  async function cycle() {
    if (stopped) return;
    if (!isOwner()) return schedule(intervalMs);
    inFlight = councilDeliberationStep(pool, { worldId, requestModel, env, snapshot })
      .then((result) => {
        if (result) {
          counts[result.source === 'llm' ? 'llm' : 'fallback'] += 1;
          counts.last = { phase: result.phase, source: result.source, at: new Date().toISOString() };
          onDecision(result);
        }
        return result;
      })
      .catch((error) => { counts.errors += 1; onError(error); return null; });
    const result = await inFlight;
    inFlight = null;
    schedule(result ? 250 : intervalMs);
  }
  schedule(1_000);
  return { running: true, async stop() { stopped = true; clearTimeout(timer); await inFlight; },
    getStatus: () => ({ running: !stopped, ...counts }) };
}

export const LUNA_BUDGET = Object.freeze({
  // Per world day: 10 proposal calls + 10 vote calls (one call votes on every open proposal) + one
  // commission decision per affordable window (cooldown 2 world hours) + 9 bid calls per tender.
  proposeCallsPerWorldDay: 10, voteCallsPerWorldDay: 10, bidCallsPerTender: 9,
  worldDaysPerRealDay: 60 // one world minute is one real second
});
export { SYNC_RAW_PER_SYNC };
