// gambit1 integration: the gambit engine on a real database migrated through 0034, inside one transaction
// that is always rolled back. Set GAMBIT1_TEST_DATABASE_URL to a scratch database (superuser: the fixture
// rows are seeded with session_replication_role=replica; every gambit write then runs with all triggers on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { activeBan, applyResponse, lapseStaleGambits, loadGambit, openGambit, parseGambitOpen, parseGambitResponse,
  readGambitWorld, readPublicGambits, settleDueCommitments, transferInternal } from '../src/world-gambits.js';
import { payCapabilityRoyalties } from '../src/gambit-deliberation.js';

const url = process.env.GAMBIT1_TEST_DATABASE_URL;
const POLICY_HASH = '5c3a9aac4183c9c52b2d8c56ad7d146b6af763d89c5e27c97bc8b3090311fea6';
const hex = (n) => `0x${randomBytes(n).toString('hex')}`;

async function expectDbError(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  let failed = false;
  try { await fn(); } catch { failed = true; }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  assert.equal(failed, true, `${name}: expected a database refusal`);
}

async function ledger(client, worldId) {
  const row = (await client.query(`SELECT
      (SELECT COALESCE(sum(spendable_raw),0) FROM arc_sync_internal_balances WHERE world_id=$1)
      + (SELECT COALESCE(sum(balance_raw),0) FROM world_sync_treasury_balances WHERE world_id=$1)
      = (SELECT COALESCE(sum(sync_amount_raw),0) FROM arc_sync_resident_reward_entitlements WHERE world_id=$1 AND status='pending')
      + (SELECT COALESCE(sum(sync_amount_raw),0) FROM world_sync_purchases WHERE world_id=$1) AS conserved,
      (SELECT count(*)::int FROM arc_sync_internal_balances WHERE world_id=$1 AND spendable_raw<0) AS negative,
      (SELECT COALESCE(sum(spendable_raw),0)::text FROM arc_sync_internal_balances b WHERE world_id=$1
        AND EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=b.world_id AND e.agent_id=b.agent_id)) AS external`, [worldId])).rows[0];
  return { conserved: row.conserved, negative: row.negative, external: row.external };
}
async function balance(client, worldId, agentId) {
  return (await client.query('SELECT spendable_raw::text AS v FROM arc_sync_internal_balances WHERE world_id=$1 AND agent_id=$2', [worldId, agentId])).rows[0].v;
}
async function setMinute(client, worldId, minute) { await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, minute]); }

async function seed(client) {
  await client.query("SET LOCAL session_replication_role = replica");
  const agent = async (name) => (await client.query('INSERT INTO agents(name,public_key) VALUES($1,$2) RETURNING id::text AS id',
    [name, randomBytes(30).toString('base64url')])).rows[0].id;
  const A = await agent('Gambit-A'), B = await agent('Gambit-B'), C = await agent('Gambit-C'), X = await agent('Visitor-X');
  const worldId = (await client.query(`INSERT INTO worlds(name,owner_agent_id,open) VALUES('gambit1-test',$1,false) RETURNING id::text AS id`, [A])).rows[0].id;
  for (const id of [A, B, C, X]) await client.query(`INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'resident')`, [worldId, id]);
  await client.query('INSERT INTO world_runtime_state(world_id,world_minutes) VALUES($1,10000)', [worldId]);
  await client.query(`INSERT INTO arc_sync_tokenomics_deployments(world_id,chain_id,manifest_hash,issuer_agent_id,issuer_wallet,token_address,reserve_address,
      operating_pool_address,auction_address,market_pool_address,genesis_policy_address,settlement_worker_address,deployment_transaction_hash,deployment_block)
    VALUES($1,5042,'0x01f5b27328f71c465660cc59394d72d19c473b3d3b85c4ef60bbed7d23cc7596',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
  [worldId, A, hex(20), hex(20), hex(20), hex(20), hex(20), hex(20), hex(20), hex(20), hex(32)]);
  for (const id of [A, B, C]) {
    const event = (await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'test.seed','{}',$3) RETURNING id`,
      [worldId, id, `seed:${id}`])).rows[0].id;
    const contribution = (await client.query(`INSERT INTO arc_sync_resident_reward_contributions(world_id,agent_id,source_type,source_event_id,source_entity_id,
        reward_weight,epoch_index,policy_version,policy_hash,status) VALUES($1,$2,'research_project',$3,$5,1,0,1,$4,'accrued') RETURNING id`,
    [worldId, id, event, POLICY_HASH, `seed:${id}`])).rows[0].id;
    await client.query(`INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id,contribution_id,epoch_index,policy_version,policy_hash,sync_amount_raw)
      VALUES($1,$2,$3,0,1,$4,1000000)`, [worldId, id, contribution, POLICY_HASH]);
  }
  await client.query(`INSERT INTO world_external_residents(world_id,agent_id,joined_world_minute,source) VALUES($1,$2,0,'backfill')`, [worldId, X]);
  await client.query(`INSERT INTO world_skill_library(skill_id,source_element,tier,name,actions) VALUES('onet:test:gambit1','x',1,'Carpentry','{work}')
    ON CONFLICT DO NOTHING`);
  const output = (await client.query(`INSERT INTO world_skill_outputs(world_id,producer_id,skill_id,drive,quality) VALUES($1,$2,'onet:test:gambit1','creation',7)
    RETURNING output_id::text AS id`, [worldId, B])).rows[0].id;
  const work = (await client.query(`INSERT INTO world_public_works(world_id,project_key,kind,name,reason,price_raw,required_skill,commissioned_by,
      commissioned_world_minute,bidding_closes_world_minute) VALUES($1,'gambit-test-hall','market_hall','Test Hall','test',5000000,'engineering',
      'governor_llm',9990,10100) RETURNING id::text AS id`, [worldId])).rows[0].id;
  // A capability proposed through the P3 council (royalty terms), adopted, used twice by B and once by A.
  const gap = (await client.query(`INSERT INTO world_capability_gaps(world_id,gap_key,category,problem_statement,first_observed_world_minute,last_observed_world_minute)
    VALUES($1,'gambit-gap','economy.learning','test gap for gambit',1,1) RETURNING id`, [worldId])).rows[0].id;
  const capability = (await client.query(`INSERT INTO world_capabilities(world_id,capability_key,category,name,description,specification,created_world_minute)
    VALUES($1,'gambit-cap','economy.learning.capability','Study circle','a test capability','{}'::jsonb,1) RETURNING id`, [worldId])).rows[0].id;
  const proposal = (await client.query(`INSERT INTO world_capability_proposals(world_id,gap_id,creator_type,creator_agent_id,action_id,category,name,problem_statement,
      expected_benefit,proposed_capability,created_world_minute,updated_world_minute,capability_id,status)
    VALUES($1,$2,'resident',$3,'gambit-test-proposal','economy.learning.capability','Study circle','test gap for gambit','learn','{}'::jsonb,1,1,$4,'adopted') RETURNING id::text AS id`,
  [worldId, gap, A, capability])).rows[0].id;
  for (const [actor, i] of [[B, 1], [B, 2], [A, 3]]) {
    await client.query(`INSERT INTO world_capability_uses(world_id,capability_id,actor_agent_id,action_id,world_minute,status,success)
      VALUES($1,$2,$3,$4,10000,'completed',true)`, [worldId, capability, actor, `gambit-use-${i}-${randomBytes(4).toString('hex')}`]);
  }
  await client.query("SET LOCAL session_replication_role = origin");
  await client.query(`INSERT INTO world_capability_royalties(world_id,proposal_id,proposer_agent_id,royalty_raw,created_world_minute)
    VALUES($1,$2,$3,2000,1)`, [worldId, proposal, A]);
  return { worldId, A, B, C, X, output, work };
}

test('gambit1: trades, verification, exposure, promises, bans and royalties move only resident SYNC and conserve it', { skip: !url }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { worldId, A, B, C, X, output, work } = await seed(client);
    // Everything below runs with the runtime role's privileges (as production does).
    if (process.env.GAMBIT1_TEST_AS_APP !== 'off') await client.query('SET LOCAL ROLE synterra_app');
    assert.deepEqual(await ledger(client, worldId), { conserved: true, negative: 0, external: '0' });
    const view = async (agentId) => readGambitWorld(client, { worldId, agentId, worldMinutes: (await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0].world_minutes * 1 });

    // 1. Material sale: B offers its output to A for 0.3 SYNC; A accepts -> material_sale transfer + reservation.
    let w = await view(B);
    assert.equal(w.view.yourSellableOutputs.length, 1);
    const sale = parseGambitOpen({ start: true, scene: 'material_trade', move: 'offer', counterparts: ['Gambit-A'], patternIds: ['QM026'],
      publicLine: 'Good timber, 0.3.', commitments: [{ kind: 'deliver_output', target: 'O1' }], ask: [{ kind: 'pay', amountSync: 0.3 }],
      claims: [{ fact: 'output_quality', subject: 'O1', value: 9 }] }, { refs: w.refs, me: B, now: 10000 });
    const opened = await openGambit(client, { worldId, me: B, parsed: sale, refs: w.refs, worldMinutes: 10000 });
    let g = await loadGambit(client, { worldId, gambitId: opened.gambitId });
    assert.equal(g.status, 'awaiting'); assert.equal(g.turnAgentId, A);
    w = await view(A);
    let reply = parseGambitResponse({ move: 'accept', publicLine: 'Deal.' }, { gambit: g, refs: w.refs, me: A, now: 10000, claims: g.claims });
    const accepted = await applyResponse(client, { worldId, gambitId: g.id, me: A, response: reply, refs: w.refs, worldMinutes: 10001 });
    assert.equal(accepted.move, 'accept');
    g = await loadGambit(client, { worldId, gambitId: g.id });
    assert.equal(g.status, 'settled');
    assert.equal(await balance(client, worldId, A), '700000');
    assert.equal(await balance(client, worldId, B), '1300000');
    const reservation = (await client.query('SELECT buyer_id::text AS buyer,price_raw::text AS price FROM world_material_reservations WHERE world_id=$1 AND output_id=$2',
      [worldId, output])).rows[0];
    assert.deepEqual(reservation, { buyer: A, price: '300000' });
    assert.equal((await client.query(`SELECT kind FROM arc_sync_internal_transfers WHERE world_id=$1`, [worldId])).rows[0].kind, 'material_sale');
    assert.deepEqual(await ledger(client, worldId), { conserved: true, negative: 0, external: '0' });

    // 2. Claims: A tells C a false skill and a true balance; C checks both (fee only for the true claim), then exposes the lie.
    w = await view(A);
    const pitch = parseGambitOpen({ start: true, scene: 'tender_bid', move: 'pact_offer', counterparts: ['Gambit-C'], target: 'T1',
      claims: [{ fact: 'build_skill', value: 90 }, { fact: 'balance', value: 0.7 }], commitments: [{ kind: 'abstain_bid', target: 'T1' }] },
    { refs: w.refs, me: A, now: 10002 });
    const pact = await openGambit(client, { worldId, me: A, parsed: pitch, refs: w.refs, worldMinutes: 10002 });
    g = await loadGambit(client, { worldId, gambitId: pact.gambitId });
    w = await view(C);
    reply = parseGambitResponse({ move: 'verify', claims: ['K1', 'K2'] }, { gambit: g, refs: w.refs, me: C, now: 10003, claims: g.claims });
    const checked = await applyResponse(client, { worldId, gambitId: g.id, me: C, response: reply, refs: w.refs, worldMinutes: 10003, verifyDelay: 30, feeRaw: 10_000n });
    assert.deepEqual(checked.verification.map((item) => [item.fact, item.verification, item.feePaid]), [['build_skill', 'false', false], ['balance', 'true', true]]);
    g = await loadGambit(client, { worldId, gambitId: g.id });
    assert.equal(g.status, 'verifying'); assert.equal(g.turnAgentId, C); assert.equal(g.turnAfter, 10033);
    assert.equal(await balance(client, worldId, A), '710000');
    assert.equal(await balance(client, worldId, C), '990000');
    reply = parseGambitResponse({ move: 'expose', claims: ['K1'], publicLine: 'Your skill is 0, not 90.' }, { gambit: g, refs: w.refs, me: C, now: 10033, claims: g.claims });
    await applyResponse(client, { worldId, gambitId: g.id, me: C, response: reply, refs: w.refs, worldMinutes: 10033 });
    g = await loadGambit(client, { worldId, gambitId: g.id });
    assert.equal(g.status, 'exposed');
    const events = (await client.query(`SELECT kind,agent_id::text AS agent,observer_agent_id::text AS observer,delta_trust::float8 AS d FROM world_reputation_events
      WHERE world_id=$1 AND gambit_id=$2 ORDER BY id`, [worldId, g.id])).rows;
    assert.deepEqual(events.map((e) => [e.kind, e.agent === A ? 'A' : 'C', e.d]), [['claim_false', 'A', -6], ['claim_true', 'A', 2], ['exposed', 'A', -25], ['exposer', 'C', 0]]);
    await expectDbError(client, 'reverify', () => client.query(`UPDATE world_gambit_claims SET verification='true' WHERE world_id=$1 AND gambit_id=$2`, [worldId, g.id]));
    await expectDbError(client, 'reopen', () => client.query(`UPDATE world_gambits SET status='awaiting' WHERE id=$1`, [g.id]));
    await expectDbError(client, 'rewrite_move', () => client.query(`DELETE FROM world_gambit_moves WHERE gambit_id=$1`, [g.id]));
    assert.deepEqual(await ledger(client, worldId), { conserved: true, negative: 0, external: '0' });

    // 3. A paid promise that is betrayed: B pays C 0.1 for staying out of the tender; C bids anyway -> broken, B's own reaction.
    w = await view(B);
    const stayOut = parseGambitOpen({ start: true, scene: 'tender_bid', move: 'rotation_pact', counterparts: ['Gambit-C'], target: 'T1',
      commitments: [{ kind: 'pay', amountSync: 0.1 }], ask: [{ kind: 'abstain_bid', target: 'T1' }] }, { refs: w.refs, me: B, now: 10040 });
    const rotation = await openGambit(client, { worldId, me: B, parsed: stayOut, refs: w.refs, worldMinutes: 10040 });
    g = await loadGambit(client, { worldId, gambitId: rotation.gambitId });
    w = await view(C);
    reply = parseGambitResponse({ move: 'accept' }, { gambit: g, refs: w.refs, me: C, now: 10041, claims: g.claims });
    await applyResponse(client, { worldId, gambitId: g.id, me: C, response: reply, refs: w.refs, worldMinutes: 10041 });
    assert.equal((await loadGambit(client, { worldId, gambitId: g.id })).status, 'accepted');
    assert.equal(await balance(client, worldId, C), '1090000');
    await client.query(`INSERT INTO world_public_work_bids(world_id,work_id,agent_id,bid_raw,skill_value,credible,source,reason,world_minute)
      VALUES($1,$2,$3,4000000,10,true,'llm','betrayal',10050)`, [worldId, work, C]);
    await setMinute(client, worldId, 10100);
    assert.equal(await settleDueCommitments(client, { worldId, worldMinutes: 10100 }), 1);
    const broken = (await client.query(`SELECT c.status,e.kind,e.observer_agent_id::text AS observer,e.delta_trust::float8 AS d FROM world_gambit_commitments c
      JOIN world_reputation_events e ON e.world_id=c.world_id AND e.gambit_id=c.gambit_id AND e.kind='broken' WHERE c.world_id=$1 AND c.gambit_id=$2 AND c.kind='abstain_bid'`,
    [worldId, g.id])).rows[0];
    assert.deepEqual(broken, { status: 'broken', kind: 'broken', observer: B, d: -10 });
    assert.equal((await loadGambit(client, { worldId, gambitId: g.id })).status, 'settled');

    // 4. A promise beyond one's balance: the payment is refused by the ledger, nothing moves, the promise is broken.
    w = await view(A);
    const tooMuch = parseGambitOpen({ start: true, scene: 'council_vote', move: 'vote_buy', counterparts: ['Gambit-B'], commitments: [{ kind: 'pay', amountSync: 5 }] },
      { refs: w.refs, me: A, now: 10100 });
    const buy = await openGambit(client, { worldId, me: A, parsed: tooMuch, refs: w.refs, worldMinutes: 10100 });
    g = await loadGambit(client, { worldId, gambitId: buy.gambitId });
    w = await view(B);
    const before = await balance(client, worldId, A);
    const result = await applyResponse(client, { worldId, gambitId: g.id, me: B, refs: w.refs, worldMinutes: 10101,
      response: parseGambitResponse({ move: 'accept' }, { gambit: g, refs: w.refs, me: B, now: 10101, claims: [] }) });
    assert.equal(result.commitments.failed.length, 1);
    assert.equal(await balance(client, worldId, A), before);
    assert.equal(await transferInternal(client, { worldId, fromAgentId: A, toAgentId: X, amountRaw: 1000n, kind: 'gambit_settlement',
      actionId: 'gambit-test-to-external', worldMinutes: 10101 }), null, 'internal SYNC never reaches an external resident');
    assert.deepEqual(await ledger(client, worldId), { conserved: true, negative: 0, external: '0' });

    // 5. A tender ban voted by the residents (poll) becomes a recorded fact.
    w = await view(A);
    const banCall = parseGambitOpen({ start: true, scene: 'council_vote', move: 'ban_call', counterparts: ['Gambit-B'], banTarget: 'Gambit-C', banWorldDays: 2,
      publicLine: 'C broke a paid promise.' }, { refs: w.refs, me: A, now: 10102 });
    const ban = await openGambit(client, { worldId, me: A, parsed: banCall, refs: w.refs, worldMinutes: 10102 });
    g = await loadGambit(client, { worldId, gambitId: ban.gambitId });
    w = await view(B);
    const closed = await applyResponse(client, { worldId, gambitId: g.id, me: B, refs: w.refs, worldMinutes: 10103, internalCount: 3,
      response: parseGambitResponse({ move: 'vote_yes' }, { gambit: g, refs: w.refs, me: B, now: 10103, claims: [] }) });
    assert.equal(closed.closed.passed, true);
    assert.ok(await activeBan(client, { worldId, agentId: C, worldMinutes: 10200 }));
    assert.equal(await activeBan(client, { worldId, agentId: C, worldMinutes: 10103 + 2 * 1440 }), null);

    // 6. Royalties: each successful use by another resident pays the proposer 0.002 SYNC; self-use pays nothing.
    const royalties = await payCapabilityRoyalties(client, { worldId, worldMinutes: 10104 });
    assert.deepEqual(royalties, { checked: 3, paid: 2 });
    const statuses = (await client.query(`SELECT status,count(*)::int AS n FROM world_capability_royalty_payments WHERE world_id=$1 GROUP BY 1 ORDER BY 1`, [worldId])).rows;
    assert.deepEqual(statuses, [{ status: 'paid', n: 2 }, { status: 'self_use', n: 1 }]);
    assert.deepEqual(await payCapabilityRoyalties(client, { worldId, worldMinutes: 10105 }), { checked: 0, paid: 0 }, 'idempotent');
    assert.deepEqual(await ledger(client, worldId), { conserved: true, negative: 0, external: '0' });
    const kinds = (await client.query(`SELECT kind,count(*)::int AS n,sum(amount_raw)::text AS raw FROM arc_sync_internal_transfers WHERE world_id=$1 GROUP BY 1 ORDER BY 1`, [worldId])).rows;
    assert.deepEqual(kinds, [{ kind: 'capability_royalty', n: 2, raw: '4000' }, { kind: 'material_sale', n: 1, raw: '300000' },
      { kind: 'subcontract', n: 1, raw: '100000' }, { kind: 'verification_fee', n: 1, raw: '10000' }]);

    // 7. An unanswered gambit lapses (void); the public view shows timeline, exposure and honesty.
    w = await view(B);
    const idle = await openGambit(client, { worldId, me: B, refs: w.refs, worldMinutes: 10105,
      parsed: parseGambitOpen({ start: true, scene: 'reputation', move: 'promise', counterparts: ['Gambit-A'], publicLine: 'Trust me.' }, { refs: w.refs, me: B, now: 10105 }) });
    assert.equal(await lapseStaleGambits(client, { worldId, worldMinutes: 10105 + 400, ttl: 360, internalCount: 3 }), 1);
    assert.equal((await loadGambit(client, { worldId, gambitId: idle.gambitId })).status, 'void');
    // 8. Counter-offer state machine: A offers 0.05, B counters asking 0.08, A accepts B's terms -> A pays 0.08.
    w = await view(A);
    const haggle = await openGambit(client, { worldId, me: A, refs: w.refs, worldMinutes: 10510,
      parsed: parseGambitOpen({ start: true, scene: 'reputation', move: 'promise', counterparts: ['Gambit-B'], commitments: [{ kind: 'pay', amountSync: 0.05 }] },
        { refs: w.refs, me: A, now: 10510 }) });
    g = await loadGambit(client, { worldId, gambitId: haggle.gambitId });
    w = await view(B);
    await applyResponse(client, { worldId, gambitId: g.id, me: B, refs: w.refs, worldMinutes: 10511,
      response: parseGambitResponse({ move: 'counter', ask: [{ kind: 'pay', amountSync: 0.08 }], publicLine: 'Make it 0.08.' }, { gambit: g, refs: w.refs, me: B, now: 10511, claims: [] }) });
    g = await loadGambit(client, { worldId, gambitId: g.id });
    assert.equal(g.status, 'awaiting'); assert.equal(g.turnAgentId, A); assert.equal(g.terms.proposerAgentId, B);
    const aBefore = BigInt(await balance(client, worldId, A));
    w = await view(A);
    await applyResponse(client, { worldId, gambitId: g.id, me: A, refs: w.refs, worldMinutes: 10512,
      response: parseGambitResponse({ move: 'accept' }, { gambit: g, refs: w.refs, me: A, now: 10512, claims: [] }) });
    assert.equal((await loadGambit(client, { worldId, gambitId: g.id })).status, 'settled');
    assert.equal(aBefore - BigInt(await balance(client, worldId, A)), 80000n);
    assert.deepEqual(await ledger(client, worldId), { conserved: true, negative: 0, external: '0' });

    const pub = await readPublicGambits(client, { worldId, limit: 50 });
    assert.equal(pub.gambits.length, 7);
    assert.equal(pub.exposed[0].subject, 'Gambit-A');
    assert.equal(pub.exposed[0].exposer, 'Gambit-C');
    assert.ok(pub.honesty.find((row) => row.name === 'Gambit-C').broken >= 1);
    assert.ok(pub.patternUsage.some((row) => row.id === 'QM026'));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
