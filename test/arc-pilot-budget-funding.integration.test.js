import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { recordArcMainnetPilotFunding } from '../src/arc/pilot-budget.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'Funding integration requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'Funding integration must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'Funding integration requires a *_test database');
}

test('funding ledger and budget update are atomic and transaction-hash idempotent on isolated PostgreSQL', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await applyWorldSchemaAndMigrations(pool, { rootDirectory });
    const client = await pool.connect();
    const worldId = randomUUID();
    const agentId = randomUUID();
    const transactionHash = `0x${randomBytes(32).toString('hex')}`;
    const input = { worldId, agentId, chainId: 5042, transactionHash,
      receiptEmitterAddress: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
      recipientAddress: '0x29Fef6FE7d56b929Afe613C0358B81c054652d42',
      receiptAmountRaw: '1977399000000000000', receiptAssetDecimals: 18,
      receiptBlockNumber: '25643826', receiptTimestamp: '2026-10-12T14:03:56.000Z' };
    try {
      await client.query('BEGIN');
      const owner = await client.query(`INSERT INTO agents(name,public_key) VALUES($1,$2) RETURNING id`,
        [`funding-test-${worldId.slice(0, 8)}`, `funding-test-${worldId}`]);
      await client.query(`INSERT INTO worlds(id,owner_agent_id,name) VALUES($1,$2,$3)`,
        [worldId, owner.rows[0].id, `Funding test ${worldId.slice(0, 8)}`]);
      await client.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)',
        [agentId, `funding-agent-${worldId.slice(0, 8)}`, `funding-agent-${worldId}`]);
      await client.query('INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,$3)', [worldId, agentId, 'resident']);
      await client.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
        reserved_usdc_base_units=0 WHERE id=1`);

      const first = await recordArcMainnetPilotFunding(client, input);
      assert.equal(first.created, true);
      assert.equal(first.budget.spentUsdcBaseUnits, '1977399');
      assert.equal(first.budget.reservedUsdcBaseUnits, '0');
      const duplicate = await recordArcMainnetPilotFunding(client, input);
      assert.equal(duplicate.created, false);
      const count = await client.query(`SELECT count(*)::integer AS count FROM arc_mainnet_pilot_funding_ledger
        WHERE chain_id=5042 AND transaction_hash=$1`, [transactionHash]);
      assert.equal(count.rows[0].count, 1);
      const budget = await client.query(`SELECT spent_usdc_base_units::text AS spent,
        reserved_usdc_base_units::text AS reserved FROM arc_mainnet_pilot_budget WHERE id=1`);
      assert.equal(budget.rows[0].spent, '1977399');
      assert.equal(budget.rows[0].reserved, '0');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await pool.end();
  }
});
