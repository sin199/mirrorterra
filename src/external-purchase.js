// external1 (user decisions 2026-10-21 14:55 and 15:01): how an external resident gets SYNC.
// The deployed SYNC protocol on Arc (chain 5042) is the ONLY seller: the Genesis Dutch Auction, then the
// Protocol Market Pool bonding curve. Price, quota (gross sales consume the 30% market quota) and USDC
// custody (all buy USDC stays in the protocol pool) are fixed on-chain. There is no operator wallet and no
// admin price here. This module is READ-ONLY towards the chain and behind MIRRORTERRA_EXTERNAL_PURCHASE
// (off by default).
//
// Flow:
//  1. bind: the resident proves control of one Arc wallet (EIP-191 signature over walletClaimMessage) in an
//     API request that is itself signed with its agent key.
//  2. buy on-chain from that wallet (auction.buy or marketPool.buy). claim(txHash) records each verified
//     SyncAuctionPurchase / ProtocolMarketBuy log once (provenance; buyer must be the bound wallet).
//  3. deposit: the wallet transfers the bought SYNC to the World Operating Pool contract (no admin withdraw;
//     only the commit-gated settlement executor pays out). claim(txHash) credits each verified Transfer log
//     once, never beyond the wallet's verified purchases. The internal "purchased" balance is then backed by
//     tokens the buyer can no longer sell back or move, so it cannot be double-spent.
//  Every credit needs N confirmations (MIRRORTERRA_EXTERNAL_PURCHASE_CONFIRMATIONS, default 12).
import { createHash } from 'node:crypto';
import { Interface, getAddress, verifyMessage } from 'ethers';
import { isExternalResident } from './external-residents.js';

export const ARC_CHAIN_ID = 5042;
export const PURCHASE_CHANNEL_CLOSED_MESSAGE = 'purchase channel not open yet';
export const AUCTION_INTERFACE = new Interface([
  'event SyncAuctionPurchase(address indexed buyer, uint256 syncAmountRaw, uint256 usdcAmountRaw, uint256 priceUsdcPerSyncE18, bytes32 indexed actionId)',
  'function finalized() view returns (bool)', 'function totalSyncSoldRaw() view returns (uint256)',
  'function totalUsdcReceivedRaw() view returns (uint256)', 'function startedAt() view returns (uint64)',
  'function currentPriceUsdcPerSyncE18() view returns (uint256)']);
export const MARKET_INTERFACE = new Interface([
  'event ProtocolMarketBuy(address indexed buyer, uint256 syncAmountRaw, uint256 grossUsdcRaw, uint256 netUsdcRaw, uint256 feeUsdcRaw, uint256 quantityBeforeRaw, uint256 quantityAfterRaw, bytes32 indexed actionId)',
  'function marketActive() view returns (bool)', 'function initialAuctionVwapE18() view returns (uint256)',
  'function initialAuctionQuantityRaw() view returns (uint256)',
  'function currentPriceUsdcPerSyncE18() view returns (bool,uint256)']);
export const TOKEN_INTERFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
export const POLICY_INTERFACE = new Interface(['function epochIndex() view returns (uint64)',
  'function marketQuota() view returns (uint256)', 'function marketReleased() view returns (uint256)']);
const AUCTION_MAX_DURATION_SECONDS = 604_800;

function coded(code, statusCode = 409, extra = {}) { return Object.assign(new Error(code), { code, statusCode, ...extra }); }
const lower = (address) => String(address || '').toLowerCase();
const hexToNumber = (value) => Number(BigInt(value || '0x0'));

export function externalPurchaseConfig(env = process.env) {
  const confirmations = Math.trunc(Number(env?.MIRRORTERRA_EXTERNAL_PURCHASE_CONFIRMATIONS ?? 12));
  return { enabled: String(env?.MIRRORTERRA_EXTERNAL_PURCHASE ?? 'off').toLowerCase() === 'on',
    minConfirmations: Number.isFinite(confirmations) && confirmations >= 1 ? Math.min(confirmations, 10_000) : 12 };
}
export function assertPurchaseGateOpen(env = process.env) {
  if (!externalPurchaseConfig(env).enabled) throw coded('EXTERNAL_PURCHASE_CLOSED', 403, { detail: PURCHASE_CHANNEL_CLOSED_MESSAGE });
}

export function walletClaimMessage({ worldId, agentId, wallet }) {
  return ['MirrorTerra external resident wallet binding v1', `chain:${ARC_CHAIN_ID}`, `world:${worldId}`,
    `agent:${agentId}`, `wallet:${lower(wallet)}`,
    'I control this wallet. SYNC I deposit from it into the World Operating Pool becomes my in-world balance.'].join('\n');
}

export async function readDeployment(client, worldId) {
  const row = (await client.query(`SELECT lower(token_address) AS token,lower(operating_pool_address) AS operating_pool,
      lower(auction_address) AS auction,lower(market_pool_address) AS market_pool,lower(genesis_policy_address) AS policy
    FROM arc_sync_tokenomics_deployments WHERE world_id=$1 AND chain_id=$2`, [worldId, ARC_CHAIN_ID])).rows[0];
  if (!row) throw coded('SYNC_DEPLOYMENT_NOT_FOUND', 409);
  return row;
}

async function withPurchaseGate(client, fn) {
  await client.query('SAVEPOINT external_purchase');
  try {
    await client.query(`SELECT set_config('mirrorterra.external_purchase','enabled',true)`);
    const result = await fn();
    await client.query(`SELECT set_config('mirrorterra.external_purchase','',true)`);
    await client.query('RELEASE SAVEPOINT external_purchase');
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT external_purchase');
    await client.query('RELEASE SAVEPOINT external_purchase');
    throw error;
  }
}

// 1. Bind one wallet (once; immutable).
export async function bindExternalWallet(client, { worldId, agentId, wallet, signature, worldMinutes = 0, env = process.env,
  recover = verifyMessage }) {
  assertPurchaseGateOpen(env);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet || ''))) throw coded('WALLET_ADDRESS_INVALID', 400);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw coded('WALLET_SIGNATURE_INVALID', 400);
  if (!await isExternalResident(client, worldId, agentId)) throw coded('EXTERNAL_RESIDENT_REQUIRED', 403);
  const message = walletClaimMessage({ worldId, agentId, wallet });
  let signer;
  try { signer = lower(recover(message, signature)); } catch { throw coded('WALLET_SIGNATURE_INVALID', 400); }
  if (signer !== lower(wallet)) throw coded('WALLET_SIGNATURE_MISMATCH', 401);
  const existing = (await client.query(`SELECT wallet_address FROM world_external_wallets WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agentId])).rows[0];
  if (existing) {
    if (existing.wallet_address === lower(wallet)) return { wallet: existing.wallet_address, bound: true, duplicate: true };
    throw coded('WALLET_ALREADY_BOUND', 409);
  }
  const taken = await client.query(`SELECT 1 FROM world_external_wallets WHERE chain_id=$1 AND wallet_address=$2`, [ARC_CHAIN_ID, lower(wallet)]);
  if (taken.rowCount) throw coded('WALLET_BOUND_TO_ANOTHER_RESIDENT', 409);
  const digest = createHash('sha256').update(`${message}\n${signature.toLowerCase()}`).digest('hex');
  await withPurchaseGate(client, () => client.query(`INSERT INTO world_external_wallets(world_id,agent_id,chain_id,wallet_address,
      claim_digest,bound_world_minute) VALUES($1,$2,$3,$4,$5,$6)`,
  [worldId, agentId, ARC_CHAIN_ID, lower(wallet), digest, Math.max(0, Math.trunc(Number(worldMinutes) || 0))]));
  return { wallet: lower(wallet), bound: true };
}

// Pure: decode a receipt into verified purchase events and deposits for one wallet.
export function decodePurchaseReceipt(receipt, { deployment, wallet, latestBlock, minConfirmations }) {
  if (!receipt || receipt.status !== '0x1') throw coded('PURCHASE_TX_NOT_SUCCESSFUL', 409);
  const blockNumber = hexToNumber(receipt.blockNumber);
  const confirmations = Number(latestBlock) - blockNumber + 1;
  if (!(blockNumber > 0) || confirmations < minConfirmations) {
    throw coded('PURCHASE_TX_NOT_CONFIRMED', 409, { confirmations: Math.max(0, confirmations), required: minConfirmations });
  }
  const me = lower(wallet);
  const purchases = [], deposits = [], foreign = [];
  for (const log of receipt.logs || []) {
    const address = lower(log.address);
    const logIndex = hexToNumber(log.logIndex);
    try {
      if (address === deployment.auction) {
        const parsed = AUCTION_INTERFACE.parseLog(log);
        if (parsed?.name !== 'SyncAuctionPurchase') continue;
        const buyer = lower(parsed.args.buyer);
        (buyer === me ? purchases : foreign).push({ source: 'genesis_auction', contract: address, logIndex, buyer,
          syncAmountRaw: parsed.args.syncAmountRaw.toString(), usdcAmountRaw: parsed.args.usdcAmountRaw.toString() });
      } else if (address === deployment.market_pool) {
        const parsed = MARKET_INTERFACE.parseLog(log);
        if (parsed?.name !== 'ProtocolMarketBuy') continue;
        const buyer = lower(parsed.args.buyer);
        (buyer === me ? purchases : foreign).push({ source: 'protocol_market', contract: address, logIndex, buyer,
          syncAmountRaw: parsed.args.syncAmountRaw.toString(), usdcAmountRaw: parsed.args.grossUsdcRaw.toString() });
      } else if (address === deployment.token) {
        const parsed = TOKEN_INTERFACE.parseLog(log);
        if (parsed?.name !== 'Transfer' || lower(parsed.args.to) !== deployment.operating_pool) continue;
        const from = lower(parsed.args.from);
        if (from === deployment.market_pool || from === deployment.policy) continue;
        (from === me ? deposits : foreign).push({ logIndex, from, to: deployment.operating_pool, token: address,
          syncAmountRaw: parsed.args.value.toString() });
      }
    } catch { /* not one of ours */ }
  }
  return { blockNumber, confirmations, purchases: purchases.filter((p) => BigInt(p.syncAmountRaw) > 0n),
    deposits: deposits.filter((d) => BigInt(d.syncAmountRaw) > 0n), foreign };
}

// 2./3. Claim a transaction hash: record its verified buys and credit its verified deposits, once each.
export async function claimExternalPurchase(client, { worldId, agentId, txHash, rpc, worldMinutes = 0, env = process.env }) {
  assertPurchaseGateOpen(env);
  const config = externalPurchaseConfig(env);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw coded('PURCHASE_TX_HASH_INVALID', 400);
  const hash = lower(txHash);
  if (!await isExternalResident(client, worldId, agentId)) throw coded('EXTERNAL_RESIDENT_REQUIRED', 403);
  const binding = (await client.query(`SELECT wallet_address FROM world_external_wallets WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agentId])).rows[0];
  if (!binding) throw coded('WALLET_NOT_BOUND', 409);
  const claimed = await client.query(`SELECT agent_id::text AS agent_id FROM world_sync_purchase_events WHERE chain_id=$1 AND tx_hash=$2
    UNION ALL SELECT agent_id::text FROM world_sync_purchases WHERE chain_id=$1 AND tx_hash=$2`, [ARC_CHAIN_ID, hash]);
  if (claimed.rowCount) throw coded('PURCHASE_ALREADY_CLAIMED', 409);
  if (!rpc) throw coded('ARC_RPC_UNAVAILABLE', 503);
  const deployment = await readDeployment(client, worldId);
  if (Number(await rpc.getChainId()) !== ARC_CHAIN_ID) throw coded('ARC_CHAIN_MISMATCH', 409);
  const [receipt, latest] = await Promise.all([rpc.getTransactionReceipt(hash), rpc.getBlockNumber()]);
  if (!receipt) throw coded('PURCHASE_TX_NOT_FOUND', 404);
  const decoded = decodePurchaseReceipt(receipt, { deployment, wallet: binding.wallet_address,
    latestBlock: hexToNumber(latest), minConfirmations: config.minConfirmations });
  if (!decoded.purchases.length && !decoded.deposits.length) {
    throw coded(decoded.foreign.length ? 'PURCHASE_WRONG_WALLET' : 'PURCHASE_TX_NO_SYNC_EVENT', 409);
  }
  const minute = Math.max(0, Math.trunc(Number(worldMinutes) || 0));
  return withPurchaseGate(client, async () => {
    const recorded = [], credited = [];
    for (const purchase of decoded.purchases) {
      await client.query(`INSERT INTO world_sync_purchase_events(world_id,agent_id,chain_id,source,contract_address,tx_hash,log_index,
          block_number,confirmations,buyer_address,sync_amount_raw,usdc_amount_raw,world_minute)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12::numeric,$13)`,
      [worldId, agentId, ARC_CHAIN_ID, purchase.source, purchase.contract, hash, purchase.logIndex, decoded.blockNumber,
        decoded.confirmations, purchase.buyer, purchase.syncAmountRaw, purchase.usdcAmountRaw, minute]);
      recorded.push(purchase);
    }
    for (const deposit of decoded.deposits) {
      await client.query(`INSERT INTO world_sync_purchases(world_id,agent_id,chain_id,token_address,tx_hash,log_index,block_number,
          confirmations,from_address,deposit_address,sync_amount_raw,world_minute)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12)`,
      [worldId, agentId, ARC_CHAIN_ID, deposit.token, hash, deposit.logIndex, decoded.blockNumber, decoded.confirmations,
        deposit.from, deposit.to, deposit.syncAmountRaw, minute]).catch((error) => {
        if (/exceeds the wallet/.test(String(error?.message))) throw coded('PURCHASE_DEPOSIT_EXCEEDS_VERIFIED_BUYS', 409);
        throw error;
      });
      credited.push(deposit);
    }
    return { txHash: hash, confirmations: decoded.confirmations, purchasesRecorded: recorded.length,
      purchasedRaw: recorded.reduce((sum, item) => sum + BigInt(item.syncAmountRaw), 0n).toString(),
      depositsCredited: credited.length,
      creditedRaw: credited.reduce((sum, item) => sum + BigInt(item.syncAmountRaw), 0n).toString() };
  });
}

// Status for GET .../external/purchase (works with the gate closed and without migration 0031 data).
export async function readExternalPurchaseStatus(client, { worldId, agentId, env = process.env, protocol = null }) {
  const config = externalPurchaseConfig(env);
  const wallet = (await client.query(`SELECT wallet_address FROM world_external_wallets WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agentId])).rows[0]?.wallet_address || null;
  const sums = (await client.query(`SELECT
      COALESCE((SELECT sum(sync_amount_raw) FROM world_sync_purchase_events WHERE world_id=$1 AND agent_id=$2),0)::text AS bought,
      COALESCE((SELECT sum(sync_amount_raw) FROM world_sync_purchases WHERE world_id=$1 AND agent_id=$2),0)::text AS credited,
      COALESCE((SELECT spendable_raw FROM arc_sync_internal_balances WHERE world_id=$1 AND agent_id=$2),0)::text AS spendable`,
  [worldId, agentId])).rows[0];
  let deployment = null;
  try { deployment = await readDeployment(client, worldId); } catch { deployment = null; }
  return { channel: config.enabled ? 'open' : 'closed', message: config.enabled ? 'Purchase channel open.' : PURCHASE_CHANNEL_CLOSED_MESSAGE,
    minConfirmations: config.minConfirmations, wallet, verifiedPurchasesRaw: sums.bought, creditedRaw: sums.credited,
    uncreditedPurchasesRaw: (BigInt(sums.bought) - BigInt(sums.credited)).toString(), spendableRaw: sums.spendable,
    how: ['Bind one Arc wallet (POST .../external/purchase/wallet with an EIP-191 signature of the binding text).',
      'Buy SYNC on Arc from that wallet: Genesis Dutch Auction buy() or Protocol Market Pool buy(). The protocol sets the price.',
      'Transfer the bought SYNC from that wallet to the World Operating Pool contract.',
      'POST .../external/purchases {txHash} for the buy and for the deposit; each log is credited once after confirmations.'],
    contracts: deployment ? { chainId: ARC_CHAIN_ID, token: deployment.token, auction: deployment.auction,
      marketPool: deployment.market_pool, depositTo: deployment.operating_pool } : null,
    protocol };
}

// Read-only protocol market status (auction state, VWAP, market pool, current buy price).
export async function readProtocolMarketStatus(rpc, deployment, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const call = async (to, iface, method) => iface.decodeFunctionResult(method, await rpc.call({ to, data: iface.encodeFunctionData(method) }, 'latest'));
  const [finalized] = await call(deployment.auction, AUCTION_INTERFACE, 'finalized');
  const [sold] = await call(deployment.auction, AUCTION_INTERFACE, 'totalSyncSoldRaw');
  const [received] = await call(deployment.auction, AUCTION_INTERFACE, 'totalUsdcReceivedRaw');
  const [startedAt] = await call(deployment.auction, AUCTION_INTERFACE, 'startedAt');
  const [auctionPrice] = await call(deployment.auction, AUCTION_INTERFACE, 'currentPriceUsdcPerSyncE18');
  const [active] = await call(deployment.market_pool, MARKET_INTERFACE, 'marketActive');
  const [defined, marketPrice] = await call(deployment.market_pool, MARKET_INTERFACE, 'currentPriceUsdcPerSyncE18');
  const endsAt = Number(startedAt) + AUCTION_MAX_DURATION_SECONDS;
  const auctionOpen = !finalized && nowSeconds < endsAt && BigInt(sold) < 100_000_000_000n;
  return { auction: { finalized, open: auctionOpen, startedAt: Number(startedAt), endsAt, totalSoldRaw: sold.toString(),
      totalUsdcRaw: received.toString(), vwapE18: BigInt(sold) > 0n ? (BigInt(received) * 10n ** 18n / BigInt(sold)).toString() : null,
      currentPriceE18: auctionPrice.toString() },
    marketPool: { active, priceDefined: defined, currentPriceE18: defined ? marketPrice.toString() : null },
    buyPossible: auctionOpen || Boolean(active) };
}

export { getAddress };
