import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const databaseUrl = process.env.MIRRORTERRA_TEST_DATABASE_URL;
const enabled = process.env.MIRRORTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worldId = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const members = [
  ['f952ef0a-001f-408e-8e5d-684b63f133ac','01'],
  ['3b331e3d-88c9-4080-adf1-0fedc13b52ae','02'],
  ['57c09d40-df32-4293-af2f-653b85c6244a','03'],
  ['559191b8-b469-46ad-962e-b0627cb8e8db','04'],
  ['f667acff-2c2e-4481-b732-e3fbea562013','05'],
  ['745df3f0-e36e-4350-827d-cb945b872b71','06'],
  ['f29f61e4-9757-4b1c-a1b8-2da4fca62bae','07'],
  ['012fdab2-73a6-4655-9aba-f29c1892a84e','08'],
  ['3cd80db6-ad3d-41a0-bb62-04c4e5720cd8','09'],
  ['46015f3f-d58c-4e0f-8bd6-bdb2afc3da91','10']
];

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
    'brand migration validation requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'brand migration validation must not use formal/default PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'),
    'brand migration validation requires a *_test database');
}

test('0007 renames only the existing world and verified Agent display names, idempotently', {
  skip: !enabled
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const migration = await readFile(path.join(repoRoot, 'migrations/0007_mirrorterra_brand_identity.sql'), 'utf8');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE worlds(id uuid PRIMARY KEY,name text NOT NULL);
      CREATE TEMP TABLE agents(id uuid PRIMARY KEY,name text NOT NULL);
      CREATE TEMP TABLE world_members(world_id uuid NOT NULL,agent_id uuid NOT NULL,
        PRIMARY KEY(world_id,agent_id));
      CREATE TEMP TABLE arc_currency_genesis_requirements(world_id uuid PRIMARY KEY,status text NOT NULL,
        current_proposal_id uuid);
      CREATE TEMP TABLE world_genesis_issuer_assignments(world_id uuid NOT NULL,capability_generation integer NOT NULL,
        issuer_agent_id uuid NOT NULL,selection_source text NOT NULL,PRIMARY KEY(world_id,capability_generation));
      CREATE TEMP TABLE arc_token_issuance_intents(id uuid PRIMARY KEY,world_id uuid NOT NULL,status text NOT NULL);
      CREATE TEMP TABLE world_genesis_currency_activations(world_id uuid PRIMARY KEY,token_id uuid NOT NULL);`);
    await client.query(migration);
    await client.query('INSERT INTO worlds(id,name) VALUES($1,$2)', [worldId, 'Synterra']);
    for (const [agentId, slot] of members) {
      await client.query('INSERT INTO agents(id,name) VALUES($1,$2)', [agentId, `Synterra-${slot}`]);
      await client.query('INSERT INTO world_members(world_id,agent_id) VALUES($1,$2)', [worldId, agentId]);
    }
    await client.query('INSERT INTO arc_currency_genesis_requirements(world_id,status) VALUES($1,$2)', [worldId, 'UNRESOLVED']);
    await client.query(`INSERT INTO world_genesis_issuer_assignments(world_id,capability_generation,issuer_agent_id,selection_source)
      VALUES($1,1,$2,'creator_genesis_assignment')`, [worldId, members[0][0]]);

    const before = (await client.query(`SELECT agent.id,agent.name FROM world_members member
      JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=$1 ORDER BY agent.id`, [worldId])).rows;
    await client.query(migration);
    await client.query(migration);
    const after = (await client.query(`SELECT agent.id,agent.name FROM world_members member
      JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=$1 ORDER BY agent.id`, [worldId])).rows;
    const world = (await client.query('SELECT id,name FROM worlds WHERE id=$1', [worldId])).rows[0];
    const requirement = (await client.query('SELECT status,current_proposal_id FROM arc_currency_genesis_requirements WHERE world_id=$1', [worldId])).rows[0];
    const issuer = (await client.query(`SELECT issuer_agent_id,selection_source FROM world_genesis_issuer_assignments
      WHERE world_id=$1 AND capability_generation=1`, [worldId])).rows[0];

    assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id));
    assert.deepEqual(after.map((row) => row.name).sort(), members.map(([, slot]) => `MirrorTerra-${slot}`).sort());
    assert.deepEqual(world, { id: worldId, name: 'MirrorTerra' });
    assert.deepEqual(requirement, { status: 'UNRESOLVED', current_proposal_id: null });
    assert.deepEqual(issuer, { issuer_agent_id: members[0][0], selection_source: 'creator_genesis_assignment' });
    assert.equal((await client.query('SELECT count(*)::int AS count FROM world_members WHERE world_id=$1', [worldId])).rows[0].count, 10);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1', [worldId])).rows[0].count, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM world_genesis_currency_activations WHERE world_id=$1', [worldId])).rows[0].count, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
