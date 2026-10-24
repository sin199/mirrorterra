import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TypedDataEncoder, SigningKey, computeAddress } from 'ethers';
import { arcNetworkConfig } from '../src/arc/config.js';
import { TurnkeySyncSettlementSigner } from '../src/arc/turnkey-settlement-signer.js';
import { readValidatedSyncPayout, syncPayoutAuthorization, SYNC_PAYOUT_TYPES } from '../src/arc/sync-payout-authorization.js';
import { SYNC_SETTLEMENT_EXECUTOR_INTERFACE } from '../src/arc/sync-payout-authorization.js';
import { TURNKEY_EVM_ACCOUNT } from '../src/arc/turnkey-wallet-provider.js';
import { TOKENOMICS_MANIFEST_HASH } from '../src/arc/sync-tokenomics.js';

const address='0x1111111111111111111111111111111111111111';
const executor='0x2222222222222222222222222222222222222222';
const row={ id:'outbox',world_id:'world',agent_id:'agent',status:'committed',transaction_id:'ledger',
  externalResident:false,transactionStatus:'committed',transactionActionId:'action',transactionId:'ledger',sourceEconomicActionId:'source',
  action_id:'action',amount_raw:'100',recipient_address:address,token_address:address,manifest_hash:TOKENOMICS_MANIFEST_HASH };
function pool(overrides={}) {
  const responses=[{...row,...overrides.row}, {amount:'100',recipient:address,verifiedAmount:'100',
    workOrderCount:1,validCount:1,agentId:'agent'},
    [{accountType:'operating_pool',amount:'-100'},{accountType:'agent',agentId:'agent',amount:'100'}],{address}];
  if(overrides.source)responses[1]=overrides.source;
  if(overrides.postings)responses[2]=overrides.postings;
  return {async query(){const value=responses.shift();const rows=Array.isArray(value)?value:[value];return {rows,rowCount:rows.length};}};
}
test('settlement authorization binds chain, executor, payout, recipient, amount and asset',()=>{
  const auth=syncPayoutAuthorization(executor,row);
  assert.equal(auth.domain.chainId,5042);
  assert.equal(auth.domain.verifyingContract,executor);
  for(const [field,value] of [['payoutId','0x'+'55'.repeat(32)],['recipient',executor],['amount',101n],['asset',executor]]) {
    assert.notEqual(auth.digest,TypedDataEncoder.hash(auth.domain,SYNC_PAYOUT_TYPES,{...auth.message,[field]:value}));
  }
  for(const changes of [{chainId:5043},{verifyingContract:address}]) {
    assert.notEqual(auth.digest,TypedDataEncoder.hash({...auth.domain,...changes},SYNC_PAYOUT_TYPES,auth.message));
  }
});
test('payout requires committed source, conserved two postings and active Agent wallet',async()=>{
  assert.equal((await readValidatedSyncPayout(pool(),{worldId:'world',outboxId:'outbox'})).amount_raw,'100');
  for(const options of [{row:{status:'pending'}},{source:{amount:'101',destinationType:'resident',agentId:'agent'}},
    {postings:[{accountType:'operating_pool',amount:'-99'},{accountType:'agent',agentId:'agent',amount:'100'}]}]) {
    await assert.rejects(readValidatedSyncPayout(pool(options),{worldId:'world',outboxId:'outbox'}));
  }
});
test('gate false blocks both authorization and submission before any provider or database call',async()=>{
  let calls=0;
  const signer=new TurnkeySyncSettlementSigner({config:arcNetworkConfig({MAINNET_WRITE_GATE:'false',
      SYNC_COMMITTED_PAYOUT_WRITE_GATE:'false'}),
    pool:{query(){calls++;throw new Error('must not query');}},api:{signRawPayload(){calls++;},signTransaction(){calls++;}},
    identity:{status:'verified',chainId:5042,agentBinding:null,allocation:'0',permission:'committed_operating_pool_payouts_only'}});
  await assert.rejects(signer.authorizeCommittedPayout({worldId:'world',outboxId:'outbox'}),{code:'SYNC_COMMITTED_PAYOUT_WRITE_GATE_CLOSED'});
  await assert.rejects(signer.sendTransaction({}),{code:'SYNC_COMMITTED_PAYOUT_WRITE_GATE_CLOSED'});
  assert.equal(calls,0);
});
test('executor exposes only payout execution and has no reserve or monetary administration path',async()=>{
  const source=await fs.readFile(new URL('../contracts/src/SyncSettlementExecutor.sol',import.meta.url),'utf8');
  assert.match(source,/chainId|_hashTypedDataV4/);
  assert.match(source,/executedPayouts\[payoutId\] = true/);
  assert.match(source,/operatingPool.executeCommittedPayout/);
  assert.doesNotMatch(source,/function (set|withdraw|upgrade|release|approve|delegatecall)/);
  assert.doesNotMatch(source,/\.call\(|\.delegatecall\(|reserve\.release/);
});
test('scoped adapter signs only the committed payout digest and checks actual SDK raw signature shape',async()=>{
  const key=new SigningKey('0x'+'12'.repeat(32));
  const signerAddress=computeAddress(key.publicKey);
  const ledger=pool({row:{settlement_worker_address:executor,operating_pool_address:address}});
  let signedDigest=null;
  const signer=new TurnkeySyncSettlementSigner({config:arcNetworkConfig({MAINNET_WRITE_GATE:'false',
      SYNC_COMMITTED_PAYOUT_WRITE_GATE:'true'}),
    pool:{async query(sql,...args){if(sql.startsWith('SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND lower'))return {rows:[],rowCount:0};return ledger.query(sql,...args);}},
    identity:{status:'verified',chainId:5042,worldId:'world',address:signerAddress,subOrganizationId:'sub',walletId:'wallet',walletAccountId:'account',
      agentBinding:null,allocation:'0',permission:'committed_operating_pool_payouts_only'},
    api:{async getWalletAccounts(){return {accounts:[{...TURNKEY_EVM_ACCOUNT,organizationId:'sub',walletId:'wallet',walletAccountId:'account',address:signerAddress}]};},
      async signRawPayload(request){signedDigest='0x'+request.payload;assert.equal(request.organizationId,'sub');assert.equal(request.signWith,signerAddress);
        const sig=key.sign(signedDigest);const parts={r:sig.r.slice(2),s:sig.s.slice(2),v:String(sig.yParity)};
        return {...parts,activity:{status:'ACTIVITY_STATUS_COMPLETED',type:'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',result:{signRawPayloadResult:parts}}};}},
    rpc:{async getNetwork(){return {chainId:5042n};},async getCode(){return '0x01';},async call(tx){
      const method=SYNC_SETTLEMENT_EXECUTOR_INTERFACE.parseTransaction(tx).name;
      return SYNC_SETTLEMENT_EXECUTOR_INTERFACE.encodeFunctionResult(method,[method==='ledgerSigner'?signerAddress:address]);}}
  });
  const result=await signer.authorizeCommittedPayout({worldId:'world',outboxId:'outbox'});
  assert.equal(signedDigest,syncPayoutAuthorization(executor,row).digest);
  const parsed=SYNC_SETTLEMENT_EXECUTOR_INTERFACE.parseTransaction(result);
  assert.equal(parsed.name,'executePayout');assert.equal(parsed.args.amount,100n);
  assert.equal(result.executor,executor);
  await assert.rejects(signer.authorizeCommittedPayout({worldId:'other',outboxId:'outbox'}),{code:'SYNC_SETTLEMENT_WORLD_MISMATCH'});
});
