// tickfix1 integration: the real PostgreSQL lock behaviour behind the 10-22/23 deadlocks.
// Needs TICKFIX_TEST_DATABASE_URL (a throwaway database; the test creates its own tables in a schema).
// It reproduces the old lock order (deadlock) and shows the new order (members first) never deadlocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { lockMembersFirst, preLockTickResidents } from '../src/tick-lock-order.js';

const url = process.env.TICKFIX_TEST_DATABASE_URL;
const env = { MIRRORTERRA_TICKFIX_FLAGS_FILE: '/nonexistent/tickfix-flags.json', MIRRORTERRA_TICKFIX_MEMBER_LOCK_WAIT_MS: '20000' };
const WORLD = '00000000-0000-4000-8000-0000000000aa';
const AGENTS = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002'];
const X = AGENTS[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SCHEMA = 'tickfix_it';

async function setup(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
    SET search_path=${SCHEMA};
    CREATE TABLE world_members(world_id uuid, agent_id uuid, joined_at timestamptz, energy int DEFAULT 50,
      PRIMARY KEY(world_id,agent_id));
    CREATE TABLE world_agent_states(world_id uuid, agent_id uuid, status text DEFAULT 'idle', PRIMARY KEY(world_id,agent_id),
      FOREIGN KEY(world_id,agent_id) REFERENCES world_members);
    CREATE TABLE world_agent_cognition_state(world_id uuid, agent_id uuid, available_affordances jsonb DEFAULT '[]',
      lease_token uuid, PRIMARY KEY(world_id,agent_id), FOREIGN KEY(world_id,agent_id) REFERENCES world_members);
    CREATE TABLE world_agent_cognition_gate_decisions(id bigserial PRIMARY KEY, world_id uuid, agent_id uuid,
      decision text, FOREIGN KEY(world_id,agent_id) REFERENCES world_members);
    CREATE TABLE arc_sync_resident_reward_entitlements(id bigserial PRIMARY KEY, world_id uuid, agent_id uuid,
      FOREIGN KEY(world_id,agent_id) REFERENCES world_members);`);
  for (const [index, agent] of AGENTS.entries()) {
    await pool.query(`INSERT INTO ${SCHEMA}.world_members(world_id,agent_id,joined_at) VALUES($1,$2,now()-($3||' minutes')::interval)`,
      [WORLD, agent, String(index)]);
    await pool.query(`INSERT INTO ${SCHEMA}.world_agent_states(world_id,agent_id) VALUES($1,$2)`, [WORLD, agent]);
    await pool.query(`INSERT INTO ${SCHEMA}.world_agent_cognition_state(world_id,agent_id) VALUES($1,$2)`, [WORLD, agent]);
  }
}

async function session(pool) {
  const client = await pool.connect();
  await client.query(`SET search_path=${SCHEMA}`);
  return client;
}
// The tick's old member read (prod line: ORDER BY m.joined_at,a.name FOR UPDATE OF m,s).
const OLD_TICK_MEMBERS = `SELECT m.agent_id FROM world_members m JOIN world_agent_states s USING(world_id,agent_id)
  WHERE m.world_id=$1 ORDER BY m.joined_at FOR UPDATE OF m,s`;
const settle = (promise) => promise.then(() => 'ok', (error) => error.code || error.message);

test('tickfix integration (real PostgreSQL lock order)', { skip: !url && 'TICKFIX_TEST_DATABASE_URL not set' }, async (t) => {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  await setup(pool);
  try {
    await t.test('old order: worker locks cognition state, then FK on members -> deadlock with the tick', async () => {
      const tick = await session(pool); const worker = await session(pool);
      try {
        await tick.query('BEGIN'); await worker.query('BEGIN');
        await tick.query(OLD_TICK_MEMBERS, [WORLD]);
        await worker.query('SELECT 1 FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE SKIP LOCKED', [WORLD, X]);
        const tickUpdate = settle(tick.query(`UPDATE world_agent_cognition_state SET available_affordances='[1]' WHERE world_id=$1 AND agent_id=$2`, [WORLD, X]));
        await sleep(100);
        const gateInsert = settle(worker.query(`INSERT INTO world_agent_cognition_gate_decisions(world_id,agent_id,decision) VALUES($1,$2,'claimed')`, [WORLD, X]));
        const results = await Promise.all([tickUpdate, gateInsert]);
        assert.ok(results.includes('40P01'), `expected one side to lose a deadlock, got ${results}`);
      } finally { await tick.query('ROLLBACK'); await worker.query('ROLLBACK'); tick.release(); worker.release(); }
    });

    await t.test('new order, tick first: worker waits on the member row holding nothing; both commit', async () => {
      const tick = await session(pool); const worker = await session(pool);
      try {
        await tick.query('BEGIN'); await worker.query('BEGIN');
        assert.equal(await preLockTickResidents(tick, WORLD, { env }), true);
        await tick.query(OLD_TICK_MEMBERS, [WORLD]); // the tick's later read re-locks rows it already holds
        const workerSide = (async () => {
          await lockMembersFirst(worker, WORLD, { agentIds: [X], env });
          const row = await worker.query('SELECT 1 FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE SKIP LOCKED', [WORLD, X]);
          assert.equal(row.rowCount, 1, 'the tick committed before the worker got the member row');
          await worker.query(`INSERT INTO world_agent_cognition_gate_decisions(world_id,agent_id,decision) VALUES($1,$2,'claimed')`, [WORLD, X]);
          await worker.query('COMMIT');
        })();
        await sleep(150);
        await tick.query(`UPDATE world_agent_cognition_state SET available_affordances='[2]' WHERE world_id=$1 AND agent_id=$2`, [WORLD, X]);
        await tick.query('COMMIT');
        assert.equal(await settle(workerSide), 'ok');
      } finally { await tick.query('ROLLBACK').catch(() => {}); await worker.query('ROLLBACK').catch(() => {}); tick.release(); worker.release(); }
    });

    await t.test('new order, worker first: the tick waits a moment at its pre-lock; both commit', async () => {
      const tick = await session(pool); const worker = await session(pool);
      try {
        await worker.query('BEGIN'); await tick.query('BEGIN');
        await lockMembersFirst(worker, WORLD, { agentIds: [X], env });
        await worker.query('SELECT 1 FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE SKIP LOCKED', [WORLD, X]);
        const tickSide = (async () => {
          await preLockTickResidents(tick, WORLD, { env });
          await tick.query(`UPDATE world_agent_cognition_state SET available_affordances='[3]' WHERE world_id=$1 AND agent_id=$2`, [WORLD, X]);
          await tick.query('COMMIT');
        })();
        await sleep(150);
        await worker.query(`INSERT INTO world_agent_cognition_gate_decisions(world_id,agent_id,decision) VALUES($1,$2,'claimed')`, [WORLD, X]);
        await worker.query('COMMIT');
        assert.equal(await settle(tickSide), 'ok');
      } finally { await tick.query('ROLLBACK').catch(() => {}); await worker.query('ROLLBACK').catch(() => {}); tick.release(); worker.release(); }
    });

    await t.test('reward worker: advisory-then-members deadlocks; members-then-advisory does not', async () => {
      const key = `sync-resident-rewards:${WORLD}`;
      // old
      let tick = await session(pool); let worker = await session(pool);
      try {
        await tick.query('BEGIN'); await worker.query('BEGIN');
        await worker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
        await tick.query(OLD_TICK_MEMBERS, [WORLD]);
        const tickAdvisory = settle(tick.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]));
        await sleep(100);
        const entitlement = settle(worker.query('INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id) VALUES($1,$2)', [WORLD, X]));
        const results = await Promise.all([tickAdvisory, entitlement]);
        assert.ok(results.includes('40P01'), `expected a deadlock, got ${results}`);
      } finally { await tick.query('ROLLBACK'); await worker.query('ROLLBACK'); tick.release(); worker.release(); }
      // new
      tick = await session(pool); worker = await session(pool);
      try {
        await tick.query('BEGIN'); await worker.query('BEGIN');
        await preLockTickResidents(tick, WORLD, { env });
        const workerSide = (async () => {
          await lockMembersFirst(worker, WORLD, { env });
          await worker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
          for (const agent of AGENTS) await worker.query('INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id) VALUES($1,$2)', [WORLD, agent]);
          await worker.query('COMMIT');
        })();
        await sleep(150);
        await tick.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
        await tick.query('COMMIT');
        assert.equal(await settle(workerSide), 'ok');
      } finally { await tick.query('ROLLBACK').catch(() => {}); await worker.query('ROLLBACK').catch(() => {}); tick.release(); worker.release(); }
    });

    await t.test('stress: 3 writers outside the tick + a tick loop, members first everywhere -> 0 deadlocks', async () => {
      let deadlocks = 0; let commits = 0;
      const run = async (fn) => { const c = await session(pool); try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); commits += 1; }
        catch (error) { await c.query('ROLLBACK').catch(() => {}); if (error.code === '40P01') deadlocks += 1; else throw error; } finally { c.release(); } };
      const jitter = () => sleep(Math.floor(Math.random() * 15));
      const tickLoop = async () => { for (let i = 0; i < 25; i += 1) await run(async (c) => {
        await preLockTickResidents(c, WORLD, { env }); await c.query(OLD_TICK_MEMBERS, [WORLD]); await jitter();
        for (const agent of [...AGENTS].reverse()) { await c.query(`UPDATE world_agent_cognition_state SET available_affordances='[4]' WHERE world_id=$1 AND agent_id=$2`, [WORLD, agent]); await jitter(); }
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sync-resident-rewards:${WORLD}`]);
      }); };
      const cognitionLoop = async () => { for (let i = 0; i < 40; i += 1) await run(async (c) => {
        const agent = AGENTS[i % AGENTS.length];
        await lockMembersFirst(c, WORLD, { agentIds: [agent], env });
        await c.query('SELECT 1 FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [WORLD, agent]); await jitter();
        await c.query(`INSERT INTO world_agent_cognition_gate_decisions(world_id,agent_id,decision) VALUES($1,$2,'claimed')`, [WORLD, agent]);
      }); };
      const rewardLoop = async () => { for (let i = 0; i < 25; i += 1) await run(async (c) => {
        await lockMembersFirst(c, WORLD, { env });
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sync-resident-rewards:${WORLD}`]); await jitter();
        for (const agent of AGENTS) await c.query('INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id) VALUES($1,$2)', [WORLD, agent]);
      }); };
      await Promise.all([tickLoop(), cognitionLoop(), cognitionLoop(), rewardLoop()]);
      assert.equal(deadlocks, 0);
      assert.equal(commits, 25 + 40 + 40 + 25);
    });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool.end();
  }
});
