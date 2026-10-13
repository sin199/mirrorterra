import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { assertArcChainId, ARC_MAINNET_CHAIN_ID } from './config.js';
import { buildArcEip1559FeeFields, assertArcInfrastructureSigner } from './wallet-provider.js';
import { markArcInfrastructureNonce, reserveArcInfrastructureNonce } from './infrastructure-nonce.js';
import { SYNC_TOTAL_SUPPLY_RAW, TOKENOMICS_MANIFEST_HASH } from './sync-tokenomics.js';
import { readValidatedSyncPayout, SYNC_SETTLEMENT_EXECUTOR_INTERFACE } from './sync-payout-authorization.js';

export const SYNC_OPERATING_POOL_WORKER_LOCK_NAME = 'synterra-sync-operating-pool-payout-worker';
const POLL_INTERVAL_MS = 2_000;

export const SYNC_OPERATING_POOL_INTERFACE = new Interface([
  'function token() view returns (address)',
  'function genesisPolicy() view returns (address)',
  'function settlementWorker() view returns (address)',
  'function executedPayouts(bytes32 actionId) view returns (bool)',
  'function executeCommittedPayout(bytes32 actionId,address recipient,uint256 amountRaw)',
  'event OperatingPoolPayout(bytes32 indexed actionId,address indexed recipient,uint256 amountRaw)'
]);

const SYNC_GENESIS_POLICY_INTERFACE = new Interface([
  'function TOKENOMICS_MANIFEST_HASH() view returns (bytes32)',
  'function token() view returns (address)',
  'function operatingPool() view returns (address)'
]);

const SYNC_TOKEN_INTERFACE = new Interface([
  'function tokenomicsManifestHash() view returns (bytes32)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)'
]);

function coded(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) { return String(error?.code || 'SYNC_PAYOUT_WORKER_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 100); }
function sameAddress(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function validAddress(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }
function validHash(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value); }
function positiveBigInt(value, code) {
  try { const n = BigInt(value); if (n > 0n) return n; } catch {}
  throw coded(code);
}

export function syncPayoutContractActionId(actionId) {
  if (typeof actionId !== 'string' || !actionId.length || actionId.length > 180) throw coded('SYNC_PAYOUT_ACTION_ID_INVALID');
  return keccak256(toUtf8Bytes(actionId));
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function contractCall(rpc, to, contractInterface, method, args = []) {
  const data = contractInterface.encodeFunctionData(method, args);
  const result = await rpc.call({ to, data }, 'latest');
  return contractInterface.decodeFunctionResult(method, result);
}

function receiptStatus(receipt) {
  return receipt?.status === 1 || receipt?.status === true || receipt?.status === '0x1' || receipt?.status === '0x01';
}

function matchingPayoutReceipt(receipt, { poolAddress, executorAddress, actionHash, recipientAddress, amountRaw, sender }) {
  const events = [];
  for (const log of receipt?.logs || []) {
    if (!sameAddress(log.address, poolAddress)) continue;
    try {
      const parsed = SYNC_OPERATING_POOL_INTERFACE.parseLog(log);
      if (parsed?.name === 'OperatingPoolPayout') events.push(parsed.args);
    } catch {}
  }
  if (events.length !== 1) return false;
  const event = events[0];
  return sameAddress(receipt.from, sender) && sameAddress(receipt.to, executorAddress)
    && String(event.actionId).toLowerCase() === actionHash.toLowerCase()
    && sameAddress(event.recipient, recipientAddress) && BigInt(event.amountRaw) === amountRaw;
}

export class SyncOperatingPoolPayoutWorker {
  #pool;
  #config;
  #signer;
  #rpc;
  #isOwner;
  #onError;
  #lockClient = null;
  #timer = null;
  #active = false;
  #worldId = null;
  #status;

  constructor({ pool, config, signer = null, rpcClient, isOwner = () => true, onError = () => {}, intervalMs = POLL_INTERVAL_MS }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL pool is required for SYNC Operating Pool payouts.');
    }
    if (!config || config.name !== 'mainnet' || Number(config.chainId) !== ARC_MAINNET_CHAIN_ID) {
      throw coded('ARC_MAINNET_ONLY');
    }
    this.#pool = pool;
    this.#config = config;
    this.#signer = signer;
    this.#rpc = rpcClient;
    this.#isOwner = isOwner;
    this.#onError = onError;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || POLL_INTERVAL_MS);
    this.#status = { available: true, running: false, mode: 'disabled', worldId: null,
      writesEnabled: false, providerName: signer?.providerName || null, lastProcessedAt: null,
      lastResult: null, lastError: null, reason: 'mainnet_write_gate_closed' };
  }

  getStatus() { return structuredClone(this.#status); }

  async start({ worldId }) {
    if (this.#status.running) return this.getStatus();
    this.#worldId = worldId;
    this.#status.worldId = worldId;
    if (!this.#config.writesEnabled) {
      this.#status = { ...this.#status, running: false, mode: 'disabled',
        writesEnabled: false, reason: 'mainnet_write_gate_closed' };
      return this.getStatus();
    }
    assertArcInfrastructureSigner(this.#signer, this.#config);
    if (!this.#rpc || typeof this.#rpc.getChainId !== 'function' || typeof this.#rpc.call !== 'function') {
      throw coded('SYNC_PAYOUT_RPC_UNAVAILABLE');
    }
    this.#lockClient = await this.#pool.connect();
    const lock = await this.#lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS owned',
      [`${SYNC_OPERATING_POOL_WORKER_LOCK_NAME}:${worldId}`]);
    if (!lock.rows[0]?.owned) {
      this.#lockClient.release();
      this.#lockClient = null;
      this.#status = { ...this.#status, running: false, mode: 'disabled', reason: 'another_sync_payout_worker_owns_lock' };
      return this.getStatus();
    }
    this.#status = { ...this.#status, running: true, mode: 'committed_outbox_only',
      writesEnabled: true, reason: null };
    this.#timer = setInterval(() => this.#process().catch((error) => this.#reportError(error)), this.intervalMs);
    this.#timer.unref?.();
    await this.#process();
    return this.getStatus();
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    while (this.#active) await new Promise((resolve) => setTimeout(resolve, 10));
    this.#status.running = false;
    if (this.#lockClient) {
      await this.#lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',
        [`${SYNC_OPERATING_POOL_WORKER_LOCK_NAME}:${this.#worldId}`]).catch(() => {});
      this.#lockClient.release();
      this.#lockClient = null;
    }
  }

  async #process() {
    if (this.#active || !this.#status.running || !this.#isOwner()) return;
    this.#active = true;
    try {
      const reconciliation = await this.#reconcileOne();
      const result = reconciliation || await this.#executeNextCommitted();
      this.#status.lastProcessedAt = new Date().toISOString();
      this.#status.lastResult = result || { processed: false, reason: 'no_committed_payout_outbox' };
      this.#status.lastError = null;
    } catch (error) {
      this.#reportError(error);
    } finally { this.#active = false; }
  }

  #reportError(error) {
    const code = safeCode(error);
    this.#status.lastError = code;
    this.#status.lastProcessedAt = new Date().toISOString();
    try { this.#onError({ code, worldId: this.#worldId }); } catch {}
  }

  async #reconcileOne() {
    const result = await this.#pool.query(`SELECT * FROM arc_sync_payout_outbox WHERE world_id=$1
      AND status IN ('submitting','submission_unknown','submitted')
      ORDER BY created_at,id LIMIT 1`, [this.#worldId]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (!row.transaction_hash) {
      if (row.status === 'submitting') await inTransaction(this.#pool, async (client) => {
        await client.query(`UPDATE arc_sync_payout_outbox SET status='submission_unknown',
            failure_code='SYNC_PAYOUT_SUBMISSION_OUTCOME_UNKNOWN',updated_at=now()
          WHERE world_id=$1 AND id=$2 AND status='submitting'`, [this.#worldId, row.id]);
        await markArcInfrastructureNonce(client, { operationType: 'operating_pool_payout',
          operationId: String(row.id), status: 'submission_unknown' });
      });
      return { processed: true, status: 'submission_unknown', outboxId: row.id,
        reason: 'hash_missing_and_automatic_resubmission_forbidden' };
    }
    if (!validHash(row.transaction_hash) || !validAddress(row.transaction_sender)
        || !validAddress(row.recipient_address)) throw coded('SYNC_PAYOUT_SUBMISSION_RECORD_INVALID');
    const deployment = await this.#readDeployment();
    const receipt = await this.#rpc.getTransactionReceipt(row.transaction_hash);
    if (!receipt) return { processed: true, status: row.status, outboxId: row.id, reason: 'receipt_pending' };
    const succeeded = receiptStatus(receipt);
    const eventMatches = succeeded && matchingPayoutReceipt(receipt, {
      poolAddress: deployment.operatingPoolAddress,
      executorAddress: deployment.settlementWorkerAddress,
      actionHash: syncPayoutContractActionId(row.action_id), recipientAddress: row.recipient_address,
      amountRaw: BigInt(row.amount_raw), sender: row.transaction_sender
    });
    await inTransaction(this.#pool, async (client) => {
      await client.query(`UPDATE arc_sync_payout_outbox SET status=$3,block_number=$4,
          failure_code=$5,updated_at=now() WHERE world_id=$1 AND id=$2
          AND status IN ('submission_unknown','submitted')`, [this.#worldId, row.id,
        eventMatches ? 'reconciled' : 'failed', receipt.blockNumber ? BigInt(receipt.blockNumber).toString() : null,
        eventMatches ? null : succeeded ? 'SYNC_PAYOUT_RECEIPT_EVENT_MISMATCH' : 'SYNC_PAYOUT_TRANSACTION_REVERTED']);
      await markArcInfrastructureNonce(client, { operationType: 'operating_pool_payout',
        operationId: String(row.id), status: eventMatches ? 'reconciled' : 'failed', transactionHash: row.transaction_hash });
    });
    return { processed: true, status: eventMatches ? 'reconciled' : 'failed', outboxId: row.id,
      transactionHash: row.transaction_hash, reason: eventMatches ? null
        : succeeded ? 'receipt_event_mismatch' : 'transaction_reverted' };
  }

  async #readDeployment() {
    const result = await this.#pool.query(`SELECT chain_id,manifest_hash,token_address,reserve_address,
        operating_pool_address,auction_address,market_pool_address,genesis_policy_address,
        settlement_worker_address FROM arc_sync_tokenomics_deployments WHERE world_id=$1`, [this.#worldId]);
    if (result.rowCount !== 1) throw coded('SYNC_TOKENOMICS_DEPLOYMENT_NOT_READY');
    const row = result.rows[0];
    if (Number(row.chain_id) !== ARC_MAINNET_CHAIN_ID || row.manifest_hash !== TOKENOMICS_MANIFEST_HASH) {
      throw coded('SYNC_TOKENOMICS_DEPLOYMENT_MANIFEST_MISMATCH');
    }
    for (const address of [row.token_address,row.reserve_address,row.operating_pool_address,row.auction_address,
      row.market_pool_address,row.genesis_policy_address,row.settlement_worker_address]) {
      if (!validAddress(address)) throw coded('SYNC_TOKENOMICS_DEPLOYMENT_ADDRESS_INVALID');
    }
    return { tokenAddress: getAddress(row.token_address), reserveAddress: getAddress(row.reserve_address),
      operatingPoolAddress: getAddress(row.operating_pool_address), auctionAddress: getAddress(row.auction_address),
      marketPoolAddress: getAddress(row.market_pool_address), genesisPolicyAddress: getAddress(row.genesis_policy_address),
      settlementWorkerAddress: getAddress(row.settlement_worker_address) };
  }

  async #verifyOnChainDeployment(deployment, signerAddress) {
    assertArcChainId(await this.#rpc.getChainId(), this.#config);
    const addresses = [deployment.tokenAddress, deployment.reserveAddress, deployment.operatingPoolAddress,
      deployment.auctionAddress, deployment.marketPoolAddress, deployment.genesisPolicyAddress, deployment.settlementWorkerAddress];
    const codes = await Promise.all(addresses.map((address) => this.#rpc.getCode(address, 'latest')));
    if (codes.some((code) => typeof code !== 'string' || code === '0x' || code.length < 4)) {
      throw coded('SYNC_TOKENOMICS_DEPLOYMENT_CODE_MISSING');
    }
    const [poolToken, poolPolicy, poolWorker, policyHash, policyToken, policyPool,
      tokenHash, tokenSupply, tokenDecimals, executorSigner, executorAsset, executorPool] = await Promise.all([
      contractCall(this.#rpc, deployment.operatingPoolAddress, SYNC_OPERATING_POOL_INTERFACE, 'token'),
      contractCall(this.#rpc, deployment.operatingPoolAddress, SYNC_OPERATING_POOL_INTERFACE, 'genesisPolicy'),
      contractCall(this.#rpc, deployment.operatingPoolAddress, SYNC_OPERATING_POOL_INTERFACE, 'settlementWorker'),
      contractCall(this.#rpc, deployment.genesisPolicyAddress, SYNC_GENESIS_POLICY_INTERFACE, 'TOKENOMICS_MANIFEST_HASH'),
      contractCall(this.#rpc, deployment.genesisPolicyAddress, SYNC_GENESIS_POLICY_INTERFACE, 'token'),
      contractCall(this.#rpc, deployment.genesisPolicyAddress, SYNC_GENESIS_POLICY_INTERFACE, 'operatingPool'),
      contractCall(this.#rpc, deployment.tokenAddress, SYNC_TOKEN_INTERFACE, 'tokenomicsManifestHash'),
      contractCall(this.#rpc, deployment.tokenAddress, SYNC_TOKEN_INTERFACE, 'totalSupply'),
      contractCall(this.#rpc, deployment.tokenAddress, SYNC_TOKEN_INTERFACE, 'decimals'),
      contractCall(this.#rpc, deployment.settlementWorkerAddress, SYNC_SETTLEMENT_EXECUTOR_INTERFACE, 'ledgerSigner'),
      contractCall(this.#rpc, deployment.settlementWorkerAddress, SYNC_SETTLEMENT_EXECUTOR_INTERFACE, 'asset'),
      contractCall(this.#rpc, deployment.settlementWorkerAddress, SYNC_SETTLEMENT_EXECUTOR_INTERFACE, 'operatingPool')
    ]);
    if (!sameAddress(poolToken[0], deployment.tokenAddress) || !sameAddress(poolPolicy[0], deployment.genesisPolicyAddress)
        || !sameAddress(poolWorker[0], deployment.settlementWorkerAddress)
        || !sameAddress(executorSigner[0], signerAddress) || !sameAddress(executorAsset[0], deployment.tokenAddress)
        || !sameAddress(executorPool[0], deployment.operatingPoolAddress)
        || !sameAddress(policyToken[0], deployment.tokenAddress) || !sameAddress(policyPool[0], deployment.operatingPoolAddress)
        || String(policyHash[0]).toLowerCase() !== TOKENOMICS_MANIFEST_HASH.toLowerCase()
        || String(tokenHash[0]).toLowerCase() !== TOKENOMICS_MANIFEST_HASH.toLowerCase()
        || BigInt(tokenSupply[0]) !== SYNC_TOTAL_SUPPLY_RAW || Number(tokenDecimals[0]) !== 6) {
      throw coded('SYNC_TOKENOMICS_DEPLOYMENT_CONTRACT_MISMATCH');
    }
  }

  async #validateLedgerPayout(row) {
    const validated = await readValidatedSyncPayout(this.#pool, { worldId: this.#worldId, outboxId: row.id });
    if (validated.action_id !== row.action_id || validated.transaction_id !== row.transaction_id
        || validated.amount_raw !== row.amount_raw || validated.recipient_address !== row.recipient_address) {
      throw coded('SYNC_PAYOUT_STATE_CHANGED');
    }
    return { amountRaw: BigInt(validated.amount_raw), recipientAddress: getAddress(validated.recipient_address) };
  }

  async #executeNextCommitted() {
    const selected = await this.#pool.query(`SELECT outbox.*,ledger.status AS "transactionStatus",
        ledger.action_id AS "transactionActionId",ledger.id AS "transactionId",
        ledger.source_economic_action_id AS "sourceEconomicActionId"
      FROM arc_sync_payout_outbox outbox JOIN arc_sync_ledger_transactions ledger
        ON ledger.world_id=outbox.world_id AND ledger.id=outbox.transaction_id
      WHERE outbox.world_id=$1 AND outbox.status='committed'
      ORDER BY outbox.created_at,outbox.id LIMIT 1`, [this.#worldId]);
    if (!selected.rowCount) return { processed: false, reason: 'no_committed_payout_outbox' };
    const row = selected.rows[0];
    await this.#validateLedgerPayout(row);
    const deployment = await this.#readDeployment();
    const signerAddress = getAddress(await this.#signer.getAddress());
    await this.#verifyOnChainDeployment(deployment, signerAddress);
    const actionHash = syncPayoutContractActionId(row.action_id);
    const executed = await contractCall(this.#rpc, deployment.settlementWorkerAddress,
      SYNC_SETTLEMENT_EXECUTOR_INTERFACE, 'executedPayouts', [actionHash]);
    if (executed[0]) {
      await inTransaction(this.#pool, async (client) => {
        const locked = await client.query(`SELECT status FROM arc_sync_payout_outbox
          WHERE world_id=$1 AND id=$2 FOR UPDATE`, [this.#worldId, row.id]);
        if (locked.rows[0]?.status !== 'committed') throw coded('SYNC_PAYOUT_STATE_CHANGED');
        await client.query(`UPDATE arc_sync_payout_outbox SET status='submitting',transaction_sender=$3,
            failure_code='SYNC_PAYOUT_ONCHAIN_ACTION_ALREADY_EXECUTED',updated_at=now()
          WHERE world_id=$1 AND id=$2 AND status='committed'`, [this.#worldId, row.id, signerAddress]);
        await client.query(`UPDATE arc_sync_payout_outbox SET status='submission_unknown',updated_at=now()
          WHERE world_id=$1 AND id=$2 AND status='submitting'`, [this.#worldId, row.id]);
      });
      return { processed: true, status: 'submission_unknown', outboxId: row.id,
        reason: 'onchain_action_exists_without_saved_transaction_hash' };
    }

    if (typeof this.#signer.authorizeCommittedPayout !== 'function') throw coded('SYNC_PAYOUT_AUTHORIZATION_SIGNER_REQUIRED');
    const authorization = await this.#signer.authorizeCommittedPayout({ worldId: this.#worldId, outboxId: row.id });
    if (!sameAddress(authorization.executor, deployment.settlementWorkerAddress)) throw coded('SYNC_PAYOUT_EXECUTOR_MISMATCH');
    const transactionData = authorization.data;
    const [block, tipHex, pendingNonceHex, estimatedGasHex, signerBalanceHex] = await Promise.all([
      this.#rpc.getBlock('latest', false), this.#rpc.maxPriorityFeePerGas(),
      this.#rpc.getTransactionCount(signerAddress, 'pending'),
      this.#rpc.estimateGas({ from: signerAddress, to: deployment.settlementWorkerAddress, value: '0x0', data: transactionData }),
      this.#rpc.getBalance(signerAddress, 'latest')
    ]);
    if (!block?.baseFeePerGas || !block.number) throw coded('ARC_BASE_FEE_UNAVAILABLE');
    const fees = buildArcEip1559FeeFields({ baseFeePerGas: BigInt(block.baseFeePerGas),
      maxPriorityFeePerGas: BigInt(tipHex), recommendedMinimum: this.#config.maxFeePerGasRecommendation });
    const estimatedGas = positiveBigInt(estimatedGasHex, 'SYNC_PAYOUT_GAS_ESTIMATE_INVALID');
    const gasLimit = estimatedGas + estimatedGas / 5n + 1n;
    const maximumGasCost = gasLimit * fees.maxFeePerGas;
    if (BigInt(signerBalanceHex) < maximumGasCost) throw coded('SYNC_PAYOUT_SIGNER_GAS_BALANCE_INSUFFICIENT');
    const fullTransaction = { chainId: ARC_MAINNET_CHAIN_ID, to: deployment.settlementWorkerAddress,
      from: signerAddress, value: 0n, data: transactionData, gasLimit,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    let nonce;
    await inTransaction(this.#pool, async (client) => {
      const locked = await client.query(`SELECT status FROM arc_sync_payout_outbox
        WHERE world_id=$1 AND id=$2 FOR UPDATE`, [this.#worldId, row.id]);
      if (locked.rows[0]?.status !== 'committed') throw coded('SYNC_PAYOUT_STATE_CHANGED');
      const reserved = await reserveArcInfrastructureNonce(client, { chainId: ARC_MAINNET_CHAIN_ID,
        address: signerAddress, operationType: 'operating_pool_payout', operationId: String(row.id),
        pendingNonce: BigInt(pendingNonceHex), startBlock: BigInt(block.number) + 1n });
      nonce = reserved.nonce;
      await markArcInfrastructureNonce(client, { operationType: 'operating_pool_payout',
        operationId: String(row.id), status: 'submitting' });
      await client.query(`UPDATE arc_sync_payout_outbox SET status='submitting',transaction_sender=$3,
          transaction_nonce=$4,gas_limit=$5,max_fee_per_gas=$6,start_block=$7,
          updated_at=now() WHERE world_id=$1 AND id=$2 AND status='committed'`, [this.#worldId,
        row.id, signerAddress, nonce.toString(), gasLimit.toString(), fees.maxFeePerGas.toString(),
        (BigInt(block.number) + 1n).toString()]);
    });
    fullTransaction.nonce = nonce;
    try {
      const submitted = await this.#signer.sendTransaction(fullTransaction);
      if (!validHash(submitted?.hash)) throw coded('ARC_SIGNER_TRANSACTION_HASH_MISSING');
      await inTransaction(this.#pool, async (client) => {
        await client.query(`UPDATE arc_sync_payout_outbox SET status='submitted',transaction_hash=$3,
            updated_at=now() WHERE world_id=$1 AND id=$2 AND status='submitting'`,
        [this.#worldId, row.id, submitted.hash]);
        await markArcInfrastructureNonce(client, { operationType: 'operating_pool_payout',
          operationId: String(row.id), status: 'submitted', transactionHash: submitted.hash });
      });
      return { processed: true, status: 'submitted', outboxId: row.id };
    } catch (error) {
      await inTransaction(this.#pool, async (client) => {
        await client.query(`UPDATE arc_sync_payout_outbox SET status='submission_unknown',failure_code=$3,
            updated_at=now() WHERE world_id=$1 AND id=$2 AND status='submitting'`,
        [this.#worldId, row.id, safeCode(error)]);
        await markArcInfrastructureNonce(client, { operationType: 'operating_pool_payout',
          operationId: String(row.id), status: 'submission_unknown' });
      });
      return { processed: true, status: 'submission_unknown', outboxId: row.id,
        reason: 'submission_outcome_unknown_no_resend' };
    }
  }
}

export function startSyncOperatingPoolPayoutWorker(options) {
  return new SyncOperatingPoolPayoutWorker(options);
}
