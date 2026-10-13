import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { Interface, getAddress, getCreateAddress, keccak256, toUtf8Bytes, formatUnits } from 'ethers';
import { arcNetworkConfig } from '../../src/arc/config.js';
import { ArcRpcClient } from '../../src/arc/rpc.js';
import { verifyArc8004IdentityOwner } from '../../src/arc/identity-registry.js';
import { inspectSyncTokenomicsSpecification, TOKENOMICS_MANIFEST_HASH, SYNC_TOKENOMICS_MANIFEST } from '../../src/arc/sync-tokenomics.js';
import { turnkeyApiFromKeychain } from '../../src/arc/turnkey-keychain.js';
import { TURNKEY_EVM_ACCOUNT } from '../../src/arc/turnkey-wallet-provider.js';

const WORLD='ce434421-8bcd-4aac-b9ba-183383c713de';
const ISSUER='f952ef0a-001f-408e-8e5d-684b63f133ac';
const WALLET='0x29Fef6FE7d56b929Afe613C0358B81c054652d42';
const PROPOSAL='56a7cfd7-5ec9-481a-bd6f-f0e4be7c0275';
const SPEC_HASH='0x43b090dab99a6bc30c6d2f44aa99cbb4d4831e01077410fac7af125e85751368';
const names=['SyncTokenomicsGenesis','SyncFixedSupplyToken','SyncGenesisReserve','SyncWorldOperatingPool',
  'SyncProtocolMarketPool','SyncGenesisDutchAuction','SyncSettlementExecutor'];
const writable={SyncTokenomicsGenesis:['refillOperatingPool','releaseAuctionSale','finalizeGenesisAuction','releaseProtocolMarketSale'],
  SyncFixedSupplyToken:['transfer','approve','transferFrom'],SyncGenesisReserve:['release'],
  SyncWorldOperatingPool:['executeCommittedPayout'],SyncProtocolMarketPool:['activate','buy','sell'],
  SyncGenesisDutchAuction:['buy','finalize'],SyncSettlementExecutor:['executePayout']};
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const asJson=(v)=>JSON.stringify(v,(_,value)=>typeof value==='bigint'?value.toString():value,2)+'\n';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try {
  if(process.env.MAINNET_WRITE_GATE !== 'false')fail('PREFLIGHT_WRITE_GATE_MUST_BE_FALSE');
  const config=arcNetworkConfig(process.env);
  const rpc=new ArcRpcClient({config,timeoutMs:20_000});
  // A read-only repeatable snapshot; no reservation, calldata, outbox or deployment row is written.
  const db=await pool.connect();let data;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const proposal=(await db.query('SELECT * FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2',[WORLD,PROPOSAL])).rows[0];
    const wallet=(await db.query("SELECT * FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2 AND status='active' AND chain_id=5042",[WORLD,ISSUER])).rows;
    const decisions=(await db.query('SELECT agent_id,decision,world_minute,action_id FROM arc_token_issuance_decisions WHERE world_id=$1 AND intent_id=$2 ORDER BY created_at',[WORLD,PROPOSAL])).rows;
    const budget=(await db.query('SELECT * FROM arc_mainnet_pilot_budget WHERE id=1')).rows[0];
    const old=(await db.query('SELECT id,status,superseded_reason FROM arc_token_issuance_intents WHERE id=$1',['c8973c8b-e71d-49ea-9961-8c043c48b554'])).rows[0];
    const world=(await db.query('SELECT world_id AS id,world_minutes AS world_minute FROM world_runtime_state WHERE world_id=$1',[WORLD])).rows[0];
    const requirement=(await db.query('SELECT * FROM arc_currency_genesis_requirements WHERE world_id=$1',[WORLD])).rows[0];
    const counts={};
    for(const table of ['arc_agent_wallets','arc_genesis_token_settlement_outbox','arc_sync_payout_outbox','arc_sync_tokenomics_deployments','arc_agent_tokens']) {
      counts[table]=Number((await db.query(`SELECT count(*) AS count FROM ${table} WHERE world_id=$1`,[WORLD])).rows[0].count);
    }
    const agentCount=Number((await db.query('SELECT count(*) AS count FROM world_members WHERE world_id=$1',[WORLD])).rows[0].count);
    await db.query('COMMIT');data={proposal,wallet,decisions,budget,old,world,requirement,counts,agentCount};
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
  const {proposal,wallet,decisions,budget,old,world,requirement,counts,agentCount}=data;
  if(proposal?.status !== 'issuer_confirmed'||proposal.issuer_agent_id!==ISSUER||wallet.length!==1
      ||!same(wallet[0].address,WALLET)||!same(proposal.issuer_wallet,WALLET)
      ||proposal.issuer_selection_source!=='creator_genesis_assignment'||wallet[0].external_identity_id!=='2378'
      ||proposal.metadata.tokenomicsManifestHash!==TOKENOMICS_MANIFEST_HASH
      ||proposal.specification_hash!==SPEC_HASH||proposal.prepared_calldata!==null||proposal.transaction_hash!==null
      ||!decisions.some(d=>d.agent_id===ISSUER&&d.decision==='issuer_confirm'&&d.world_minute===proposal.issuer_confirmed_world_minute)
      ||counts.arc_sync_tokenomics_deployments!==0||counts.arc_agent_tokens!==0
      ||counts.arc_genesis_token_settlement_outbox!==0||counts.arc_sync_payout_outbox!==0
      ||counts.arc_agent_wallets!==10||agentCount!==10||old?.status!=='superseded')fail('PREFLIGHT_FORMAL_STATE_MISMATCH');
  const spec=proposal.metadata.agentSpecification;
  const validation=inspectSyncTokenomicsSpecification(spec);
  if(validation.specificationHash!==SPEC_HASH)fail('PREFLIGHT_SPECIFICATION_MISMATCH');
  const confirmation=JSON.parse(await fs.readFile('.synterra/preflights/SYNC_CONFIRMATION_COGNITION_RESULT.json','utf8'));
  if(confirmation.intentId!==PROPOSAL||confirmation.decision!=='confirm'||confirmation.specificationHash!==SPEC_HASH
      ||confirmation.manifestHash!==TOKENOMICS_MANIFEST_HASH||String(confirmation.worldMinute)!==proposal.issuer_confirmed_world_minute)fail('PREFLIGHT_CONFIRMATION_EVIDENCE_MISMATCH');
  const identity=await verifyArc8004IdentityOwner({rpc,config,identityId:'2378',issuerWallet:WALLET});
  if(!identity.ready)fail('TOKEN_ISSUER_IDENTITY_NOT_READY');
  const settlement=JSON.parse(await fs.readFile(process.env.ARC_SYNC_SETTLEMENT_IDENTITY_FILE||'.synterra/settlement-identity.json','utf8'));
  if(settlement.worldId!==WORLD||settlement.status!=='verified'||settlement.agentBinding!==null||settlement.allocation!=='0'
      ||same(settlement.address,WALLET))fail('PREFLIGHT_SETTLEMENT_IDENTITY_INVALID');
  const {api}=await turnkeyApiFromKeychain();
  for(const ref of [settlement,{subOrganizationId:wallet[0].provider_suborganization_id,walletId:wallet[0].provider_wallet_id,
    walletAccountId:wallet[0].provider_key_reference,address:WALLET}]) {
    const accounts=await api.getWalletAccounts({organizationId:ref.subOrganizationId,walletId:ref.walletId});
    if(accounts.accounts?.length!==1)fail('PREFLIGHT_TURNKEY_ACCOUNT_AMBIGUOUS');
    const a=accounts.accounts[0];
    if(!same(a.address,ref.address)||a.walletAccountId!==ref.walletAccountId||a.organizationId!==ref.subOrganizationId
        ||a.walletId!==ref.walletId||Object.entries(TURNKEY_EVM_ACCOUNT).some(([k,v])=>a[k]!==v))fail('PREFLIGHT_TURNKEY_ACCOUNT_MISMATCH');
  }
  const compiled=[];const artifacts={};
  for(const name of names) {
    const a=JSON.parse(await fs.readFile(`contracts/out/${name}.sol/${name}.json`,'utf8'));artifacts[name]=a;
    if(Object.keys(a.bytecode.linkReferences||{}).length)fail('PREFLIGHT_UNLINKED_BYTECODE');
    const writes=a.abi.filter(x=>x.type==='function'&&!['view','pure'].includes(x.stateMutability)).map(x=>x.name);
    if(writes.some(n=>!writable[name].includes(n)))fail('PREFLIGHT_UNEXPECTED_MONETARY_ENTRYPOINT');
    for(const [filename,source] of Object.entries(a.metadata.sources)) {
      const sourcePath=filename.startsWith('@openzeppelin/')?path.join('node_modules',filename):path.join('contracts',filename);
      if(keccak256(await fs.readFile(sourcePath))!==source.keccak256)fail('PREFLIGHT_COMPILED_SOURCE_MISMATCH');
    }
    compiled.push({name,compiler:a.metadata.compiler.version,settings:a.metadata.settings,
      creationBytecodeBytes:(a.bytecode.object.length-2)/2,creationBytecodeHash:keccak256(a.bytecode.object),
      runtimeTemplateHash:keccak256(a.deployedBytecode.object),stateChangingFunctions:writes,sourceHashes:a.metadata.sources,
      compiledSourcesMatchCurrentFiles:true});
  }
  const [chainId,block,nonceHex,balanceHex,tipHex,latestNonceHex]=await Promise.all([
    rpc.getChainId(),rpc.getBlock('latest',false),rpc.getTransactionCount(WALLET,'pending'),rpc.getBalance(WALLET,'latest'),
    rpc.maxPriorityFeePerGas(),rpc.getTransactionCount(WALLET,'latest')]);
  if(chainId!==5042||nonceHex!==latestNonceHex)fail('PREFLIGHT_PENDING_ISSUER_TRANSACTION');
  const nonce=BigInt(nonceHex);
  const genesis=getCreateAddress({from:WALLET,nonce});
  const addresses={genesisPolicy:genesis};
  for(const [i,key] of ['token','reserve','operatingPool','protocolMarketPool','genesisAuction','settlementExecutor'].entries()) {
    addresses[key]=getCreateAddress({from:genesis,nonce:i+1});
  }
  for(const addr of Object.values(addresses))if(await rpc.getCode(addr,'latest')!=='0x')fail('PREFLIGHT_EXPECTED_ADDRESS_OCCUPIED');
  const ctor=[`0x${WORLD.replaceAll('-','')}`,2378n,WALLET,settlement.address,spec.name,spec.symbol,SPEC_HASH];
  const encoded=new Interface(artifacts.SyncTokenomicsGenesis.abi).encodeDeploy(ctor);
  const initcode=artifacts.SyncTokenomicsGenesis.bytecode.object+encoded.slice(2);
  const call={from:WALLET,data:initcode,value:'0x0',nonce:nonceHex};
  const [estimateHex,simulatedRuntime]=await Promise.all([rpc.estimateGas(call,'pending'),rpc.call(call,'pending')]);
  if(!/^0x[0-9a-f]+$/i.test(simulatedRuntime)||simulatedRuntime.length!==artifacts.SyncTokenomicsGenesis.deployedBytecode.object.length)fail('PREFLIGHT_CONSTRUCTOR_SIMULATION_FAILED');
  const estimate=BigInt(estimateHex),gasLimit=estimate+estimate/5n+1n;
  const base=BigInt(block.baseFeePerGas),tip=BigInt(tipHex);
  const maxFee=base*2n+tip>20_000_000_000n?base*2n+tip:20_000_000_000n;
  const expected=estimate*(base+tip),worst=gasLimit*maxFee;
  const worstUnits=(worst+999_999_999_999n)/1_000_000_000_000n;
  const spent=BigInt(budget.spent_usdc_base_units),reserved=BigInt(budget.reserved_usdc_base_units),cap=BigInt(budget.limit_usdc_base_units);
  if(cap>10_000_000n||spent+reserved+worstUnits>cap||BigInt(balanceHex)<worst)fail('PREFLIGHT_BOOTSTRAP_OR_WALLET_BUDGET_INSUFFICIENT');
  const transaction={type:2,chainId:5042,from:WALLET,to:null,value:'0',data:initcode,nonce:nonce.toString(),
    gasLimit:gasLimit.toString(),maxFeePerGas:maxFee.toString(),maxPriorityFeePerGas:tip.toString()};
  const report={title:'SYNC Tokenomics v1.0 Final Preflight — unsigned, awaiting human deployment approval',
    generatedAt:new Date().toISOString(),implementationCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    status:'FINAL_PREFLIGHT_AWAITING_HUMAN_APPROVAL',technicalPreflightPassed:true,readyForExecution:false,
    worldId:WORLD,worldMinute:world.world_minute,issuerAgentId:ISSUER,issuerWallet:WALLET,provenance:'creator_genesis_assignment',
    proposalId:PROPOSAL,proposalStatus:proposal.status,confirmation,specificationHash:SPEC_HASH,tokenomicsManifestHash:TOKENOMICS_MANIFEST_HASH,
    canonicalDesignFields:spec,canonicalSpecification:validation.canonicalSpec,manifest:SYNC_TOKENOMICS_MANIFEST,
    externalIdentity:identity,legacyProposal:old,formalCounts:counts,requirement,
    settlement:{signer:settlement.address,provider:'turnkey',subOrganizationId:settlement.subOrganizationId,
      walletId:settlement.walletId,walletAccountId:settlement.walletAccountId,verifiedBy:'live Turnkey getWalletAccounts',
      provenance:settlement.provenance,executor:addresses.settlementExecutor,operatingPool:addresses.operatingPool,
      immutableBindings:true,agentBinding:null,genesisAllocation:'0',payoutDomain:'chainId=5042 + executor + payoutId + recipient + amount + asset',
      replayProtection:'executor and Operating Pool executedPayouts[payoutId]',
      authorizationSource:'committed authoritative economic action + exactly two conserved ledger postings + active Agent wallet',
      trustBoundary:'chain verifies the ledger signer attestation; PostgreSQL content is not readable on-chain',
      reserveAccess:false,marketPoolAccess:false,arbitraryCall:false,setter:false,upgrade:false,
      reserveProof:'SyncGenesisReserve.release requires msg.sender == immutable genesisPolicy; executor only calls bound OperatingPool.executeCommittedPayout. Genesis refill independently enforces trigger/target/economy epoch quota.'},
    expectedAddresses:addresses,deploymentOrder:['issuer CREATE Genesis policy','child nonce 1 token','child nonce 2 reserve',
      'child nonce 3 Operating Pool (immutable predicted executor)','child nonce 4 Protocol Market Pool',
      'child nonce 5 auction','child nonce 6 executor; constructor verifies expected address','allocate 10M pool + 990M reserve; start epoch 0'],
    compiledContracts:compiled,constructorArguments:ctor.map(x=>typeof x==='bigint'?x.toString():x),
    initcodeHash:keccak256(initcode),initcodeBytes:(initcode.length-2)/2,exactInitcode:initcode,
    exactCalldata:initcode,unsignedTransactions:[transaction],transactionCount:1,readOnlySimulation:{ethCallPassed:true,ethEstimateGasPassed:true,
      simulatedRuntimeBytes:(simulatedRuntime.length-2)/2,blockNumber:BigInt(block.number).toString(),pendingNonce:nonce.toString(),
      balanceNativeUsdc:formatUnits(BigInt(balanceHex),18),baseFeePerGas:base.toString(),priorityFeePerGas:tip.toString()},
    gas:{estimated:estimate.toString(),limit:gasLimit.toString(),safetyMargin:'20% + 1 gas',maxFeePerGas:maxFee.toString(),
      expectedNativeUsdcCost:formatUnits(expected,18),worstCaseNativeUsdcCost:formatUnits(worst,18),worstCaseBudgetUsdc:formatUnits(worstUnits,6)},
    bootstrapBudget:{capUsdc:formatUnits(cap,6),spentUsdc:formatUnits(spent,6),reservedUsdc:formatUnits(reserved,6),
      remainingUsdc:formatUnits(cap-spent-reserved,6),remainingAfterDeploymentWorstCaseUsdc:formatUnits(cap-spent-reserved-worstUnits,6),
      reservationCreated:false,actualReservationRequiredImmediatelyBeforeApprovedSubmission:true},
    reconciliation:['receipt status=1 and contractAddress == expected Genesis; exactly one SyncGenesisDeployed event from Genesis',
      'verify event world/issuer/identity/specification/manifest and all child addresses; ownerOf(2378)==issuer',
      'verify runtime bytecode with compiler immutableReferences plus all immutable getters and constants',
      'executor ledgerSigner/asset/operatingPool, pool settlementWorker, reserve genesisPolicy all equal preflight bindings',
      'totalSupply=1e15 raw; pool=1e13 raw; reserve=99e13 raw; Creator/Agents/signers=0; decimals=6; fees=50/50',
      'only after full validation insert immutable deployment row with settlement_worker_address=executor; initialize conserved ledger balances; reconcile actual gas budget'],
    exactlyOnce:{existingSubmission:false,nonce:nonce.toString(),automaticResubmission:false,
      beforeSubmission:'fresh nonce/fee/gas/balance/owner and hashes; reserve budget; persist sender+nonce+initcode hash+signed tx hash before send',
      unknownSubmission:'do not re-sign, resend or change nonce; reconcile tx hash, sender+nonce, receipt, expected Genesis code and SyncGenesisDeployed logs; resume only after outcome proven'},
    signingBoundary:{signerProvider:'turnkey',signerWallet:WALLET,relayer:null,deployer:WALLET,
      signedTransactions:0,walletSignatureCalls:0,broadcastCalls:0,
      note:'This artifact is an exact unsigned CREATE transaction. Existing general Arc sendTransaction rejects CREATE targets; future approved deployment must use a dedicated exact-envelope CREATE path, without opening the generic write gate.'},
    mainnetWriteGate:false,mainnetWritesThisPhase:0,tokenDeploymentBroadcast:false,syncDeployed:false};
  const dir='.synterra/preflights';await fs.mkdir(dir,{recursive:true});
  const filename=path.join(dir,'SYNC_FINAL_PREFLIGHT_'+world.world_minute);
  await fs.writeFile(filename+'.json',asJson(report),{mode:0o600});
  await fs.writeFile(filename+'.md',`# SYNC Final Preflight\n\n**未签名，未广播，未部署；等待人类最终批准。**\n\n`+
    `Proposal: ${PROPOSAL}\n\n01 explicit confirmation: confirm, minute ${confirmation.worldMinute}, confidence ${confirmation.cognition.confidence}\n\n`+
    `Manifest: ${TOKENOMICS_MANIFEST_HASH}\n\nSpecification: ${SPEC_HASH}\n\n`+
    `## Deployment and permissions\n\n`+Object.entries(addresses).map(([k,v])=>`- ${k}: ${v}`).join('\n')+
    `\n- Dedicated Turnkey ledger signer: ${settlement.address}\n\n`+
    `Executor 仅可调用 immutable Operating Pool payout；EIP-712 绑定 chain/executor/payoutId/recipient/amount/asset，payoutId 不可重放。无 setter、upgrade、任意 call 或 Reserve release 路径。Reserve 只接受 immutable Genesis policy；refill 仍受 epoch/trigger/target 限制。链上信任账本 signer 的授权证明，不能读取 PostgreSQL。\n\n`+
    `## Fresh RPC and budget\n\nNonce: ${nonce}; gas estimate: ${estimate}; gas limit: ${gasLimit}; maxFeePerGas: ${maxFee}; priority: ${tip}.\n\n`+
    `Expected cost: ${formatUnits(expected,18)} USDC; worst case: ${formatUnits(worst,18)} USDC.\n\n`+
    `Bootstrap cap/spent/reserved/remaining: ${formatUnits(cap,6)} / ${formatUnits(spent,6)} / ${formatUnits(reserved,6)} / ${formatUnits(cap-spent-reserved,6)} USDC. 未新增 reservation。\n\n`+
    `## Canonical specification\n\n\`\`\`json\n${asJson(spec)}\`\`\`\n\n`+
    `1B supply = 10M Operating Pool + 990M Reserve；Creator/Genesis Agent 初始分配 0；buy/sell 50 bps 全留 Market Pool。\n\n`+
    `## Exact artifact\n\n[完整 JSON、initcode、constructor args、unsigned transaction 和 reconciliation](${path.basename(filename)}.json)\n\n`+
    `Initcode hash: ${report.initcodeHash}; bytes: ${report.initcodeBytes}.\n\n`+
    `这是精确 unsigned CREATE bundle。现有通用 Arc signer 拒绝 to=null；最后批准后须使用只接受本 bundle 的专用 CREATE 签名路径。\n\n`+
    `MAINNET_WRITE_GATE=false；本阶段 Mainnet writes=0。\n`,{mode:0o600});
  console.log(asJson({status:report.status,proposalId:PROPOSAL,confirmation:'confirm',settlementSigner:settlement.address,
    expectedAddresses:addresses,nonce:nonce.toString(),gas:report.gas,bootstrapBudget:report.bootstrapBudget,
    files:[filename+'.md',filename+'.json'],mainnetWriteGate:false,mainnetWrites:0}));
}catch(e){console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'SYNC_FINAL_PREFLIGHT_FAILED',
  rpcCode:e.rpcCode,rpcMessage:e.rpcMessage}));process.exitCode=1;}finally{await pool.end();}
