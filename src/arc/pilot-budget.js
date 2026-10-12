import { assertArcMainnetChainId, ARC_MAINNET_CHAIN_ID } from './config.js';

export const ARC_MAINNET_PILOT_BUDGET_USDC_BASE_UNITS = 10_000_000n;
export const ARC_NATIVE_WEI_PER_USDC_BASE_UNIT = 1_000_000_000_000n;
export const ARC_MAINNET_PILOT_FUNDING_CATEGORY = 'genesis_bootstrap_gas_funding';

function nonNegativeBigInt(value, label) {
  let parsed;
  try { parsed = BigInt(value); }
  catch { throw new TypeError(`${label} must be a non-negative integer.`); }
  if (parsed < 0n) throw new RangeError(`${label} must be a non-negative integer.`);
  return parsed;
}

function positiveBigInt(value, label) {
  const parsed = nonNegativeBigInt(value, label);
  if (parsed === 0n) throw new RangeError(`${label} must be positive.`);
  return parsed;
}

export function arcNativeWeiToUsdcBaseUnitsCeiling(nativeWei) {
  const amount = nonNegativeBigInt(nativeWei, 'nativeWei');
  return (amount + ARC_NATIVE_WEI_PER_USDC_BASE_UNIT - 1n) / ARC_NATIVE_WEI_PER_USDC_BASE_UNIT;
}

export function arcReceiptAmountToUsdcBaseUnits(amountRaw, assetDecimals) {
  const amount = positiveBigInt(amountRaw, 'receiptAmountRaw');
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 36) {
    throw new RangeError('receiptAssetDecimals must be an integer from 0 through 36.');
  }
  if (assetDecimals === 6) return amount;
  if (assetDecimals < 6) return amount * (10n ** BigInt(6 - assetDecimals));
  const divisor = 10n ** BigInt(assetDecimals - 6);
  if (amount % divisor !== 0n) {
    throw new RangeError('Receipt amount cannot be represented exactly in the pilot budget USDC units.');
  }
  return amount / divisor;
}

function fundingInput({ worldId, agentId, chainId, transactionHash, receiptEmitterAddress, recipientAddress,
  receiptAmountRaw, receiptAssetDecimals, receiptBlockNumber, receiptTimestamp }) {
  assertArcMainnetChainId(chainId);
  if (typeof worldId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(worldId)
      || typeof agentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    throw new TypeError('worldId and agentId must be UUIDs.');
  }
  if (typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) {
    throw new TypeError('transactionHash must be a 32-byte transaction hash.');
  }
  if (typeof receiptEmitterAddress !== 'string' || !/^0x[0-9a-f]{40}$/i.test(receiptEmitterAddress)) {
    throw new TypeError('receiptEmitterAddress must be an EVM address.');
  }
  if (typeof recipientAddress !== 'string' || !/^0x[0-9a-f]{40}$/i.test(recipientAddress)) {
    throw new TypeError('recipientAddress must be an EVM address.');
  }
  const raw = positiveBigInt(receiptAmountRaw, 'receiptAmountRaw');
  const budgetAmount = arcReceiptAmountToUsdcBaseUnits(raw, receiptAssetDecimals);
  const blockNumber = nonNegativeBigInt(receiptBlockNumber, 'receiptBlockNumber');
  const timestamp = receiptTimestamp instanceof Date ? new Date(receiptTimestamp) : new Date(receiptTimestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError('receiptTimestamp must be a valid timestamp.');
  return {
    worldId: worldId.toLowerCase(), agentId: agentId.toLowerCase(), chainId: ARC_MAINNET_CHAIN_ID,
    transactionHash: transactionHash.toLowerCase(), category: ARC_MAINNET_PILOT_FUNDING_CATEGORY,
    assetSymbol: 'USDC', receiptEmitterAddress: receiptEmitterAddress.toLowerCase(),
    recipientAddress: recipientAddress.toLowerCase(), receiptAmountRaw: raw,
    receiptAssetDecimals, budgetAmountUsdcBaseUnits: budgetAmount, receiptBlockNumber: blockNumber,
    receiptTimestamp: timestamp
  };
}

function fundingRowsMatch(row, input) {
  return String(row.world_id).toLowerCase() === input.worldId
    && String(row.agent_id).toLowerCase() === input.agentId
    && Number(row.chain_id) === input.chainId
    && String(row.transaction_hash).toLowerCase() === input.transactionHash
    && row.category === input.category
    && row.asset_symbol === input.assetSymbol
    && String(row.receipt_emitter_address).toLowerCase() === input.receiptEmitterAddress
    && String(row.recipient_address).toLowerCase() === input.recipientAddress
    && BigInt(row.receipt_amount_raw) === input.receiptAmountRaw
    && Number(row.receipt_asset_decimals) === input.receiptAssetDecimals
    && BigInt(row.budget_amount_usdc_base_units) === input.budgetAmountUsdcBaseUnits
    && BigInt(row.receipt_block_number) === input.receiptBlockNumber
    && new Date(row.receipt_timestamp).getTime() === input.receiptTimestamp.getTime();
}

/**
 * Record a verified Arc receipt inside a caller-owned PostgreSQL transaction.
 * The caller must BEGIN/COMMIT on this same client. The budget-row lock serializes
 * this accounting update with pilot cost reservations and settlements.
 */
export async function recordArcMainnetPilotFunding(client, values) {
  const input = fundingInput(values);
  const budgetResult = await client.query('SELECT * FROM arc_mainnet_pilot_budget WHERE id=1 FOR UPDATE');
  if (!budgetResult.rowCount) {
    throw Object.assign(new Error('MAINNET_PILOT_BUDGET_NOT_INITIALIZED'), { code: 'ARC_PILOT_BUDGET_NOT_INITIALIZED' });
  }
  const priorResult = await client.query(`SELECT * FROM arc_mainnet_pilot_funding_ledger
    WHERE chain_id=$1 AND transaction_hash=$2 FOR UPDATE`, [input.chainId, input.transactionHash]);
  if (priorResult.rowCount) {
    if (!fundingRowsMatch(priorResult.rows[0], input)) {
      throw Object.assign(new Error('ARC_PILOT_FUNDING_IDEMPOTENCY_CONFLICT'), { code: 'ARC_PILOT_FUNDING_IDEMPOTENCY_CONFLICT' });
    }
    const row = budgetResult.rows[0];
    const spent = BigInt(row.spent_usdc_base_units);
    const reserved = BigInt(row.reserved_usdc_base_units);
    const limit = BigInt(row.limit_usdc_base_units);
    return { created: false, funding: priorResult.rows[0], budget: {
      spentUsdcBaseUnits: spent.toString(), reservedUsdcBaseUnits: reserved.toString(),
      remainingUsdcBaseUnits: (limit - spent - reserved).toString(), limitUsdcBaseUnits: limit.toString()
    } };
  }

  const budget = budgetResult.rows[0];
  const spent = BigInt(budget.spent_usdc_base_units);
  const reserved = BigInt(budget.reserved_usdc_base_units);
  const limit = BigInt(budget.limit_usdc_base_units);
  if (spent + reserved + input.budgetAmountUsdcBaseUnits > limit) {
    throw Object.assign(new Error('ARC_MAINNET_PILOT_COST_CAP_EXCEEDED'), {
      code: 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED', limitUsdcBaseUnits: limit.toString(),
      spentUsdcBaseUnits: spent.toString(), reservedUsdcBaseUnits: reserved.toString(),
      requestedUsdcBaseUnits: input.budgetAmountUsdcBaseUnits.toString()
    });
  }
  const inserted = await client.query(`INSERT INTO arc_mainnet_pilot_funding_ledger(world_id,agent_id,chain_id,
      transaction_hash,category,asset_symbol,receipt_emitter_address,recipient_address,receipt_amount_raw,
      receipt_asset_decimals,budget_amount_usdc_base_units,receipt_block_number,receipt_timestamp)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [input.worldId, input.agentId,
    input.chainId, input.transactionHash, input.category, input.assetSymbol, input.receiptEmitterAddress,
    input.recipientAddress, input.receiptAmountRaw.toString(), input.receiptAssetDecimals,
    input.budgetAmountUsdcBaseUnits.toString(), input.receiptBlockNumber.toString(), input.receiptTimestamp]);
  const updated = await client.query(`UPDATE arc_mainnet_pilot_budget
    SET spent_usdc_base_units=spent_usdc_base_units+$1,updated_at=now() WHERE id=1
    RETURNING spent_usdc_base_units,reserved_usdc_base_units,limit_usdc_base_units`,
  [input.budgetAmountUsdcBaseUnits.toString()]);
  if (!updated.rowCount) throw Object.assign(new Error('MAINNET_PILOT_BUDGET_NOT_INITIALIZED'), {
    code: 'ARC_PILOT_BUDGET_NOT_INITIALIZED'
  });
  const next = updated.rows[0];
  const nextSpent = BigInt(next.spent_usdc_base_units);
  const nextReserved = BigInt(next.reserved_usdc_base_units);
  const nextLimit = BigInt(next.limit_usdc_base_units);
  return { created: true, funding: inserted.rows[0], budget: {
    spentUsdcBaseUnits: nextSpent.toString(), reservedUsdcBaseUnits: nextReserved.toString(),
    remainingUsdcBaseUnits: (nextLimit - nextSpent - nextReserved).toString(), limitUsdcBaseUnits: nextLimit.toString()
  } };
}

export function arcPilotTransactionCostCeiling({ transferUsdcBaseUnits = 0n, gasLimit, maxFeePerGas }) {
  const transfer = nonNegativeBigInt(transferUsdcBaseUnits, 'transferUsdcBaseUnits');
  const gas = positiveBigInt(gasLimit, 'gasLimit');
  const fee = positiveBigInt(maxFeePerGas, 'maxFeePerGas');
  return transfer + arcNativeWeiToUsdcBaseUnitsCeiling(gas * fee);
}

export async function reserveArcMainnetPilotCost(client, { operationType, operationId, worldId = null,
  chainId = ARC_MAINNET_CHAIN_ID, transferUsdcBaseUnits = 0n, gasLimit, maxFeePerGas }) {
  assertArcMainnetChainId(chainId);
  if (!['settlement','token_creation','token_reserve_release','deployment','checkpoint','provenance'].includes(operationType)) {
    throw new TypeError('operationType is not supported by the Mainnet pilot budget.');
  }
  if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 180) {
    throw new TypeError('operationId must contain 1 to 180 characters.');
  }
  const transfer = nonNegativeBigInt(transferUsdcBaseUnits, 'transferUsdcBaseUnits');
  const gas = positiveBigInt(gasLimit, 'gasLimit');
  const fee = positiveBigInt(maxFeePerGas, 'maxFeePerGas');
  const cost = arcPilotTransactionCostCeiling({ transferUsdcBaseUnits: transfer, gasLimit: gas, maxFeePerGas: fee });
  const budget = await client.query('SELECT * FROM arc_mainnet_pilot_budget WHERE id=1 FOR UPDATE');
  if (!budget.rowCount) throw Object.assign(new Error('MAINNET_PILOT_BUDGET_NOT_INITIALIZED'), { code: 'ARC_PILOT_BUDGET_NOT_INITIALIZED' });
  const prior = await client.query(`SELECT * FROM arc_mainnet_pilot_cost_reservations
    WHERE operation_type=$1 AND operation_id=$2 FOR UPDATE`, [operationType, operationId]);
  if (prior.rowCount) {
    const row = prior.rows[0];
    const equivalent = row.world_id === worldId && Number(row.chain_id) === ARC_MAINNET_CHAIN_ID
      && BigInt(row.transfer_usdc_base_units) === transfer && BigInt(row.gas_limit) === gas
      && BigInt(row.max_fee_per_gas) === fee && BigInt(row.reserved_cost_usdc_base_units) === cost;
    if (!equivalent) throw Object.assign(new Error('ARC_PILOT_COST_IDEMPOTENCY_CONFLICT'),
      { code: 'ARC_PILOT_COST_IDEMPOTENCY_CONFLICT' });
    return { reservation: row, created: false, ceilingUsdcBaseUnits: cost };
  }
  const spent = BigInt(budget.rows[0].spent_usdc_base_units);
  const reserved = BigInt(budget.rows[0].reserved_usdc_base_units);
  const limit = BigInt(budget.rows[0].limit_usdc_base_units);
  if (spent + reserved + cost > limit) {
    const error = new Error('ARC_MAINNET_PILOT_COST_CAP_EXCEEDED');
    error.code = 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED';
    error.limitUsdcBaseUnits = limit.toString();
    error.spentUsdcBaseUnits = spent.toString();
    error.reservedUsdcBaseUnits = reserved.toString();
    error.requestedUsdcBaseUnits = cost.toString();
    throw error;
  }
  const inserted = await client.query(`INSERT INTO arc_mainnet_pilot_cost_reservations(operation_type,operation_id,world_id,
      chain_id,transfer_usdc_base_units,gas_limit,max_fee_per_gas,reserved_cost_usdc_base_units,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved') RETURNING *`, [operationType, operationId, worldId,
    ARC_MAINNET_CHAIN_ID, transfer.toString(), gas.toString(), fee.toString(), cost.toString()]);
  await client.query(`UPDATE arc_mainnet_pilot_budget SET reserved_usdc_base_units=reserved_usdc_base_units+$1,
    updated_at=now() WHERE id=1`, [cost.toString()]);
  return { reservation: inserted.rows[0], created: true, ceilingUsdcBaseUnits: cost };
}

export async function setArcMainnetPilotCostStatus(client, { operationType, operationId, status, transactionHash = null }) {
  if (!['submitting','submission_unknown','submitted'].includes(status)) throw new TypeError('Cost reservation status is invalid.');
  const result = await client.query(`UPDATE arc_mainnet_pilot_cost_reservations SET status=$3,
      transaction_hash=COALESCE($4,transaction_hash),updated_at=now()
    WHERE operation_type=$1 AND operation_id=$2 AND status IN ('reserved','submitting','submission_unknown','submitted')
    RETURNING *`, [operationType, operationId, status, transactionHash]);
  if (!result.rowCount) throw Object.assign(new Error('ARC_PILOT_COST_RESERVATION_NOT_FOUND'),
    { code: 'ARC_PILOT_COST_RESERVATION_NOT_FOUND' });
  return result.rows[0];
}

export async function releaseArcMainnetPilotCost(client, { operationType, operationId }) {
  const budget = await client.query('SELECT * FROM arc_mainnet_pilot_budget WHERE id=1 FOR UPDATE');
  const reservation = await client.query(`SELECT * FROM arc_mainnet_pilot_cost_reservations
    WHERE operation_type=$1 AND operation_id=$2 FOR UPDATE`, [operationType, operationId]);
  if (!reservation.rowCount) return false;
  const row = reservation.rows[0];
  if (row.status === 'released') return false;
  if (!['reserved','submitting'].includes(row.status)) {
    throw Object.assign(new Error('ARC_PILOT_COST_RESERVATION_CANNOT_BE_RELEASED'),
      { code: 'ARC_PILOT_COST_RESERVATION_CANNOT_BE_RELEASED' });
  }
  const amount = BigInt(row.reserved_cost_usdc_base_units);
  if (BigInt(budget.rows[0].reserved_usdc_base_units) < amount) {
    throw Object.assign(new Error('ARC_PILOT_BUDGET_RESERVATION_INVARIANT_FAILED'),
      { code: 'ARC_PILOT_BUDGET_RESERVATION_INVARIANT_FAILED' });
  }
  await client.query(`UPDATE arc_mainnet_pilot_cost_reservations SET status='released',updated_at=now() WHERE id=$1`, [row.id]);
  await client.query(`UPDATE arc_mainnet_pilot_budget SET reserved_usdc_base_units=reserved_usdc_base_units-$1,
    updated_at=now() WHERE id=1`, [amount.toString()]);
  return true;
}

export async function settleArcMainnetPilotCost(client, { operationType, operationId, receiptStatus,
  gasUsed, effectiveGasPrice }) {
  const budget = await client.query('SELECT * FROM arc_mainnet_pilot_budget WHERE id=1 FOR UPDATE');
  const reservation = await client.query(`SELECT * FROM arc_mainnet_pilot_cost_reservations
    WHERE operation_type=$1 AND operation_id=$2 FOR UPDATE`, [operationType, operationId]);
  if (!reservation.rowCount) throw Object.assign(new Error('ARC_PILOT_COST_RESERVATION_NOT_FOUND'),
    { code: 'ARC_PILOT_COST_RESERVATION_NOT_FOUND' });
  const row = reservation.rows[0];
  if (row.status === 'settled') return { settled: false, actualCostUsdcBaseUnits: String(row.actual_cost_usdc_base_units) };
  if (!['submitting','submission_unknown','submitted'].includes(row.status)) {
    throw Object.assign(new Error('ARC_PILOT_COST_RESERVATION_NOT_SUBMITTED'),
      { code: 'ARC_PILOT_COST_RESERVATION_NOT_SUBMITTED' });
  }
  const success = receiptStatus === true || receiptStatus === 1 || receiptStatus === '0x1' || receiptStatus === '0x01';
  const used = nonNegativeBigInt(gasUsed, 'gasUsed');
  const effectivePrice = nonNegativeBigInt(effectiveGasPrice, 'effectiveGasPrice');
  const gasCost = arcNativeWeiToUsdcBaseUnitsCeiling(used * effectivePrice);
  const transferCost = success ? BigInt(row.transfer_usdc_base_units) : 0n;
  const actual = transferCost + gasCost;
  const reservedAmount = BigInt(row.reserved_cost_usdc_base_units);
  if (actual > reservedAmount) {
    throw Object.assign(new Error('ARC_PILOT_ACTUAL_COST_EXCEEDS_RESERVED_CEILING'),
      { code: 'ARC_PILOT_ACTUAL_COST_EXCEEDS_RESERVED_CEILING' });
  }
  if (BigInt(budget.rows[0].reserved_usdc_base_units) < reservedAmount) {
    throw Object.assign(new Error('ARC_PILOT_BUDGET_RESERVATION_INVARIANT_FAILED'),
      { code: 'ARC_PILOT_BUDGET_RESERVATION_INVARIANT_FAILED' });
  }
  await client.query(`UPDATE arc_mainnet_pilot_cost_reservations SET status='settled',
      actual_cost_usdc_base_units=$2,gas_used=$3,effective_gas_price=$4,updated_at=now() WHERE id=$1`,
  [row.id, actual.toString(), used.toString(), effectivePrice.toString()]);
  await client.query(`UPDATE arc_mainnet_pilot_budget SET reserved_usdc_base_units=reserved_usdc_base_units-$1,
      spent_usdc_base_units=spent_usdc_base_units+$2,updated_at=now() WHERE id=1`,
  [reservedAmount.toString(), actual.toString()]);
  return { settled: true, actualCostUsdcBaseUnits: actual.toString(), gasCostUsdcBaseUnits: gasCost.toString(),
    transferCostUsdcBaseUnits: transferCost.toString() };
}
