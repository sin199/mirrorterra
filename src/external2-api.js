import { bindExternalOperator, bindExternalWithdrawalWallet, createExternalWithdrawal,
  readExternalWithdrawal, acceptExternalContribution, readExternal2Policy } from './external2.js';

export function registerExternal2Routes(app, { pool, transaction, fail, validUuid, requireActionId }) {
  const guarded = (handler) => async (request, reply) => {
    if (!validUuid(request.params.worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
    if (request.params.id && !validUuid(request.params.id)) return fail(reply, 400, 'EXTERNAL2_ID_INVALID');
    return handler(request, reply, request.params.worldId);
  };
  app.post('/v1/worlds/:worldId/external/operator-binding', guarded(async (request, reply, worldId) => {
    const body = request.body || {};
    requireActionId(body);
    return reply.send(await transaction((db) => bindExternalOperator(db, { worldId, agentId: request.agentId,
      operatorId: body.operatorId, nonce: body.nonce, expiresAt: body.expiresAt, signature: body.operatorSignature })));
  }));
  app.post('/v1/worlds/:worldId/external/withdrawal-wallet', guarded(async (request, reply, worldId) => {
    const body = request.body || {};
    requireActionId(body);
    return reply.send(await transaction((db) => bindExternalWithdrawalWallet(db, { worldId, agentId: request.agentId,
      wallet: body.wallet, signature: body.walletSignature })));
  }));
  app.post('/v1/worlds/:worldId/external/withdrawals', guarded(async (request, reply, worldId) => {
    const body = request.body || {};
    const actionId = requireActionId(body);
    return reply.send(await transaction((db) => createExternalWithdrawal(db, { worldId, agentId: request.agentId,
      actionId, grossRaw: body.grossRaw, wallet: body.wallet })));
  }));
  app.get('/v1/worlds/:worldId/external/withdrawals/:id', guarded(async (request, reply, worldId) =>
    reply.send(await readExternalWithdrawal(pool, { worldId, agentId: request.agentId, id: request.params.id }))));
  // Receipts have opaque IDs; another operator needs this bounded signed read
  // before they can attest to work they actually used or adopted.
  app.get('/v1/worlds/:worldId/contributions', guarded(async (request, reply, worldId) => {
    const authorAgentId = request.query?.authorAgentId;
    if (!validUuid(authorAgentId)) return fail(reply, 400, 'AUTHOR_AGENT_ID_INVALID');
    const rows = await pool.query(`SELECT r.id::text AS id,r.kind,r.source_ref AS "sourceRef",
        r.amount_raw::text AS "amountRaw",r.created_at AS "createdAt",
        EXISTS(SELECT 1 FROM world_external_contribution_acceptances a
          WHERE a.world_id=r.world_id AND a.receipt_id=r.id) AS accepted,
        mirrorterra_external_independent_pair(r.world_id,r.agent_id,$3::uuid) AS "independentOperator"
      FROM world_external_contribution_receipts r
      WHERE r.world_id=$1 AND r.agent_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 50`,
    [worldId, authorAgentId, request.agentId]);
    return reply.send({ contributions: rows.rows });
  }));
  app.post('/v1/worlds/:worldId/contributions/:id/accept', guarded(async (request, reply, worldId) => {
    const actionId = requireActionId(request.body || {});
    return reply.send(await transaction((db) => acceptExternalContribution(db, { worldId, agentId: request.agentId,
      receiptId: request.params.id, actionId })));
  }));
  app.get('/v1/worlds/:worldId/external/economy', guarded(async (request, reply, worldId) => {
    const agentId = request.agentId;
    const balance = (await pool.query(`SELECT b.spendable_raw::text AS "bookBalanceRaw",
        LEAST(GREATEST(b.spendable_raw,0),mirrorterra_external_frozen_raw(b.world_id,b.agent_id))::text AS "frozenRaw",
        b.spendable_raw-LEAST(GREATEST(b.spendable_raw,0),mirrorterra_external_frozen_raw(b.world_id,b.agent_id)) AS "availableRaw",
        mirrorterra_external_probation_complete(b.world_id,b.agent_id) AS "probationComplete"
      FROM arc_sync_internal_balances b JOIN world_external_residents e ON e.world_id=b.world_id AND e.agent_id=b.agent_id
      WHERE b.world_id=$1 AND b.agent_id=$2`, [worldId, agentId])).rows[0];
    if (!balance) return fail(reply, 403, 'EXTERNAL_RESIDENT_REQUIRED');
    const receipts = await pool.query(`SELECT id,kind,source_ref AS "sourceRef",amount_raw::text AS "amountRaw"
      FROM world_external_contribution_receipts WHERE world_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC LIMIT 30`, [worldId, agentId]);
    const policy = await readExternal2Policy(pool);
    return reply.send({ ...balance, availableRaw: String(balance.availableRaw), receipts: receipts.rows,
      rewardCap: null, probationRealDays: policy.probation_real_days, probationAcceptances: policy.probation_acceptances,
      withdrawalsOpen: policy.withdrawals, authorization: 'unsigned', broadcast: false });
  }));
}
