// MirrorTerra Central Bank: the world's internal bookkeeper for SYNC.
// Display-level only. It reads the internal SYNC ledger (rewards booked by the bank and
// resident-to-resident purchases), plus the reward worker's last capacity snapshot as a
// reference figure; it never writes, never signs, and never changes payout or commit gates.
// SYNC is booked internally; nothing here moves anything on-chain.
import { SYNC_GENESIS_ISSUER_AGENT_ID } from './arc/sync-tokenomics.js';
import { SYNC_CENTRAL_BANK_NAME, SYNC_CENTRAL_BANK_PAYOUT_LABEL, deriveInternalCapacitySnapshot,
  readSyncResidentRewardCapacity } from './arc/sync-resident-rewards.js';
import { currentPlaceDisplayName, currentResidentDisplayName } from './public-display.js';
import { CENTRAL_BANK_DESCRIPTION, CENTRAL_BANK_PURPOSE, isCentralBankScene } from './central-bank-place.js';
import { readCouncilSummary } from './council.js';

// Display only: the bank's place row was created with older wording; show the bookkeeper wording.
export function presentCentralBankScene(scene) {
  return isCentralBankScene(scene)
    ? { ...scene, description: CENTRAL_BANK_DESCRIPTION, purpose: CENTRAL_BANK_PURPOSE } : scene;
}

export const CENTRAL_BANK_NAME = SYNC_CENTRAL_BANK_NAME;
export const CENTRAL_BANK_PAYOUT_LABEL = SYNC_CENTRAL_BANK_PAYOUT_LABEL;
export const CENTRAL_BANK_CONVERSION_NOTE = 'SYNC is booked internally';
export const CENTRAL_BANK_ROLE_NOTE = 'Keeps the world\'s books: every resident\'s SYNC is booked here.';
export const CENTRAL_BANK_LEDGER_RECENT_LIMIT = 10;
const RESIDENT_TO_RESIDENT = 'resident → resident';
const REWARD_REASON = Object.freeze({ skill_output: 'skill output', business_production: 'business production',
  research_project: 'research', shared_project_cooperation: 'shared project' });
const TRANSFER_REASON = Object.freeze({ business_service_payment: 'purchase', business_wage: 'wage' });
export const CENTRAL_BANK_GOVERNOR_AGENT_ID = SYNC_GENESIS_ISSUER_AGENT_ID;
export const CENTRAL_BANK_LOCATION = Object.freeze({ label: 'World centre', x: 0, z: 0 });

const RAW = /^\d+$/;
const HOME_PREFIX = 'home:';

// Friendly place name for the governor's current location: never a raw "home:<uuid>" key.
export function governorLocationLabel(location, { governorAgentId = CENTRAL_BANK_GOVERNOR_AGENT_ID, governorName = null,
  homeOwnerName = null } = {}) {
  if (typeof location !== 'string' || !location) return null;
  if (location.startsWith(HOME_PREFIX)) {
    const ownerId = location.slice(HOME_PREFIX.length);
    const owner = ownerId === governorAgentId ? governorName : homeOwnerName;
    return owner ? `${currentResidentDisplayName(owner)}'s home` : 'A resident\'s home';
  }
  if (location === 'Exchange') return 'Research Exchange';
  return currentPlaceDisplayName(location);
}
const rawOrNull = (value) => (value === null || value === undefined || !RAW.test(String(value)) ? null : String(value));

export function centralBankUnavailable(reason) {
  return { available: false, name: CENTRAL_BANK_NAME, reason, role: CENTRAL_BANK_ROLE_NOTE,
    conversion: { open: false, note: CENTRAL_BANK_CONVERSION_NOTE } };
}

export function centralBankLedgerUnavailable(reason) {
  return { available: false, reason };
}

const compareRawDesc = (left, right) => {
  const a = BigInt(left), b = BigInt(right);
  return a > b ? -1 : a < b ? 1 : 0;
};
const rawOrZero = (value) => rawOrNull(value) ?? '0';
const residentLabel = (name) => (typeof name === 'string' && name ? currentResidentDisplayName(name) : 'A resident');

// Pure: the read-only ledger view, built from rows already read. Names and amounts only: no ids.
export function buildCentralBankLedger({ balances = [], totals = {}, counts = {}, recent = [],
  recentLimit = CENTRAL_BANK_LEDGER_RECENT_LIMIT } = {}) {
  const residents = balances
    .map((row) => ({ name: residentLabel(row.name), balanceRaw: rawOrZero(row.balanceRaw) }))
    .sort((left, right) => compareRawDesc(left.balanceRaw, right.balanceRaw) || left.name.localeCompare(right.name));
  const entries = recent
    .map((row) => {
      const reward = row.entryType === 'reward';
      const kind = reward ? row.sourceType : row.kind;
      const reason = reward ? (REWARD_REASON[kind] || String(kind || 'reward').replace(/_/g, ' '))
        : [TRANSFER_REASON[kind] || String(kind || 'transfer').replace(/_/g, ' '), row.serviceName].filter(Boolean).join(' · ');
      return { type: reward ? 'reward' : 'purchase',
        from: reward ? CENTRAL_BANK_NAME : residentLabel(row.fromName),
        to: residentLabel(row.toName),
        label: reward ? CENTRAL_BANK_PAYOUT_LABEL : RESIDENT_TO_RESIDENT,
        amountRaw: rawOrZero(row.amountRaw), reason, at: row.createdAt ?? null,
        sortKey: row.sortKey ?? null };
    })
    .sort((left, right) => (left.sortKey === null || right.sortKey === null ? 0
      : String(right.sortKey).localeCompare(String(left.sortKey))))
    .slice(0, Math.max(0, recentLimit))
    .map(({ sortKey, ...entry }) => entry);
  return {
    available: true,
    residents,
    totals: {
      bookedRaw: rawOrZero(totals.bookedRaw),
      pendingRaw: rawOrZero(totals.pendingRaw),
      rewardCount: Number(totals.rewardCount) || 0
    },
    counts: {
      internalTrades: Number(counts.internalTrades) || 0,
      internalTransfers: Number(counts.internalTransfers) || 0
    },
    recent: entries
  };
}

async function ledgerSchemaReady(pool) {
  const result = await pool.query(`SELECT to_regclass('public.arc_sync_internal_balances') IS NOT NULL
      AND to_regclass('public.arc_sync_internal_transfers') IS NOT NULL
      AND to_regclass('public.world_sync_internal_orders') IS NOT NULL AS ready`);
  return result.rows[0]?.ready === true;
}

// Read-only (SELECT only). Uses the arc_sync_internal_balances view from migration 0027.
export async function readCentralBankLedger(pool, { worldId, recentLimit = CENTRAL_BANK_LEDGER_RECENT_LIMIT } = {}) {
  if (!worldId) return centralBankLedgerUnavailable('world_missing');
  if (!await ledgerSchemaReady(pool)) return centralBankLedgerUnavailable('sync_ledger_schema_missing');
  const limit = Math.max(1, Math.min(20, Number(recentLimit) || CENTRAL_BANK_LEDGER_RECENT_LIMIT));
  const [balances, totals, counts, recent] = await Promise.all([
    pool.query(`SELECT agent.name,balance.spendable_raw::text AS "balanceRaw"
      FROM arc_sync_internal_balances balance JOIN agents agent ON agent.id=balance.agent_id
      WHERE balance.world_id=$1`, [worldId]),
    pool.query(`SELECT COALESCE(sum(sync_amount_raw),0)::text AS "bookedRaw",
        COALESCE(sum(sync_amount_raw) FILTER (WHERE status='pending'),0)::text AS "pendingRaw",
        count(*)::int AS "rewardCount"
      FROM arc_sync_resident_reward_entitlements WHERE world_id=$1`, [worldId]),
    pool.query(`SELECT (SELECT count(*)::int FROM world_sync_internal_orders WHERE world_id=$1) AS "internalTrades",
        (SELECT count(*)::int FROM arc_sync_internal_transfers WHERE world_id=$1) AS "internalTransfers"`, [worldId]),
    pool.query(`SELECT * FROM (
        (SELECT 'reward' AS "entryType",NULL::text AS "fromName",agent.name AS "toName",
          entitlement.sync_amount_raw::text AS "amountRaw",contribution.source_type AS "sourceType",NULL::text AS kind,
          NULL::text AS "serviceName",entitlement.created_at AS "createdAt",
          to_char(entitlement.created_at AT TIME ZONE 'UTC','YYYYMMDDHH24MISSUS') AS "sortKey"
        FROM arc_sync_resident_reward_entitlements entitlement
        JOIN arc_sync_resident_reward_contributions contribution
          ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
        JOIN agents agent ON agent.id=entitlement.agent_id
        WHERE entitlement.world_id=$1 ORDER BY entitlement.created_at DESC,entitlement.id DESC LIMIT $2)
        UNION ALL
        (SELECT 'transfer',sender.name,receiver.name,transfer.amount_raw::text,NULL::text,transfer.kind,
          service.name,transfer.created_at,
          to_char(transfer.created_at AT TIME ZONE 'UTC','YYYYMMDDHH24MISSUS')
        FROM arc_sync_internal_transfers transfer
        JOIN agents sender ON sender.id=transfer.from_agent_id
        JOIN agents receiver ON receiver.id=transfer.to_agent_id
        LEFT JOIN world_sync_internal_orders internal_order
          ON internal_order.world_id=transfer.world_id AND internal_order.transfer_id=transfer.id
        LEFT JOIN world_business_services service ON service.id=internal_order.service_id
        WHERE transfer.world_id=$1 ORDER BY transfer.created_at DESC,transfer.id DESC LIMIT $2)
      ) entries ORDER BY "sortKey" DESC LIMIT $2`, [worldId, limit])
  ]);
  return buildCentralBankLedger({ balances: balances.rows, totals: totals.rows[0] || {}, counts: counts.rows[0] || {},
    recent: recent.rows, recentLimit: limit });
}

// Pure: shapes what the vault shows from rows already read. Every number comes from an input;
// a value with no source stays null instead of being estimated.
export function buildCentralBankSummary({ savedSnapshot = null, nowSeconds, ledgerPoolBalanceRaw = null,
  capacity = null, pending = {}, totals = {}, governor = null, ledger = null, council = null, symbol = 'SYNC', decimals = 6 }) {
  const snapshot = savedSnapshot ? {
    blockNumber: String(savedSnapshot.block_number ?? savedSnapshot.blockNumber),
    epochIndex: String(savedSnapshot.epoch_index ?? savedSnapshot.epochIndex),
    epochStart: String(savedSnapshot.epoch_start ?? savedSnapshot.epochStart),
    economyQuotaRaw: rawOrNull(savedSnapshot.economy_quota_raw ?? savedSnapshot.economyQuotaRaw),
    onchainPoolBalanceRaw: rawOrNull(savedSnapshot.onchain_pool_balance_raw ?? savedSnapshot.onchainPoolBalanceRaw),
    observedAt: savedSnapshot.observed_at ?? savedSnapshot.observedAt ?? null } : null;
  const current = savedSnapshot && Number.isFinite(Number(nowSeconds))
    ? deriveInternalCapacitySnapshot(savedSnapshot, nowSeconds) : null;
  const vaultSource = snapshot?.onchainPoolBalanceRaw ? 'chain_snapshot' : rawOrNull(ledgerPoolBalanceRaw) ? 'db_ledger' : null;
  const vaultBalanceRaw = vaultSource === 'chain_snapshot' ? snapshot.onchainPoolBalanceRaw
    : vaultSource === 'db_ledger' ? String(ledgerPoolBalanceRaw) : null;
  const epochEndSeconds = snapshot ? (BigInt(snapshot.epochStart) + 2_592_000n).toString() : null;
  return {
    available: true,
    name: CENTRAL_BANK_NAME,
    kind: 'institution',
    location: { ...CENTRAL_BANK_LOCATION },
    role: CENTRAL_BANK_ROLE_NOTE,
    governor: governor ? { name: currentResidentDisplayName(governor.name),
      title: 'Governor', location: governorLocationLabel(governor.location ?? null, { governorAgentId: governor.agentId,
        governorName: governor.name, homeOwnerName: governor.homeOwnerName ?? null }),
      atBank: governor.location === CENTRAL_BANK_NAME,
      atHome: typeof governor.location === 'string' && governor.location.startsWith(HOME_PREFIX) }
      : { name: null, title: 'Governor', location: null, atBank: false, atHome: false },
    institutionalReserve: true,
    reserveNote: 'Reference only: the SYNC operating pool figure. It is not in circulation and is not the governor\'s personal wealth.',
    token: { symbol, decimals },
    vault: {
      balanceRaw: vaultBalanceRaw,
      source: vaultSource,
      onchainPoolBalanceRaw: snapshot?.onchainPoolBalanceRaw ?? null,
      ledgerPoolBalanceRaw: rawOrNull(ledgerPoolBalanceRaw),
      snapshotBlock: snapshot?.blockNumber ?? null,
      snapshotObservedAt: snapshot?.observedAt ?? null
    },
    epoch: {
      index: current?.epochIndex ?? snapshot?.epochIndex ?? null,
      startsAtSeconds: snapshot?.epochStart ?? null,
      endsAtSeconds: epochEndSeconds,
      quotaRaw: current ? current.economyQuotaRaw : null,
      quotaRemainingRaw: current && capacity ? capacity.quotaRemainingRaw.toString() : null,
      capacityRemainingRaw: current && capacity ? capacity.remainingRaw.toString() : null,
      status: !snapshot ? 'no_chain_snapshot_yet' : current ? 'current' : 'awaiting_chain_snapshot_for_current_epoch'
    },
    pendingEntitlements: {
      totalRaw: rawOrNull(pending.totalRaw) ?? '0',
      count: Number(pending.count) || 0,
      residents: Number(pending.residents) || 0
    },
    payouts: {
      label: CENTRAL_BANK_PAYOUT_LABEL,
      totalRaw: rawOrNull(totals.totalRaw) ?? '0',
      count: Number(totals.count) || 0
    },
    ledger: ledger || centralBankLedgerUnavailable('not_read'),
    council: council || { available: false, reason: 'not_read' },
    onChainTransfers: false,
    conversion: { open: false, note: CENTRAL_BANK_CONVERSION_NOTE }
  };
}

async function bankSchemaReady(pool) {
  const result = await pool.query(`SELECT to_regclass('public.arc_sync_reward_capacity_snapshots') IS NOT NULL
      AND to_regclass('public.arc_sync_resident_reward_entitlements') IS NOT NULL
      AND to_regclass('public.arc_sync_ledger_accounts') IS NOT NULL AS ready`);
  return result.rows[0]?.ready === true;
}

// Read-only. Safe on a default_transaction_read_only pool.
export async function readCentralBankSummary(pool, { worldId } = {}) {
  if (!worldId) return centralBankUnavailable('world_missing');
  if (!await bankSchemaReady(pool)) return centralBankUnavailable('sync_economy_schema_missing');
  const [snapshotRows, ledger, pending, totals, governor, bookLedger, council] = await Promise.all([
    pool.query(`SELECT block_number::text AS block_number,epoch_index::text AS epoch_index,
        epoch_start::text AS epoch_start,economy_quota_raw::text AS economy_quota_raw,
        onchain_pool_balance_raw::text AS onchain_pool_balance_raw,observed_at,
        extract(epoch FROM now())::bigint::text AS now_seconds
      FROM arc_sync_reward_capacity_snapshots WHERE world_id=$1
      ORDER BY block_number DESC,id DESC LIMIT 1`, [worldId]),
    pool.query(`SELECT (account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0))::text AS balance_raw
      FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
        ON posting.world_id=account.world_id AND posting.account_id=account.id
      WHERE account.world_id=$1 AND account.account_type='operating_pool' AND account.account_key='operating-pool'
      GROUP BY account.id,account.opening_balance_raw`, [worldId]),
    pool.query(`SELECT COALESCE(sum(sync_amount_raw),0)::text AS "totalRaw",count(*)::int AS count,
        count(DISTINCT agent_id)::int AS residents
      FROM arc_sync_resident_reward_entitlements WHERE world_id=$1 AND status='pending'`, [worldId]),
    pool.query(`SELECT COALESCE(sum(sync_amount_raw),0)::text AS "totalRaw",count(*)::int AS count
      FROM arc_sync_resident_reward_entitlements WHERE world_id=$1`, [worldId]),
    pool.query(`SELECT agent.id AS "agentId",agent.name,member.location,owner.name AS "homeOwnerName"
      FROM agents agent LEFT JOIN world_members member ON member.world_id=$1 AND member.agent_id=agent.id
      LEFT JOIN agents owner ON member.location LIKE 'home:%' AND owner.id::text=substr(member.location,6)
      WHERE agent.id=$2`, [worldId, CENTRAL_BANK_GOVERNOR_AGENT_ID]),
    // A ledger read failure only blanks the ledger view, never the whole bank.
    readCentralBankLedger(pool, { worldId }).catch(() => centralBankLedgerUnavailable('read_failed')),
    // Treasury and council (migration 0028); a failure only blanks this section.
    readCouncilSummary(pool, { worldId }).catch(() => ({ available: false, reason: 'read_failed' }))
  ]);
  const saved = snapshotRows.rows[0] || null;
  const current = saved ? deriveInternalCapacitySnapshot(saved, saved.now_seconds) : null;
  // Quota remaining uses the same capacity math as the reward worker, for the current epoch only.
  const capacity = current && ledger.rowCount === 1
    ? await readSyncResidentRewardCapacity(pool, worldId, current).catch(() => null) : null;
  return buildCentralBankSummary({ savedSnapshot: saved, nowSeconds: saved?.now_seconds,
    ledgerPoolBalanceRaw: ledger.rows[0]?.balance_raw ?? null, capacity, pending: pending.rows[0] || {},
    totals: totals.rows[0] || {}, governor: governor.rows[0] || null, ledger: bookLedger, council });
}
