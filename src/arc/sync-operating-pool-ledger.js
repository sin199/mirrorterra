import { createHash } from 'node:crypto';
import { TOKENOMICS_MANIFEST_HASH } from './sync-tokenomics.js';

function error(code) { return Object.assign(new Error(code), { code }); }

export function normalizeSyncPayoutRaw(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^[1-9]\d*$/.test(raw) || raw.length > 78) throw error('SYNC_PAYOUT_RAW_INVALID');
  return BigInt(raw).toString();
}

function payoutLedgerActionId(worldId, economicActionId) {
  const digest = createHash('sha256').update(`${worldId}:${economicActionId}`).digest('hex');
  return `sync-payout:${digest}`;
}

function sameAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

// Caller owns the surrounding PostgreSQL transaction. The exact raw SYNC amount
// is part of the formal economic action and is never inferred from its USDC amount.
export async function recordSyncOperatingPoolPayout(client, { worldId, economicActionId }) {
  if (!client || typeof client.query !== 'function') throw new TypeError('PostgreSQL transaction client is required.');
  if (typeof worldId !== 'string' || typeof economicActionId !== 'string' || !economicActionId.length) {
    throw error('SYNC_PAYOUT_SOURCE_ACTION_INVALID');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`sync-payout-source:${worldId}:${economicActionId}`]);
  const sourceResult = await client.query(`SELECT economic.id,economic.world_time AS "worldMinute",
      economic.sync_payout_raw::text AS "syncPayoutRaw",destination.account_type AS "destinationType",
      destination.owner_id AS "agentId"
    FROM world_economic_transactions economic
    JOIN world_economic_accounts destination ON destination.world_id=economic.world_id
      AND destination.id=economic.destination_account_id
    WHERE economic.world_id=$1 AND economic.action_id=$2 FOR UPDATE OF economic`, [worldId, economicActionId]);
  if (!sourceResult.rowCount) throw error('SYNC_PAYOUT_SOURCE_ACTION_NOT_FOUND');
  const source = sourceResult.rows[0];
  const amountRaw = normalizeSyncPayoutRaw(source.syncPayoutRaw);
  if (!amountRaw) return { created: false, idempotent: true, reason: 'no_sync_payout_authorized' };
  if (source.destinationType !== 'resident' || typeof source.agentId !== 'string') {
    throw error('SYNC_PAYOUT_SOURCE_MUST_CREDIT_RESIDENT');
  }

  const deployment = await client.query(`SELECT manifest_hash AS "manifestHash",operating_pool_address AS "poolAddress"
    FROM arc_sync_tokenomics_deployments WHERE world_id=$1 AND chain_id=5042`, [worldId]);
  if (!deployment.rowCount || deployment.rows[0].manifestHash !== TOKENOMICS_MANIFEST_HASH) {
    throw error('SYNC_TOKENOMICS_DEPLOYMENT_NOT_READY');
  }
  const wallet = await client.query(`SELECT address FROM arc_agent_wallets
    WHERE world_id=$1 AND agent_id=$2 AND chain_id=5042 AND status='active'`, [worldId, source.agentId]);
  if (wallet.rowCount !== 1 || !/^0x[0-9a-fA-F]{40}$/.test(String(wallet.rows[0]?.address || ''))) {
    throw error('SYNC_PAYOUT_AGENT_WALLET_NOT_READY');
  }
  const recipientAddress = wallet.rows[0].address;
  const actionId = payoutLedgerActionId(worldId, economicActionId);

  const existing = await client.query(`SELECT ledger.id,ledger.status,posting.amount_raw::text AS amount,
      account.account_type AS "accountType",account.agent_id AS "agentId",outbox.recipient_address AS "recipientAddress"
    FROM arc_sync_ledger_transactions ledger
    LEFT JOIN arc_sync_ledger_postings posting ON posting.world_id=ledger.world_id
      AND posting.transaction_id=ledger.id
    LEFT JOIN arc_sync_ledger_accounts account ON account.world_id=posting.world_id AND account.id=posting.account_id
    LEFT JOIN arc_sync_payout_outbox outbox ON outbox.world_id=ledger.world_id AND outbox.transaction_id=ledger.id
    WHERE ledger.world_id=$1 AND ledger.source_economic_action_id=$2
    ORDER BY posting.id`, [worldId, economicActionId]);
  if (existing.rowCount) {
    const poolDebit = existing.rows.find((row) => row.accountType === 'operating_pool');
    const agentCredit = existing.rows.find((row) => row.accountType === 'agent');
    if (existing.rowCount !== 2 || existing.rows.some((row) => row.status !== 'committed') || !poolDebit || !agentCredit
        || BigInt(poolDebit.amount) !== -BigInt(amountRaw) || BigInt(agentCredit.amount) !== BigInt(amountRaw)
        || agentCredit.agentId !== source.agentId || !sameAddress(existing.rows[0].recipientAddress, recipientAddress)) {
      throw error('SYNC_PAYOUT_ACTION_ID_CONFLICT');
    }
    return { created: false, idempotent: true, transactionId: existing.rows[0].id,
      actionId, amountRaw, recipientAddress };
  }

  const poolAccount = await client.query(`SELECT id FROM arc_sync_ledger_accounts
    WHERE world_id=$1 AND account_type='operating_pool' AND account_key='operating-pool' FOR UPDATE`, [worldId]);
  if (!poolAccount.rowCount) throw error('SYNC_OPERATING_POOL_LEDGER_NOT_INITIALIZED');
  const poolBalance = await client.query(`SELECT (account.opening_balance_raw
      + COALESCE(sum(posting.amount_raw),0))::text AS balance_raw
    FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
      ON posting.world_id=account.world_id AND posting.account_id=account.id
    WHERE account.world_id=$1 AND account.id=$2
    GROUP BY account.id,account.opening_balance_raw`, [worldId, poolAccount.rows[0].id]);
  const currentPoolBalance = BigInt(poolBalance.rows[0]?.balance_raw || '0');
  if (currentPoolBalance < BigInt(amountRaw)) throw error('SYNC_OPERATING_POOL_LEDGER_BALANCE_INSUFFICIENT');

  await client.query(`INSERT INTO arc_sync_ledger_accounts(world_id,account_type,account_key,agent_id,opening_balance_raw)
    VALUES($1,'agent',$2,$3,0) ON CONFLICT(world_id,account_key) DO NOTHING`,
  [worldId, `agent:${source.agentId}`, source.agentId]);
  const agentAccount = await client.query(`SELECT id FROM arc_sync_ledger_accounts
    WHERE world_id=$1 AND account_type='agent' AND agent_id=$2 AND account_key=$3`,
  [worldId, source.agentId, `agent:${source.agentId}`]);
  if (!agentAccount.rowCount) throw error('SYNC_AGENT_LEDGER_ACCOUNT_CONFLICT');

  const transaction = await client.query(`INSERT INTO arc_sync_ledger_transactions(world_id,action_id,
      source_economic_action_id,transaction_type,world_minute,status,metadata)
    VALUES($1,$2,$3,'operating_pool_payout',$4,'draft',jsonb_build_object('payoutAmountSource',
      'world_economic_transactions.sync_payout_raw','payoutAmountDenomination','raw_SYNC','manifestHash',$5::text))
    RETURNING id`,
  [worldId, actionId, economicActionId, Number(source.worldMinute) || 0, deployment.rows[0].manifestHash]);
  const transactionId = transaction.rows[0].id;
  await client.query(`INSERT INTO arc_sync_ledger_postings(world_id,transaction_id,account_id,amount_raw)
    VALUES($1,$2,$3,-($4::numeric)),($1,$2,$5,$4::numeric)`,
  [worldId, transactionId, poolAccount.rows[0].id, amountRaw, agentAccount.rows[0].id]);
  await client.query(`INSERT INTO arc_sync_payout_outbox(world_id,transaction_id,action_id,agent_id,
      recipient_address,amount_raw,status)
    VALUES($1,$2,$3,$4,$5,$6::numeric,'committed')`,
  [worldId, transactionId, actionId, source.agentId, recipientAddress, amountRaw]);
  await client.query(`UPDATE arc_sync_ledger_transactions SET status='committed',committed_at=now()
    WHERE world_id=$1 AND id=$2 AND status='draft'`, [worldId, transactionId]);
  return { created: true, idempotent: false, transactionId, actionId, amountRaw, recipientAddress };
}
