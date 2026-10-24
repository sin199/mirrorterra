// MirrorTerra Central Bank treasury (internal ledger only).
// The treasury is an internal account at the Central Bank. Its only inflows are council taxes and
// resident purchases of council-approved goods/sinks; council3: its ONLY outflow is payment for
// building public works (milestone payments to builders, src/public-works.js). Every movement is one balanced row in world_sync_treasury_entries
// (resident <-> treasury), idempotent by entry_key and checked by a DB trigger that never lets a
// payer go below zero. Nothing here issues SYNC: the treasury only holds SYNC residents already
// earned (pool-backed pending entitlements), so total internal SYNC stays bounded by the pool and
// the epoch quota. Nothing here touches the chain, the reserve, the payout outbox or any gate.
// Kill switch: MIRRORTERRA_COUNCIL=off (also off when MIRRORTERRA_SYNC_ECONOMY=off) restores the
// pre-council reward path exactly (every reward is a pool-backed contribution) and stops taxes.
import { createHash } from 'node:crypto';
import { enqueueSyncResidentRewardContribution, normalizeSyncRewardWeight,
  syncEconomyEnabled } from './arc/sync-resident-rewards.js';

export const SYNC_RAW_PER_SYNC = 1_000_000n;
export const TREASURY_LABEL = 'Central Bank treasury';
export const TREASURY_SPEND_LABEL = 'Treasury → resident';
export const TREASURY_INFLOW_KINDS = Object.freeze(['sales_tax','income_tax','wealth_tax','reward_adjustment',
  'goods_purchase','land_rent']);
export const TREASURY_OUTFLOW_KINDS = Object.freeze(['reward','reward_bonus','bounty','subsidy','grant',
  'public_works','service_purchase']);
// Governor (MirrorTerra-01) discretionary spending. council2 (user direction 2026-10-20): NO daily
// ceiling. The only bounds are the treasury's own balance (DB trigger: never below zero) and the
// SYNC already escrowed for open contests (app: never commits the same SYNC twice).
export const TREASURY_DISCRETIONARY_KINDS = Object.freeze(['bounty','subsidy','grant','public_works','service_purchase']);
export const MINUTES_PER_WORLD_DAY = 1_440;

export const REWARD_SOURCE_TYPES = Object.freeze(['research_project','shared_project_cooperation',
  'business_production','skill_output']);
export const SERVICE_TYPES = Object.freeze(['food_service','social_service','trading_service','research_service',
  'engineering_service']);
export const GOODS = Object.freeze(['house_upgrade','tools','tuition','land_rent']);
export const GUIDANCE_MODES = Object.freeze(['balanced','bounties_first','subsidies_first','public_works','save']);

// Levers and their hard bounds (mirrored by mirrorterra_council_value_valid in migration 0028).
export const LEVER_BOUNDS = Object.freeze({
  tax: { min: 0, max: 3_000 },             // basis points: 0-30%
  multiplier: { min: 250, max: 3_000 },    // milli: 0.25x-3x
  price: { min: 500, max: 2_000 },         // milli: 0.5x-2x
  good: { min: 100_000n, max: 20_000_000n } // raw: 0.1-20 SYNC
});

export const LEVER_KEYS = Object.freeze([
  'tax.sales','tax.income','tax.wealth',
  ...REWARD_SOURCE_TYPES.map((source) => `multiplier.${source}`),
  ...SERVICE_TYPES.map((service) => `price.${service}`),
  ...GOODS.map((good) => `good.${good}`),
  'treasury.guidance'
]);

export function councilEnabled(env = process.env) {
  return String(env?.MIRRORTERRA_COUNCIL ?? 'on').trim().toLowerCase() !== 'off' && syncEconomyEnabled(env);
}

function coded(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }
const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
const minBig = (...values) => values.reduce((left, right) => (left < right ? left : right));
const maxZero = (value) => (value > 0n ? value : 0n);

export function defaultLeverValue(lever) {
  if (lever.startsWith('tax.')) return { bps: 0 };
  if (lever.startsWith('multiplier.') || lever.startsWith('price.')) return { milli: 1000 };
  if (lever.startsWith('good.')) return { offered: false };
  if (lever === 'treasury.guidance') return { mode: 'balanced' };
  return null;
}

// Pure mirror of the SQL CHECK function. Unknown levers and out-of-range values are invalid.
export function leverValueValid(lever, value) {
  if (!LEVER_KEYS.includes(lever) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const int = (n) => typeof n === 'number' && Number.isInteger(n);
  if (lever.startsWith('tax.')) return int(value.bps) && value.bps >= LEVER_BOUNDS.tax.min && value.bps <= LEVER_BOUNDS.tax.max;
  if (lever.startsWith('multiplier.')) return int(value.milli)
    && value.milli >= LEVER_BOUNDS.multiplier.min && value.milli <= LEVER_BOUNDS.multiplier.max;
  if (lever.startsWith('price.')) return int(value.milli)
    && value.milli >= LEVER_BOUNDS.price.min && value.milli <= LEVER_BOUNDS.price.max;
  if (lever.startsWith('good.')) {
    if (value.offered === false) return true;
    if (typeof value.priceRaw !== 'string' || !/^[1-9]\d{0,12}$/.test(value.priceRaw)) return false;
    const raw = BigInt(value.priceRaw);
    return raw >= LEVER_BOUNDS.good.min && raw <= LEVER_BOUNDS.good.max;
  }
  if (lever === 'treasury.guidance') return GUIDANCE_MODES.includes(value.mode);
  return false;
}

// Pure: tax due on an amount at a rate in basis points, never more than the payer can pay.
export function taxDue(amountRaw, bps, spendableRaw = null) {
  const amount = maxZero(big(amountRaw));
  const rate = BigInt(Math.max(0, Math.min(LEVER_BOUNDS.tax.max, Math.trunc(Number(bps) || 0))));
  const due = amount * rate / 10_000n;
  return spendableRaw === null ? due : minBig(due, maxZero(big(spendableRaw)));
}

// Pure: idle-balance (wealth) tax for one world day. The rate is a monthly rate charged daily
// (rate / 30) on the balance above a 50 SYNC exemption, and never exceeds the balance.
export const WEALTH_TAX_EXEMPTION_RAW = 50n * SYNC_RAW_PER_SYNC;
export function wealthTaxDue(balanceRaw, bps) {
  const balance = maxZero(big(balanceRaw));
  const taxable = maxZero(balance - WEALTH_TAX_EXEMPTION_RAW);
  const rate = BigInt(Math.max(0, Math.min(LEVER_BOUNDS.tax.max, Math.trunc(Number(bps) || 0))));
  return minBig(taxable * rate / 10_000n / 30n, balance);
}

// Pure: what a reward weight is worth after the council's source multiplier.
export function rewardAmounts({ rewardWeight, sourceType, policies = {}, rawPerWeight }) {
  const { milli } = normalizeSyncRewardWeight(rewardWeight);
  const base = milli * BigInt(rawPerWeight) / 1000n;
  const multiplier = BigInt(policies[`multiplier.${sourceType}`]?.milli ?? 1000);
  const gross = base * multiplier / 1000n;
  const incomeTax = taxDue(gross, policies['tax.income']?.bps ?? 0);
  return { baseRaw: base, multiplierMilli: Number(multiplier), grossRaw: gross, incomeTaxRaw: incomeTax,
    netRaw: gross - incomeTax };
}

// Pure: what the treasury can still commit: its balance minus the SYNC escrowed for open contests.
export function treasuryFreeBalance({ treasuryBalanceRaw, escrowRaw = 0n }) {
  return maxZero(maxZero(big(treasuryBalanceRaw)) - maxZero(big(escrowRaw)));
}

export async function treasuryTablesReady(client) {
  const result = await client.query(`SELECT to_regclass('public.world_sync_treasury_entries') IS NOT NULL
    AND to_regclass('public.world_council_policies') IS NOT NULL AS ready`);
  return result.rows?.[0]?.ready === true;
}

export function worldDayOf(worldMinutes) {
  return Math.max(0, Math.floor((Number(worldMinutes) || 0) / MINUTES_PER_WORLD_DAY));
}

// Effective council policies for a world day (defaults for levers never changed). A passed change
// applies from its effective_world_day; before that the previous value applies.
export async function readCouncilPolicies(client, { worldId, worldDay = null }) {
  const rows = await client.query(`SELECT policy.lever_key,policy.value,policy.previous_value,
      policy.effective_world_day::text AS effective_world_day,
      COALESCE($2::bigint,floor(state.world_minutes/1440.0)::bigint)::text AS today
    FROM world_council_policies policy LEFT JOIN world_runtime_state state ON state.world_id=policy.world_id
    WHERE policy.world_id=$1`, [worldId, worldDay]);
  const policies = Object.fromEntries(LEVER_KEYS.map((lever) => [lever, defaultLeverValue(lever)]));
  for (const row of rows.rows || []) {
    if (!LEVER_KEYS.includes(row.lever_key)) continue;
    const effective = Number(row.effective_world_day) <= Number(row.today) ? row.value : row.previous_value;
    if (leverValueValid(row.lever_key, effective)) policies[row.lever_key] = effective;
  }
  return policies;
}

export async function readTreasuryBalance(client, worldId) {
  const result = await client.query(`SELECT COALESCE((SELECT balance_raw FROM world_sync_treasury_balances
    WHERE world_id=$1),0)::text AS balance_raw`, [worldId]);
  return big(result.rows?.[0]?.balance_raw);
}

// SYNC committed and not yet paid: council3 public works (0030, required at startup) reserve their
// price while out to tender and the unpaid rest of the contract while being built; legacy council2
// contests and 0028 bounties still open (closed unpaid by the first council3 hour) are counted too.
export async function readTreasuryEscrow(client, worldId) {
  const result = await client.query(`SELECT
      COALESCE((SELECT sum(amount_raw) FROM world_treasury_bounties WHERE world_id=$1 AND status='open'),0)
      + COALESCE((SELECT sum(COALESCE(contract_price_raw,reward_raw)) FROM world_treasury_contests
          WHERE world_id=$1 AND status='open'),0)
      + COALESCE((SELECT sum(COALESCE(contract_price_raw,price_raw)-paid_raw) FROM world_public_works
          WHERE world_id=$1 AND status IN ('bidding','building')),0) AS escrow`, [worldId]);
  return big(result.rows?.[0]?.escrow);
}

export async function readTreasuryFreeBalance(client, worldId) {
  const [balance, escrow] = [await readTreasuryBalance(client, worldId), await readTreasuryEscrow(client, worldId)];
  return treasuryFreeBalance({ treasuryBalanceRaw: balance, escrowRaw: escrow });
}

// One balanced treasury entry, idempotent by entryKey. Exactly one of fromAgentId/toAgentId is set
// (the other side is the treasury). Runs in a savepoint: a rejected entry (insufficient balance,
// ceiling) never aborts the caller's transaction. Returns { created, id } or { created:false, rejected }.
async function isExternalRecipient(client, worldId, agentId) {
  try {
    const ready = await client.query(`SELECT to_regclass('public.world_external_residents') IS NOT NULL AS ready`);
    if (!ready.rows?.[0]?.ready) return false;
    const row = await client.query(`SELECT 1 FROM world_external_residents WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
    return Boolean(row.rowCount);
  } catch { return false; }
}

export async function postTreasuryEntry(client, { worldId, entryKey, kind, fromAgentId = null, toAgentId = null,
  amountRaw, reason, actor, sourceRef = null, worldMinute }) {
  const amount = big(amountRaw);
  if (amount <= 0n) return { created: false, rejected: 'ZERO_AMOUNT' };
  if ((fromAgentId === null) === (toAgentId === null)) throw coded('TREASURY_ENTRY_SIDE_INVALID', 400);
  if (fromAgentId && !TREASURY_INFLOW_KINDS.includes(kind)) throw coded('TREASURY_ENTRY_KIND_INVALID', 400);
  if (toAgentId && !TREASURY_OUTFLOW_KINDS.includes(kind)) throw coded('TREASURY_ENTRY_KIND_INVALID', 400);
  const minute = Math.max(0, Math.trunc(Number(worldMinute) || 0));
  const text = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  // external1: external residents receive no treasury SYNC (also enforced by a 0031 trigger).
  if (toAgentId && await isExternalRecipient(client, worldId, toAgentId)) return { created: false, rejected: 'EXTERNAL_NO_TREASURY_SYNC' };
  await client.query('SAVEPOINT world_treasury_entry');
  try {
    const inserted = await client.query(`INSERT INTO world_sync_treasury_entries(world_id,entry_key,kind,from_agent_id,
        to_agent_id,amount_raw,reason,actor,source_ref,world_day,world_minute)
      VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10,$11)
      ON CONFLICT(world_id,entry_key) DO NOTHING RETURNING id`,
    [worldId, String(entryKey).slice(0, 200), kind, fromAgentId, toAgentId, amount.toString(),
      text.length >= 3 ? text : 'Treasury entry', actor, sourceRef ? String(sourceRef).slice(0, 200) : null,
      worldDayOf(minute), minute]);
    await client.query('RELEASE SAVEPOINT world_treasury_entry');
    return inserted.rowCount ? { created: true, id: inserted.rows[0].id, amountRaw: amount.toString() }
      : { created: false, duplicate: true };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT world_treasury_entry');
    await client.query('RELEASE SAVEPOINT world_treasury_entry');
    return { created: false, rejected: String(error?.message || 'TREASURY_ENTRY_REJECTED').slice(0, 120) };
  }
}

// Reward issuance. council3 (user direction 2026-10-20): the treasury no longer pays rewards first
// (that drained it: 27.8 of 27.9 SYNC went back out as rewards); every standard reward (research,
// skill output, business production, shared projects) goes down the unchanged pool path
// (contribution -> pending entitlement, every 0018/0027 trigger and gate kept). Income tax and a
// reward weight below 1x are still settled hourly against those pool rewards by the tax collector
// (council.js collectCouncilTaxes); the treasury funds construction only.
//
// council4 (user choice 2026-10-20 21:13): a council reward weight below 1x is applied HERE, at issuance,
// instead of clawing the difference back into the treasury every hour (that was an unvoted hidden tax:
// 457.35 SYNC on 2026-10-20). The 0018/0027 triggers pin each contribution's weight to its source
// (effort points, production units, quality x factor) and each entitlement to weight x rate, so a single
// reward cannot be scaled; instead a deterministic share of the source's rewards is issued: a reward is
// issued when hash(world, source type, source entity) < weight. Over many rewards each resident receives
// weight x the base, and the rest is simply never released from the pool (no treasury entry, no ledger
// or chain posting). Weights >= 1x issue every reward (the treasury pays no bonus).
export function rewardWeightAdmits({ worldId, sourceType, sourceEntityId, milli }) {
  const weight = Math.trunc(Number(milli));
  if (!Number.isFinite(weight) || weight >= 1000) return true;
  if (weight <= 0) return false;
  const unit = createHash('sha256').update(`council-weight:${worldId}:${sourceType}:${sourceEntityId}`).digest().readUInt32BE(0)
    / 0x100000000;
  return unit < weight / 1000;
}

const WEIGHT_CACHE_MS = 15_000;
let weightCache = { worldId: null, at: 0, milli: {} };
export function resetRewardWeightCache() { weightCache = { worldId: null, at: 0, milli: {} }; }
async function councilRewardWeights(client, worldId, env) {
  if (!councilEnabled(env)) return {};
  if (weightCache.worldId === worldId && Date.now() - weightCache.at < WEIGHT_CACHE_MS) return weightCache.milli;
  let milli = {};
  await client.query('SAVEPOINT world_council_weight_read');
  try {
    const ready = await client.query(`SELECT to_regclass('public.world_council_policies') IS NOT NULL AS ready`);
    if (ready.rows?.[0]?.ready === true) {
      const policies = await readCouncilPolicies(client, { worldId });
      milli = Object.fromEntries(REWARD_SOURCE_TYPES.map((type) => [type, Number(policies[`multiplier.${type}`]?.milli) || 1000]));
    }
    await client.query('RELEASE SAVEPOINT world_council_weight_read');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT world_council_weight_read').catch(() => {});
    await client.query('RELEASE SAVEPOINT world_council_weight_read').catch(() => {});
    return {};
  }
  weightCache = { worldId, at: Date.now(), milli };
  return milli;
}

export async function issueResidentReward(client, { worldId, agentId, sourceType, sourceEventId, sourceEntityId,
  rewardWeight }, { env = process.env } = {}) {
  // external1b: external residents earn no pool rewards. Skip before the insert (the 0031 trigger would
  // only mark the row not_eligible); nothing is recorded, the source's own record (project contribution,
  // production, skill output) still counts toward council eligibility.
  if (await isExternalRecipient(client, worldId, agentId)) {
    return { created: false, skipped: 'EXTERNAL_RESIDENT', funding: 'none' };
  }
  const milli = (await councilRewardWeights(client, worldId, env))[sourceType] ?? 1000;
  if (!rewardWeightAdmits({ worldId, sourceType, sourceEntityId, milli })) {
    return { created: false, skipped: 'COUNCIL_REWARD_WEIGHT', weightMilli: milli, funding: 'pool_retained' };
  }
  const result = await enqueueSyncResidentRewardContribution(client, { worldId, agentId, sourceType, sourceEventId,
    sourceEntityId, rewardWeight }, { env });
  return { ...result, funding: 'pool' };
}

// Council price lever for internal service prices (milli, 1000 = unchanged). Never throws.
export async function readCouncilPriceMultipliers(client, { worldId, env = process.env } = {}) {
  const neutral = Object.fromEntries(SERVICE_TYPES.map((type) => [type, 1000]));
  if (!councilEnabled(env)) return neutral;
  try {
    if (!await treasuryTablesReady(client)) return neutral;
  } catch { return neutral; }
  await client.query('SAVEPOINT world_council_price_read');
  try {
    const policies = await readCouncilPolicies(client, { worldId });
    await client.query('RELEASE SAVEPOINT world_council_price_read');
    return Object.fromEntries(SERVICE_TYPES.map((type) => [type, Number(policies[`price.${type}`]?.milli) || 1000]));
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT world_council_price_read').catch(() => {});
    await client.query('RELEASE SAVEPOINT world_council_price_read').catch(() => {});
    return neutral;
  }
}

// council2: owners' competitive SYNC prices (milli of the council-adjusted base, 500-2000) by service id.
// Never throws; empty (= the deterministic demand/scarcity quote) when the council is off or 0029 absent.
export async function readOwnerSyncPriceMilli(client, { worldId, serviceId = null, env = process.env } = {}) {
  if (!councilEnabled(env)) return {};
  try {
    const ready = await client.query(`SELECT to_regclass('public.world_business_sync_prices') IS NOT NULL AS ready`);
    if (!ready.rows?.[0]?.ready) return {};
  } catch { return {}; }
  await client.query('SAVEPOINT world_owner_price_read');
  try {
    const rows = await client.query(`SELECT service_id::text AS service_id,price_milli FROM world_business_sync_prices
      WHERE world_id=$1 AND ($2::uuid IS NULL OR service_id=$2::uuid)`, [worldId, serviceId]);
    await client.query('RELEASE SAVEPOINT world_owner_price_read');
    return Object.fromEntries((rows.rows || []).map((row) => [row.service_id, Number(row.price_milli)]));
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT world_owner_price_read').catch(() => {});
    await client.query('RELEASE SAVEPOINT world_owner_price_read').catch(() => {});
    return {};
  }
}
