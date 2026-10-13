import { randomUUID } from 'node:crypto';
import { TOKENOMICS_MANIFEST_HASH } from './sync-tokenomics.js';

const STORM_CLEANUP_REWARD_RAW = '1000000'; // 1 SYNC, published before acceptance.
function fail(code) { throw Object.assign(new Error(code), { code }); }
function same(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

// Called only by the world scheduler in the transaction that creates a genuine
// environment event. Agent-created opportunities never enter this path.
export async function publishWorldWorkOrder(client, { worldId, opportunityId, worldMinute }) {
  await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
  const selected = await client.query(`SELECT opportunity.id,opportunity.creator_agent_id,
      opportunity.source_type,opportunity.opportunity_type,opportunity.scene_id,scene.name AS location,
      opportunity.source_key,opportunity.metadata,opportunity.created_world_time,
      opportunity.expires_world_time,opportunity.status
    FROM world_opportunities opportunity JOIN world_scenes scene
      ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
    WHERE opportunity.world_id=$1 AND opportunity.id=$2 FOR UPDATE OF opportunity`, [worldId, opportunityId]);
  const opportunity = selected.rows[0];
  if (!opportunity || opportunity.creator_agent_id !== null || opportunity.source_type !== 'event'
      || opportunity.opportunity_type !== 'WORK' || opportunity.metadata?.needReason !== 'storm_damage'
      || !opportunity.scene_id || !opportunity.location || opportunity.status !== 'open'
      || Number(opportunity.created_world_time) !== Number(worldMinute)) fail('SYNC_WORLD_WORK_ORDER_SOURCE_INVALID');
  const targetResult = await client.query(`INSERT INTO world_sync_cleanup_targets(
      world_id,opportunity_id,source_key,scene_id,location,kind,created_world_minute)
    VALUES($1,$2,$3,$4,$5,'storm_debris',$6)
    ON CONFLICT(world_id,opportunity_id) DO NOTHING RETURNING id`,
  [worldId, opportunityId, opportunity.source_key, opportunity.scene_id, opportunity.location, worldMinute]);
  const target = targetResult.rows[0] || (await client.query(`SELECT id FROM world_sync_cleanup_targets
    WHERE world_id=$1 AND opportunity_id=$2 AND source_key=$3 AND scene_id=$4
      AND location=$5 AND status='pending'`,
  [worldId, opportunityId, opportunity.source_key, opportunity.scene_id, opportunity.location])).rows[0];
  if (!target) fail('SYNC_WORLD_CLEANUP_TARGET_CONFLICT');
  const repeated = await client.query(`SELECT id,status FROM world_sync_work_orders
    WHERE world_id=$1 AND opportunity_id=$2`, [worldId, opportunityId]);
  if (repeated.rowCount) return { ...repeated.rows[0], created: false };
  const pool = await client.query(`SELECT account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0) AS balance
    FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
      ON posting.world_id=account.world_id AND posting.account_id=account.id
    WHERE account.world_id=$1 AND account.account_type='operating_pool'
    GROUP BY account.id,account.opening_balance_raw`, [worldId]);
  const locked = await client.query(`SELECT COALESCE(sum(raw_sync_reward),0)::text AS amount
    FROM world_sync_work_orders WHERE world_id=$1 AND status IN ('open','accepted','verified')`, [worldId]);
  if (!pool.rowCount || BigInt(pool.rows[0].balance) - BigInt(locked.rows[0].amount)
      < BigInt(STORM_CLEANUP_REWARD_RAW)) return { created: false, reason: 'operating_pool_budget_unavailable' };
  const deadline = Number(opportunity.expires_world_time);
  if (!Number.isSafeInteger(deadline) || deadline <= worldMinute) fail('SYNC_WORLD_WORK_ORDER_DEADLINE_INVALID');
  const criteria = { type: 'storm_cleanup', sceneId: opportunity.scene_id, location: opportunity.location,
    targetId: target.id,
    description: 'Clear post-storm debris at the named public garden after accepting this order.' };
  const evidence = { eventType: 'world.action_completed', action: 'work', output: 'storm_debris_cleared',
    targetId: target.id,
    independentFromAcceptance: true };
  const inserted = await client.query(`INSERT INTO world_sync_work_orders(world_id,opportunity_id,target_id,source_key,
      budget_source,raw_sync_reward,acceptance_criteria,evidence_requirements,published_world_minute,deadline_world_minute)
    VALUES($1,$2,$3,$4,'world_operating_pool',$5::numeric,$6::jsonb,$7::jsonb,$8,$9)
    RETURNING id,status,raw_sync_reward::text AS "rawSyncReward"`, [worldId, opportunityId,
    target.id, `protocol-storm-cleanup:${opportunity.source_key}`, STORM_CLEANUP_REWARD_RAW,
    JSON.stringify(criteria), JSON.stringify(evidence), worldMinute, deadline]);
  await client.query(`UPDATE world_opportunities SET capacity=1,
      reward=reward||jsonb_build_object('rawSyncReward',$3::text,'budgetSource','world_operating_pool',
        'workOrderId',$4::text,'targetId',$5::text),updated_at=now() WHERE world_id=$1 AND id=$2`,
  [worldId, opportunityId, STORM_CLEANUP_REWARD_RAW, inserted.rows[0].id, target.id]);
  return { ...inserted.rows[0], created: true };
}

export async function acceptWorldWorkOrder(client, { worldId, opportunityId, agentId, worldMinute }) {
  const selected = await client.query(`SELECT id,status,deadline_world_minute FROM world_sync_work_orders
    WHERE world_id=$1 AND opportunity_id=$2 FOR UPDATE`, [worldId, opportunityId]);
  if (!selected.rowCount) return null;
  const row = selected.rows[0];
  if (row.status !== 'open' || Number(worldMinute) > Number(row.deadline_world_minute)) {
    fail('SYNC_WORLD_WORK_ORDER_NOT_OPEN');
  }
  const updated = await client.query(`UPDATE world_sync_work_orders SET status='accepted',accepted_agent_id=$3,
      accepted_world_minute=$4,accepted_at=now(),updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='open' RETURNING id`,
  [worldId, row.id, agentId, worldMinute]);
  if (updated.rowCount !== 1) fail('SYNC_WORLD_WORK_ORDER_ACCEPTANCE_CONFLICT');
  return { id: row.id, status: 'accepted' };
}

export async function clearWorldWorkOrderTarget(client, { worldId, workOrderId, agentId, worldMinute, place }) {
  const selected = await client.query(`SELECT work_order.*,scene.name AS scene_name,
      target.location AS target_location,target.status AS target_status
    FROM world_sync_work_orders work_order JOIN world_sync_cleanup_targets target
      ON target.world_id=work_order.world_id AND target.id=work_order.target_id
    JOIN world_opportunities opportunity
      ON opportunity.world_id=work_order.world_id AND opportunity.id=work_order.opportunity_id
    JOIN world_scenes scene ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
    WHERE work_order.world_id=$1 AND work_order.id=$2 FOR UPDATE OF work_order`, [worldId, workOrderId]);
  const row = selected.rows[0];
  if (!row || row.status !== 'accepted' || row.accepted_agent_id !== agentId
      || row.target_status !== 'pending' || !same(row.scene_name, place)
      || !same(row.target_location, place) || Number(worldMinute) < Number(row.accepted_world_minute)
      || Number(worldMinute) > Number(row.deadline_world_minute)) return null;
  const cleared = await client.query(`UPDATE world_sync_cleanup_targets SET status='cleared',
      cleared_by_agent_id=$3,cleared_world_minute=$4,cleared_at=now()
    WHERE world_id=$1 AND id=$2 AND status='pending'
    RETURNING id`, [worldId, row.target_id, agentId, worldMinute]);
  return cleared.rowCount === 1 ? { workOrderId: row.id, targetId: row.target_id } : null;
}

export async function verifyWorldWorkOrderCompletion(client, { worldId, workOrderId, agentId,
  worldMinute, evidenceEventId, place, targetId }) {
  const selected = await client.query(`SELECT work_order.*,scene.name AS scene_name,
      target.location AS target_location,target.status AS target_status,
      target.cleared_by_agent_id,target.cleared_world_minute,target.cleared_at
    FROM world_sync_work_orders work_order JOIN world_sync_cleanup_targets target
      ON target.world_id=work_order.world_id AND target.id=work_order.target_id
    JOIN world_opportunities opportunity ON opportunity.world_id=work_order.world_id
      AND opportunity.id=work_order.opportunity_id
    JOIN world_scenes scene ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
    WHERE work_order.world_id=$1 AND work_order.id=$2 FOR UPDATE OF work_order`, [worldId, workOrderId]);
  const row = selected.rows[0];
  if (!row || row.status !== 'accepted' || row.accepted_agent_id !== agentId
      || row.target_id !== targetId || row.target_status !== 'cleared'
      || row.cleared_by_agent_id !== agentId || Number(row.cleared_world_minute) !== Number(worldMinute)
      || !same(row.scene_name, place) || !same(row.target_location, place)
      || Number(worldMinute) < Number(row.accepted_world_minute)
      || Number(worldMinute) > Number(row.deadline_world_minute)
      || new Date(row.cleared_at) <= new Date(row.accepted_at)) fail('SYNC_WORLD_WORK_ORDER_COMPLETION_INVALID');
  const event = await client.query(`SELECT id FROM world_events WHERE id=$1 AND world_id=$2 AND actor_id=$3
      AND event_type='world.action_completed' AND data->>'action'='work'
      AND data->>'place'=$4 AND data->'work'->>'output'='storm_debris_cleared'
      AND data->'work'->>'targetId'=$7 AND data->'work'->>'workOrderId'=$8
      AND (data->>'worldMinutes')::bigint=$5 AND created_at>$6::timestamptz`,
  [evidenceEventId, worldId, agentId, place, worldMinute, row.accepted_at, targetId, workOrderId]);
  if (event.rowCount !== 1) fail('SYNC_WORLD_WORK_ORDER_EVIDENCE_INVALID');
  await client.query(`UPDATE world_sync_work_orders SET status='verified',evidence_event_id=$3,
      verified_world_minute=$4,evidence=jsonb_build_object('eventId',$3::bigint,
        'action','work','output','storm_debris_cleared','place',$5::text,'targetId',$6::text),updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status='accepted'`,
  [worldId, workOrderId, evidenceEventId, worldMinute, place, targetId]);
  await client.query(`UPDATE world_opportunity_participants SET status='completed',updated_world_time=$4,updated_at=now()
    WHERE world_id=$1 AND opportunity_id=$2 AND agent_id=$3 AND status='accepted'`,
  [worldId, row.opportunity_id, agentId, worldMinute]);
  await client.query(`UPDATE world_opportunities SET status='completed',updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, row.opportunity_id]);
  return { id: row.id, status: 'verified', rawSyncReward: String(row.raw_sync_reward) };
}

export async function expireWorldWorkOrders(client, { worldId, worldMinute }) {
  const expired = await client.query(`UPDATE world_sync_work_orders work_order SET
      status=CASE WHEN opportunity.status IN ('closed','failed') THEN 'cancelled' ELSE 'expired' END,
      updated_at=now()
    FROM world_opportunities opportunity WHERE opportunity.world_id=work_order.world_id
      AND opportunity.id=work_order.opportunity_id AND work_order.world_id=$1
      AND work_order.status IN ('open','accepted')
      AND (work_order.deadline_world_minute<=$2 OR opportunity.status IN ('closed','failed'))
    RETURNING work_order.id`, [worldId, worldMinute]);
  return expired.rowCount;
}

export async function commitVerifiedWorldWorkOrderBatches(client, { worldId, worldMinute }) {
  await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
  const orders = await client.query(`SELECT id,accepted_agent_id,raw_sync_reward::text AS amount_raw
    FROM world_sync_work_orders WHERE world_id=$1 AND status='verified'
    ORDER BY accepted_agent_id,id FOR UPDATE`, [worldId]);
  const byAgent = new Map();
  for (const row of orders.rows) {
    if (!byAgent.has(row.accepted_agent_id)) byAgent.set(row.accepted_agent_id, []);
    byAgent.get(row.accepted_agent_id).push(row);
  }
  const committed = [];
  for (const [agentId, items] of byAgent) {
    const wallet = await client.query(`SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2
      AND chain_id=5042 AND status='active'`, [worldId, agentId]);
    if (wallet.rowCount !== 1) fail('SYNC_WORLD_WORK_ORDER_WALLET_NOT_READY');
    const deployment = await client.query(`SELECT manifest_hash FROM arc_sync_tokenomics_deployments
      WHERE world_id=$1 AND chain_id=5042`, [worldId]);
    if (deployment.rows[0]?.manifest_hash !== TOKENOMICS_MANIFEST_HASH) fail('SYNC_TOKENOMICS_DEPLOYMENT_NOT_READY');
    const amount = items.reduce((sum, item) => sum + BigInt(item.amount_raw), 0n);
    const batchId = randomUUID();
    const batchAction = `sync-work-order-batch:${batchId}`;
    const payoutAction = `sync-payout-batch:${batchId}`;
    await client.query(`INSERT INTO world_sync_work_order_batches(id,world_id,action_id,agent_id,
        recipient_address,amount_raw,world_minute,status)
      VALUES($1,$2,$3,$4,$5,$6::numeric,$7,'committed')`,
    [batchId, worldId, batchAction, agentId, wallet.rows[0].address, amount.toString(), worldMinute]);
    await client.query(`INSERT INTO world_sync_work_order_batch_items(world_id,batch_id,work_order_id)
      SELECT $1,$2,id FROM world_sync_work_orders WHERE world_id=$1 AND id=ANY($3::uuid[])`,
    [worldId, batchId, items.map((item) => item.id)]);
    await client.query(`UPDATE world_sync_work_orders SET status='batched',updated_at=now()
      WHERE world_id=$1 AND id=ANY($2::uuid[]) AND status='verified'`, [worldId, items.map((item) => item.id)]);
    await client.query(`INSERT INTO arc_sync_ledger_accounts(world_id,account_type,account_key,agent_id,opening_balance_raw)
      VALUES($1,'agent',$2,$3,0) ON CONFLICT(world_id,account_key) DO NOTHING`,
    [worldId, `agent:${agentId}`, agentId]);
    const accounts = await client.query(`SELECT id,account_type FROM arc_sync_ledger_accounts
      WHERE world_id=$1 AND (account_key='operating-pool' OR account_key=$2)`, [worldId, `agent:${agentId}`]);
    const pool = accounts.rows.find((row) => row.account_type === 'operating_pool');
    const agent = accounts.rows.find((row) => row.account_type === 'agent');
    if (!pool || !agent) fail('SYNC_LEDGER_ACCOUNTS_MISSING');
    const ledger = await client.query(`INSERT INTO arc_sync_ledger_transactions(world_id,action_id,
        source_economic_action_id,transaction_type,world_minute,status,metadata)
      VALUES($1,$2,$3,'operating_pool_payout',$4,'draft',jsonb_build_object(
        'source','world_work_order_batch','manifestHash',$5::text,'workOrderCount',$6::int)) RETURNING id`,
    [worldId, payoutAction, batchAction, worldMinute, TOKENOMICS_MANIFEST_HASH, items.length]);
    const ledgerId = ledger.rows[0].id;
    await client.query(`INSERT INTO arc_sync_ledger_postings(world_id,transaction_id,account_id,amount_raw)
      VALUES($1,$2,$3,-($5::numeric)),($1,$2,$4,$5::numeric)`,
    [worldId, ledgerId, pool.id, agent.id, amount.toString()]);
    await client.query(`INSERT INTO arc_sync_payout_outbox(world_id,transaction_id,action_id,agent_id,
        recipient_address,amount_raw,status)
      VALUES($1,$2,$3,$4,$5,$6::numeric,'committed')`,
    [worldId, ledgerId, payoutAction, agentId, wallet.rows[0].address, amount.toString()]);
    await client.query(`UPDATE arc_sync_ledger_transactions SET status='committed',committed_at=now()
      WHERE world_id=$1 AND id=$2 AND status='draft'`, [worldId, ledgerId]);
    committed.push({ batchId, agentId, amountRaw: amount.toString(), workOrderCount: items.length });
  }
  return committed;
}
