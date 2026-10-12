import test from 'node:test';
import assert from 'node:assert/strict';
import { arcReceiptAmountToUsdcBaseUnits, recordArcMainnetPilotFunding } from '../src/arc/pilot-budget.js';

const FUNDING = Object.freeze({
  worldId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  chainId: 5042,
  transactionHash: `0x${'a'.repeat(64)}`,
  receiptEmitterAddress: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
  recipientAddress: '0x29Fef6FE7d56b929Afe613C0358B81c054652d42',
  receiptAmountRaw: '1977399000000000000',
  receiptAssetDecimals: 18,
  receiptBlockNumber: '25643826',
  receiptTimestamp: '2026-10-12T14:03:56.000Z'
});

function fundingRow(values) {
  const [world_id, agent_id, chain_id, transaction_hash, category, asset_symbol, receipt_emitter_address,
    recipient_address, receipt_amount_raw, receipt_asset_decimals, budget_amount_usdc_base_units,
    receipt_block_number, receipt_timestamp] = values;
  return { world_id, agent_id, chain_id, transaction_hash, category, asset_symbol, receipt_emitter_address,
    recipient_address, receipt_amount_raw, receipt_asset_decimals, budget_amount_usdc_base_units,
    receipt_block_number, receipt_timestamp: new Date(receipt_timestamp) };
}

function fundingDatabase({ spent = '0', reserved = '0', limit = '10000000' } = {}) {
  const ledger = [];
  const budget = { id: 1, spent_usdc_base_units: spent, reserved_usdc_base_units: reserved,
    limit_usdc_base_units: limit };
  const client = {
    async query(sql, values = []) {
      const query = String(sql).replace(/\s+/g, ' ').trim();
      if (query.startsWith('SELECT * FROM arc_mainnet_pilot_budget')) {
        return { rowCount: 1, rows: [{ ...budget }] };
      }
      if (query.startsWith('SELECT * FROM arc_mainnet_pilot_funding_ledger')) {
        const row = ledger.find((entry) => entry.chain_id === Number(values[0])
          && entry.transaction_hash === values[1]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
      }
      if (query.startsWith('INSERT INTO arc_mainnet_pilot_funding_ledger')) {
        const row = fundingRow(values);
        ledger.push(row);
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (query.startsWith('UPDATE arc_mainnet_pilot_budget')) {
        budget.spent_usdc_base_units = (BigInt(budget.spent_usdc_base_units) + BigInt(values[0])).toString();
        return { rowCount: 1, rows: [{ spent_usdc_base_units: budget.spent_usdc_base_units,
          reserved_usdc_base_units: budget.reserved_usdc_base_units, limit_usdc_base_units: budget.limit_usdc_base_units }] };
      }
      throw new Error(`Unexpected SQL in funding test: ${query}`);
    }
  };
  return { client, budget, ledger };
}

test('Arc receipt amount converts exactly to six-decimal pilot budget units', () => {
  assert.equal(arcReceiptAmountToUsdcBaseUnits('1977399000000000000', 18), 1_977_399n);
  assert.equal(arcReceiptAmountToUsdcBaseUnits('1977399', 6), 1_977_399n);
  assert.throws(() => arcReceiptAmountToUsdcBaseUnits('1000000000001', 18), /represented exactly/);
});

test('verified funding is recorded once, preserves reserved, and rejects conflicts or cap overflow', async () => {
  const database = fundingDatabase({ reserved: '4567' });
  const first = await recordArcMainnetPilotFunding(database.client, FUNDING);
  assert.equal(first.created, true);
  assert.deepEqual(first.budget, { spentUsdcBaseUnits: '1977399', reservedUsdcBaseUnits: '4567',
    remainingUsdcBaseUnits: '8018034', limitUsdcBaseUnits: '10000000' });
  assert.equal(database.ledger.length, 1);

  const retry = await recordArcMainnetPilotFunding(database.client, FUNDING);
  assert.equal(retry.created, false);
  assert.equal(database.budget.spent_usdc_base_units, '1977399');
  assert.equal(database.budget.reserved_usdc_base_units, '4567');
  assert.equal(database.ledger.length, 1);

  await assert.rejects(recordArcMainnetPilotFunding(database.client, {
    ...FUNDING, receiptEmitterAddress: '0x1111111111111111111111111111111111111111'
  }), (error) => error.code === 'ARC_PILOT_FUNDING_IDEMPOTENCY_CONFLICT');

  const capped = fundingDatabase({ spent: '9000000', reserved: '500000' });
  await assert.rejects(recordArcMainnetPilotFunding(capped.client, {
    ...FUNDING, transactionHash: `0x${'b'.repeat(64)}`
  }), (error) => error.code === 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED');
  assert.equal(capped.ledger.length, 0);
  assert.equal(capped.budget.spent_usdc_base_units, '9000000');
});
