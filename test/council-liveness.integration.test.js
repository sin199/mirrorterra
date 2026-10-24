// Integration (council3, updated for council4's builder-capacity rule): council liveness without Luna, public works (commission -> bids -> award ->
// construction sessions -> milestone payments -> a real place with its effect), the Luna deliberation
// path with a scripted model (one resident's call fails -> fallback), taxes and conservation, on a real
// migrated database (0028 + 0029 + 0030 + 0031), inside a single transaction that is always rolled back.
// Set COUNCIL_TEST_DATABASE_URL to run it (a scratch DB restored from a production dump); skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { COUNCIL_GOVERNOR_ID, COUNCIL_QUORUM, readEconomyStats, runCouncilHour } from '../src/council.js';
import { issueResidentReward, readTreasuryBalance, readTreasuryFreeBalance } from '../src/treasury.js';
import { NO_BUILDER_CAPACITY, advancePublicWork, commissionCapacity, publicWorksEffectsFromScenes, readPublicWorks,
  runPublicWorksHour } from '../src/public-works.js';
import { councilDeliberationStep } from '../src/council-deliberation.js';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
const ENV = { MIRRORTERRA_COUNCIL: 'on', MIRRORTERRA_SYNC_ECONOMY: 'on' };

async function conservation(client, worldId) {
  const result = await client.query(`SELECT
      (SELECT COALESCE(sum(spendable_raw),0) FROM arc_sync_internal_balances WHERE world_id=$1)::text AS residents,
      (SELECT COALESCE((SELECT balance_raw FROM world_sync_treasury_balances WHERE world_id=$1),0))::text AS treasury,
      (SELECT COALESCE(sum(sync_amount_raw),0) FROM arc_sync_resident_reward_entitlements
        WHERE world_id=$1 AND status='pending')::text AS backed,
      (SELECT count(*) FROM arc_sync_internal_balances WHERE world_id=$1 AND spendable_raw<0)::int AS negative`, [worldId]);
  const row = result.rows[0];
  return { residents: BigInt(row.residents), treasury: BigInt(row.treasury), backed: BigInt(row.backed), negative: row.negative };
}

// A "pool" over the single test client: transactions become savepoints inside the rolled-back test transaction.
function poolOver(client) {
  let n = 0;
  return { query: (...args) => client.query(...args), async connect() {
    const name = `deliberation_${n += 1}`;
    return { release() {}, query(sql, params) {
      const text = String(sql).trim();
      if (text === 'BEGIN') return client.query(`SAVEPOINT ${name}`);
      if (text === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${name}`);
      if (text === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${name}`).then(() => client.query(`RELEASE SAVEPOINT ${name}`));
      return client.query(sql, params);
    } };
  } };
}

test('council4: liveness without Luna, no tender while no builder has capacity, public works paid per milestone, Luna deliberation with fallback, conservation', { skip: !url }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const log = [];
  try {
    await client.query('BEGIN');
    const world = await client.query(`SELECT deployment.world_id::text AS world_id,state.world_minutes::bigint AS minutes,
        (SELECT count(*) FROM world_members member WHERE member.world_id=deployment.world_id
          -- external1: the council's Luna/fallback members are the original residents (external residents decide via their own AI)
          AND NOT EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=member.world_id AND e.agent_id=member.agent_id))::int AS members
      FROM arc_sync_tokenomics_deployments deployment JOIN world_runtime_state state ON state.world_id=deployment.world_id
      ORDER BY members DESC LIMIT 1`);
    assert.ok(world.rowCount, 'a SYNC world is required');
    const { world_id: worldId, members } = world.rows[0];
    assert.ok(members >= COUNCIL_QUORUM);
    const day = Math.floor(Number(world.rows[0].minutes) / 1440) + 1;
    const startedAt = (await client.query('SELECT now() AS t')).rows[0].t;
    const before = await conservation(client, worldId);
    assert.equal(before.residents + before.treasury, before.backed);

    // Day 1: no Luna at all. The in-tick safety net proposes (11:00), votes (14:00) and decides (15:00).
    for (let hour = 0; hour < 24; hour += 1) {
      await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, day * 1440 + hour * 60]);
      await runCouncilHour(client, { worldId, worldMinutes: day * 1440 + hour * 60, env: ENV });
    }
    const proposals = await client.query(`SELECT id,title,status,source,
        (SELECT count(*) FROM world_council_votes vote WHERE vote.proposal_id=proposal.id)::int AS votes
      FROM world_council_proposals proposal WHERE world_id=$1 AND opened_world_day=$2`, [worldId, day]);
    assert.ok(proposals.rowCount >= 1, 'a proposal within one world day without Luna');
    assert.equal(proposals.rows[0].source, 'session_fallback');
    assert.ok(proposals.rows[0].votes >= COUNCIL_QUORUM);
    assert.ok(['passed','rejected'].includes(proposals.rows[0].status));
    const fallbackRows = await client.query(`SELECT phase,source,count(*)::int AS n FROM world_council_deliberations
      WHERE world_id=$1 AND world_day=$2 GROUP BY 1,2 ORDER BY 1`, [worldId, day]);
    assert.ok(fallbackRows.rows.every((row) => row.source === 'fallback'));
    log.push({ day1: proposals.rows[0].title, status: proposals.rows[0].status, deliberations: fallbackRows.rows });

    // Day 1 under council4: a NO_BUILDER_CAPACITY skip is recorded at most once per world hour.
    const skipsPerHour = async () => (await client.query(`SELECT world_minute/60 AS h,count(*)::int AS n
      FROM world_council_deliberations WHERE world_id=$1 AND world_day>=$2 AND failure_code=$3 GROUP BY 1 HAVING count(*)>1`,
    [worldId, day, NO_BUILDER_CAPACITY])).rowCount;
    assert.equal(await skipsPerHour(), 0, 'at most one capacity skip per world hour');
    const day1Skips = (await client.query(`SELECT count(*)::int AS n FROM world_council_deliberations WHERE world_id=$1
      AND world_day=$2 AND failure_code=$3`, [worldId, day, NO_BUILDER_CAPACITY])).rows[0].n;

    // Day 2: 30 SYNC of goods revenue. Treasury -> public works.
    const rich = (await client.query(`SELECT agent_id::text AS id FROM arc_sync_internal_balances WHERE world_id=$1
      AND agent_id<>$2 ORDER BY spendable_raw DESC LIMIT 1`, [worldId, COUNCIL_GOVERNOR_ID])).rows[0].id;
    const d2 = (day + 1) * 1440;
    await client.query(`INSERT INTO world_sync_treasury_entries(world_id,entry_key,kind,from_agent_id,amount_raw,reason,actor,world_day,world_minute)
      VALUES($1,'test:inflow:30','goods_purchase',$2,30000000,'integration test inflow','market',$3,$4)`, [worldId, rich, day + 1, d2]);
    const residentsNow = async () => (await readEconomyStats(client, { worldId })).residents || [];
    const buildingNow = () => readPublicWorks(client, { worldId, statuses: ['building'] });
    const tenders = async () => (await client.query(`SELECT count(*)::int AS n FROM world_public_works WHERE world_id=$1
      AND commissioned_world_minute>=$2`, [worldId, d2])).rows[0].n;
    // council4: when no eligible builder has capacity, the council does not commission (no tender to cancel, no '.rN' churn).
    const capacity0 = commissionCapacity(await residentsNow(), await buildingNow(), d2);
    await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, d2]);
    const h0 = await runCouncilHour(client, { worldId, worldMinutes: d2, env: ENV });
    if (!capacity0.hasCapacity) {
      assert.equal(h0.publicWorks?.commissioned, undefined, `no commission while saturated (${JSON.stringify(h0.publicWorks)})`);
      assert.equal(await tenders(), 0, 'no tender while no builder has capacity');
      if (h0.publicWorks?.skipped) {
        assert.equal(h0.publicWorks.skipped.reason, NO_BUILDER_CAPACITY);
        const again = await runPublicWorksHour(client, { worldId, worldMinutes: d2 + 30, stats: { residents: await residentsNow() }, env: ENV });
        assert.equal(again.skipped?.recorded, false, 'second skip in the same world hour is not recorded');
        assert.equal(await skipsPerHour(), 0);
      }
    }
    log.push({ day2Start: { capacity: capacity0, skipped: h0.publicWorks?.skipped || null, day1Skips } });

    // Builders build (one session on every held contract each hour), so capacity frees up; the council commissions.
    const buildAll = async (minute) => {
      for (const held of await buildingNow()) {
        if (held.scene_name) await advancePublicWork(client, { worldId, agentId: held.builder_agent_id, place: held.scene_name, worldMinutes: minute });
      }
    };
    let workId = null, price = 0n, freeBefore = 0n, hour = 1;
    for (; hour <= 6 && !workId; hour += 1) {
      await buildAll(d2 + hour * 60 - 20);
      freeBefore = await readTreasuryFreeBalance(client, worldId);
      await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, d2 + hour * 60]);
      const result = await runCouncilHour(client, { worldId, worldMinutes: d2 + hour * 60, env: ENV });
      if (result.publicWorks?.commissioned?.workId) {
        assert.ok(commissionCapacity(await residentsNow(), await buildingNow(), d2 + hour * 60).hasCapacity,
          'commissioned only while a builder had capacity');
        workId = result.publicWorks.commissioned.workId;
        price = BigInt(result.publicWorks.commissioned.priceRaw);
      }
    }
    assert.ok(workId, 'commissioned once builders were building');
    assert.ok(await readTreasuryBalance(client, worldId) >= 0n);
    const reserved = async () => BigInt((await client.query(`SELECT COALESCE(contract_price_raw,price_raw)-paid_raw AS r
      FROM world_public_works WHERE id=$1 AND status IN ('bidding','building')`, [workId])).rows[0]?.r ?? 0);
    assert.equal(await reserved(), price, 'the whole price is reserved (escrow)');
    assert.ok(price <= freeBefore, 'commissioned only because the free balance covered the full price');
    // Bidding closes after 2 world hours: heuristic bids fill in, the best credible bid wins, the site appears.
    let awardMinute = 0;
    for (let step = 0; step < 3; step += 1, hour += 1) {
      await buildAll(d2 + hour * 60 - 20);
      await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, d2 + hour * 60]);
      await runCouncilHour(client, { worldId, worldMinutes: d2 + hour * 60, env: ENV });
      awardMinute = d2 + hour * 60;
      const status = (await client.query('SELECT status FROM world_public_works WHERE id=$1', [workId])).rows[0].status;
      if (status !== 'bidding') break;
    }
    let work = (await client.query(`SELECT work.*,scene.name AS scene_name,scene.status AS scene_status,scene.features
      FROM world_public_works work LEFT JOIN world_scenes scene ON scene.id=work.scene_id WHERE work.id=$1`, [workId])).rows[0];
    assert.equal(work.status, 'building', 'a builder with capacity won the tender');
    const expansion = work.kind === 'expansion';
    const levelBefore = Number(work.features?.publicWork?.level) || 1;
    if (expansion) assert.equal(work.scene_status, 'active', 'an expansion is built at the existing (open) facility');
    else {
      assert.equal(work.scene_status, 'inactive', 'a construction site, not yet usable');
      assert.equal(work.features.publicWork.stage, 'building');
    }
    const bids = await client.query('SELECT count(*)::int AS n,count(*) FILTER (WHERE credible)::int AS credible FROM world_public_work_bids WHERE work_id=$1', [workId]);
    assert.ok(bids.rows[0].n >= members - 1 - 1, 'every non-governor resident bid');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM world_sync_treasury_entries WHERE source_ref=$1`, [`public_work:${workId}`])).rows[0].n, 0,
      'commissioning and the award pay nobody');
    assert.equal(await reserved(), BigInt(work.contract_price_raw), 'after the award only the winning bid stays reserved');
    log.push({ work: { name: work.name, kind: work.kind, price: work.price_raw, contract: work.contract_price_raw, bids: bids.rows[0] } });
    // Construction: the builder works at the site; the treasury pays at 25/50/75/100% only.
    const contract = BigInt(work.contract_price_raw);
    const payments = [];
    for (let session = 0; session < 20; session += 1) {
      const result = await advancePublicWork(client, { worldId, agentId: work.builder_agent_id, place: work.scene_name,
        worldMinutes: awardMinute + 10 + session * 30 });
      assert.ok(result, 'the builder has a session at its site');
      payments.push(...result.payments.map((payment) => ({ ...payment, progress: result.progress })));
      if (result.completed) break;
    }
    const nobody = await advancePublicWork(client, { worldId, agentId: rich, place: work.scene_name, worldMinutes: awardMinute + 700 });
    assert.ok(nobody === null || nobody.workId !== workId, 'only the builder builds');
    assert.deepEqual(payments.map((payment) => payment.milestone), [1, 2, 3, 4]);
    assert.ok(payments.every((payment) => payment.progress >= payment.milestone * 25));
    const paidEntries = await client.query(`SELECT kind,to_agent_id::text AS to,amount_raw::text AS amount FROM world_sync_treasury_entries
      WHERE world_id=$1 AND source_ref=$2 ORDER BY id`, [worldId, `public_work:${workId}`]);
    assert.equal(paidEntries.rowCount, 4);
    assert.ok(paidEntries.rows.every((entry) => entry.kind === 'public_works' && entry.to === work.builder_agent_id));
    assert.equal(paidEntries.rows.reduce((sum, entry) => sum + BigInt(entry.amount), 0n), contract, 'paid exactly the contract');
    work = (await client.query(`SELECT work.*,scene.status AS scene_status,scene.features,scene.name AS scene_name
      FROM world_public_works work JOIN world_scenes scene ON scene.id=work.scene_id WHERE work.id=$1`, [workId])).rows[0];
    assert.equal(work.status, 'completed');
    assert.equal(work.scene_status, 'active', 'the finished project is a real place');
    assert.equal(work.features.publicWork.stage, 'built');
    if (expansion) assert.equal(Number(work.features.publicWork.level), Math.min(3, levelBefore + 1), 'the facility grew one level');
    const effects = publicWorksEffectsFromScenes([{ status: work.scene_status, features: work.features }]);
    assert.ok(Object.values(effects).some((value) => value > 0), `the place has its effect (${JSON.stringify(effects)})`);
    assert.equal(await reserved(), 0n, 'nothing of this work stays reserved');
    log.push({ completed: { name: work.name, effects, payments: payments.map((payment) => payment.amountRaw.toString()) } });

    // Taxes on, hourly conservation, no handouts.
    for (const [lever, value] of [['tax.wealth', { bps: 3000 }], ['tax.income', { bps: 1000 }], ['tax.sales', { bps: 500 }]]) {
      await client.query(`INSERT INTO world_council_policies(world_id,lever_key,value,previous_value,effective_world_day,updated_world_minute)
        VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6) ON CONFLICT(world_id,lever_key) DO UPDATE SET value=EXCLUDED.value,
          effective_world_day=EXCLUDED.effective_world_day`, [worldId, lever, JSON.stringify(value), JSON.stringify({ bps: 0 }), day + 2, d2 + 1000]);
    }
    for (let hour = 0; hour < 24; hour += 1) {
      const minute = (day + 2) * 1440 + hour * 60;
      await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, minute]);
      await runCouncilHour(client, { worldId, worldMinutes: minute, env: ENV });
      const check = await conservation(client, worldId);
      assert.equal(check.negative, 0, `no negative balance at hour ${hour}`);
      assert.equal(check.residents + check.treasury, check.backed, `conservation at hour ${hour}`);
      assert.ok(check.treasury >= 0n);
    }
    const handouts = await client.query(`SELECT kind,count(*)::int AS n FROM world_sync_treasury_entries WHERE world_id=$1
      AND to_agent_id IS NOT NULL AND created_at>=$2 AND kind<>'public_works' GROUP BY kind`, [worldId, startedAt]);
    assert.equal(handouts.rowCount, 0, `no grants/prizes/bounties/purchases/rewards (${JSON.stringify(handouts.rows)})`);
    const flows = await client.query(`SELECT kind,count(*)::int AS n,sum(amount_raw)::text AS amount FROM world_sync_treasury_entries
      WHERE world_id=$1 AND created_at>=$2 GROUP BY kind ORDER BY kind`, [worldId, startedAt]);
    log.push({ flows: flows.rows });

    // Luna deliberation with a scripted model: one resident's call fails -> fallback for that resident only.
    const residents = (await client.query(`SELECT m.agent_id::text AS id,a.name FROM world_members m JOIN agents a ON a.id=m.agent_id
      WHERE m.world_id=$1 ORDER BY m.joined_at,a.name`, [worldId])).rows;
    const failing = residents[2].id;
    const lunaCalls = [];
    const requestModel = async ({ messages, callContext }) => {
      lunaCalls.push(callContext.agentId);
      if (callContext.agentId === failing) throw Object.assign(new Error('timeout'), { code: 'BAI_COMPLETION_UNAVAILABLE' });
      const user = JSON.parse(messages.at(-1).content);
      if (user.proposals) return { output: { votes: user.proposals.map((proposal) => ({ id: proposal.id,
        stance: callContext.agentId === residents[1].id ? 'no' : 'yes', reason: `My view on ${proposal.title.slice(0, 30)}.` })) } };
      if (user.availableLevers) return { output: callContext.agentId === residents[3].id
        ? { propose: true, lever: 'good.tuition', target: 1.5, reason: 'Tuition gives SYNC a use and funds a school.' }
        : { propose: false, reason: 'Nothing needs to change today.' } };
      if (user.projects) return { output: { commission: false, reason: 'Wait.' } };
      if (user.tender) return { output: { bid: false, reason: 'Busy.' } };
      return { output: {} };
    };
    const pool = poolOver(client);
    const d4 = (day + 3) * 1440;
    const steps = [];
    await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, d4 + 9 * 60 + 5]);
    const snapshotCache = { value: null };
    const snapshot = async (db, args) => { if (!snapshotCache.value) {
      const { readEconomyStats } = await import('../src/council.js');
      const { readCouncilPolicies } = await import('../src/treasury.js');
      snapshotCache.value = { stats: await readEconomyStats(db, args), policies: await readCouncilPolicies(db, { worldId, worldDay: day + 3 }) };
    } return snapshotCache.value; };
    for (let i = 0; i < members + 2; i += 1) {
      const result = await councilDeliberationStep(pool, { worldId, requestModel, env: ENV, snapshot });
      if (!result) break;
      steps.push(result);
    }
    const proposeSteps = steps.filter((step) => step.phase === 'propose');
    assert.equal(proposeSteps.length, members, 'every resident made one proposal decision');
    assert.equal(proposeSteps.filter((step) => step.source === 'fallback').length, 1);
    assert.ok(proposeSteps.some((step) => step.source === 'llm' && step.propose && step.title), 'a Luna proposal was created');
    await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, d4 + 11 * 60 + 5]);
    for (let i = 0; i < members + 2; i += 1) {
      const result = await councilDeliberationStep(pool, { worldId, requestModel, env: ENV, snapshot });
      if (!result || result.phase !== 'vote') break;
      steps.push(result);
    }
    const lunaProposal = (await client.query(`SELECT id,source,
        (SELECT count(*) FILTER (WHERE source='cognition') FROM world_council_votes v WHERE v.proposal_id=p.id)::int AS llm,
        (SELECT count(*) FILTER (WHERE source='session_fallback') FROM world_council_votes v WHERE v.proposal_id=p.id)::int AS fallback
      FROM world_council_proposals p WHERE world_id=$1 AND opened_world_day=$2 AND lever_key='good.tuition'`, [worldId, day + 3])).rows[0];
    assert.equal(lunaProposal.source, 'cognition');
    assert.equal(lunaProposal.llm, members - 1, 'Luna votes');
    assert.equal(lunaProposal.fallback, 1, 'the failed resident got the deterministic vote');
    const sources = await client.query(`SELECT phase,source,count(*)::int AS n FROM world_council_deliberations
      WHERE world_id=$1 AND world_day=$2 GROUP BY 1,2 ORDER BY 1,2`, [worldId, day + 3]);
    log.push({ luna: { calls: lunaCalls.length, sources: sources.rows } });

    // DB guards.
    await client.query('SAVEPOINT guard');
    await assert.rejects(client.query('DELETE FROM world_public_works WHERE id=$1', [workId]), /never deleted|permission denied/);
    await client.query('ROLLBACK TO SAVEPOINT guard');
    await assert.rejects(client.query('UPDATE world_public_works SET progress=10 WHERE id=$1', [workId]), /final|only grow/);
    await client.query('ROLLBACK TO SAVEPOINT guard');
    await assert.rejects(client.query('UPDATE world_public_works SET price_raw=price_raw+1 WHERE id=$1', [workId]), /immutable|final|permission denied/);
    await client.query('ROLLBACK TO SAVEPOINT guard');
    await assert.rejects(client.query(`INSERT INTO world_sync_treasury_entries(world_id,entry_key,kind,to_agent_id,amount_raw,reason,actor,world_day,world_minute)
      VALUES($1,'guard:overdraft:test','public_works',$2,999999999999999,'overdraft test','council',$3,$4)`,
    [worldId, rich, day + 3, d4]), /treasury balance/);
    await client.query('ROLLBACK TO SAVEPOINT guard');

    // A reward goes down the pool path (its own source-event trigger refuses this synthetic event); never the treasury.
    const entriesBefore = (await client.query('SELECT count(*)::int AS n FROM world_sync_treasury_entries WHERE world_id=$1', [worldId])).rows[0].n;
    await client.query('SAVEPOINT reward');
    await assert.rejects(issueResidentReward(client, { worldId, agentId: rich, sourceType: 'skill_output',
      sourceEventId: '1', sourceEntityId: 'council3-integration-test', rewardWeight: '1' }, { env: ENV }), /SYNC reward source/);
    await client.query('ROLLBACK TO SAVEPOINT reward');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM world_sync_treasury_entries WHERE world_id=$1', [worldId])).rows[0].n,
      entriesBefore, 'the treasury paid no reward');
    const after = await conservation(client, worldId);
    assert.equal(after.negative, 0);
    console.log(JSON.stringify(log, (key, value) => (typeof value === 'bigint' ? value.toString() : value)));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
