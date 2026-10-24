// external1 integration: external residents on a real migrated database (0031), inside one transaction that is
// always rolled back. Set EXTERNAL1_TEST_DATABASE_URL (a scratch DB restored from a production dump); skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Wallet, AbiCoder, zeroPadValue, id as keccakId } from 'ethers';
import { initializeResidentRows } from '../src/world-engine.js';
import { ensureExternalResident, enforceRateLimit, externalConfig, readExternalResidents, recordRegistration,
  resetExternalTablesCache } from '../src/external-residents.js';
import { createCouncilProposal, readCouncilMembership, readEconomyStats, runCouncilHour, EXTERNAL_SILENT_ABSTAIN } from '../src/council.js';
import { externalPublicWorkBid, externalPropose, externalVote, readExternalSelf } from '../src/external-api.js';
import { awardPublicWork, placePublicWorkBid, readPublicWorks } from '../src/public-works.js';
import { postTreasuryEntry } from '../src/treasury.js';
import { AUCTION_INTERFACE, TOKEN_INTERFACE, bindExternalWallet, claimExternalPurchase, walletClaimMessage,
  readExternalPurchaseStatus } from '../src/external-purchase.js';

const url = process.env.EXTERNAL1_TEST_DATABASE_URL;
const ENV = { MIRRORTERRA_COUNCIL: 'on', MIRRORTERRA_SYNC_ECONOMY: 'on', MIRRORTERRA_COUNCIL_LUNA: 'off' };

async function expectDbError(client, name, fn, pattern) {
  await client.query(`SAVEPOINT ${name}`);
  try { await fn(); assert.fail(`${name}: expected a database refusal`); }
  catch (error) { assert.match(String(error.message), pattern, name); }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); }
}

test('external1: join -> engine rows, no internal money, Sybil eligibility, external API vote/bid with fallback, purchase gate', { skip: !url }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  resetExternalTablesCache();
  try {
    await client.query('BEGIN');
    const world = (await client.query(`SELECT d.world_id::text AS world_id,r.world_minutes::bigint AS minutes,lower(d.token_address) AS token,
        lower(d.operating_pool_address) AS pool,lower(d.auction_address) AS auction
      FROM arc_sync_tokenomics_deployments d JOIN world_runtime_state r ON r.world_id=d.world_id LIMIT 1`)).rows[0];
    assert.ok(world, 'a SYNC world is required');
    const worldId = world.world_id;
    const internal = (await client.query(`SELECT agent_id::text AS id FROM world_agent_states WHERE world_id=$1
      AND NOT EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=$1 AND e.agent_id=world_agent_states.agent_id)
      ORDER BY agent_id`, [worldId])).rows.map((row) => row.id);
    assert.ok(internal.length >= 10, 'the original residents are internal');
    // Put the clock at 10:00 of the current world day (rolled back).
    const day = Math.floor(Number(world.minutes) / 1440);
    const ten = day * 1440 + 600;
    await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, ten]);
    const existingEligibleExternals = (await readExternalResidents(client,
      { worldId, worldMinutes: ten, config: externalConfig({}) })).filter((row) => row.eligible).length;

    // 1. Three external agents join: flag + engine rows; a fourth joiner beyond a cap of 3 new is refused.
    const existingExternals = Number((await client.query('SELECT count(*)::int AS n FROM world_external_residents WHERE world_id=$1', [worldId])).rows[0].n);
    const config = externalConfig({ MIRRORTERRA_EXTERNAL_POPULATION_CAP: String(existingExternals + 3) });
    const externals = [];
    for (let i = 0; i < 4; i += 1) {
      const agent = (await client.query(`INSERT INTO agents(name,public_key) VALUES($1,$2) RETURNING id::text AS id`,
        [`Visitor-Test-${i}`, randomBytes(40).toString('base64url')])).rows[0].id;
      const join = () => client.query(`INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'resident')`, [worldId, agent]);
      if (i < 3) await join();
      if (i < 3) {
        const joined = await ensureExternalResident(client, { worldId, agentId: agent, source: 'api_join', worldMinutes: ten, config,
          initialize: initializeResidentRows });
        assert.equal(joined.external, true);
        externals.push(agent);
      } else {
        // the route's transaction rolls back the membership row too
        await expectDbError(client, 'cap', async () => { await join();
          await ensureExternalResident(client, { worldId, agentId: agent, config, initialize: initializeResidentRows }); },
          /EXTERNAL_POPULATION_CAP_REACHED/);
      }
    }
    const rows = await client.query(`SELECT e.agent_id::text AS id,s.agent_id IS NOT NULL AS state,p.agent_id IS NOT NULL AS profile,
        (SELECT count(*) FROM world_agent_skills k WHERE k.world_id=e.world_id AND k.agent_id=e.agent_id)::int AS skills,
        (SELECT count(*) FROM world_agent_goals g WHERE g.world_id=e.world_id AND g.agent_id=e.agent_id)::int AS goals,
        b.spendable_raw::text AS spendable
      FROM world_external_residents e LEFT JOIN world_agent_states s ON s.world_id=e.world_id AND s.agent_id=e.agent_id
      LEFT JOIN world_social_profiles p ON p.world_id=e.world_id AND p.agent_id=e.agent_id
      LEFT JOIN arc_sync_internal_balances b ON b.world_id=e.world_id AND b.agent_id=e.agent_id
      WHERE e.world_id=$1 AND e.agent_id=ANY($2::uuid[])`, [worldId, externals]);
    for (const row of rows.rows) {
      assert.ok(row.state && row.profile && row.skills >= 4 && row.goals >= 1, `engine rows for ${row.id}`);
      assert.equal(row.spendable, '0', 'no starting balance');
    }
    await expectDbError(client, 'immutable', () => client.query(`UPDATE world_external_residents SET joined_world_minute=0
      WHERE world_id=$1 AND agent_id=$2`, [worldId, externals[0]]), /immutable|permission denied/);

    // 2. No internal money: treasury, internal->external transfer, pool entitlement all refused by the database.
    const posted = await postTreasuryEntry(client, { worldId, entryKey: `test:${randomUUID()}`, kind: 'public_works', toAgentId: externals[0],
      amountRaw: 1n, reason: 'test milestone', actor: 'council', worldMinute: ten });
    assert.equal(posted.created, false);
    await expectDbError(client, 'treasury', () => client.query(`INSERT INTO world_sync_treasury_entries(world_id,entry_key,kind,to_agent_id,amount_raw,
        reason,actor,world_day,world_minute) VALUES($1,$2,'public_works',$3,1,'direct test','council',$4,$5)`,
    [worldId, `test:${randomUUID()}`, externals[0], day, ten]), /no treasury SYNC/);
    await expectDbError(client, 'transfer', () => client.query(`INSERT INTO arc_sync_internal_transfers(world_id,action_id,from_agent_id,to_agent_id,
        amount_raw,kind,world_minute) VALUES($1,$2,$3,$4,1,'business_service_payment',$5)`,
    [worldId, `test-transfer:${randomUUID()}`, internal[1], externals[0], ten]), /only receive purchased SYNC/);
    await expectDbError(client, 'entitlement', () => client.query(`INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id,contribution_id,
        epoch_index,policy_version,policy_hash,sync_amount_raw,status) VALUES($1,$2,gen_random_uuid(),0,2,'x',1,'pending')`,
    [worldId, externals[0]]), /no pool rewards/);

    // 3. Sybil eligibility: a resident with 3 world days and one volunteer session is eligible; fresh joiners are not.
    const veteran = (await client.query(`INSERT INTO agents(name,public_key) VALUES('Visitor-Veteran',$1) RETURNING id::text AS id`,
      [randomBytes(40).toString('base64url')])).rows[0].id;
    await client.query(`INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'resident')`, [worldId, veteran]);
    await client.query(`INSERT INTO world_external_residents(world_id,agent_id,joined_world_minute,source) VALUES($1,$2,$3,'backfill')`,
      [worldId, veteran, ten - 3 * 1440]);
    await initializeResidentRows(client, { worldId, agentId: veteran, index: 13, worldMinutes: ten });
    let list = await readExternalResidents(client, { worldId, worldMinutes: ten, config });
    assert.equal(list.find((row) => row.agentId === veteran).eligible, false, 'residence alone is not enough');
    const anyWork = (await client.query(`SELECT id FROM world_public_works WHERE world_id=$1 ORDER BY commissioned_world_minute LIMIT 1`, [worldId])).rows[0];
    assert.ok(anyWork, 'a public work exists in the snapshot');
    await client.query(`INSERT INTO world_public_work_volunteers(world_id,work_id,agent_id,source,reason,pledged_world_minute,sessions,progress_added)
      VALUES($1,$2,$3,'external_api','helped',$4,1,5)`, [worldId, anyWork.id, veteran, ten - 100]);
    list = await readExternalResidents(client, { worldId, worldMinutes: ten, config });
    assert.equal(list.find((row) => row.agentId === veteran).eligible, true);
    assert.ok(externals.every((id) => list.find((row) => row.agentId === id).eligible === false));
    const membership = await readCouncilMembership(client, { worldId, worldMinutes: ten, env: {} });
    const expectedMembers = internal.length + existingEligibleExternals + 1;
    assert.equal(membership.members, expectedMembers);
    assert.equal(membership.quorum, Math.ceil(expectedMembers * 0.6));

    // 4. External API: propose (eligible only, 09-13), vote, volunteer; fallback abstains for the silent one.
    await client.query(`UPDATE world_council_proposals SET status='rejected',decided_world_minute=$2,decision_reason='test reset'
      WHERE world_id=$1 AND status='open'`, [worldId, ten]).catch(() => null);
    await expectDbError(client, 'ineligible_vote', () => externalPropose(client, { worldId, agentId: externals[0], actionId: 'act-propose-0',
      lever: 'good.tools', target: 3.3, reason: 'cheaper tools', env: {} }), /EXTERNAL_COUNCIL_NOT_ELIGIBLE/);
    const proposal = await externalPropose(client, { worldId, agentId: veteran, actionId: 'act-propose-1', lever: 'price.food_service',
      target: 0.9, reason: 'food is too expensive for newcomers', env: {} });
    assert.equal(proposal.status, 'open');
    const replay = await externalPropose(client, { worldId, agentId: veteran, actionId: 'act-propose-1', lever: 'price.food_service',
      target: 0.9, reason: 'food is too expensive for newcomers', env: {} });
    assert.equal(replay.idempotent, true);
    const second = await createCouncilProposal(client, { worldId, proposerAgentId: internal[0], lever: 'good.tuition',
      value: { priceRaw: '2000000' }, reason: 'school fees', source: 'session_fallback', worldMinutes: ten });
    const vote = await externalVote(client, { worldId, agentId: veteran, actionId: 'act-vote-1', proposalId: proposal.proposalId,
      stance: 'yes', reason: 'I proposed it', env: {} });
    assert.equal(vote.stance, 'yes');
    await expectDbError(client, 'ineligible_vote2', () => externalVote(client, { worldId, agentId: externals[1], actionId: 'act-vote-2',
      proposalId: proposal.proposalId, stance: 'no', reason: 'no', env: {} }), /EXTERNAL_COUNCIL_NOT_ELIGIBLE/);
    // 14:00 safety net: internal residents get deterministic votes; the silent veteran abstains on the second proposal.
    await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, day * 1440 + 14 * 60]);
    const hour14 = await runCouncilHour(client, { worldId, worldMinutes: day * 1440 + 14 * 60, env: ENV });
    assert.ok(Number(hour14.abstentions) >= 1);
    const abstained = await client.query(`SELECT count(*)::int AS n FROM world_council_deliberations WHERE proposal_id=$1 AND agent_id=$2
      AND failure_code=$3`, [second.proposalId, veteran, EXTERNAL_SILENT_ABSTAIN]);
    assert.equal(abstained.rows[0].n, 1);
    const castByUs = await client.query(`SELECT count(*)::int AS n FROM world_council_votes WHERE agent_id=ANY($1::uuid[])`, [[...externals, veteran]]);
    assert.equal(castByUs.rows[0].n, 1, 'only the vote the external AI cast itself');
    await client.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, day * 1440 + 15 * 60]);
    const hour15 = await runCouncilHour(client, { worldId, worldMinutes: day * 1440 + 15 * 60, env: ENV });
    assert.ok((hour15.decided || []).length >= 2, 'both proposals tallied with the dynamic quorum');

    // Public works: externals cannot bid for pay; they volunteer; silent ones get the deterministic fallback.
    const work = (await client.query(`INSERT INTO world_public_works(world_id,project_key,kind,name,reason,price_raw,required_skill,
        commissioned_by,commissioned_world_minute,bidding_closes_world_minute) VALUES($1,$2,'park','Test Grove','test',5000000,'social',
        'governor_fallback',$3,$4) RETURNING id::text AS id`, [worldId, `test:${randomUUID().slice(0, 8)}`, ten, ten + 120])).rows[0];
    await expectDbError(client, 'paid_bid', () => placePublicWorkBid(client, { worldId, workId: work.id, agentId: externals[0], bidRaw: 2000000n,
      reason: 'cheap', source: 'llm', worldMinutes: ten }), /EXTERNAL_VOLUNTEER_ONLY/);
    const pledge = await externalPublicWorkBid(client, { worldId, agentId: externals[0], actionId: 'act-bid-1', workId: work.id, reason: 'happy to help', env: {} });
    assert.equal(pledge.volunteer, true);
    assert.equal(pledge.paid, false);
    const stats = await readEconomyStats(client, { worldId });
    const [bidding] = (await readPublicWorks(client, { worldId, statuses: ['bidding'] })).filter((row) => String(row.id) === work.id);
    const awarded = await awardPublicWork(client, { worldId, work: bidding, worldMinutes: ten + 121, stats });
    if (awarded.builder) assert.ok(!externals.includes(awarded.builder) && awarded.builder !== veteran, 'an internal builder holds the contract');
    const fallbackRows = await client.query(`SELECT count(*)::int AS n FROM world_council_deliberations WHERE work_id=$1
      AND failure_code='EXTERNAL_SILENT_VOLUNTEER_FALLBACK'`, [work.id]);
    assert.ok(fallbackRows.rows[0].n >= 2, 'silent externals got the deterministic volunteer decision');
    const externalBids = await client.query(`SELECT count(*)::int AS n FROM world_public_work_bids WHERE work_id=$1 AND agent_id=ANY($2::uuid[])`,
      [work.id, [...externals, veteran]]);
    assert.equal(externalBids.rows[0].n, 0, 'no paid bid in an external resident\'s name');

    // 5. Purchase: the DB gate refuses without the GUC; with the gate on, a verified buy + deposit is credited once.
    await expectDbError(client, 'wallet_gate', () => client.query(`INSERT INTO world_external_wallets(world_id,agent_id,chain_id,wallet_address,
        claim_digest,bound_world_minute) VALUES($1,$2,5042,$3,$4,0)`, [worldId, externals[2], '0x' + '1'.repeat(40), 'a'.repeat(64)]),
    /gate is closed/);
    const OPEN = { MIRRORTERRA_EXTERNAL_PURCHASE: 'on', MIRRORTERRA_EXTERNAL_PURCHASE_CONFIRMATIONS: '2' };
    const wallet = Wallet.createRandom();
    await bindExternalWallet(client, { worldId, agentId: externals[2], wallet: wallet.address,
      signature: await wallet.signMessage(walletClaimMessage({ worldId, agentId: externals[2], wallet: wallet.address })), env: OPEN });
    const pad = (address) => zeroPadValue(address, 32);
    const coder = AbiCoder.defaultAbiCoder();
    const tx = '0x' + randomBytes(32).toString('hex');
    const receipt = { status: '0x1', blockNumber: '0x10', logs: [
      { address: world.auction, logIndex: '0x0', topics: [AUCTION_INTERFACE.getEvent('SyncAuctionPurchase').topicHash, pad(wallet.address), keccakId('a')],
        data: coder.encode(['uint256','uint256','uint256'], [3_000_000n, 20_000n, 10n ** 16n]) },
      { address: world.token, logIndex: '0x1', topics: [TOKEN_INTERFACE.getEvent('Transfer').topicHash, pad(wallet.address), pad(world.pool)],
        data: coder.encode(['uint256'], [3_000_000n]) }] };
    const rpc = { getChainId: async () => '0x13b2', getBlockNumber: async () => '0x20', getTransactionReceipt: async (hash) => (hash === tx ? receipt : null) };
    await expectDbError(client, 'claim_closed', () => claimExternalPurchase(client, { worldId, agentId: externals[2], txHash: tx, rpc, env: {} }),
      /EXTERNAL_PURCHASE_CLOSED/);
    const claimed = await claimExternalPurchase(client, { worldId, agentId: externals[2], txHash: tx, rpc, worldMinutes: ten, env: OPEN });
    assert.equal(claimed.creditedRaw, '3000000');
    await expectDbError(client, 'replay', () => claimExternalPurchase(client, { worldId, agentId: externals[2], txHash: tx, rpc, env: OPEN }),
      /PURCHASE_ALREADY_CLAIMED/);
    const status = await readExternalPurchaseStatus(client, { worldId, agentId: externals[2], env: {} });
    assert.equal(status.channel, 'closed');
    assert.equal(status.message, 'purchase channel not open yet');
    assert.equal(status.creditedRaw, '3000000');
    // Purchased SYNC may move to another external resident; the origin view keeps internal_origin_raw at 0.
    await client.query(`INSERT INTO arc_sync_internal_transfers(world_id,action_id,from_agent_id,to_agent_id,amount_raw,kind,world_minute)
      VALUES($1,$2,$3,$4,1000000,'business_service_payment',$5)`, [worldId, `test-transfer:${randomUUID()}`, externals[2], externals[1], ten]);
    const origin = await client.query(`SELECT agent_id::text AS id,spendable_raw::text AS s,internal_origin_raw::text AS i
      FROM world_external_resident_balances WHERE world_id=$1 AND agent_id=ANY($2::uuid[]) ORDER BY agent_id`, [worldId, [externals[1], externals[2]]]);
    for (const row of origin.rows) assert.equal(row.i, '0');
    assert.deepEqual(origin.rows.map((row) => row.s).sort(), ['1000000', '2000000']);
    const self = await readExternalSelf(client, { worldId, agentId: externals[2], env: {} });
    assert.equal(self.economy.purchasedRaw, '3000000');
    assert.equal(self.economy.internalOriginRaw, '0');

    // 6. Rate limit table.
    const hash = 'f'.repeat(32);
    for (let i = 0; i < 3; i += 1) await recordRegistration(client, { kind: 'register', hash });
    await expectDbError(client, 'rate', () => enforceRateLimit(client, { kind: 'register', hash, config: externalConfig({}) }), /REGISTRATION_RATE_LIMITED/);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
