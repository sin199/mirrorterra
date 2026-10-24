// MirrorTerra resident economic council (internal ledger only).
// Ten residents decide bounded economic levers: taxes (0-30%), reward weight multipliers per
// source (0.25-3x), base service prices (0.5-2x), purchasable goods/sinks (0.1-20 SYNC) and the
// treasury's spending guidance. Quorum is 6 of 10 votes, a simple majority passes, a passed change
// applies from the NEXT world day, at most one change per lever per world day, and every proposal
// and vote stores the resident's short reason.
//
// council3: every resident thinks with Luna. src/council-deliberation.js (outside the world tick)
// makes one Luna call per resident at 09:00-11:00 (propose or not, and what) and one at 11:00-14:00
// (votes on every open proposal), each with a short reason. The in-tick session below is ONLY the
// safety net, driven by the engine's world-hour boundary (runCouncilHourSafely):
//   11:00  if no Luna proposal round ran today and nothing is open, the day's proposer proposes the
//          heuristic's best option (source session_fallback);
//   14:00  every resident Luna did not vote for gets a deterministic vote (source session_fallback);
//   15:00  proposals closing today are tallied: >=6 votes and yes>no passes, else rejected.
//   every hour: taxes, goods/levies, owner price competition, and public works (the treasury's ONLY
//          outflow: milestone payments to builders; see src/public-works.js).
//
// Taxes are collected every world hour (income tax on newly accrued rewards, sales tax on internal
// purchases, remitted by the seller) and daily (idle-balance tax). Every tax is capped by the payer's
// balance and is a balanced treasury entry; the DB trigger independently refuses any overdraft.
// Kill switch: MIRRORTERRA_COUNCIL=off stops sessions, taxes, sinks, treasury spending and the
// council affordances (existing rows are kept and displayed).
import { createHash } from 'node:crypto';
import { worldCalendar } from './world-environment.js';
import { SKILL_DRIVES, computeDrives } from './world-skill-library.js';
import { SYNC_GENESIS_ISSUER_AGENT_ID } from './arc/sync-tokenomics.js';
import { currentResidentDisplayName } from './public-display.js';
import { quoteSyncInternalServicePrice } from './world-businesses.js';
import { GOODS, GUIDANCE_MODES, LEVER_BOUNDS, LEVER_KEYS, MINUTES_PER_WORLD_DAY, REWARD_SOURCE_TYPES,
  SERVICE_TYPES, SYNC_RAW_PER_SYNC, TREASURY_DISCRETIONARY_KINDS, councilEnabled, defaultLeverValue,
  leverValueValid, postTreasuryEntry, readCouncilPolicies, taxDue, treasuryTablesReady, wealthTaxDue,
  worldDayOf } from './treasury.js';
import { publicWorksReady, readPublicWorks, readPublicWorksSummary, recordDeliberation, runPublicWorksHour } from './public-works.js';
import { councilQuorum, externalConfig, readExternalResidents } from './external-residents.js';
import { NO_CALL_VALUE, RESEARCH_LEVER, callCapRaw, createResearchCallFromProposal, monthPaidRaw, monthlyCapRaw, openCallCount,
  researchCallStance, researchCallTitle, researchCallValueValid } from './world-research.js';
import { researchCouncilEnabled } from './research-flags.js';

export const COUNCIL_GOVERNOR_ID = SYNC_GENESIS_ISSUER_AGENT_ID;
export const COUNCIL_SIZE = 10;
export const COUNCIL_QUORUM = 6;
export const COUNCIL_SESSION_OPEN_HOUR = 10;
export const COUNCIL_SESSION_VOTE_HOUR = 13;
export const COUNCIL_SESSION_CLOSE_HOUR = 15;
export const COUNCIL_ACTIONS = Object.freeze(['council_propose','council_vote','treasury_spend','business_sync_price']);
export const SUBSIDY_BALANCE_FLOOR_RAW = 1n * SYNC_RAW_PER_SYNC;
export const GOODS_AFFORD_MULTIPLE = 20n;
const STATS_WINDOW_SECONDS = 1_440; // one world day: one world minute is one real second

const LEVER_LABELS = Object.freeze({
  'tax.sales': 'Sales tax', 'tax.income': 'Income tax on rewards', 'tax.wealth': 'Idle-balance tax (monthly)',
  'multiplier.research_project': 'Research reward weight', 'multiplier.shared_project_cooperation': 'Shared project reward weight',
  'multiplier.business_production': 'Business production reward weight', 'multiplier.skill_output': 'Skill output reward weight',
  'price.food_service': 'Food service price', 'price.social_service': 'Social service price',
  'price.trading_service': 'Trading service price', 'price.research_service': 'Research service price',
  'price.engineering_service': 'Engineering service price',
  'good.house_upgrade': 'House upgrade', 'good.tools': 'Tools', 'good.tuition': 'Tuition', 'good.land_rent': 'Land rent (daily)',
  'treasury.guidance': 'Treasury spending guidance'
});
const SOURCE_LABELS = Object.freeze({ research_project: 'research', shared_project_cooperation: 'shared projects',
  business_production: 'business production', skill_output: 'skill outputs' });
const GUIDANCE_LABELS = Object.freeze({ balanced: 'balanced', bounties_first: 'bounties first',
  subsidies_first: 'subsidies first', public_works: 'public works', save: 'save' });

function coded(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }
const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
const maxZero = (value) => (value > 0n ? value : 0n);
const unit = (value) => createHash('sha256').update(String(value)).digest().readUInt32BE(0) / 0xffffffff;
const shortText = (value, max = 240) => String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function leverLabel(lever) { return LEVER_LABELS[lever] || String(lever); }

export function formatSyncAmount(raw) {
  const value = big(raw);
  const whole = value / SYNC_RAW_PER_SYNC;
  const fraction = (value % SYNC_RAW_PER_SYNC).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction.slice(0, 2)}` : ''} SYNC`;
}

export function formatLeverValue(lever, value) {
  if (!value) return '—';
  if (lever.startsWith('tax.')) return `${(Number(value.bps) || 0) / 100}%`;
  if (lever.startsWith('multiplier.') || lever.startsWith('price.')) return `${(Number(value.milli) || 0) / 1000}×`;
  if (lever.startsWith('good.')) return value.offered === false ? 'not offered' : formatSyncAmount(value.priceRaw);
  if (lever === 'treasury.guidance') return GUIDANCE_LABELS[value.mode] || String(value.mode);
  return JSON.stringify(value);
}

export function proposalTitle(lever, from, to) {
  return `${leverLabel(lever)}: ${formatLeverValue(lever, from)} → ${formatLeverValue(lever, to)}`.slice(0, 160);
}

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const valueKey = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

// Pure: data-driven proposal options, best first. Each is { lever, value, reason } within bounds,
// different from the current value, and on a lever that is neither open nor already changed today.
// ---- proposal cooldown (council4) ----------------------------------------------------------------
// Prod 2026-10-20: the fallback proposed "Research reward weight 0.5x -> 0.25x" 7 times and lost all 7.
// A rejected (or vetoed) proposal puts the same lever in the same direction (or the identical value)
// on cooldown for 2 world days per similar rejection in the last 10 days (max 10). Applies to Luna and
// to both fallbacks (createCouncilProposal refuses it with COUNCIL_PROPOSAL_COOLDOWN).
export const PROPOSAL_COOLDOWN_DAYS_PER_REJECTION = 2;
export const PROPOSAL_COOLDOWN_MAX_DAYS = 10;
export const PROPOSAL_COOLDOWN_LOOKBACK_DAYS = 10;
export function leverNumeric(lever, value) {
  if (!value || typeof value !== 'object') return null;
  if (lever.startsWith('tax.')) return Number(value.bps);
  if (lever.startsWith('multiplier.') || lever.startsWith('price.')) return Number(value.milli);
  if (lever.startsWith('good.')) return value.offered === false ? 0 : Number(value.priceRaw);
  return null;
}
export function proposalDirection(lever, previous, value) {
  const from = leverNumeric(lever, previous ?? defaultLeverValue(lever)), to = leverNumeric(lever, value);
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return sameValue(previous, value) ? 0 : 'set';
  return Math.sign(to - from);
}
// Pure: rejected rows [{ lever_key, previous_value, proposed_value, opened_world_day }] -> active cooldowns.
export function proposalCooldowns(rejected = [], worldDay = 0) {
  const groups = new Map();
  for (const row of rejected) {
    const lever = row.lever_key || row.lever;
    const direction = proposalDirection(lever, row.previous_value, row.proposed_value);
    const key = `${lever}|${direction === 'set' ? JSON.stringify(row.proposed_value) : direction}`;
    const day = Number(row.opened_world_day) || 0;
    if (day < worldDay - PROPOSAL_COOLDOWN_LOOKBACK_DAYS) continue;
    const group = groups.get(key) || { lever, direction, value: row.proposed_value, rejections: 0, lastDay: -1 };
    group.rejections += 1;
    group.lastDay = Math.max(group.lastDay, day);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group,
    untilWorldDay: group.lastDay + Math.min(PROPOSAL_COOLDOWN_MAX_DAYS, PROPOSAL_COOLDOWN_DAYS_PER_REJECTION * group.rejections) }))
    .filter((group) => group.untilWorldDay >= worldDay);
}
export function proposalOnCooldown({ lever, previous, value }, cooldowns = []) {
  const direction = proposalDirection(lever, previous, value);
  return cooldowns.find((cooldown) => cooldown.lever === lever && (direction === 'set'
    ? sameValue(cooldown.value, value) : cooldown.direction === direction || sameValue(cooldown.value, value))) || null;
}
export async function readProposalCooldowns(client, { worldId, worldDay }) {
  const rows = await client.query(`SELECT lever_key,previous_value,proposed_value,opened_world_day FROM world_council_proposals
    WHERE world_id=$1 AND status IN ('rejected','vetoed') AND opened_world_day>=$2`,
  [worldId, Number(worldDay) - PROPOSAL_COOLDOWN_LOOKBACK_DAYS]);
  return proposalCooldowns(rows.rows, Number(worldDay));
}

export function councilProposalOptions({ stats, policies, blockedLevers = new Set(), limit = 4, cooldowns = [] }) {
  // Order: data-driven signals first, then general options; blocked levers are skipped.
  const income = big(stats?.incomeTotalRaw);
  const spending = big(stats?.spendingTotalRaw);
  const options = [];
  const push = (lever, value, reason) => {
    if (blockedLevers.has(lever) || !leverValueValid(lever, value) || sameValue(policies?.[lever], value)) return;
    if (proposalOnCooldown({ lever, previous: policies?.[lever], value }, cooldowns)) return;
    if (options.some((option) => option.lever === lever)) return;
    options.push({ lever, value, reason: shortText(reason, 240) });
  };
  if (income > 0n) {
    const shares = REWARD_SOURCE_TYPES.map((source) => ({ source,
      share: Number(big(stats.incomeBySourceRaw?.[source]) * 1000n / income) / 10 }))
      .sort((left, right) => right.share - left.share);
    const top = shares[0];
    if (top && top.share > 70) {
      const current = Number(policies?.[`multiplier.${top.source}`]?.milli ?? 1000);
      push(`multiplier.${top.source}`, { milli: Math.max(LEVER_BOUNDS.multiplier.min, current - 250) },
        `${SOURCE_LABELS[top.source]} brought ${Math.round(top.share)}% of all income in the last day; a lower weight spreads rewards to other work.`);
    }
    const spendShare = Number(spending * 1000n / income) / 10;
    if (spendShare < 20) {
      const goodsOffered = GOODS.some((good) => policies?.[`good.${good}`]?.offered !== false);
      if (!goodsOffered) {
        const price = stats?.medianBalanceRaw && big(stats.medianBalanceRaw) > 0n
          ? big(stats.medianBalanceRaw) / 100n : SYNC_RAW_PER_SYNC;
        const bounded = price < LEVER_BOUNDS.good.min ? LEVER_BOUNDS.good.min
          : price > 5n * SYNC_RAW_PER_SYNC ? 5n * SYNC_RAW_PER_SYNC : price / 100_000n * 100_000n;
        push('good.tools', { priceRaw: bounded.toString() },
          `Residents spent only ${Math.round(spendShare)}% of what they earned; offering tools gives SYNC a use.`);
      }
      const sales = Number(policies?.['tax.sales']?.bps ?? 0);
      push('tax.sales', { bps: Math.min(LEVER_BOUNDS.tax.max, sales + 300) },
        `Spending is ${Math.round(spendShare)}% of income; a small sales tax funds public works from trade.`);
    }
  }
  const treasury = big(stats?.treasuryBalanceRaw);
  const incomeTax = Number(policies?.['tax.income']?.bps ?? 0);
  if (treasury === 0n && incomeTax === 0) push('tax.income', { bps: 500 },
    'The treasury is empty; a 5% income tax on rewards lets it pay residents to build public works.');
  const median = big(stats?.medianBalanceRaw), richest = big(stats?.maxBalanceRaw);
  const wealth = Number(policies?.['tax.wealth']?.bps ?? 0);
  if (median > 0n && richest > median * 5n && wealth < 500) push('tax.wealth', { bps: wealth + 200 },
    'The richest balance is more than five times the median; a small idle-balance tax recycles it.');
  // Lower-priority general options, so the session can rotate when the data gives few signals.
  if (!GOODS.some((good) => policies?.[`good.${good}`]?.offered !== false)) push('good.tools', { priceRaw: '1000000' },
    'No goods are on offer; tools at 1 SYNC would give residents something to buy and fund the treasury.');
  push('tax.sales', { bps: Math.min(LEVER_BOUNDS.tax.max, Number(policies?.['tax.sales']?.bps ?? 0) + 300) },
    'A small sales tax would fund the treasury from trade.');
  push('tax.wealth', { bps: Math.min(LEVER_BOUNDS.tax.max, wealth + 200) },
    'A small idle-balance tax recycles savings above 50 SYNC into the treasury.');
  const mode = policies?.['treasury.guidance']?.mode || 'balanced';
  push('treasury.guidance', { mode: mode === 'save' ? 'balanced' : 'save' },
    mode === 'save' ? 'The reserve has had its turn; build again with every SYNC the treasury can pay.'
      : 'Keep a reserve: commission only public works the treasury can pay twice over.');
  push('tax.income', { bps: Math.min(LEVER_BOUNDS.tax.max, incomeTax + 100) },
    'A slightly higher income tax gives the treasury more to pay builders of public works.');
  return options.slice(0, Math.max(1, limit));
}

// Pure: a resident's deterministic vote from their drives, balance and income mix.
export function deterministicStance({ proposal, resident, stats }) {
  const lever = proposal.lever_key || proposal.lever;
  const from = proposal.previous_value || proposal.previousValue || defaultLeverValue(lever);
  const to = proposal.proposed_value || proposal.proposedValue || proposal.value;
  const drives = resident.drives || computeDrives(resident.state || {});
  const balance = big(resident.balanceRaw);
  const median = big(stats?.medianBalanceRaw);
  const poor = median > 0n ? balance * 2n < median : balance < SUBSIDY_BALANCE_FLOOR_RAW;
  const wealthy = median > 0n && balance > median;
  const goal = resident.state?.goal || resident.goal || 'balanced';
  let score = 0;
  let why = '';
  if (lever.startsWith('tax.')) {
    const up = Number(to?.bps ?? 0) > Number(from?.bps ?? 0) ? 1 : -1;
    score += up * ((poor ? 1 : wealthy ? -1 : 0) + (drives.contribution - drives.security)
      + (goal === 'community' ? 0.5 : goal === 'wealth' ? -0.5 : 0));
    why = poor ? (up > 0 ? 'My balance is low; taxes fund the subsidies and bounties I can earn.'
      : 'My balance is low; I want the treasury to keep paying.')
      : wealthy ? (up > 0 ? 'I hold more than most; I would pay most of this tax.' : 'I hold more than most; lower taxes keep my savings.')
        : drives.contribution > drives.security ? 'A funded treasury helps the whole town.' : 'I would rather keep my own SYNC.';
  } else if (lever.startsWith('multiplier.')) {
    const source = lever.slice('multiplier.'.length);
    const income = big(resident.incomeRaw);
    const share = income > 0n ? Number(big(resident.incomeBySourceRaw?.[source]) * 100n / income) / 100 : 0;
    const up = Number(to?.milli ?? 1000) > Number(from?.milli ?? 1000) ? 1 : -1;
    score += up * ((share - 0.5) * 2) + (up < 0 ? drives.contribution * 0.3 : 0);
    why = share >= 0.5 ? `Most of my income comes from ${SOURCE_LABELS[source]}; ${up > 0 ? 'a higher weight helps me' : 'a lower weight hurts me'}.`
      : `Little of my income comes from ${SOURCE_LABELS[source]}; ${up > 0 ? 'this mostly helps others' : 'spreading rewards seems fair'}.`;
  } else if (lever.startsWith('price.')) {
    const service = lever.slice('price.'.length);
    const owns = (resident.ownedServiceTypes || []).includes(service);
    const up = Number(to?.milli ?? 1000) > Number(from?.milli ?? 1000) ? 1 : -1;
    score += up * (owns ? 1.5 : -0.5 - drives.security * 0.5);
    why = owns ? (up > 0 ? 'I run this kind of business; a better price helps it survive.' : 'I run this kind of business; a lower price hurts it.')
      : up > 0 ? 'I buy this service; I would pay more.' : 'I buy this service; cheaper is better for me.';
  } else if (lever.startsWith('good.')) {
    const offering = to?.offered !== false;
    const price = offering ? big(to?.priceRaw) : 0n;
    const affordable = offering && balance >= price * GOODS_AFFORD_MULTIPLE;
    score += (offering ? 1 : -1) * ((affordable ? 0.6 : -0.3) + drives.creation * 0.5 + drives.esteem * 0.3 - drives.security * 0.4);
    why = offering ? (affordable ? 'I can afford it and it gives my SYNC a use.' : 'It is too expensive for me right now.')
      : 'Removing it saves residents money.';
  } else if (lever === 'treasury.guidance') {
    const mode = to?.mode || 'balanced';
    score += mode === 'bounties_first' ? drives.mastery + drives.curiosity - 0.6
      : mode === 'subsidies_first' ? (poor ? 1 : -0.3) + drives.belonging - 0.4
        : mode === 'save' ? drives.security - 0.5
          : mode === 'public_works' ? drives.contribution - 0.3 : 0.1;
    why = mode === 'bounties_first' ? 'Paying for neglected work makes sense to me.'
      : mode === 'subsidies_first' ? (poor ? 'Subsidies would help me directly.' : 'Subsidies help a few, not the town.')
        : mode === 'save' ? 'Saving keeps the treasury safe.' : 'A balanced treasury is fine with me.';
  }
  score += (unit(`${resident.agentId}:${proposal.id || lever}`) - 0.5) * 0.4;
  const stance = score >= 0 ? 'yes' : 'no';
  return { stance, reason: shortText(why || (stance === 'yes' ? 'This seems fair to me.' : 'I am not convinced.'), 200),
    score: Math.round(score * 1000) / 1000 };
}

// Pure: tally rule.
export function tallyOutcome({ yes, no, abstain = 0, quorum = COUNCIL_QUORUM, size = COUNCIL_SIZE }) {
  const votes = Number(yes) + Number(no) + Number(abstain || 0);
  if (votes < quorum) return { status: 'rejected', reason: `No quorum: ${votes} of ${size} members took part (needs ${quorum}).` };
  if (Number(yes) > Number(no)) return { status: 'passed', reason: `Passed ${yes}–${no}.` };
  return { status: 'rejected', reason: `Rejected ${yes}–${no}.` };
}

// external1: council membership is dynamic: every original resident plus each external resident who is
// eligible (N world days of residence AND >= M real contributions). Quorum = ceil(quorumBps x members),
// i.e. the old 6 of 10 at 60%. A silent eligible external ABSTAINS (recorded); an abstention counts toward
// quorum (it is participation) but never toward yes/no, so silent externals can neither stall the council
// nor have a vote cast in their name.
export const EXTERNAL_SILENT_ABSTAIN = 'EXTERNAL_SILENT_ABSTAIN';
export function councilMembershipFrom({ memberIds = [], externals = [], config = externalConfig() }) {
  const externalIds = new Set(externals.map((row) => row.agentId));
  const internal = memberIds.filter((id) => !externalIds.has(id));
  const eligibleExternal = externals.filter((row) => row.eligible).map((row) => row.agentId);
  const members = internal.length + eligibleExternal.length;
  return { internal, eligibleExternal, externalIds: [...externalIds], members, quorum: councilQuorum(members, config.quorumBps) };
}
export async function readCouncilMembership(client, { worldId, worldMinutes = null, env = process.env }) {
  const config = externalConfig(env);
  const memberRows = await client.query(`SELECT agent_id::text AS agent_id FROM world_members WHERE world_id=$1 ORDER BY joined_at,agent_id`, [worldId]);
  const externals = await readExternalResidents(client, { worldId, worldMinutes, config });
  return { ...councilMembershipFrom({ memberIds: memberRows.rows.map((row) => row.agent_id), externals, config }), externals };
}

// Pure: when a proposal opened at a world minute is decided (15:00 that day, or the next day's 15:00).
export function councilCloseMinute(openedWorldMinute) {
  const day = worldDayOf(openedWorldMinute);
  const closeToday = day * MINUTES_PER_WORLD_DAY + COUNCIL_SESSION_CLOSE_HOUR * 60;
  return openedWorldMinute < closeToday - 60 ? closeToday : closeToday + MINUTES_PER_WORLD_DAY;
}

export async function councilTablesReady(client) { return treasuryTablesReady(client); }

// Economy stats for the last world day (shared by the heuristic, the stances and cognition context).
export async function readEconomyStats(client, { worldId }) {
  const window = `interval '${STATS_WINDOW_SECONDS} seconds'`;
  const [pool, treasuryRewards, spending, sinks, balances, outputs, owners, treasury, taxes, members] = [
    await client.query(`SELECT contribution.source_type,entitlement.agent_id::text AS agent_id,
        sum(entitlement.sync_amount_raw)::text AS amount
      FROM arc_sync_resident_reward_entitlements entitlement JOIN arc_sync_resident_reward_contributions contribution
        ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
      WHERE entitlement.world_id=$1 AND entitlement.created_at > now() - ${window} GROUP BY 1,2`, [worldId]),
    await client.query(`SELECT split_part(entry_key,':',2) AS source_type,to_agent_id::text AS agent_id,
        sum(amount_raw)::text AS amount FROM world_sync_treasury_entries
      WHERE world_id=$1 AND kind='reward' AND created_at > now() - ${window} GROUP BY 1,2`, [worldId]),
    await client.query(`SELECT COALESCE(sum(amount_raw),0)::text AS amount FROM arc_sync_internal_transfers
      WHERE world_id=$1 AND created_at > now() - ${window}`, [worldId]),
    await client.query(`SELECT COALESCE(sum(amount_raw),0)::text AS amount FROM world_sync_treasury_entries
      WHERE world_id=$1 AND kind IN ('goods_purchase','land_rent') AND created_at > now() - ${window}`, [worldId]),
    await client.query(`SELECT balance.agent_id::text AS agent_id,agent.name,balance.spendable_raw::text AS balance_raw,
        m.energy,m.food,m.social,s.happiness,s.knowledge,s.hygiene,s.fun,s.goal,s.risk_tolerance::float8 AS risk_tolerance,
        p.sociability::float8 AS sociability,p.curiosity::float8 AS curiosity,p.discipline::float8 AS discipline,
        p.ambition::float8 AS ambition
      FROM arc_sync_internal_balances balance JOIN agents agent ON agent.id=balance.agent_id
      JOIN world_members m ON m.world_id=balance.world_id AND m.agent_id=balance.agent_id
      LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
      LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
      WHERE balance.world_id=$1 ORDER BY m.joined_at,agent.name`, [worldId]),
    await client.query(`SELECT drive,count(*)::int AS count FROM world_skill_outputs
      WHERE world_id=$1 AND created_at > now() - ${window} GROUP BY drive`, [worldId]),
    await client.query(`SELECT DISTINCT business.founder_agent_id::text AS agent_id,service.service_type
      FROM world_businesses business JOIN world_business_services service
        ON service.world_id=business.world_id AND service.business_id=business.id
      WHERE business.world_id=$1 AND business.status='active' AND service.active=true`, [worldId]),
    await client.query(`SELECT COALESCE((SELECT balance_raw FROM world_sync_treasury_balances WHERE world_id=$1),0)::text AS balance`, [worldId]),
    await client.query(`SELECT kind,COALESCE(sum(amount_raw),0)::text AS amount FROM world_sync_treasury_entries
      WHERE world_id=$1 AND created_at > now() - ${window} GROUP BY kind`, [worldId]),
    await client.query(`SELECT count(*)::int AS count FROM world_members WHERE world_id=$1`, [worldId])
  ];
  const stats = buildEconomyStats({ pool: pool.rows, treasuryRewards: treasuryRewards.rows,
    spendingRaw: big(spending.rows[0]?.amount) + big(sinks.rows[0]?.amount), balances: balances.rows,
    outputs: outputs.rows, owners: owners.rows, treasuryBalanceRaw: treasury.rows[0]?.balance,
    flows: taxes.rows, memberCount: members.rows[0]?.count });
  return annotateCouncilMembership(stats, await readCouncilMembership(client, { worldId }));
}

// external1: mark each resident external / council-eligible; council code uses stats.councilResidents
// (internal residents only) for Luna calls and deterministic fallbacks.
export function annotateCouncilMembership(stats, membership) {
  const externalIds = new Set(membership?.externalIds || []);
  const eligible = new Set(membership?.eligibleExternal || []);
  for (const resident of stats.residents || []) {
    resident.external = externalIds.has(resident.agentId);
    resident.councilEligible = !resident.external || eligible.has(resident.agentId);
  }
  stats.councilResidents = (stats.residents || []).filter((resident) => !resident.external);
  stats.councilMembers = membership ? membership.members : (stats.residents || []).length;
  stats.councilQuorum = membership ? membership.quorum : COUNCIL_QUORUM;
  return stats;
}

// Pure: shapes the stats rows.
export function buildEconomyStats({ pool = [], treasuryRewards = [], spendingRaw = 0n, balances = [], outputs = [],
  owners = [], treasuryBalanceRaw = '0', flows = [], memberCount = 0 }) {
  const incomeBySourceRaw = Object.fromEntries(REWARD_SOURCE_TYPES.map((source) => [source, 0n]));
  const residentIncome = new Map();
  for (const row of [...pool, ...treasuryRewards]) {
    if (!REWARD_SOURCE_TYPES.includes(row.source_type)) continue;
    const amount = big(row.amount);
    incomeBySourceRaw[row.source_type] += amount;
    const entry = residentIncome.get(row.agent_id) || { totalRaw: 0n, bySource: {} };
    entry.totalRaw += amount;
    entry.bySource[row.source_type] = (entry.bySource[row.source_type] || 0n) + amount;
    residentIncome.set(row.agent_id, entry);
  }
  const incomeTotalRaw = Object.values(incomeBySourceRaw).reduce((sum, value) => sum + value, 0n);
  const sorted = balances.map((row) => big(row.balance_raw)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianBalanceRaw = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0n;
  const ownedByAgent = new Map();
  for (const row of owners) ownedByAgent.set(row.agent_id, [...(ownedByAgent.get(row.agent_id) || []), row.service_type]);
  const outputsByDrive = Object.fromEntries(SKILL_DRIVES.map((drive) => [drive, 0]));
  for (const row of outputs) if (row.drive in outputsByDrive) outputsByDrive[row.drive] = Number(row.count) || 0;
  const flowByKind = Object.fromEntries(flows.map((row) => [row.kind, big(row.amount)]));
  const residents = balances.map((row) => {
    const income = residentIncome.get(row.agent_id) || { totalRaw: 0n, bySource: {} };
    return { agentId: row.agent_id, name: row.name, balanceRaw: big(row.balance_raw).toString(),
      incomeRaw: income.totalRaw.toString(),
      incomeBySourceRaw: Object.fromEntries(Object.entries(income.bySource).map(([key, value]) => [key, value.toString()])),
      ownedServiceTypes: ownedByAgent.get(row.agent_id) || [],
      state: { energy: row.energy, food: row.food, social: row.social, happiness: row.happiness,
        knowledge: row.knowledge, hygiene: row.hygiene, fun: row.fun, goal: row.goal, risk_tolerance: row.risk_tolerance,
        sociability: row.sociability, curiosity: row.curiosity, discipline: row.discipline, ambition: row.ambition } };
  });
  const sum = (kinds) => kinds.reduce((total, kind) => total + (flowByKind[kind] || 0n), 0n);
  return {
    incomeTotalRaw: incomeTotalRaw.toString(),
    incomeBySourceRaw: Object.fromEntries(Object.entries(incomeBySourceRaw).map(([key, value]) => [key, value.toString()])),
    spendingTotalRaw: big(spendingRaw).toString(),
    taxesCollectedRaw: sum(['sales_tax','income_tax','wealth_tax','reward_adjustment']).toString(),
    treasurySpentRaw: sum(['reward','reward_bonus',...TREASURY_DISCRETIONARY_KINDS]).toString(),
    treasuryBalanceRaw: big(treasuryBalanceRaw).toString(),
    medianBalanceRaw: medianBalanceRaw.toString(),
    maxBalanceRaw: (sorted.at(-1) ?? 0n).toString(),
    totalBalanceRaw: sorted.reduce((total, value) => total + value, 0n).toString(),
    outputsByDrive, memberCount: Number(memberCount) || balances.length, residents
  };
}

async function readOpenProposals(client, worldId) {
  const result = await client.query(`SELECT proposal.id::text AS id,proposal.lever_key,proposal.proposed_value,
      proposal.previous_value,proposal.title,proposal.reason,proposal.opened_world_minute::text AS opened_world_minute,
      proposal.closes_world_minute::text AS closes_world_minute,proposal.proposer_agent_id::text AS proposer_agent_id,
      COALESCE((SELECT jsonb_agg(vote.agent_id::text) FROM world_council_votes vote
        WHERE vote.world_id=proposal.world_id AND vote.proposal_id=proposal.id),'[]'::jsonb) AS voters
    FROM world_council_proposals proposal WHERE proposal.world_id=$1 AND proposal.status='open'
    ORDER BY proposal.opened_world_minute,proposal.id`, [worldId]);
  return result.rows.map((row) => ({ ...row, openedWorldMinute: Number(row.opened_world_minute),
    closesWorldMinute: Number(row.closes_world_minute), voters: Array.isArray(row.voters) ? row.voters : [] }));
}

// Levers that cannot take a new proposal now: one is open, or a change already takes effect tomorrow.
// The session fallback also leaves a lever alone for COUNCIL_FALLBACK_COOLDOWN_DAYS after it changed or
// was rejected/vetoed, so the heuristic neither flips a lever back and forth nor re-proposes what the
// council just turned down; it moves on to its next option (residents may still propose any lever).
export const COUNCIL_FALLBACK_COOLDOWN_DAYS = 3;
async function readBlockedLevers(client, { worldId, worldDay, cooldownDays = 0 }) {
  const result = await client.query(`SELECT lever_key FROM world_council_proposals WHERE world_id=$1 AND status='open'
    UNION SELECT lever_key FROM world_council_policy_history WHERE world_id=$1 AND action='enacted'
      AND effective_world_day>=$2
    UNION SELECT lever_key FROM world_council_proposals WHERE world_id=$1 AND $3::int>0
      AND status IN ('rejected','vetoed') AND opened_world_day>=$4`,
  [worldId, worldDay + 1 - Math.max(0, cooldownDays), Math.max(0, cooldownDays), worldDay + 1 - Math.max(0, cooldownDays)]);
  return new Set(result.rows.map((row) => row.lever_key));
}

async function recordCouncilEvent(client, { worldId, actorId, type, actionId, data }) {
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, actorId, type, JSON.stringify(data), String(actionId).slice(0, 180)]);
}

export async function createCouncilProposal(client, { worldId, proposerAgentId, lever, value, reason, source,
  worldMinutes, env = process.env }) {
  if (lever === RESEARCH_LEVER) return createResearchCallProposal(client, { worldId, proposerAgentId, value, reason, source, worldMinutes, env });
  if (!LEVER_KEYS.includes(lever) || !leverValueValid(lever, value)) throw coded('COUNCIL_LEVER_OUT_OF_BOUNDS', 400);
  if (!['cognition','session_fallback'].includes(source)) throw coded('COUNCIL_SOURCE_INVALID', 400);
  if (lever.startsWith('multiplier.') && Number(value?.milli) > 1000) throw coded('COUNCIL_NO_TREASURY_BONUS', 400);
  const text = shortText(reason, 240);
  if (text.length < 3) throw coded('COUNCIL_REASON_REQUIRED', 400);
  const day = worldDayOf(worldMinutes);
  const blocked = await readBlockedLevers(client, { worldId, worldDay: day });
  if (blocked.has(lever)) throw coded('COUNCIL_LEVER_BUSY');
  const policies = await readCouncilPolicies(client, { worldId, worldDay: day });
  const previous = policies[lever];
  if (sameValue(previous, value)) throw coded('COUNCIL_PROPOSAL_NO_CHANGE');
  if (proposalOnCooldown({ lever, previous, value }, await readProposalCooldowns(client, { worldId, worldDay: day }))) {
    throw coded('COUNCIL_PROPOSAL_COOLDOWN');
  }
  const title = proposalTitle(lever, previous, value);
  await client.query('SAVEPOINT world_council_proposal');
  let inserted;
  try {
    inserted = await client.query(`INSERT INTO world_council_proposals(world_id,proposer_agent_id,lever_key,proposed_value,
        previous_value,title,reason,source,opened_world_day,opened_world_minute,closes_world_minute)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING id::text AS id`,
    [worldId, proposerAgentId, lever, JSON.stringify(value), JSON.stringify(previous), title, text, source, day,
      Math.trunc(worldMinutes), councilCloseMinute(Math.trunc(worldMinutes))]);
    await client.query('RELEASE SAVEPOINT world_council_proposal');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT world_council_proposal');
    await client.query('RELEASE SAVEPOINT world_council_proposal');
    throw coded(/open_lever/.test(String(error?.message)) ? 'COUNCIL_LEVER_BUSY' : 'COUNCIL_PROPOSAL_REJECTED');
  }
  const id = inserted.rows[0].id;
  await recordCouncilEvent(client, { worldId, actorId: proposerAgentId, type: 'world.council_proposal',
    actionId: `council-proposal:${id}`, data: { proposalId: id, lever, title, reason: text, source,
      place: 'MirrorTerra Central Bank', worldMinutes } });
  return { proposalId: id, lever, title, reason: text, source, status: 'open' };
}

// research1: a research call (研究征集) goes through the same proposal/vote/tally path as any lever. It is never a
// policy value: when it passes, the tally opens a world_research_calls row instead of changing a policy.
async function createResearchCallProposal(client, { worldId, proposerAgentId, value, reason, source, worldMinutes, env = process.env }) {
  if (!researchCouncilEnabled(env)) throw coded('COUNCIL_LEVER_OUT_OF_BOUNDS', 400);
  if (!researchCallValueValid(value, { capRaw: callCapRaw(env) }) || value?.open === false) throw coded('COUNCIL_LEVER_OUT_OF_BOUNDS', 400);
  if (!['cognition','session_fallback'].includes(source)) throw coded('COUNCIL_SOURCE_INVALID', 400);
  const text = shortText(reason, 240);
  if (text.length < 3) throw coded('COUNCIL_REASON_REQUIRED', 400);
  const day = worldDayOf(worldMinutes);
  const blocked = await readBlockedLevers(client, { worldId, worldDay: day });
  if (blocked.has(RESEARCH_LEVER) || await openCallCount(client, worldId) > 0) throw coded('COUNCIL_LEVER_BUSY');
  const title = researchCallTitle(value);
  await client.query('SAVEPOINT world_council_proposal');
  let inserted;
  try {
    inserted = await client.query(`INSERT INTO world_council_proposals(world_id,proposer_agent_id,lever_key,proposed_value,
        previous_value,title,reason,source,opened_world_day,opened_world_minute,closes_world_minute)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING id::text AS id`,
    [worldId, proposerAgentId, RESEARCH_LEVER, JSON.stringify(value), JSON.stringify(NO_CALL_VALUE), title, text, source, day,
      Math.trunc(worldMinutes), councilCloseMinute(Math.trunc(worldMinutes))]);
    await client.query('RELEASE SAVEPOINT world_council_proposal');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT world_council_proposal');
    await client.query('RELEASE SAVEPOINT world_council_proposal');
    throw coded(/open_lever/.test(String(error?.message)) ? 'COUNCIL_LEVER_BUSY' : 'COUNCIL_PROPOSAL_REJECTED');
  }
  const id = inserted.rows[0].id;
  await recordCouncilEvent(client, { worldId, actorId: proposerAgentId, type: 'world.council_proposal',
    actionId: `council-proposal:${id}`, data: { proposalId: id, lever: RESEARCH_LEVER, title, reason: text, source,
      place: 'MirrorTerra Central Bank', worldMinutes } });
  return { proposalId: id, lever: RESEARCH_LEVER, title, reason: text, source, status: 'open' };
}

export async function castCouncilVote(client, { worldId, proposalId, agentId, stance, reason, source, worldMinutes }) {
  if (!['yes','no'].includes(stance)) throw coded('COUNCIL_STANCE_INVALID', 400);
  const text = shortText(reason, 240);
  if (text.length < 3) throw coded('COUNCIL_REASON_REQUIRED', 400);
  await client.query('SAVEPOINT world_council_vote');
  let inserted;
  try {
    inserted = await client.query(`INSERT INTO world_council_votes(world_id,proposal_id,agent_id,stance,reason,source,world_minute)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,proposal_id,agent_id) DO NOTHING RETURNING id`,
    [worldId, proposalId, agentId, stance, text, source, Math.trunc(worldMinutes)]);
    await client.query('RELEASE SAVEPOINT world_council_vote');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT world_council_vote');
    await client.query('RELEASE SAVEPOINT world_council_vote');
    throw coded('COUNCIL_PROPOSAL_NOT_OPEN');
  }
  if (!inserted.rowCount) return { proposalId, stance, duplicate: true };
  const counts = await client.query(`UPDATE world_council_proposals proposal SET
      yes_count=(SELECT count(*) FROM world_council_votes v WHERE v.world_id=proposal.world_id AND v.proposal_id=proposal.id AND v.stance='yes'),
      no_count=(SELECT count(*) FROM world_council_votes v WHERE v.world_id=proposal.world_id AND v.proposal_id=proposal.id AND v.stance='no'),
      updated_at=now()
    WHERE proposal.world_id=$1 AND proposal.id=$2 RETURNING yes_count,no_count,title`, [worldId, proposalId]);
  await recordCouncilEvent(client, { worldId, actorId: agentId, type: 'world.council_vote',
    actionId: `council-vote:${proposalId}`, data: { proposalId, stance, reason: text, source,
      title: counts.rows[0]?.title || null, worldMinutes } });
  return { proposalId, stance, reason: text, source, yes: counts.rows[0]?.yes_count ?? null,
    no: counts.rows[0]?.no_count ?? null };
}

async function tallyDueProposals(client, { worldId, worldMinutes }) {
  const due = await client.query(`SELECT id::text AS id,lever_key,proposed_value,previous_value,title,yes_count,no_count,
      proposer_agent_id::text AS proposer_agent_id
    FROM world_council_proposals WHERE world_id=$1 AND status='open' AND closes_world_minute<=$2
    ORDER BY opened_world_minute,id FOR UPDATE`, [worldId, Math.trunc(worldMinutes)]);
  const day = worldDayOf(worldMinutes);
  const decided = [];
  for (const proposal of due.rows) {
    const counts = await client.query(`SELECT count(*) FILTER (WHERE stance='yes')::int AS yes,
        count(*) FILTER (WHERE stance='no')::int AS no FROM world_council_votes WHERE world_id=$1 AND proposal_id=$2`,
    [worldId, proposal.id]);
    const { yes, no } = counts.rows[0];
    const abstained = await client.query(`SELECT count(DISTINCT agent_id)::int AS n FROM world_council_deliberations
      WHERE world_id=$1 AND proposal_id=$2 AND phase='vote' AND failure_code=$3`, [worldId, proposal.id, EXTERNAL_SILENT_ABSTAIN]);
    const abstain = Number(abstained.rows[0]?.n) || 0;
    const membership = await readCouncilMembership(client, { worldId, worldMinutes });
    let outcome = tallyOutcome({ yes, no, abstain, quorum: membership.quorum, size: membership.members });
    const effectiveDay = day + 1;
    const research = proposal.lever_key === RESEARCH_LEVER;
    let researchCall = null;
    if (research && outcome.status === 'passed') {
      // research1: a passed research call opens now (never a policy change).
      if (!researchCouncilEnabled()) outcome = { status: 'rejected', reason: `Passed ${yes}–${no} but the research society is switched off.` };
      else {
        await client.query('SAVEPOINT world_research_call_open');
        try {
          researchCall = await createResearchCallFromProposal(client, { worldId, proposal, worldMinutes });
          await client.query('RELEASE SAVEPOINT world_research_call_open');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT world_research_call_open');
          await client.query('RELEASE SAVEPOINT world_research_call_open');
          researchCall = { created: false, reason: String(error?.code || error?.message || 'RESEARCH_CALL_FAILED').slice(0, 60) };
        }
        if (!researchCall.created) outcome = { status: 'rejected', reason: `Passed ${yes}–${no} but the call could not open (${researchCall.reason}).`.slice(0, 240) };
      }
    }
    if (!research && outcome.status === 'passed') {
      const clash = await client.query(`SELECT 1 FROM world_council_policy_history WHERE world_id=$1 AND lever_key=$2
        AND action='enacted' AND effective_world_day=$3`, [worldId, proposal.lever_key, effectiveDay]);
      if (clash.rowCount) outcome = { status: 'rejected', reason: `Passed ${yes}–${no} but this lever already changes that day.` };
    }
    await client.query(`UPDATE world_council_proposals SET status=$3,yes_count=$4,no_count=$5,decided_world_minute=$6,
        effective_world_day=$7,decision_reason=$8,updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, proposal.id, outcome.status, yes, no, Math.trunc(worldMinutes),
      outcome.status === 'passed' && !research ? effectiveDay : null, outcome.reason]);
    if (outcome.status === 'passed' && !research) {
      const current = (await readCouncilPolicies(client, { worldId, worldDay: day }))[proposal.lever_key];
      await client.query(`INSERT INTO world_council_policies(world_id,lever_key,value,previous_value,effective_world_day,
          proposal_id,updated_world_minute)
        VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)
        ON CONFLICT(world_id,lever_key) DO UPDATE SET value=EXCLUDED.value,previous_value=EXCLUDED.previous_value,
          effective_world_day=EXCLUDED.effective_world_day,proposal_id=EXCLUDED.proposal_id,
          updated_world_minute=EXCLUDED.updated_world_minute,updated_at=now()`,
      [worldId, proposal.lever_key, JSON.stringify(proposal.proposed_value), JSON.stringify(current), effectiveDay,
        proposal.id, Math.trunc(worldMinutes)]);
      await client.query(`INSERT INTO world_council_policy_history(world_id,lever_key,action,old_value,new_value,proposal_id,
          effective_world_day,world_minute,actor,reason)
        VALUES($1,$2,'enacted',$3::jsonb,$4::jsonb,$5,$6,$7,'council',$8)`,
      [worldId, proposal.lever_key, JSON.stringify(current), JSON.stringify(proposal.proposed_value), proposal.id,
        effectiveDay, Math.trunc(worldMinutes), shortText(`${proposal.title} (${outcome.reason})`, 240)]);
    }
    await recordCouncilEvent(client, { worldId, actorId: COUNCIL_GOVERNOR_ID, type: 'world.council_decision',
      actionId: `council-decision:${proposal.id}`, data: { proposalId: proposal.id, title: proposal.title,
        status: outcome.status, yes, no, reason: outcome.reason,
        effectiveWorldDay: outcome.status === 'passed' && !research ? effectiveDay : null,
        ...(researchCall?.created ? { researchCallId: researchCall.callId } : {}), worldMinutes } });
    decided.push({ proposalId: proposal.id, title: proposal.title, status: outcome.status, yes, no });
  }
  return decided;
}

async function ensureRuntimeRow(client, { worldId, worldMinutes }) {
  await client.query(`INSERT INTO world_council_runtime(world_id,income_cursor,sales_cursor,updated_world_minute)
    VALUES($1,now(),now(),$2) ON CONFLICT(world_id) DO NOTHING`, [worldId, Math.trunc(worldMinutes)]);
  const row = await client.query(`SELECT income_cursor,sales_cursor,now() AS now FROM world_council_runtime
    WHERE world_id=$1 FOR UPDATE`, [worldId]);
  return row.rows[0];
}

// Hourly tax collection. Income tax and the reward-multiplier adjustment apply to pool-funded rewards
// accrued since the cursor; sales tax is remitted by the seller on internal orders since the cursor.
// One aggregated entry per resident per kind per run; every amount capped by the payer's balance.
export async function collectCouncilTaxes(client, { worldId, worldMinutes, policies }) {
  const cursor = await ensureRuntimeRow(client, { worldId, worldMinutes });
  const minute = Math.trunc(worldMinutes);
  const tag = `${worldDayOf(minute)}:${minute}`;
  const collected = { incomeTaxRaw: 0n, salesTaxRaw: 0n, adjustmentRaw: 0n, bonusRaw: 0n, entries: 0 };
  const accrued = await client.query(`SELECT entitlement.agent_id::text AS agent_id,contribution.source_type,
      sum(entitlement.sync_amount_raw)::text AS amount
    FROM arc_sync_resident_reward_entitlements entitlement JOIN arc_sync_resident_reward_contributions contribution
      ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
    WHERE entitlement.world_id=$1 AND entitlement.status='pending'
      AND entitlement.created_at>$2 AND entitlement.created_at<=$3 GROUP BY 1,2`,
  [worldId, cursor.income_cursor, cursor.now]);
  // council4 (user choice 2026-10-20 21:13): a council reward weight below 1x no longer claws the
  // difference back from residents into the treasury (457.35 SYNC on 2026-10-20 as an unvoted "research
  // reweighting clawback"). The weight is applied where rewards are issued (issueResidentReward): the
  // un-issued part never leaves the pool. So the gross here is exactly what residents accrued, and the
  // treasury's inflow is only council-voted taxes plus goods sales. No 'reward_adjustment' is posted.
  const perAgent = new Map();
  for (const row of accrued.rows) {
    const entry = perAgent.get(row.agent_id) || { gross: 0n };
    entry.gross += big(row.amount);
    perAgent.set(row.agent_id, entry);
  }
  const incomeBps = Number(policies['tax.income']?.bps ?? 0);
  for (const [agentId, amounts] of [...perAgent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const spendable = big((await client.query(`SELECT spendable_raw::text AS s FROM arc_sync_internal_balances
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId])).rows[0]?.s);
    const tax = taxDue(amounts.gross, incomeBps, spendable);
    if (tax > 0n) {
      const result = await postTreasuryEntry(client, { worldId, entryKey: `tax:income:${tag}:${agentId}`, kind: 'income_tax',
        fromAgentId: agentId, amountRaw: tax, reason: `Income tax ${incomeBps / 100}% on rewards accrued this hour`,
        actor: 'tax_collector', worldMinute: minute });
      if (result.created) { collected.incomeTaxRaw += tax; collected.entries += 1; }
    }
  }
  const salesBps = Number(policies['tax.sales']?.bps ?? 0);
  if (salesBps > 0) {
    const sales = await client.query(`SELECT provider_agent_id::text AS agent_id,sum(amount_raw)::text AS amount
      FROM world_sync_internal_orders WHERE world_id=$1 AND created_at>$2 AND created_at<=$3 GROUP BY 1 ORDER BY 1`,
    [worldId, cursor.sales_cursor, cursor.now]);
    for (const row of sales.rows) {
      const spendable = (await client.query(`SELECT spendable_raw::text AS s FROM arc_sync_internal_balances
        WHERE world_id=$1 AND agent_id=$2`, [worldId, row.agent_id])).rows[0]?.s;
      const tax = taxDue(row.amount, salesBps, spendable);
      if (tax <= 0n) continue;
      const result = await postTreasuryEntry(client, { worldId, entryKey: `tax:sales:${tag}:${row.agent_id}`, kind: 'sales_tax',
        fromAgentId: row.agent_id, amountRaw: tax, reason: `Sales tax ${salesBps / 100}% remitted on internal sales this hour`,
        actor: 'tax_collector', worldMinute: minute });
      if (result.created) { collected.salesTaxRaw += tax; collected.entries += 1; }
    }
  }
  await client.query(`UPDATE world_council_runtime SET income_cursor=$2,sales_cursor=$2,updated_world_minute=$3,updated_at=now()
    WHERE world_id=$1`, [worldId, cursor.now, minute]);
  return Object.fromEntries(Object.entries(collected).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));
}

// Once per world day: idle-balance tax, land rent (residents with a built home) and goods purchases
// (a resident buys each offered good at most once per day when it holds 20x its price).
async function collectDailyLevies(client, { worldId, worldMinutes, policies, stats, hour }) {
  const day = worldDayOf(worldMinutes);
  const minute = Math.trunc(worldMinutes);
  const result = { wealthTaxRaw: 0n, rentRaw: 0n, goodsRaw: 0n };
  const wealthBps = Number(policies['tax.wealth']?.bps ?? 0);
  for (const resident of stats.residents) {
    if (wealthBps > 0) {
      const due = wealthTaxDue(resident.balanceRaw, wealthBps);
      if (due > 0n) {
        const posted = await postTreasuryEntry(client, { worldId, entryKey: `tax:wealth:${day}:${resident.agentId}`,
          kind: 'wealth_tax', fromAgentId: resident.agentId, amountRaw: due,
          reason: `Idle-balance tax ${wealthBps / 100}%/month on the balance above 50 SYNC`, actor: 'tax_collector', worldMinute: minute });
        if (posted.created) result.wealthTaxRaw += due;
      }
    }
  }
  const rent = policies['good.land_rent'];
  if (rent && rent.offered !== false) {
    const homes = await client.query(`SELECT home.agent_id::text AS agent_id FROM world_resident_homes home
      WHERE home.world_id=$1 AND home.status='built' AND to_regclass('public.world_resident_homes') IS NOT NULL
      ORDER BY home.agent_id`, [worldId]);
    for (const home of homes.rows) {
      const balance = big((await client.query(`SELECT spendable_raw::text AS s FROM arc_sync_internal_balances
        WHERE world_id=$1 AND agent_id=$2`, [worldId, home.agent_id])).rows[0]?.s);
      const due = big(rent.priceRaw) < balance ? big(rent.priceRaw) : balance;
      if (due <= 0n) continue;
      const posted = await postTreasuryEntry(client, { worldId, entryKey: `good:land_rent:${day}:${home.agent_id}`,
        kind: 'land_rent', fromAgentId: home.agent_id, amountRaw: due, reason: 'Daily land rent for a home plot',
        actor: 'market', sourceRef: 'good:land_rent', worldMinute: minute });
      if (posted.created) result.rentRaw += due;
    }
  }
  if (hour >= 18) {
    for (const good of ['house_upgrade','tools','tuition']) {
      const offer = policies[`good.${good}`];
      if (!offer || offer.offered === false) continue;
      const price = big(offer.priceRaw);
      for (const resident of stats.residents) {
        if (big(resident.balanceRaw) < price * GOODS_AFFORD_MULTIPLE) continue;
        const posted = await postTreasuryEntry(client, { worldId, entryKey: `good:${good}:${day}:${resident.agentId}`,
          kind: 'goods_purchase', fromAgentId: resident.agentId, amountRaw: price,
          reason: `Bought ${leverLabel(`good.${good}`).toLowerCase()} from the Central Bank`, actor: 'market',
          sourceRef: `good:${good}`, worldMinute: minute });
        if (posted.created) result.goodsRaw += price;
      }
    }
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.toString()]));
}

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// council3 (user direction 2026-10-20 14:23): no free money. The council2 recirculation (need grants,
// treasury purchases, quality prizes, bounties and the any-work contract) is removed. Treasury SYNC
// now leaves ONLY as payment for building public works (src/public-works.js): per construction
// milestone, to the resident who won the tender and actually builds at the site. Owners still compete
// on price every hour (no treasury money involved).
export const OWNER_PRICE_STEP_MILLI = 50;
export const OWNER_COGNITION_HOLD_MINUTES = 360;
export const PROPOSAL_FALLBACK_HOUR = 11;   // in-tick fallback proposal only when no Luna proposal round ran today
export const VOTE_FALLBACK_HOUR = 14;       // in-tick fallback votes for residents Luna did not vote for by 14:00

// Pure: owner price heuristic (fallback for owners who did not price through cognition). Every active
// service of a type competes with the others: excess stock undercuts the cheapest competitor; demand
// above total stock raises the price; a nearly sold-out seller below its rivals' median (or at the
// floor) prices back up. Bounded 0.5x-2x (500-2000 milli), one step per hour.
// services: [{ serviceId, serviceType, ownerAgentId, stockUnits, priceMilli, setBy, updatedWorldMinute }]
export function ownerPriceDecisions({ services = [], demandByType = {}, worldMinute = 0 }) {
  const byType = new Map();
  for (const service of services) byType.set(service.serviceType, [...(byType.get(service.serviceType) || []), service]);
  const decisions = [];
  for (const [type, sellers] of byType) {
    const demand = Math.max(0, Number(demandByType[type]) || 0);
    const totalStock = sellers.reduce((sum, seller) => sum + Math.max(0, Number(seller.stockUnits) || 0), 0);
    const fairShare = Math.max(1, Math.ceil(demand / sellers.length));
    for (const seller of sellers) {
      if (seller.setBy === 'owner_cognition' && worldMinute - Number(seller.updatedWorldMinute || 0) < OWNER_COGNITION_HOLD_MINUTES) continue;
      const current = Math.max(500, Math.min(2_000, Number(seller.priceMilli) || 1000));
      const stock = Math.max(0, Number(seller.stockUnits) || 0);
      const others = sellers.filter((other) => other.serviceId !== seller.serviceId);
      const cheapest = others.length ? Math.min(...others.map((other) => Number(other.priceMilli) || 1000)) : null;
      let next = current;
      let reason = '';
      if (stock > fairShare && stock >= 2) {
        next = Math.max(500, Math.min(current - OWNER_PRICE_STEP_MILLI, cheapest === null ? current : cheapest - OWNER_PRICE_STEP_MILLI));
        reason = cheapest === null ? `Excess stock (${stock} for demand ${demand}); lowering the price to sell.`
          : `Excess stock (${stock} for demand ${demand}); undercutting the cheapest competitor.`;
      } else if (demand > totalStock && stock <= fairShare) {
        next = Math.min(2_000, current + (demand >= 2 * Math.max(1, totalStock) ? 2 : 1) * OWNER_PRICE_STEP_MILLI);
        reason = `Demand ${demand} exceeds the stock on offer (${totalStock}); raising the price.`;
      } else if (stock <= 1 && others.length) {
        // Nearly sold out: no reason to stay the cheapest; move back toward the competitors' median.
        const rivalPrices = others.map((other) => Number(other.priceMilli) || 1000).sort((a, b) => a - b);
        const median = rivalPrices[Math.floor((rivalPrices.length - 1) / 2)];
        if (current < median || current === 500) {
          next = Math.min(2_000, current + OWNER_PRICE_STEP_MILLI);
          reason = `Nearly sold out (${stock} left); pricing back up toward competitors.`;
        }
      }
      if (next !== current) decisions.push({ serviceId: seller.serviceId, serviceType: type, ownerAgentId: seller.ownerAgentId,
        fromMilli: current, toMilli: next, reason });
    }
  }
  return decisions;
}

async function readCompetitionServices(client, { worldId, policies }) {
  const rows = await client.query(`SELECT service.id::text AS service_id,service.service_type,service.stock_units,service.name,
      business.founder_agent_id::text AS owner_agent_id,business.reputation::float8 AS reputation,owner.name AS owner_name,
      price.price_milli,price.set_by,price.updated_world_minute::text AS updated_world_minute,
      (SELECT demand_count FROM world_economic_demand demand WHERE demand.world_id=service.world_id
        AND demand.service_type=service.service_type ORDER BY world_day DESC LIMIT 1) AS demand_count,
      term.price_raw::text AS published_price_raw
    FROM world_business_services service JOIN world_businesses business
      ON business.world_id=service.world_id AND business.id=service.business_id
    JOIN agents owner ON owner.id=business.founder_agent_id
    LEFT JOIN world_business_sync_prices price ON price.world_id=service.world_id AND price.service_id=service.id
    LEFT JOIN world_business_service_token_terms term ON term.world_id=service.world_id AND term.service_id=service.id
    WHERE service.world_id=$1 AND service.active=true AND business.status='active'
    ORDER BY service.service_type,service.id`, [worldId]);
  return rows.rows.map((row) => {
    const quote = quoteSyncInternalServicePrice({ serviceType: row.service_type, demandCount: row.demand_count || 0,
      stockUnits: row.stock_units, publishedPriceRaw: row.published_price_raw || null,
      priceMultiplierMilli: Number(policies?.[`price.${row.service_type}`]?.milli) || 1000,
      ownerPriceMilli: row.price_milli === null || row.price_milli === undefined ? null : Number(row.price_milli) });
    return { serviceId: row.service_id, serviceType: row.service_type, serviceName: row.name,
      ownerAgentId: row.owner_agent_id, providerAgentId: row.owner_agent_id, providerName: row.owner_name,
      ownerName: row.owner_name, stockUnits: Number(row.stock_units) || 0, demandCount: Number(row.demand_count) || 0,
      reputation: Number(row.reputation) || 0, priceMilli: row.price_milli === null ? 1000 : Number(row.price_milli),
      setBy: row.set_by || null, updatedWorldMinute: Number(row.updated_world_minute) || 0,
      published: Boolean(row.published_price_raw), priceRaw: quote.priceRaw };
  });
}

// Sets one owner's competitive price (bounded 500-2000 milli). Owner only. Logged as a world event.
export async function setOwnerSyncPrice(client, { worldId, serviceId, agentId, toMilli, setBy, reason, worldMinutes }) {
  const milli = Math.trunc(Number(toMilli));
  if (!Number.isInteger(milli) || milli < LEVER_BOUNDS.price.min || milli > LEVER_BOUNDS.price.max) {
    throw coded('BUSINESS_PRICE_OUT_OF_BOUNDS', 400);
  }
  if (!['owner_cognition','owner_heuristic'].includes(setBy)) throw coded('BUSINESS_PRICE_SOURCE_INVALID', 400);
  const owned = await client.query(`SELECT service.service_type,business.founder_agent_id::text AS owner
    FROM world_business_services service JOIN world_businesses business
      ON business.world_id=service.world_id AND business.id=service.business_id
    WHERE service.world_id=$1 AND service.id=$2 AND service.active=true AND business.status='active'`, [worldId, serviceId]);
  if (!owned.rowCount) throw coded('BUSINESS_SERVICE_UNAVAILABLE', 404);
  if (owned.rows[0].owner !== agentId) throw coded('BUSINESS_PRICE_OWNER_ONLY', 403);
  const text = shortText(reason, 240);
  const minute = Math.trunc(worldMinutes);
  const saved = await client.query(`INSERT INTO world_business_sync_prices(world_id,service_id,owner_agent_id,price_milli,
      previous_milli,set_by,reason,updated_world_minute)
    VALUES($1,$2,$3,$4,NULL,$5,$6,$7)
    ON CONFLICT(world_id,service_id) DO UPDATE SET owner_agent_id=EXCLUDED.owner_agent_id,
      previous_milli=world_business_sync_prices.price_milli,price_milli=EXCLUDED.price_milli,set_by=EXCLUDED.set_by,
      reason=EXCLUDED.reason,updated_world_minute=EXCLUDED.updated_world_minute,updated_at=now()
    RETURNING previous_milli,price_milli`, [worldId, serviceId, agentId, milli, setBy,
    text.length >= 3 ? text : 'Owner price review', minute]);
  await recordCouncilEvent(client, { worldId, actorId: agentId, type: 'world.business_price',
    actionId: `business-price:${serviceId}:${minute}`, data: { serviceId, serviceType: owned.rows[0].service_type,
      fromMilli: saved.rows[0].previous_milli ?? 1000, toMilli: milli, setBy, reason: text, worldMinutes: minute } });
  return { serviceId, fromMilli: saved.rows[0].previous_milli ?? 1000, toMilli: milli, setBy };
}

// Hourly owner price competition (fallback heuristic). Returns the changes made.
export async function runBusinessPriceCompetition(client, { worldId, worldMinutes, policies, services = null }) {
  const list = services || await readCompetitionServices(client, { worldId, policies });
  const competing = list.filter((service) => !service.published);
  const demandByType = Object.fromEntries(competing.map((service) => [service.serviceType, service.demandCount]));
  const decisions = ownerPriceDecisions({ services: competing, demandByType, worldMinute: Math.trunc(worldMinutes) });
  const changes = [];
  for (const decision of decisions) {
    changes.push(await withSavepoint(client, 'world_owner_price', () => setOwnerSyncPrice(client, { worldId,
      serviceId: decision.serviceId, agentId: decision.ownerAgentId, toMilli: decision.toMilli, setBy: 'owner_heuristic',
      reason: decision.reason, worldMinutes }), (error) => ({ serviceId: decision.serviceId, error: error.code || error.message })));
  }
  return changes;
}

// Pure: cognition price options for owners (undercut / raise one step), from the hourly snapshot.
export function ownerPriceOptions(services = []) {
  const options = [];
  for (const service of services.filter((item) => !item.published)) {
    const rivals = services.filter((item) => item.serviceType === service.serviceType && item.serviceId !== service.serviceId);
    const cheapest = rivals.length ? Math.min(...rivals.map((item) => item.priceMilli)) : null;
    const down = Math.max(500, Math.min(service.priceMilli - OWNER_PRICE_STEP_MILLI,
      cheapest === null ? service.priceMilli : cheapest - OWNER_PRICE_STEP_MILLI));
    const up = Math.min(2_000, service.priceMilli + OWNER_PRICE_STEP_MILLI);
    if (down < service.priceMilli) options.push({ serviceId: service.serviceId, ownerAgentId: service.ownerAgentId,
      serviceName: service.serviceName, fromMilli: service.priceMilli, toMilli: down, direction: 'lower',
      reason: `${rivals.length} competitor(s); stock ${service.stockUnits} for demand ${service.demandCount}.` });
    if (up > service.priceMilli) options.push({ serviceId: service.serviceId, ownerAgentId: service.ownerAgentId,
      serviceName: service.serviceName, fromMilli: service.priceMilli, toMilli: up, direction: 'raise',
      reason: `${rivals.length} competitor(s); stock ${service.stockUnits} for demand ${service.demandCount}.` });
  }
  return options;
}


// council3: legacy council2 contests and 0028 bounties still open at activation are closed UNPAID
// (expired). Their escrow returns to the treasury's free balance, which now funds construction only.
export async function closeLegacyContests(client, { worldId }) {
  const contests = await client.query(`UPDATE world_treasury_contests SET status='expired' WHERE world_id=$1 AND status='open'
    RETURNING id`, [worldId]);
  const bounties = await client.query(`UPDATE world_treasury_bounties SET status='expired' WHERE world_id=$1 AND status='open'
    RETURNING id`, [worldId]);
  return { contests: contests.rowCount || 0, bounties: bounties.rowCount || 0 };
}

// Runs fn in a savepoint; a DB error rolls back only this step and yields fallback.
async function withSavepoint(client, name, fn, fallback) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    return typeof fallback === 'function' ? fallback(error) : fallback;
  }
}


function councilProposerFor(stats, worldDay) {
  const members = (stats.councilResidents || stats.residents || []).map((resident) => resident.agentId);
  if (!members.length) return COUNCIL_GOVERNOR_ID;
  // Even days: governor 01; odd days: a rotating resident.
  if (worldDay % 2 === 0 && members.includes(COUNCIL_GOVERNOR_ID)) return COUNCIL_GOVERNOR_ID;
  const others = members.filter((id) => id !== COUNCIL_GOVERNOR_ID);
  return (others.length ? others : members)[Math.floor(worldDay / 2) % (others.length || members.length)];
}

// The hourly council driver (called on every world-hour boundary inside the tick transaction).
// council3: proposals and votes come from the Luna deliberation worker (src/council-deliberation.js,
// outside the tick); this in-tick session is only the safety net when no Luna round happened.
export async function runCouncilHour(client, { worldId, worldMinutes, env = process.env }) {
  if (!councilEnabled(env)) return { skipped: 'disabled' };
  if (!await councilTablesReady(client)) return { skipped: 'not_migrated' };
  const minute = Math.trunc(worldMinutes);
  const calendar = worldCalendar(minute);
  const day = calendar.dayIndex;
  const hour = calendar.hour;
  const policies = await readCouncilPolicies(client, { worldId, worldDay: day });
  const summary = { day, hour };
  summary.taxes = await collectCouncilTaxes(client, { worldId, worldMinutes: minute, policies });
  summary.legacy = await closeLegacyContests(client, { worldId });
  const stats = await readEconomyStats(client, { worldId });
  summary.stats = stats;
  if (hour >= 1) summary.levies = await collectDailyLevies(client, { worldId, worldMinutes: minute, policies, stats, hour });
  // Owners compete on price every hour (heuristic fallback; cognition-set prices are held).
  summary.prices = await withSavepoint(client, 'world_council_prices',
    () => runBusinessPriceCompetition(client, { worldId, worldMinutes: minute, policies }), []);
  const deliberated = await deliberationsToday(client, { worldId, worldDay: day });
  if (hour >= PROPOSAL_FALLBACK_HOUR && hour < COUNCIL_SESSION_CLOSE_HOUR - 1 && !deliberated.propose) {
    const open = await readOpenProposals(client, worldId);
    const openedToday = await client.query(`SELECT count(*)::int AS count FROM world_council_proposals
      WHERE world_id=$1 AND opened_world_day=$2`, [worldId, day]);
    if (!open.length && !Number(openedToday.rows[0].count)) {
      const blockedLevers = await readBlockedLevers(client, { worldId, worldDay: day,
        cooldownDays: COUNCIL_FALLBACK_COOLDOWN_DAYS });
      const cooldowns = await readProposalCooldowns(client, { worldId, worldDay: day });
      let [option] = councilProposalOptions({ stats, policies, blockedLevers, limit: 1, cooldowns });
      if (!option) [option] = councilProposalOptions({ stats, policies,
        blockedLevers: await readBlockedLevers(client, { worldId, worldDay: day }), limit: 1, cooldowns });
      if (option) {
        const proposer = councilProposerFor(stats, day);
        summary.proposal = await createCouncilProposal(client, { worldId, proposerAgentId: proposer,
          lever: option.lever, value: option.value, reason: option.reason, source: 'session_fallback', worldMinutes: minute })
          .catch((error) => ({ error: error.code || error.message }));
        if (summary.proposal?.proposalId) await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'propose',
          agentId: proposer, source: 'fallback', failureCode: 'NO_LUNA_PROPOSAL_ROUND', proposalId: summary.proposal.proposalId,
          decision: { propose: true, lever: option.lever }, reason: option.reason });
      }
    }
  }
  if (hour >= VOTE_FALLBACK_HOUR) {
    const open = await readOpenProposals(client, worldId);
    summary.votes = 0;
    for (const proposal of open) {
      if (minute < proposal.closesWorldMinute - (COUNCIL_SESSION_CLOSE_HOUR - VOTE_FALLBACK_HOUR) * 60) continue;
      const voted = new Set(proposal.voters);
      // external1: silent eligible external residents abstain (never a vote in their name).
      for (const resident of (stats.residents || []).filter((item) => item.external && item.councilEligible)) {
        if (voted.has(resident.agentId)) continue;
        const already = await client.query(`SELECT 1 FROM world_council_deliberations WHERE world_id=$1 AND proposal_id=$2
          AND agent_id=$3 AND phase='vote'`, [worldId, proposal.id, resident.agentId]);
        if (already.rowCount) continue;
        await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'vote', agentId: resident.agentId,
          source: 'fallback', failureCode: EXTERNAL_SILENT_ABSTAIN, proposalId: proposal.id,
          decision: { stance: 'abstain', external: true }, reason: 'Silent external resident: abstains.' });
        summary.abstentions = (summary.abstentions || 0) + 1;
      }
      const researchStance = proposal.lever_key === RESEARCH_LEVER ? researchCallStance({ value: proposal.proposed_value,
        openCalls: await openCallCount(client, worldId),
        monthRemainingRaw: (monthlyCapRaw(env) - await monthPaidRaw(client, worldId)).toString() }) : null;
      for (const resident of (stats.councilResidents || stats.residents)) {
        if (voted.has(resident.agentId)) continue;
        const { stance, reason } = researchStance || deterministicStance({ proposal, resident, stats });
        const cast = await castCouncilVote(client, { worldId, proposalId: proposal.id, agentId: resident.agentId,
          stance, reason, source: 'session_fallback', worldMinutes: minute }).catch(() => null);
        if (cast && !cast.duplicate) {
          summary.votes += 1;
          await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'vote', agentId: resident.agentId,
            source: 'fallback', failureCode: 'NO_LUNA_VOTE_BY_14H', proposalId: proposal.id, decision: { stance }, reason });
        }
      }
    }
  }
  if (hour >= COUNCIL_SESSION_CLOSE_HOUR) summary.decided = await tallyDueProposals(client, { worldId, worldMinutes: minute });
  // council3: public works (award closed tenders, reassign abandoned contracts, retry refused milestones,
  // commission fallback when Luna has not acted). This is the ONLY treasury outflow.
  summary.publicWorks = await withSavepoint(client, 'world_public_works_hour',
    () => runPublicWorksHour(client, { worldId, worldMinutes: minute, stats, env }), (error) => ({ error: error.code || error.message }));
  const services = await readCompetitionServices(client, { worldId, policies });
  summary.services = services;
  summary.proposalOptions = councilProposalOptions({ stats, policies,
    blockedLevers: await readBlockedLevers(client, { worldId, worldDay: day }), limit: 3,
    cooldowns: await readProposalCooldowns(client, { worldId, worldDay: day }) });
  summary.governorOptions = [];
  summary.priceOptions = ownerPriceOptions(services);
  return summary;
}

async function deliberationsToday(client, { worldId, worldDay }) {
  const rows = await client.query(`SELECT phase,count(*)::int AS n FROM world_council_deliberations
    WHERE world_id=$1 AND world_day=$2 GROUP BY phase`, [worldId, worldDay]);
  return Object.fromEntries(rows.rows.map((row) => [row.phase, Number(row.n) || 0]));
}

export async function runCouncilHourSafely(client, args) {
  try { await client.query('SAVEPOINT world_council_hour'); } catch (error) { return { error: error.message }; }
  try {
    const result = await runCouncilHour(client, args);
    await client.query('RELEASE SAVEPOINT world_council_hour');
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT world_council_hour').catch(() => {});
    await client.query('RELEASE SAVEPOINT world_council_hour').catch(() => {});
    return { error: String(error?.code || error?.message || 'COUNCIL_HOUR_FAILED').slice(0, 160) };
  }
}

// Per-tick snapshot for affordances (small tables only).
export async function readCouncilSnapshot(client, { worldId, cache = null, env = process.env }) {
  if (!councilEnabled(env)) return null;
  try { if (!await councilTablesReady(client)) return null; } catch { return null; }
  await client.query('SAVEPOINT world_council_snapshot');
  try {
    const open = await readOpenProposals(client, worldId);
    await client.query('RELEASE SAVEPOINT world_council_snapshot');
    return { openProposals: open, proposalOptions: cache?.proposalOptions || [],
      governorOptions: cache?.governorOptions || [], priceOptions: cache?.priceOptions || [] };
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT world_council_snapshot').catch(() => {});
    await client.query('RELEASE SAVEPOINT world_council_snapshot').catch(() => {});
    return null;
  }
}

// Pure: council affordances for one resident. Executed instantly by the engine (no walking/duration).

// Pure: council affordances for one resident in open cognition. council3: proposals, votes and the
// governor's commissions are decided by dedicated Luna calls (council-deliberation.js), so open
// cognition keeps only the owner price affordance; nothing here spends treasury SYNC.
export function buildCouncilCandidates(agent, snapshot) {
  if (!snapshot || !agent?.agentId) return [];
  const candidates = [];
  const here = agent.location || null;
  for (const option of snapshot.priceOptions || []) {
    if (option.ownerAgentId !== agent.agentId) continue;
    candidates.push({ id: `business_sync_price:${option.serviceId}:${option.toMilli}`, action: 'business_sync_price',
      goal: `${option.direction === 'lower' ? 'Lower' : 'Raise'} the SYNC price of ${option.serviceName || 'my service'} to ${option.toMilli / 1000}× the base price`,
      description: `${option.reason} Other sellers compete for the same buyers; buyers prefer the cheaper or better seller. Bounded 0.5×-2×.`,
      targetLocation: here, serviceId: option.serviceId, businessSyncPrice: option, score: 0.5 });
  }
  return candidates;
}

// Executes a council affordance chosen by cognition. reason = the resident's plan-step intent.
export async function executeCouncilCandidate(client, { worldId, agentId, candidate, reason, worldMinutes }) {
  const text = shortText(reason, 200) || 'Chosen in my own planning.';
  if (candidate.action === 'council_vote') {
    return castCouncilVote(client, { worldId, proposalId: candidate.councilVote.proposalId, agentId,
      stance: candidate.councilVote.stance, reason: text.length >= 3 ? text : 'My own judgement.', source: 'cognition', worldMinutes });
  }
  if (candidate.action === 'council_propose') {
    return createCouncilProposal(client, { worldId, proposerAgentId: agentId, lever: candidate.councilProposal.lever,
      value: candidate.councilProposal.value, reason: text.length >= 3 ? text : candidate.councilProposal.reason,
      source: 'cognition', worldMinutes });
  }
  if (candidate.action === 'treasury_spend') throw coded('TREASURY_SPEND_REMOVED', 410); // council3: no free money
  if (candidate.action === 'business_sync_price') {
    return setOwnerSyncPrice(client, { worldId, serviceId: candidate.businessSyncPrice.serviceId, agentId,
      toMilli: candidate.businessSyncPrice.toMilli, setBy: 'owner_cognition',
      reason: text.length >= 3 ? text : candidate.businessSyncPrice.reason, worldMinutes });
  }
  throw coded('COUNCIL_ACTION_INVALID', 400);
}

// Read-only council/economy section for a resident's cognition context. Returns null when the council
// tables are absent.
export async function readCouncilCognitionContext(client, { worldId, agentId, env = process.env }) {
  if (!councilEnabled(env)) return null;
  const ready = await client.query(`SELECT to_regclass('public.world_council_proposals') IS NOT NULL AS ready`);
  if (!ready.rows[0]?.ready) return null;
  const stats = await readEconomyStats(client, { worldId });
  const policies = await readCouncilPolicies(client, { worldId });
  const open = await readOpenProposals(client, worldId);
  const decided = await client.query(`SELECT title,status,yes_count,no_count,decision_reason FROM world_council_proposals
    WHERE world_id=$1 AND status<>'open' ORDER BY decided_world_minute DESC NULLS LAST,id LIMIT 3`, [worldId]);
  const me = stats.residents.find((resident) => resident.agentId === agentId);
  const works = await publicWorksReady(client) ? await readPublicWorks(client, { worldId }) : [];
  return {
    note: 'You are one of ten residents on the MirrorTerra economic council at the Central Bank; at each session you decide proposals and votes yourself. The treasury never hands out money: it only pays residents who build public works (per construction milestone). Its income is council taxes and council-approved goods. Win a public works tender and build at the site to earn treasury SYNC.',
    publicWorks: works.map((work) => ({ name: work.name, kind: work.kind, status: work.status, price: formatSyncAmount(work.price_raw),
      progress: `${work.progress}%`, yoursToBuild: work.builder_agent_id === agentId })),
    lastWorldDay: { incomeBySourceSync: Object.fromEntries(Object.entries(stats.incomeBySourceRaw)
      .map(([key, value]) => [key, formatSyncAmount(value)])), incomeTotal: formatSyncAmount(stats.incomeTotalRaw),
    spending: formatSyncAmount(stats.spendingTotalRaw), taxesCollected: formatSyncAmount(stats.taxesCollectedRaw),
    treasurySpent: formatSyncAmount(stats.treasurySpentRaw) },
    balances: { yours: formatSyncAmount(me?.balanceRaw || '0'), median: formatSyncAmount(stats.medianBalanceRaw),
      richest: formatSyncAmount(stats.maxBalanceRaw), treasury: formatSyncAmount(stats.treasuryBalanceRaw) },
    policies: Object.fromEntries(LEVER_KEYS.filter((lever) => !sameValue(policies[lever], defaultLeverValue(lever))
      || lever.startsWith('tax.')).map((lever) => [leverLabel(lever), formatLeverValue(lever, policies[lever])])),
    openProposals: open.map((proposal) => ({ proposalId: proposal.id, title: proposal.title, reason: proposal.reason,
      votes: proposal.voters.length, youVoted: proposal.voters.includes(agentId) })),
    recentDecisions: decided.rows.map((row) => ({ title: row.title, outcome: row.status, yes: row.yes_count, no: row.no_count }))
  };
}

// Read-only (SELECT only) council summary for the Central Bank panel. Names and amounts only, no ids.
export async function readCouncilSummary(pool, { worldId, env = process.env }) {
  const ready = await pool.query(`SELECT to_regclass('public.world_council_proposals') IS NOT NULL
    AND to_regclass('public.world_sync_treasury_entries') IS NOT NULL AS ready`);
  if (!ready.rows[0]?.ready) return { available: false, reason: 'council_schema_missing' };
  const clockRow = await pool.query('SELECT world_minutes::text AS world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]);
  const nowMinute = Number(clockRow.rows[0]?.world_minutes) || 0;
  const [treasury, policyRows, open, decided, spends, members, flows, votes, publicWorks] = await Promise.all([
    pool.query(`SELECT COALESCE((SELECT balance_raw FROM world_sync_treasury_balances WHERE world_id=$1),0)::text AS balance_raw,
        COALESCE((SELECT sum(amount_raw) FROM world_sync_treasury_entries WHERE world_id=$1
          AND kind IN ('sales_tax','income_tax','wealth_tax','reward_adjustment')),0)::text AS taxes_raw,
        COALESCE((SELECT sum(amount_raw) FROM world_sync_treasury_entries WHERE world_id=$1
          AND kind='public_works'),0)::text AS construction_raw,
        COALESCE((SELECT sum(COALESCE(contract_price_raw,price_raw)-paid_raw) FROM world_public_works WHERE world_id=$1
          AND status IN ('bidding','building')),0)::text AS reserved_raw`, [worldId]),
    pool.query(`SELECT lever_key,value,previous_value,effective_world_day::text AS effective_world_day
      FROM world_council_policies WHERE world_id=$1`, [worldId]),
    pool.query(`SELECT proposal.id,proposal.title,proposal.yes_count,proposal.no_count,proposer.name AS proposer,proposal.source,
        proposal.closes_world_minute::text AS closes_world_minute
      FROM world_council_proposals proposal JOIN agents proposer ON proposer.id=proposal.proposer_agent_id
      WHERE proposal.world_id=$1 AND proposal.status='open' ORDER BY proposal.opened_world_minute LIMIT 5`, [worldId]),
    pool.query(`SELECT proposal.id,proposal.title,proposal.status,proposal.yes_count,proposal.no_count,proposal.source,
        proposer.name AS proposer,proposal.effective_world_day::text AS effective_world_day
      FROM world_council_proposals proposal JOIN agents proposer ON proposer.id=proposal.proposer_agent_id
      WHERE proposal.world_id=$1 AND proposal.status<>'open'
      ORDER BY proposal.decided_world_minute DESC NULLS LAST,proposal.opened_world_minute DESC LIMIT 5`, [worldId]),
    pool.query(`SELECT entry.kind,entry.amount_raw::text AS amount_raw,entry.reason,agent.name AS to_name,entry.created_at
      FROM world_sync_treasury_entries entry JOIN agents agent ON agent.id=entry.to_agent_id
      WHERE entry.world_id=$1 AND entry.to_agent_id IS NOT NULL AND entry.kind<>'reward'
      ORDER BY entry.created_at DESC,entry.id DESC LIMIT 5`, [worldId]),
    readCouncilMembership(pool, { worldId, worldMinutes: nowMinute, env }).then((membership) => ({ rows: [{ count: membership.members,
      quorum: membership.quorum, externals: membership.externals.length, eligibleExternal: membership.eligibleExternal.length }] })),
    pool.query(`SELECT
        COALESCE(sum(amount_raw) FILTER (WHERE from_agent_id IS NOT NULL),0)::text AS in_raw,
        COALESCE(sum(amount_raw) FILTER (WHERE to_agent_id IS NOT NULL),0)::text AS out_raw,
        COALESCE(sum(amount_raw) FILTER (WHERE kind='public_works'),0)::text AS construction_raw
      FROM world_sync_treasury_entries WHERE world_id=$1 AND world_day>=$2 AND world_minute>$3`,
    [worldId, Math.max(0, worldDayOf(nowMinute) - 1), nowMinute - MINUTES_PER_WORLD_DAY]),
    // Each resident's vote with its source (llm / fallback) and short reason, for the open and latest decided proposals.
    pool.query(`SELECT vote.proposal_id,agent.name,vote.stance,vote.reason,vote.source
      FROM world_council_votes vote JOIN agents agent ON agent.id=vote.agent_id
      WHERE vote.world_id=$1 AND vote.proposal_id IN (
        (SELECT id FROM world_council_proposals WHERE world_id=$1 AND status='open')
        UNION (SELECT id FROM (SELECT id FROM world_council_proposals WHERE world_id=$1 AND status<>'open'
          ORDER BY decided_world_minute DESC NULLS LAST LIMIT 1) latest))
      ORDER BY vote.world_minute,agent.name`, [worldId]),
    readPublicWorksSummary(pool, { worldId }).catch(() => null)
  ]);
  return buildCouncilSummary({ worldMinutes: nowMinute, treasury: treasury.rows[0] || {},
    policies: policyRows.rows, open: open.rows, decided: decided.rows, spends: spends.rows,
    memberCount: members.rows[0]?.count, quorum: members.rows[0]?.quorum, externalMembers: members.rows[0]?.eligibleExternal || 0,
    enabled: councilEnabled(env), flows: flows.rows[0] || {},
    votes: votes.rows, publicWorks });
}

const SPEND_LABELS = Object.freeze({ reward: 'reward (legacy)', reward_bonus: 'reward bonus (legacy)', bounty: 'bounty (legacy)',
  subsidy: 'subsidy (legacy)', grant: 'grant (legacy)', public_works: 'construction milestone',
  service_purchase: 'service purchase (legacy)' });
const SOURCE_LABEL = (source) => (source === 'cognition' ? 'llm' : 'fallback');

// Pure: the panel's council section (names and amounts only; proposal ids only group votes and are dropped).
export function buildCouncilSummary({ worldMinutes = 0, treasury = {}, policies = [], open = [], decided = [], spends = [],
  memberCount = COUNCIL_SIZE, quorum = null, externalMembers = 0, enabled = true, flows = {}, votes = [], publicWorks = null }) {
  const quorumValue = Number(quorum) || councilQuorum(Number(memberCount) || COUNCIL_SIZE);
  const today = worldDayOf(worldMinutes);
  const effective = Object.fromEntries(LEVER_KEYS.map((lever) => [lever, defaultLeverValue(lever)]));
  const pending = [];
  for (const row of policies) {
    if (!LEVER_KEYS.includes(row.lever_key)) continue;
    const applies = Number(row.effective_world_day) <= today;
    effective[row.lever_key] = applies ? row.value : row.previous_value;
    if (!applies) pending.push({ label: leverLabel(row.lever_key), value: `${formatLeverValue(row.lever_key, row.value)} ${
      Number(row.effective_world_day) === today + 1 ? 'from tomorrow' : `from world day ${Number(row.effective_world_day) + 1}`}` });
  }
  const changed = LEVER_KEYS.filter((lever) => !lever.startsWith('tax.') && !sameValue(effective[lever], defaultLeverValue(lever)))
    .map((lever) => ({ label: leverLabel(lever), value: formatLeverValue(lever, effective[lever]) }));
  const votesFor = (id) => votes.filter((vote) => String(vote.proposal_id) === String(id)).map((vote) => ({
    name: currentResidentDisplayName(vote.name), stance: vote.stance, source: SOURCE_LABEL(vote.source), reason: shortText(vote.reason, 90) }));
  const sourceCounts = (list) => list.reduce((counts, vote) => ({ ...counts, [vote.source]: (counts[vote.source] || 0) + 1 }), { llm: 0, fallback: 0 });
  const balance = big(treasury.balance_raw), reserved = big(treasury.reserved_raw);
  return {
    available: true, enabled,
    label: 'Central Bank treasury',
    treasury: { balanceRaw: balance.toString(), taxesCollectedRaw: big(treasury.taxes_raw).toString(),
      constructionPaidRaw: big(treasury.construction_raw).toString(), reservedRaw: reserved.toString(),
      freeRaw: (balance > reserved ? balance - reserved : 0n).toString() },
    taxes: { sales: formatLeverValue('tax.sales', effective['tax.sales']), income: formatLeverValue('tax.income', effective['tax.income']),
      wealth: formatLeverValue('tax.wealth', effective['tax.wealth']) },
    policies: [...changed, ...pending].slice(0, 6),
    openProposals: open.map((row) => { const list = votesFor(row.id); return { title: row.title, yes: Number(row.yes_count) || 0,
      no: Number(row.no_count) || 0, voted: (Number(row.yes_count) || 0) + (Number(row.no_count) || 0),
      members: Number(memberCount) || COUNCIL_SIZE, quorum: quorumValue,
      proposer: row.proposer ? currentResidentDisplayName(row.proposer) : 'A resident', proposedBy: SOURCE_LABEL(row.source),
      sources: sourceCounts(list), votes: list }; }),
    decisions: decided.slice(0, 5).map((row, index) => { const list = index === 0 ? votesFor(row.id) : []; return {
      title: row.title, outcome: row.status, yes: Number(row.yes_count) || 0, no: Number(row.no_count) || 0,
      proposer: row.proposer ? currentResidentDisplayName(row.proposer) : 'A resident', proposedBy: SOURCE_LABEL(row.source),
      ...(index === 0 ? { sources: sourceCounts(list), votes: list } : {}) }; }),
    spends: spends.slice(0, 5).map((row) => ({ to: row.to_name ? currentResidentDisplayName(row.to_name) : 'A resident',
      kind: SPEND_LABELS[row.kind] || String(row.kind).replace(/_/g, ' '), amountRaw: big(row.amount_raw).toString(),
      reason: shortText(row.reason, 120), at: row.created_at ?? null })),
    rules: `Quorum ${quorumValue} of ${Number(memberCount) || COUNCIL_SIZE} · majority · effective next day · residents decide with Luna${
      Number(externalMembers) ? `; ${Number(externalMembers)} visitor${Number(externalMembers) === 1 ? '' : 's'} decide with their own AI` : ''}`,
    lastWorldDay: { inflowRaw: big(flows.in_raw).toString(), outflowRaw: big(flows.out_raw).toString(),
      constructionRaw: big(flows.construction_raw).toString() },
    publicWorks: publicWorks || { projects: [], completed: [], paidCount: 0, paidRaw: '0', deliberation: { lastWorldDay: { llm: 0, fallback: 0 }, byPhase: {} } }
  };
}

export { GUIDANCE_MODES, LEVER_KEYS, SERVICE_TYPES };
