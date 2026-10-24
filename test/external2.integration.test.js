import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { Wallet } from 'ethers';
import { initializeResidentRows, startWorldEngine } from '../src/world-engine.js';
import { bindExternalOperator, bindExternalWithdrawalWallet, externalWithdrawalWalletMessage,
  createExternalWithdrawal, acceptExternalContribution, operatorBindingMessage } from '../src/external2.js';
import { postTreasuryEntry } from '../src/treasury.js';
import { externalPublicWorkBid } from '../src/external-api.js';
import { assertPlatformModelPrincipal } from '../src/agent-runtime/model-principal.js';
import { createBaiBudgetGateway } from '../src/agent-runtime/bai-budget.js';

const url = process.env.EXTERNAL2_TEST_DATABASE_URL;
const attempt = async (db, name, fn, pattern) => {
  await db.query(`SAVEPOINT ${name}`);
  try { await assert.rejects(fn, pattern); }
  finally { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); await db.query(`RELEASE SAVEPOINT ${name}`); }
};

test('0038 on full clone: three signed residents, independent operators, probation and locked fee recipient',
  { skip: !url }, async () => {
    const db = new pg.Client({ connectionString: url });
    const commitSimulation = process.env.EXTERNAL2_SIMULATION_COMMIT === '1';
    let simulation = null;
    await db.connect();
    try {
      await db.query('BEGIN');
      const world = (await db.query(`SELECT world_id::text AS id FROM arc_sync_tokenomics_deployments LIMIT 1`)).rows[0];
      assert.ok(world);
      const worldId = world.id;
      const priorInfrastructure = BigInt((await db.query(`SELECT COALESCE((SELECT balance_raw FROM
        world_external_infrastructure_balances WHERE world_id=$1),0)::text AS raw`, [worldId])).rows[0].raw);
      const snapshotMinute = Number((await db.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0].world_minutes);
      const minute = (Math.floor(snapshotMinute / 1440) + 1) * 1440 + 600;
      await db.query('UPDATE world_runtime_state SET world_minutes=$2 WHERE world_id=$1', [worldId, minute]);
      const operators = Array.from({ length: 2 }, (_, i) => ({ id: randomUUID(), name: `Test operator ${i} ${randomUUID()}`,
        ...generateKeyPairSync('ed25519') }));
      for (const operator of operators) await db.query(`INSERT INTO world_external_operators(id,name,public_key)
        VALUES($1,$2,$3)`, [operator.id, operator.name, operator.publicKey.export({ format: 'pem', type: 'spki' }).toString()]);
      await db.query(`UPDATE world_external2_policy SET byom=true,operator_binding=true,probation=true,
        public_work_rewards=true,withdrawals=true WHERE singleton`);
      const agents = [];
      for (let i = 0; i < 3; i += 1) {
        const agent = (await db.query(`INSERT INTO agents(name,public_key) VALUES($1,$2) RETURNING id::text AS id`,
          [`External2-Test-${i}-${randomUUID().slice(0, 8)}`, randomBytes(40).toString('base64url')])).rows[0].id;
        agents.push(agent);
        await db.query(`INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'resident')`, [worldId, agent]);
        if (i === 1) {
          // A pre-existing, balanced treasury reward must also freeze once its
          // recipient becomes a newly bound external resident.
          const legacy = await postTreasuryEntry(db, { worldId, entryKey: `external2:legacy:${agent}`,
            kind: 'reward', toAgentId: agent, amountRaw: 1_000_000n,
            reason: 'Earlier resident contribution', actor: 'council', worldMinute: minute });
          assert.equal(legacy.created, true);
          await db.query('SET CONSTRAINTS ALL IMMEDIATE');
          await db.query('SET CONSTRAINTS ALL DEFERRED');
        }
        await db.query(`INSERT INTO world_external_residents(world_id,agent_id,joined_world_minute,source,created_at)
          VALUES($1,$2,$3,'api_join',now()-($4::int * interval '1 day'))`, [worldId, agent, minute, i === 2 ? 4 : 0]);
        await initializeResidentRows(db, { worldId, agentId: agent, index: 12 + i, worldMinutes: minute });
      }
      await db.query('SET LOCAL ROLE synterra_app');
      for (let i = 0; i < agents.length; i += 1) {
        const operator = operators[i === 2 ? 1 : 0];
        const expiry = new Date(Date.now() + 60_000).toISOString();
        const nonce = randomBytes(20).toString('base64url');
        const message = operatorBindingMessage({ operatorId: operator.id, worldId, agentId: agents[i], nonce, expiresAt: expiry });
        const signature = sign(null, Buffer.from(message), operator.privateKey).toString('base64url');
        const binding = await bindExternalOperator(db, { worldId, agentId: agents[i], operatorId: operator.id,
          nonce, expiresAt: expiry, signature });
        assert.equal(binding.bound, true);
      }
      const pair = async (a, b) => (await db.query('SELECT mirrorterra_external_independent_pair($1,$2,$3) AS ok',
        [worldId, agents[a], agents[b]])).rows[0].ok;
      assert.equal(await pair(0, 1), false, 'same operator cannot verify each other');
      assert.equal(await pair(0, 2), true, 'different operators are independent');
      const tender = (await db.query(`INSERT INTO world_public_works
        (world_id,project_key,kind,name,reason,price_raw,required_skill,commissioned_by,
          commissioned_world_minute,bidding_closes_world_minute,status)
        VALUES($1,$2,'park','External signed tender','External2 signed bid evidence',1000000,
          'social','governor_fallback',$3,$4,'bidding') RETURNING id::text AS id`,
      [worldId, `external2:bid:${randomUUID()}`, minute, minute + 120])).rows[0];
      const signedBid = await externalPublicWorkBid(db, { worldId, agentId: agents[0],
        actionId: 'external2-signed-paid-bid-01', workId: tender.id, bidRaw: '800000', reason: 'Build the park' });
      assert.equal(signedBid.paid, true);
      assert.equal(signedBid.volunteer, false);
      assert.equal((await db.query(`SELECT source FROM world_public_work_bids WHERE world_id=$1 AND work_id=$2
        AND agent_id=$3`, [worldId, tender.id, agents[0]])).rows[0].source, 'llm');
      const holds = (await db.query(`SELECT agent_id::text AS id,real_days,required_acceptances,
        mirrorterra_external_probation_complete(world_id,agent_id) AS complete
        FROM world_external_reward_holds WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`, [worldId, agents])).rows;
      assert.equal(holds.length, 3);
      for (const row of holds) {
        assert.equal(row.real_days, 3);
        assert.equal(row.required_acceptances, 3);
        assert.equal(row.complete, row.id === agents[2], 'three real days releases earlier than three acceptances');
      }
      assert.equal((await db.query(`SELECT mirrorterra_external_frozen_raw($1,$2)::text AS raw`,
        [worldId, agents[1]])).rows[0].raw, '1000000', 'legacy earned SYNC freezes without a new receipt');
      for (const agentId of agents) await assert.rejects(
        assertPlatformModelPrincipal(db, { worldId, agentId }), { code: 'EXTERNAL_MODEL_CALL_FORBIDDEN' });
      // A completed, paid engine work produces one receipt. Three distinct accepted
      // works from another operator release a fresh resident before the real-day clock.
      const makeCompletedWork = async (agentId, ordinal) => {
        const work = (await db.query(`INSERT INTO world_public_works
          (world_id,project_key,kind,name,reason,price_raw,required_skill,commissioned_by,
            commissioned_world_minute,bidding_closes_world_minute,status,builder_agent_id,
            contract_price_raw,awarded_world_minute)
          VALUES($1,$2,'park',$3,'Engine test evidence',1000000,'social','governor_fallback',
            $4,$5,'building',$6,1000000,$5) RETURNING id::text AS id`,
          [worldId, `external2:test:${randomUUID()}`, `External2 test park ${ordinal}`, minute, minute + 1, agentId])).rows[0];
        const paid = await postTreasuryEntry(db, { worldId, entryKey: `public_work:${work.id}:0:m4`, kind: 'public_works',
          toAgentId: agentId, amountRaw: 1_000_000n, reason: 'Engine accepted completed public work', actor: 'council',
          sourceRef: `public_work:${work.id}`, worldMinute: minute + 2 });
        assert.equal(paid.created, true, paid.rejected);
        await db.query(`UPDATE world_public_works SET progress=100,sessions=4,milestones_paid=4,
          paid_raw=1000000,last_work_world_minute=$3,status='completed',completed_world_minute=$3
          WHERE world_id=$1 AND id=$2`, [worldId, work.id, minute + 3]);
        const receipt = (await db.query(`SELECT id::text AS id FROM world_external_contribution_receipts
          WHERE world_id=$1 AND kind='public_work' AND source_ref=$2`, [worldId, work.id])).rows[0];
        assert.ok(receipt, 'completed work produces a contribution receipt');
        return { workId: work.id, receiptId: receipt.id };
      };
      const firstWorks = [];
      for (let i = 0; i < 3; i += 1) firstWorks.push(await makeCompletedWork(agents[0], i));
      await makeCompletedWork(agents[2], 3);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      const frozen = (await db.query(`SELECT mirrorterra_external_frozen_raw($1,$2)::text AS raw`, [worldId, agents[0]])).rows[0].raw;
      assert.equal(frozen, '3000000', 'rewards credit but stay frozen');
      const wallets = [Wallet.createRandom(), Wallet.createRandom()];
      for (const [index, agentId] of [agents[0], agents[2]].entries()) {
        const wallet = wallets[index];
        const message = externalWithdrawalWalletMessage({ worldId, agentId, wallet: wallet.address });
        assert.equal((await bindExternalWithdrawalWallet(db, { worldId, agentId, wallet: wallet.address,
          signature: await wallet.signMessage(message) })).bound, true);
      }
      const legacyWallet = Wallet.createRandom();
      assert.equal((await bindExternalWithdrawalWallet(db, { worldId, agentId: agents[1], wallet: legacyWallet.address,
        signature: await legacyWallet.signMessage(externalWithdrawalWalletMessage({ worldId,
          agentId: agents[1], wallet: legacyWallet.address })) })).bound, true);
      await attempt(db, 'legacy_frozen_withdrawal', () => createExternalWithdrawal(db, { worldId, agentId: agents[1],
        actionId: 'legacy-frozen-attempt-01', grossRaw: '1000000', wallet: legacyWallet.address }),
      /EXTERNAL_WITHDRAWAL_BALANCE_FROZEN_OR_INSUFFICIENT/);
      await attempt(db, 'legacy_frozen_transfer', () => db.query(`INSERT INTO arc_sync_internal_transfers
        (world_id,action_id,from_agent_id,to_agent_id,amount_raw,kind,world_minute)
        VALUES($1,'external2-frozen-transfer',$2,$3,1000000,'business_service_payment',$4)`,
      [worldId, agents[1], agents[0], minute]), /EXTERNAL_BALANCE_FROZEN_OR_INSUFFICIENT/);
      await attempt(db, 'frozen_withdrawal', () => createExternalWithdrawal(db, { worldId, agentId: agents[0],
        actionId: 'frozen-attempt-0001', grossRaw: '1000000', wallet: wallets[0].address }),
      /EXTERNAL_WITHDRAWAL_BALANCE_FROZEN_OR_INSUFFICIENT/);
      await attempt(db, 'same_operator', async () => {
        await db.query(`INSERT INTO world_public_work_uses(world_id,work_id,agent_id,building_type,activity,use_kind,world_minute)
          VALUES($1,$2,$3,'park','socialize','social',$4)`, [worldId, firstWorks[0].workId, agents[1], minute + 4]);
        await acceptExternalContribution(db, { worldId, agentId: agents[1], receiptId: firstWorks[0].receiptId,
          actionId: 'same-operator-acceptance-01' });
      }, /EXTERNAL_ACCEPTANCE_REQUIRES_OTHER_OPERATOR/);
      for (const [index, work] of firstWorks.entries()) {
        await db.query(`INSERT INTO world_public_work_uses(world_id,work_id,agent_id,building_type,activity,use_kind,world_minute)
          VALUES($1,$2,$3,'park','socialize','social',$4)`, [worldId, work.workId, agents[2], minute + 5 + index]);
        assert.equal((await acceptExternalContribution(db, { worldId, agentId: agents[2], receiptId: work.receiptId,
          actionId: `other-operator-acceptance-0${index}` })).accepted, true);
      }
      assert.equal((await db.query(`SELECT mirrorterra_external_probation_complete($1,$2) AS done`, [worldId, agents[0]])).rows[0].done, true);
      await db.query('SET CONSTRAINTS ALL DEFERRED');
      const withdrawal = await createExternalWithdrawal(db, { worldId, agentId: agents[2],
        actionId: 'time-matured-withdrawal-01', grossRaw: '1000000', wallet: wallets[1].address });
      assert.equal(withdrawal.payouts.length, 2);
      assert.deepEqual(withdrawal.payouts.map((p) => [p.kind,p.amountRaw]),
        [['infrastructure_fee','30000'],['resident','970000']]);
      assert.notEqual(withdrawal.payouts[0].payoutId, withdrawal.payouts[1].payoutId);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      const balanceAfter = (await db.query(`SELECT spendable_raw::text AS raw FROM arc_sync_internal_balances
        WHERE world_id=$1 AND agent_id=$2`, [worldId, agents[2]])).rows[0].raw;
      assert.equal(balanceAfter, '0');
      const infra = (await db.query(`SELECT balance_raw::text AS raw FROM world_external_infrastructure_balances
        WHERE world_id=$1`, [worldId])).rows[0].raw;
      assert.equal(infra, String(priorInfrastructure + 30_000n));
      const postings = (await db.query(`SELECT sum(p.amount_raw)::text AS total,count(*)::int AS count
        FROM world_external_ledger_postings p JOIN world_external_payout_outbox o ON o.world_id=p.world_id AND o.id=p.outbox_id
        WHERE p.world_id=$1 AND o.withdrawal_id=$2`, [worldId, withdrawal.id])).rows[0];
      assert.equal(postings.total, '0');
      assert.equal(postings.count, 4);
      const fakeWithdrawal = randomUUID();
      const sample = { worldId, fakeWithdrawal, payoutId: `0x${'a'.repeat(64)}` };
      await attempt(db, 'wrong_fee', () => db.query(`INSERT INTO world_external_payout_outbox
        (world_id,withdrawal_id,payout_id,kind,recipient,amount_raw)
        VALUES($1,$2,$3,'infrastructure_fee',$4,1)`, [sample.worldId,sample.fakeWithdrawal,sample.payoutId,`0x${'1'.repeat(40)}`]),
      /EXTERNAL_WITHDRAWAL_PAYOUT_MISMATCH|external2_infrastructure_recipient_locked/);
      const feeCheck = (await db.query(`SELECT pg_get_constraintdef(c.oid,true) AS definition
        FROM pg_constraint c WHERE c.conname='external2_infrastructure_recipient_locked'`)).rows[0]?.definition;
      assert.match(feeCheck, /lower\(recipient\).*0x37428832cc1546aea4bc72948d739b08677d7739/);
      assert.equal((await db.query(`SELECT lower($1::text)='0x37428832cc1546aea4bc72948d739b08677d7739' AS valid`,
        ['0x37428832CC1546AEA4BC72948D739B08677D7739'])).rows[0].valid, true);
      if (commitSimulation) {
        await db.query('COMMIT');
        simulation = { worldId, agents };
      }
    } finally {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    }
    if (simulation) {
      const pool = new pg.Pool({ connectionString: `${url}?options=-c%20role%3Dsynterra_app`, max: 4 });
      let engine;
      try {
        const gateway = createBaiBudgetGateway(pool);
        let sends = 0;
        for (const agentId of simulation.agents) await assert.rejects(gateway.runRequest({ worldId: simulation.worldId,
          agentId, source: 'openCognition', tier: 'sonnet', model: 'claude-sonnet-5.5', body: '{}',
          maxTokens: 100, timeoutMs: 1000 }, async () => { sends += 1; }), { code: 'EXTERNAL_MODEL_CALL_FORBIDDEN' });
        assert.equal(sends, 0, 'gateway never invokes provider for all three external identities');
        const initial = (await pool.query(`SELECT world_minutes,tick_count,last_tick_at FROM world_runtime_state WHERE world_id=$1`,
          [simulation.worldId])).rows[0];
        let simulatedNow = new Date(initial.last_tick_at).getTime() + 10_000;
        const errors = [];
        const rssBefore = process.memoryUsage().rss;
        engine = await startWorldEngine(pool, { worldId: simulation.worldId, schedule: false,
          nowProvider: () => simulatedNow, openCognitionEnabled: false,
          onError: (error) => errors.push(error) });
        assert.equal(engine.running, true);
        let rssPeak = process.memoryUsage().rss;
        for (let tick = 0; tick < 10; tick += 1) {
          simulatedNow += 5_000;
          await engine.tickOnce();
          rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        }
        const final = (await pool.query(`SELECT world_minutes,tick_count FROM world_runtime_state WHERE world_id=$1`,
          [simulation.worldId])).rows[0];
        assert.ok(Number(final.world_minutes) > Number(initial.world_minutes), 'world minute advances');
        assert.ok(Number(final.tick_count) > Number(initial.tick_count), 'tick count advances');
        assert.equal(engine.getLiveness().lastTickError, null);
        assert.equal(errors.length, 0);
        assert.ok(rssPeak < 1_000_000_000, `simulation RSS peak ${rssPeak}`);
        process.stdout.write(JSON.stringify({ event: 'external2_simulation', externalResidents: 3, sameOperatorPair: true,
          modelGatewayExternalSends: sends, worldMinuteBefore: initial.world_minutes, worldMinuteAfter: final.world_minutes,
          tickBefore: initial.tick_count, tickAfter: final.tick_count, rssBefore, rssAfter: process.memoryUsage().rss,
          rssPeak }) + '\n');
      } finally {
        await engine?.stop();
        await pool.end();
      }
    }
  });
