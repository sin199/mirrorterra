import { createHash, createPublicKey, verify } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { lockMembersFirst } from './tick-lock-order.js';

export const INFRASTRUCTURE_TREASURY_WALLET = '0x37428832cc1546aea4bc72948d739b08677d7739';
export const PLATFORM_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
export const VISITOR_HARK_AGENT_ID = 'c0c95ab1-e08c-4e06-bc99-f188730089e5';
export const EXTERNAL2_DEFAULTS = Object.freeze({ byom: false, operator_binding: false,
  public_work_rewards: false, research_rewards: false, verification_rewards: false,
  probation: false, withdrawals: false, probation_real_days: 3, probation_acceptances: 3 });
export const external2Error = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });

// Configuration is owner-written SQL, never a resident body, session GUC, or public API.
export async function readExternal2Policy(db) {
  const ready = await db.query(`SELECT to_regclass('public.world_external2_policy') IS NOT NULL AS external2_ready`);
  if (!ready.rows?.[0]?.external2_ready) return { ...EXTERNAL2_DEFAULTS };
  const row = (await db.query('SELECT * FROM world_external2_policy WHERE singleton=true')).rows[0];
  if (!row) throw external2Error('EXTERNAL2_POLICY_UNAVAILABLE', 503);
  return row;
}

export function operatorBindingMessage({ operatorId, worldId, agentId, nonce, expiresAt }) {
  return ['MirrorTerra operator resident binding v1', `operator:${operatorId}`, `world:${worldId}`,
    `agent:${agentId}`, `nonce:${nonce}`, `expires:${expiresAt}`, 'This resident is operated by the registered operator.'].join('\n');
}

export async function bindExternalOperator(db, { worldId, agentId, operatorId, nonce, expiresAt, signature }) {
  if (!(await readExternal2Policy(db)).operator_binding) throw external2Error('EXTERNAL_OPERATOR_BINDING_CLOSED', 403);
  if (!/^[0-9a-f-]{36}$/i.test(String(operatorId || '')) || !/^[A-Za-z0-9_-]{16,128}$/.test(String(nonce || ''))
      || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    throw external2Error('EXTERNAL_OPERATOR_BINDING_INVALID', 400);
  }
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt
      || expiry <= Date.now() || expiry > Date.now() + 24 * 60 * 60_000) {
    throw external2Error('EXTERNAL_OPERATOR_BINDING_EXPIRED', 400);
  }
  await lockMembersFirst(db, worldId, { agentIds: [agentId] });
  const operator = (await db.query(`SELECT public_key,independent FROM world_external_operators WHERE id=$1 AND active=true`, [operatorId])).rows[0];
  if (!operator?.public_key || operatorId === PLATFORM_OPERATOR_ID) throw external2Error('EXTERNAL_OPERATOR_NOT_TRUSTED', 403);
  const message = operatorBindingMessage({ operatorId, worldId, agentId, nonce, expiresAt });
  let valid = false;
  try {
    const key = createPublicKey(operator.public_key);
    valid = key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'));
  } catch { /* Invalid signatures cannot bind or change a resident. */ }
  if (!valid) throw external2Error('EXTERNAL_OPERATOR_SIGNATURE_INVALID', 401);
  const digest = createHash('sha256').update(message).digest('hex');
  const existing = (await db.query(`SELECT operator_id,claim_digest FROM world_external_operator_bindings
    WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId])).rows[0];
  if (existing) {
    if (existing.operator_id !== operatorId || existing.claim_digest !== digest) throw external2Error('EXTERNAL_OPERATOR_BINDING_IMMUTABLE');
    return { bound: true, duplicate: true, operatorId };
  }
  await db.query(`INSERT INTO world_external_operator_bindings(world_id,agent_id,operator_id,claim_digest,operator_signature,
      non_independent) VALUES($1,$2,$3,$4,$5,false)`, [worldId, agentId, operatorId, digest, signature]);
  return { bound: true, operatorId };
}

export async function requireExternalOperator(db, { worldId, agentId }) {
  const row = (await db.query(`SELECT operator_id,independent FROM mirrorterra_external_operator($1,$2)`, [worldId, agentId])).rows[0];
  if (!row?.operator_id || !row.independent) throw external2Error('EXTERNAL_INDEPENDENT_OPERATOR_REQUIRED', 403);
  return row;
}

export function splitExternalWithdrawal(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(raw)) throw external2Error('EXTERNAL_WITHDRAWAL_AMOUNT_INVALID', 400);
  const gross = BigInt(raw);
  if (gross > (1n << 256n) - 1n) throw external2Error('EXTERNAL_WITHDRAWAL_AMOUNT_INVALID', 400);
  const fee = gross * 3n / 100n;
  if (!fee || gross <= fee) throw external2Error('EXTERNAL_WITHDRAWAL_AMOUNT_TOO_SMALL', 400);
  return { grossRaw: raw, netRaw: String(gross - fee), feeRaw: String(fee) };
}

export function externalWithdrawalWalletMessage({ worldId, agentId, wallet }) {
  return ['MirrorTerra external withdrawal wallet v1', 'chain:5042', `world:${worldId}`, `agent:${agentId}`,
    `wallet:${String(wallet).toLowerCase()}`, 'I control this wallet for receiving my resident withdrawals.'].join('\n');
}

export async function bindExternalWithdrawalWallet(db, { worldId, agentId, wallet, signature }) {
  if (!(await readExternal2Policy(db)).withdrawals) throw external2Error('EXTERNAL_WITHDRAWALS_CLOSED', 403);
  await lockMembersFirst(db, worldId, { agentIds: [agentId] });
  await requireExternalOperator(db, { worldId, agentId });
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet || ''))) throw external2Error('EXTERNAL_WITHDRAWAL_WALLET_INVALID', 400);
  const address = wallet.toLowerCase();
  const message = externalWithdrawalWalletMessage({ worldId, agentId, wallet: address });
  let signer;
  try { signer = verifyMessage(message, signature).toLowerCase(); } catch { /* invalid signature */ }
  if (signer !== address) throw external2Error('EXTERNAL_WITHDRAWAL_WALLET_SIGNATURE_INVALID', 401);
  const prior = (await db.query(`SELECT wallet_address FROM world_external_withdrawal_wallets WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agentId])).rows[0];
  if (prior) {
    if (prior.wallet_address !== address) throw external2Error('EXTERNAL_WITHDRAWAL_WALLET_IMMUTABLE');
    return { bound: true, wallet: address, duplicate: true };
  }
  const digest = createHash('sha256').update(message).digest('hex');
  await db.query(`INSERT INTO world_external_withdrawal_wallets(world_id,agent_id,wallet_address,claim_digest) VALUES($1,$2,$3,$4)`,
    [worldId, agentId, address, digest]);
  return { bound: true, wallet: address };
}

export async function readExternalWithdrawal(db, { worldId, agentId, id }) {
  const row = (await db.query(`SELECT id,action_id AS "actionId",wallet_address AS wallet,gross_raw::text AS "grossRaw",
      net_raw::text AS "netRaw",fee_raw::text AS "feeRaw",status,payload_digest AS "payloadDigest"
    FROM world_external_withdrawals WHERE world_id=$1 AND agent_id=$2 AND id=$3`, [worldId, agentId, id])).rows[0];
  if (!row) throw external2Error('EXTERNAL_WITHDRAWAL_NOT_FOUND', 404);
  const payouts = await db.query(`SELECT payout_id AS "payoutId",kind,recipient,amount_raw::text AS "amountRaw",chain_id AS "chainId",status
    FROM world_external_payout_outbox WHERE world_id=$1 AND withdrawal_id=$2 ORDER BY kind`, [worldId, id]);
  const { payloadDigest, ...publicRow } = row;
  return { ...publicRow, payouts: payouts.rows, authorization: 'unsigned', broadcast: false, gasPayer: 'external_submitter' };
}

// Caller owns a transaction. Two deferred DB checks make any partial write uncommittable.
export async function createExternalWithdrawal(db, { worldId, agentId, actionId, grossRaw, wallet }) {
  const amounts = splitExternalWithdrawal(grossRaw);
  if (typeof actionId !== 'string' || actionId.length<8 || actionId.length>180) throw external2Error('ACTION_ID_INVALID', 400);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet || ''))) throw external2Error('EXTERNAL_WITHDRAWAL_WALLET_INVALID', 400);
  const address = wallet.toLowerCase();
  const digest = createHash('sha256').update(JSON.stringify([worldId, agentId, actionId, grossRaw, address])).digest('hex');
  await lockMembersFirst(db, worldId, { agentIds: [agentId] });
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sync-internal:${worldId}:${agentId}`]);
  const prior = (await db.query(`SELECT id,payload_digest FROM world_external_withdrawals
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, actionId])).rows[0];
  if (prior) {
    if (prior.payload_digest !== digest) throw external2Error('EXTERNAL_WITHDRAWAL_IDEMPOTENCY_CONFLICT');
    return { ...await readExternalWithdrawal(db, { worldId, agentId, id: prior.id }), duplicate: true };
  }
  if (!(await readExternal2Policy(db)).withdrawals) throw external2Error('EXTERNAL_WITHDRAWALS_CLOSED', 403);
  await requireExternalOperator(db, { worldId, agentId });
  await db.query(`UPDATE world_external_reward_holds SET released_at=now() WHERE world_id=$1 AND agent_id=$2
    AND released_at IS NULL AND mirrorterra_external_probation_complete(world_id,agent_id)`, [worldId, agentId]);
  const inserted = await db.query(`INSERT INTO world_external_withdrawals(world_id,agent_id,action_id,payload_digest,wallet_address,gross_raw,net_raw,fee_raw)
    VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric) RETURNING id`,
  [worldId, agentId, actionId, digest, address, amounts.grossRaw, amounts.netRaw, amounts.feeRaw]);
  const id = inserted.rows[0].id;
  const accounts = [
    { kind: 'resident_claim', key: `resident:${agentId}`, agent: agentId, wallet: null },
    { kind: 'external_wallet_payable', key: `wallet:${agentId}`, agent: agentId, wallet: address },
    { kind: 'infrastructure_treasury', key: 'infrastructure-treasury', agent: null, wallet: INFRASTRUCTURE_TREASURY_WALLET }
  ];
  for (const account of accounts) await db.query(`INSERT INTO world_external_ledger_accounts(world_id,kind,account_key,agent_id,wallet_address)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,account_key) DO NOTHING`, [worldId, account.kind, account.key, account.agent, account.wallet]);
  const selected = await db.query(`SELECT id,kind,agent_id FROM world_external_ledger_accounts WHERE world_id=$1
    AND (account_key=ANY($2::text[])) ORDER BY account_key`, [worldId, accounts.map((a) => a.key)]);
  const byKind = new Map(selected.rows.map((a) => [a.kind, a.id]));
  if (byKind.size!==3) throw external2Error('EXTERNAL_WITHDRAWAL_ACCOUNTS_MISSING');
  for (const payout of [
    { kind: 'resident', recipient: address, amount: amounts.netRaw, credit: 'external_wallet_payable' },
    { kind: 'infrastructure_fee', recipient: INFRASTRUCTURE_TREASURY_WALLET, amount: amounts.feeRaw, credit: 'infrastructure_treasury' }
  ]) {
    const payoutId = `0x${createHash('sha256').update(`mirrorterra-external2:${id}:${payout.kind}`).digest('hex')}`;
    const outbox = await db.query(`INSERT INTO world_external_payout_outbox(world_id,withdrawal_id,payout_id,kind,recipient,amount_raw)
      VALUES($1,$2,$3,$4,$5,$6::numeric) RETURNING id`, [worldId, id, payoutId, payout.kind, payout.recipient, payout.amount]);
    await db.query(`INSERT INTO world_external_ledger_postings(world_id,outbox_id,account_id,amount_raw)
      VALUES($1,$2,$3,-($5::numeric)),($1,$2,$4,$5::numeric)`,
    [worldId, outbox.rows[0].id, byKind.get('resident_claim'), byKind.get(payout.credit), payout.amount]);
  }
  return readExternalWithdrawal(db, { worldId, agentId, id });
}

export async function acceptExternalContribution(db, { worldId, agentId, receiptId, actionId }) {
  const receipt = (await db.query(`SELECT agent_id FROM world_external_contribution_receipts WHERE world_id=$1 AND id=$2`, [worldId, receiptId])).rows[0];
  if (!receipt) throw external2Error('EXTERNAL_CONTRIBUTION_NOT_FOUND', 404);
  await lockMembersFirst(db, worldId, { agentIds: [agentId, receipt.agent_id].sort() });
  const result = await db.query(`INSERT INTO world_external_contribution_acceptances(world_id,receipt_id,acceptor_agent_id,action_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(world_id,receipt_id) DO NOTHING RETURNING receipt_id`, [worldId, receiptId, agentId, actionId]);
  await db.query(`UPDATE world_external_reward_holds SET released_at=now() WHERE world_id=$1 AND agent_id=$2 AND released_at IS NULL
    AND mirrorterra_external_probation_complete(world_id,agent_id)`, [worldId, receipt.agent_id]);
  return { accepted: true, duplicate: !result.rowCount, receiptId };
}
