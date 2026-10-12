import { Interface } from 'ethers';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { arcReceiptAmountToUsdcBaseUnits, recordArcMainnetPilotFunding } from '../../src/arc/pilot-budget.js';
import { arcNetworkConfig, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS,
  ARC_SYSTEM_USDC_TRANSFER_EMITTER, ARC_NATIVE_GAS_DECIMALS, ARC_USDC_TOKEN_DECIMALS,
  ARC_TRANSFER_TOPIC0 } from '../../src/arc/config.js';
import { ArcRpcClient } from '../../src/arc/rpc.js';
import { readWorldMigrationPlan } from '../../src/database-migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRANSFER = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const MIGRATION = '0009_arc_mainnet_pilot_funding_ledger.sql';

function parseArgs(argv) {
  const result = { record: false };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--record') { result.record = true; continue; }
    if (!['--world-id', '--agent-id', '--transaction-hash', '--recipient'].includes(name)) {
      throw new TypeError(`Unknown option: ${name}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${name} requires a value.`);
    result[name.slice(2)] = value;
  }
  for (const key of ['world-id', 'agent-id', 'transaction-hash', 'recipient']) {
    if (!result[key]) throw new TypeError(`--${key} is required.`);
  }
  return result;
}

function parseAddressTopic(topic) {
  if (typeof topic !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(topic)) {
    throw new Error('Funding receipt contains a malformed Transfer address topic.');
  }
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function transferRows(receipt, emitterAddress, recipientAddress, decimals) {
  const emitter = emitterAddress.toLowerCase();
  return receipt.logs.filter((log) => String(log.address).toLowerCase() === emitter
      && String(log.topics?.[0]).toLowerCase() === ARC_TRANSFER_TOPIC0.toLowerCase())
    .map((log) => {
      const parsed = TRANSFER.parseLog({ topics: log.topics, data: log.data });
      const from = parseAddressTopic(log.topics[1]);
      const to = parseAddressTopic(log.topics[2]);
      return { from, to, amountRaw: BigInt(parsed.args.value), decimals };
    }).filter((row) => row.to === recipientAddress.toLowerCase());
}

function uniqueTransfer(rows) {
  const unique = new Map(rows.map((row) => [`${row.from}:${row.to}:${row.amountRaw}`, row]));
  if (unique.size !== 1) throw new Error('Funding receipt does not contain exactly one unambiguous transfer to the issuer wallet.');
  return [...unique.values()][0];
}

function formatUsdcBaseUnits(value) {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.SYNTERRA_MIGRATION_DATABASE_URL;
  if (!connectionString) throw Object.assign(new Error('MIGRATION_DATABASE_URL_UNAVAILABLE'), { code: 'MIGRATION_TARGET_REQUIRED' });
  if (process.env.SYNTERRA_MIGRATION_ACK !== 'I_CONFIRMED_TARGET_BACKUP_AND_WORLD_ID') {
    throw Object.assign(new Error('MIGRATION_ACK_REQUIRED'), { code: 'MIGRATION_ACK_REQUIRED' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args['world-id'])
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args['agent-id'])
      || !/^0x[0-9a-f]{64}$/i.test(args['transaction-hash'])
      || !/^0x[0-9a-f]{40}$/i.test(args.recipient)) {
    throw new TypeError('World, Agent, transaction hash, or recipient has an invalid format.');
  }

  const config = arcNetworkConfig({ ...process.env, ARC_ENV: 'mainnet' });
  const rpc = new ArcRpcClient({ config, timeoutMs: 12_000 });
  const chainId = await rpc.getChainId();
  if (chainId !== ARC_MAINNET_CHAIN_ID || config.writesEnabled) {
    throw Object.assign(new Error('Arc chain or write-gate verification failed.'), { code: 'ARC_MAINNET_PREFLIGHT_REQUIRED' });
  }
  const [receipt, transaction] = await Promise.all([
    rpc.getTransactionReceipt(args['transaction-hash']),
    rpc.getTransaction(args['transaction-hash'])
  ]);
  if (!receipt || String(receipt.status).toLowerCase() !== '0x1'
      || String(receipt.transactionHash).toLowerCase() !== args['transaction-hash'].toLowerCase()
      || !transaction || String(transaction.hash).toLowerCase() !== args['transaction-hash'].toLowerCase()) {
    throw Object.assign(new Error('Funding transaction or successful receipt could not be verified.'), { code: 'FUNDING_RECEIPT_NOT_VERIFIED' });
  }

  const recipient = args.recipient.toLowerCase();
  const nativeRows = transferRows(receipt, ARC_SYSTEM_USDC_TRANSFER_EMITTER, recipient, ARC_NATIVE_GAS_DECIMALS);
  const nativeTransfer = uniqueTransfer(nativeRows);
  const budgetAmount = arcReceiptAmountToUsdcBaseUnits(nativeTransfer.amountRaw, nativeTransfer.decimals);
  const tokenRows = transferRows(receipt, ARC_MAINNET_USDC_ADDRESS, recipient, ARC_USDC_TOKEN_DECIMALS);
  if (tokenRows.length) {
    const tokenTransfers = new Map(tokenRows.map((row) => [`${row.from}:${row.to}:${arcReceiptAmountToUsdcBaseUnits(row.amountRaw, row.decimals)}`, row]));
    const tokenTransfer = [...tokenTransfers.values()][0];
    if (tokenTransfers.size !== 1 || !tokenTransfer
        || arcReceiptAmountToUsdcBaseUnits(tokenTransfer.amountRaw, tokenTransfer.decimals) !== budgetAmount) {
      throw Object.assign(new Error('Native and ERC-20 receipt views do not reconcile to one funding amount.'), {
        code: 'FUNDING_RECEIPT_VIEW_MISMATCH'
      });
    }
  }
  const block = await rpc.getBlock(receipt.blockNumber, false);
  if (!block?.timestamp || BigInt(block.number) !== BigInt(receipt.blockNumber)) {
    throw Object.assign(new Error('Funding receipt block could not be verified.'), { code: 'FUNDING_RECEIPT_BLOCK_NOT_VERIFIED' });
  }
  const receiptTimestamp = new Date(Number(BigInt(block.timestamp) * 1000n));
  if (!Number.isFinite(receiptTimestamp.getTime())) throw new Error('Funding receipt block timestamp is invalid.');

  if (!args.record) {
    console.log(JSON.stringify({ mode: 'plan_only', chainId, transactionHash: args['transaction-hash'].toLowerCase(),
      recipient, receiptAmountRaw: nativeTransfer.amountRaw.toString(), receiptAssetDecimals: nativeTransfer.decimals,
      budgetAmountUsdcBaseUnits: budgetAmount.toString(), receiptBlockNumber: BigInt(receipt.blockNumber).toString(),
      receiptTimestamp: receiptTimestamp.toISOString(), databaseWrite: false, mainnetWrites: false }));
    return;
  }

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migration = (await readWorldMigrationPlan(ROOT)).find((item) => item.name === MIGRATION);
    const applied = await client.query('SELECT checksum FROM public.synterra_schema_migrations WHERE version=$1', [MIGRATION]);
    if (!migration || !applied.rowCount || applied.rows[0].checksum !== migration.checksum) {
      throw Object.assign(new Error('Funding ledger migration checksum is not applied.'), { code: 'FUNDING_LEDGER_SCHEMA_NOT_READY' });
    }
    const assignment = await client.query(`SELECT assignment.selection_source,wallet.address,wallet.status
      FROM public.world_genesis_issuer_assignments assignment
      JOIN public.arc_agent_wallets wallet ON wallet.world_id=assignment.world_id
        AND wallet.agent_id=assignment.issuer_agent_id AND wallet.chain_id=$3
      WHERE assignment.world_id=$1 AND assignment.capability_generation=1
        AND assignment.issuer_agent_id=$2`, [args['world-id'], args['agent-id'], ARC_MAINNET_CHAIN_ID]);
    if (assignment.rowCount !== 1 || assignment.rows[0].selection_source !== 'creator_genesis_assignment'
        || assignment.rows[0].status !== 'active'
        || String(assignment.rows[0].address).toLowerCase() !== recipient) {
      throw Object.assign(new Error('Funding recipient does not match the active Generation 1 issuer wallet.'), {
        code: 'FUNDING_ISSUER_WALLET_MISMATCH'
      });
    }
    const recorded = await recordArcMainnetPilotFunding(client, {
      worldId: args['world-id'], agentId: args['agent-id'], chainId,
      transactionHash: args['transaction-hash'], receiptEmitterAddress: ARC_SYSTEM_USDC_TRANSFER_EMITTER,
      recipientAddress: recipient, receiptAmountRaw: nativeTransfer.amountRaw,
      receiptAssetDecimals: nativeTransfer.decimals, receiptBlockNumber: BigInt(receipt.blockNumber), receiptTimestamp
    });
    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'recorded', category: 'genesis_bootstrap_gas_funding',
      created: recorded.created, transactionHash: args['transaction-hash'].toLowerCase(), recipient,
      amountUsdc: formatUsdcBaseUnits(budgetAmount), budgetAmountUsdcBaseUnits: budgetAmount.toString(),
      budget: recorded.budget, mainnetWrites: false }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const code = String(error?.code || 'FUNDING_ACCOUNTING_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
  console.error(JSON.stringify({ event: 'arc_mainnet_funding_accounting_failed', code }));
  process.exitCode = 1;
});
