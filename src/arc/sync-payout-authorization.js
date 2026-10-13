import { getAddress, Interface, keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { TOKENOMICS_MANIFEST_HASH } from './sync-tokenomics.js';

export const SYNC_SETTLEMENT_EXECUTOR_INTERFACE = new Interface([
  'function ledgerSigner() view returns (address)', 'function asset() view returns (address)',
  'function operatingPool() view returns (address)',
  'function executedPayouts(bytes32 payoutId) view returns (bool)',
  'function executePayout(bytes32 payoutId,address recipient,uint256 amount,address asset,bytes authorization)',
  'event LedgerPayoutExecuted(bytes32 indexed payoutId,address indexed recipient,uint256 amount,address asset)'
]);
export const SYNC_PAYOUT_TYPES = Object.freeze({ Payout: [
  { name: 'payoutId', type: 'bytes32' }, { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'asset', type: 'address' }
] });
export function syncPayoutAuthorization(executor, payout) {
  const domain = { name: 'MirrorTerra SYNC Settlement', version: '1', chainId: 5042, verifyingContract: getAddress(executor) };
  const message = { payoutId: keccak256(toUtf8Bytes(payout.action_id)), recipient: getAddress(payout.recipient_address),
    amount: BigInt(payout.amount_raw), asset: getAddress(payout.token_address) };
  return { domain, message, digest: TypedDataEncoder.hash(domain, SYNC_PAYOUT_TYPES, message) };
}
function fail(code) { throw Object.assign(new Error(code), { code }); }
function same(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }

/// All authorization comes from an existing committed authoritative economic action and its two postings.
export async function readValidatedSyncPayout(pool, { worldId, outboxId, status = 'committed' }) {
  if (!['committed','submitting'].includes(status)) fail('SYNC_PAYOUT_STATE_INVALID');
  const selected = await pool.query(`SELECT outbox.*,ledger.status AS "transactionStatus",
      ledger.action_id AS "transactionActionId",ledger.id AS "transactionId",
      ledger.source_economic_action_id AS "sourceEconomicActionId",deployment.token_address,
      deployment.operating_pool_address,deployment.settlement_worker_address,deployment.manifest_hash
    FROM arc_sync_payout_outbox outbox JOIN arc_sync_ledger_transactions ledger
      ON ledger.world_id=outbox.world_id AND ledger.id=outbox.transaction_id
    JOIN arc_sync_tokenomics_deployments deployment ON deployment.world_id=outbox.world_id
    WHERE outbox.world_id=$1 AND outbox.id=$2`, [worldId, outboxId]);
  if (selected.rowCount !== 1) fail('SYNC_PAYOUT_OUTBOX_MISSING');
  const row = selected.rows[0];
  if (row.status !== status || row.transactionStatus !== 'committed' || row.transactionActionId !== row.action_id
      || row.transactionId !== row.transaction_id || row.manifest_hash !== TOKENOMICS_MANIFEST_HASH) fail('SYNC_PAYOUT_OUTBOX_NOT_COMMITTED');
  const amount = BigInt(row.amount_raw);
  if (amount <= 0n) fail('SYNC_PAYOUT_AMOUNT_INVALID');
  const source = await pool.query(`SELECT economic.sync_payout_raw::text AS amount,
      destination.account_type AS "destinationType",destination.owner_id AS "agentId"
    FROM world_economic_transactions economic JOIN world_economic_accounts destination
      ON destination.world_id=economic.world_id AND destination.id=economic.destination_account_id
    WHERE economic.world_id=$1 AND economic.action_id=$2`, [worldId, row.sourceEconomicActionId]);
  if (source.rowCount !== 1 || BigInt(source.rows[0].amount || '0') !== amount
      || source.rows[0].destinationType !== 'resident' || source.rows[0].agentId !== row.agent_id) fail('SYNC_PAYOUT_SOURCE_ACTION_MISMATCH');
  const entries = await pool.query(`SELECT account.account_type AS "accountType",
      account.agent_id AS "agentId",posting.amount_raw::text AS amount
    FROM arc_sync_ledger_postings posting JOIN arc_sync_ledger_accounts account
      ON account.world_id=posting.world_id AND account.id=posting.account_id
    WHERE posting.world_id=$1 AND posting.transaction_id=$2`, [worldId, row.transaction_id]);
  const debit = entries.rows.find((e) => e.accountType === 'operating_pool');
  const credit = entries.rows.find((e) => e.accountType === 'agent' && e.agentId === row.agent_id);
  if (entries.rowCount !== 2 || !debit || !credit || BigInt(debit.amount) !== -amount
      || BigInt(credit.amount) !== amount) fail('SYNC_PAYOUT_DOUBLE_ENTRY_INVALID');
  const wallets = await pool.query(`SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2
    AND chain_id=5042 AND status='active'`, [worldId,row.agent_id]);
  if (wallets.rowCount !== 1 || !same(wallets.rows[0].address,row.recipient_address)) fail('SYNC_PAYOUT_AGENT_WALLET_MISMATCH');
  return row;
}
