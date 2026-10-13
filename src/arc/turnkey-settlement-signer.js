import fs from 'node:fs/promises';
import { getAddress, JsonRpcProvider, recoverAddress, Signature, Transaction } from 'ethers';
import { ArcInfrastructureSigner, validateArcTransactionEnvelope } from './wallet-provider.js';
import { assertArcWriteAllowed } from './config.js';
import { turnkeyApiFromKeychain } from './turnkey-keychain.js';
import { parseTurnkeySignedTransactionResponse, TURNKEY_EVM_ACCOUNT } from './turnkey-wallet-provider.js';
import { readValidatedSyncPayout, syncPayoutAuthorization, SYNC_SETTLEMENT_EXECUTOR_INTERFACE as ABI } from './sync-payout-authorization.js';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function same(a,b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }

/// No arbitrary digest signing or transaction target interface is exposed by this adapter.
export class TurnkeySyncSettlementSigner extends ArcInfrastructureSigner {
  #pool; #api; #identity; #rpc;
  constructor({ config, pool, api, identity, rpc }) {
    super({ config, providerName: 'turnkey_sync_settlement' });
    if (!pool || !api || identity?.status !== 'verified' || identity?.chainId !== 5042
        || identity.agentBinding !== null || identity.allocation !== '0'
        || identity.permission !== 'committed_operating_pool_payouts_only') fail('SYNC_SETTLEMENT_IDENTITY_INVALID');
    this.#pool=pool; this.#api=api; this.#identity=Object.freeze({ ...identity });
    this.#rpc=rpc || new JsonRpcProvider(config.primaryRpcUrl,5042);
  }
  async getAddress() {
    const id=this.#identity;
    const response=await this.#api.getWalletAccounts({ organizationId:id.subOrganizationId,walletId:id.walletId });
    if (response.accounts?.length !== 1) fail('SYNC_SETTLEMENT_ACCOUNT_AMBIGUOUS');
    const a=response.accounts[0];
    if (a.organizationId !== id.subOrganizationId || a.walletId !== id.walletId
        || a.walletAccountId !== id.walletAccountId || !same(a.address,id.address)
        || Object.entries(TURNKEY_EVM_ACCOUNT).some(([k,v])=>a[k] !== v)) fail('SYNC_SETTLEMENT_ACCOUNT_MISMATCH');
    const agents=await this.#pool.query("SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND lower(address)=lower($2)",[id.worldId,id.address]);
    if (agents.rowCount !== 0) fail('SYNC_SETTLEMENT_AGENT_IDENTITY_FORBIDDEN');
    return getAddress(a.address);
  }
  async #binding(row) {
    if (Number((await this.#rpc.getNetwork()).chainId) !== 5042) fail('ARC_CHAIN_ID_MISMATCH');
    const address=await this.getAddress();
    const executor=getAddress(row.settlement_worker_address);
    if ((await this.#rpc.getCode(executor)) === '0x') fail('SYNC_SETTLEMENT_EXECUTOR_NOT_DEPLOYED');
    for (const [method,expected] of [['ledgerSigner',address],['asset',row.token_address],['operatingPool',row.operating_pool_address]]) {
      const data=await this.#rpc.call({to:executor,data:ABI.encodeFunctionData(method)});
      if (!same(ABI.decodeFunctionResult(method,data)[0],expected)) fail('SYNC_SETTLEMENT_BINDING_MISMATCH');
    }
    return {address,executor};
  }
  async authorizeCommittedPayout({ worldId, outboxId }) {
    assertArcWriteAllowed(this.config, { operation:'committed SYNC payout authorization' });
    if (worldId !== this.#identity.worldId) fail('SYNC_SETTLEMENT_WORLD_MISMATCH');
    const row=await readValidatedSyncPayout(this.#pool,{worldId,outboxId});
    const {address,executor}=await this.#binding(row);
    const {digest}=syncPayoutAuthorization(executor,row);
    const response=await this.#api.signRawPayload({organizationId:this.#identity.subOrganizationId,signWith:address,
      payload:digest.slice(2),encoding:'PAYLOAD_ENCODING_HEXADECIMAL',hashFunction:'HASH_FUNCTION_NO_OP'});
    if (response.activity?.status !== 'ACTIVITY_STATUS_COMPLETED'
        || response.activity?.type !== 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2') fail('SYNC_SETTLEMENT_SIGNATURE_INCOMPLETE');
    const nested=response.activity?.result?.signRawPayloadResult;
    if (!nested || ['r','s','v'].some((k)=>String(nested[k]) !== String(response[k]))) fail('SYNC_SETTLEMENT_SIGNATURE_SHAPE_INVALID');
    const parts={};
    for (const k of ['r','s']) {
      if (!/^(?:0x)?[0-9a-f]{64}$/i.test(response[k] || '')) fail('SYNC_SETTLEMENT_SIGNATURE_INVALID');
      parts[k]='0x'+response[k].replace(/^0x/i,'');
    }
    const v=Number(response.v);
    if (![0,1,27,28].includes(v)) fail('SYNC_SETTLEMENT_SIGNATURE_INVALID');
    const authorization=Signature.from({...parts,v:v<2?v+27:v}).serialized;
    if (!same(recoverAddress(digest,authorization),address)) fail('SYNC_SETTLEMENT_SIGNATURE_SIGNER_MISMATCH');
    return { authorization, executor, data:ABI.encodeFunctionData('executePayout',
      [syncPayoutAuthorization(executor,row).message.payoutId,row.recipient_address,row.amount_raw,row.token_address,authorization]) };
  }
  async sendTransaction(transaction) {
    assertArcWriteAllowed(this.config,{operation:'committed SYNC payout submission'});
    validateArcTransactionEnvelope(this.config,transaction);
    const parsed=ABI.parseTransaction({data:transaction.data,value:transaction.value || 0n});
    if (parsed?.name !== 'executePayout') fail('SYNC_SETTLEMENT_ONLY_PAYOUT_ALLOWED');
    const selected=await this.#pool.query(`SELECT id FROM arc_sync_payout_outbox WHERE world_id=$1 AND status='submitting'
      AND lower(transaction_sender)=lower($2) AND transaction_nonce=$3`,
      [this.#identity.worldId,transaction.from,BigInt(transaction.nonce).toString()]);
    if (selected.rowCount !== 1) fail('SYNC_SETTLEMENT_PAYOUT_AMBIGUOUS');
    const row=await readValidatedSyncPayout(this.#pool,{worldId:this.#identity.worldId,outboxId:selected.rows[0].id,status:'submitting'});
    const {address,executor}=await this.#binding(row);
    const {message,digest}=syncPayoutAuthorization(executor,row);
    if (!same(transaction.to,executor) || !same(transaction.from,address) || !same(row.transaction_sender,address)
        || BigInt(transaction.nonce) !== BigInt(row.transaction_nonce)
        || BigInt(transaction.gasLimit) !== BigInt(row.gas_limit)
        || BigInt(transaction.maxFeePerGas) !== BigInt(row.max_fee_per_gas)
        || parsed.args.payoutId !== message.payoutId || !same(parsed.args.recipient,message.recipient)
        || parsed.args.amount !== message.amount || !same(parsed.args.asset,message.asset)
        || !same(recoverAddress(digest,parsed.args.authorization),address)) fail('SYNC_SETTLEMENT_TRANSACTION_MISMATCH');
    const unsigned=Transaction.from({...transaction,from:undefined});
    const response=await this.#api.signTransaction({organizationId:this.#identity.subOrganizationId,signWith:address,
      unsignedTransaction:unsigned.unsignedSerialized,type:'TRANSACTION_TYPE_ETHEREUM'});
    const signed=parseTurnkeySignedTransactionResponse(response,{from:address,chainId:5042,to:executor,
      data:unsigned.data,value:0n,unsignedTransaction:unsigned.unsignedSerialized});
    const submitted=await this.#rpc.broadcastTransaction(signed.signedTransaction);
    if (!same(submitted.hash,signed.hash)) fail('SYNC_SETTLEMENT_BROADCAST_HASH_MISMATCH');
    return {hash:signed.hash,providerName:this.providerName};
  }
}
export async function createArcInfrastructureSigner({config,env,pool}) {
  const identity=JSON.parse(await fs.readFile(env.ARC_SYNC_SETTLEMENT_IDENTITY_FILE,'utf8'));
  const {api}=await turnkeyApiFromKeychain();
  return new TurnkeySyncSettlementSigner({config,pool,api,identity});
}
