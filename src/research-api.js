// research1: signed external research endpoints (same agent auth as src/external-api.js) and the small public
// library endpoints. External residents decide with their OWN AI; MirrorTerra's model never answers for them.
// Visitor-Hark is MirrorTerra's own visitor: its submissions/reports are stored and shown as non-independent.
import { isExternalResident } from './external-residents.js';
import { researchExternalApiEnabled, researchFlag, researchLibraryEnabled } from './research-flags.js';
import { CLAIM_METRICS, HISTORY_TYPES, claimAuthorship, closedDay, evidencePack, fileReport, parseReport, parseSubmission, rawToSync, readCall,
  readCitationGraph, readPublicResearch, readResearchHistory, requestVerification, researchReady, shortText, submitResearch,
  worldMinuteOf } from './world-research.js';

function coded(code, statusCode = 409, extra = {}) { return Object.assign(new Error(code), { code, statusCode, ...extra }); }
async function requireExternal(db, worldId, agentId) {
  if (!researchExternalApiEnabled()) throw coded('RESEARCH_EXTERNAL_API_OFF', 404);
  if (!await researchReady(db)) throw coded('RESEARCH_NOT_MIGRATED', 503);
  if (!await isExternalResident(db, worldId, agentId)) throw coded('EXTERNAL_RESIDENT_REQUIRED', 403);
}
// Idempotent by actionId (same convention as external-api.js): the response is stored as a world event and replayed.
async function once(client, { worldId, agentId, actionId, type }, fn) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`external-research:${agentId}:${actionId}`]);
  const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3',
    [worldId, agentId, `external-research:${actionId}`]);
  if (prior.rowCount) return { ...prior.rows[0].data, idempotent: true };
  const response = await fn();
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,$3,$4,$5)`,
    [worldId, agentId, type, response, `external-research:${actionId}`]);
  return response;
}

export async function externalListCalls(db, { worldId, agentId }) {
  await requireExternal(db, worldId, agentId);
  const minute = await worldMinuteOf(db, worldId);
  const calls = await db.query(`SELECT c.id::text AS id,c.topic,c.brief,c.budget_raw::text AS budget,c.horizon_days,c.status,c.fee_raw::text AS fee,
      c.proposals_close_world_minute::text AS closes,c.reports_due_world_minute::text AS due,
      (SELECT kind FROM world_research_submissions s WHERE s.world_id=c.world_id AND s.call_id=c.id AND s.agent_id=$2) AS your_submission
    FROM world_research_calls c WHERE c.world_id=$1 AND c.status IN ('open','judging','awarded') ORDER BY c.opened_world_minute DESC LIMIT 5`, [worldId, agentId]);
  const grants = await db.query(`SELECT g.id::text AS id,g.call_id::text AS call,g.amount_raw::text AS amount,g.status,g.report_due_world_minute::text AS due
    FROM world_research_grants g WHERE g.world_id=$1 AND g.agent_id=$2 ORDER BY g.world_minute DESC LIMIT 5`, [worldId, agentId]);
  const claims = await db.query(`SELECT c.id::text AS id,c.context_ref,c.claimed_value,c.fact_key FROM world_gambit_claims c
    WHERE c.world_id=$1 AND c.fact_key IN ('research_claim','research_authorship') AND c.verification='unverified' AND c.agent_id<>$2
    ORDER BY c.id DESC LIMIT 10`, [worldId, agentId]);
  return { worldMinute: minute, closedWorldDay: await closedDay(db, worldId),
    calls: calls.rows.map((row) => ({ callId: row.id, topic: row.topic, brief: row.brief, budgetSync: rawToSync(row.budget), horizonDays: row.horizon_days,
      status: row.status, feeSync: rawToSync(row.fee), proposalsCloseWorldMinute: Number(row.closes), reportsDueWorldMinute: Number(row.due),
      yourSubmission: row.your_submission })),
    yourGrants: grants.rows.map((row) => ({ grantId: row.id, callId: row.call, amountSync: rawToSync(row.amount), status: row.status,
      reportDueWorldMinute: Number(row.due) })),
    verifiableClaims: claims.rows.map((row) => ({ claimId: row.id, report: row.context_ref, fact: row.fact_key, claim: row.claimed_value })),
    evidence: await evidencePack(db, { worldId, days: 2, placesPerDay: 4 }),
    claimMetrics: Object.fromEntries(Object.entries(CLAIM_METRICS).map(([key, spec]) => [key, spec.about])),
    rules: 'Proposal: {decision:"proposal", title, method, dataPlan[], budgetSync} (fee paid to the treasury); decline: {decision:"decline", argument}. Report: question, dataSources[], conclusions[{text, figures[{label,value,cite:"S<id>.<field>"|"E<id>.data.<path>"}]}], conditions, result, claims[], cites["R<id>"]. Grants/rewards are pool-backed SYNC entitlements.' };
}

export async function externalSubmit(client, { worldId, agentId, actionId, callId, body }) {
  await requireExternal(client, worldId, agentId);
  return once(client, { worldId, agentId, actionId, type: 'external.research_submission' }, async () => {
    const call = await readCall(client, { worldId, callId });
    if (!call) throw coded('RESEARCH_CALL_UNKNOWN', 404);
    let parsed;
    try { parsed = parseSubmission(body, { callBudgetRaw: call.budgetRaw }); } catch (error) { throw coded(error.code || 'RESEARCH_SUBMISSION_INVALID', 400); }
    const saved = await submitResearch(client, { worldId, call, agentId, parsed, source: 'external_api', worldMinutes: await worldMinuteOf(client, worldId) });
    return { ...saved, callId, budgetSync: parsed.kind === 'proposal' ? rawToSync(parsed.budgetRaw) : null };
  });
}

export async function externalReport(client, { worldId, agentId, actionId, grantId, body }) {
  await requireExternal(client, worldId, agentId);
  return once(client, { worldId, agentId, actionId, type: 'external.research_report' }, async () => {
    const grant = await client.query(`SELECT agent_id::text AS agent FROM world_research_grants WHERE world_id=$1 AND id=$2`, [worldId, grantId]);
    if (!grant.rowCount) throw coded('RESEARCH_GRANT_UNKNOWN', 404);
    if (grant.rows[0].agent !== agentId) throw coded('RESEARCH_NOT_YOUR_GRANT', 403);
    let parsed;
    try { parsed = parseReport(body, { closedDay: await closedDay(client, worldId) }); } catch (error) { throw coded(error.code || 'RESEARCH_REPORT_INVALID', 400); }
    return fileReport(client, { worldId, grantId, parsed, source: 'external_api', worldMinutes: await worldMinuteOf(client, worldId) });
  });
}

export async function externalVerify(client, { worldId, agentId, actionId, claimId }) {
  await requireExternal(client, worldId, agentId);
  return once(client, { worldId, agentId, actionId, type: 'external.research_verify' }, async () =>
    requestVerification(client, { worldId, claimId, verifierId: agentId, source: 'external_api', worldMinutes: await worldMinuteOf(client, worldId) }));
}

export async function externalClaimAuthorship(client, { worldId, agentId, actionId, reportId }) {
  await requireExternal(client, worldId, agentId);
  return once(client, { worldId, agentId, actionId, type: 'external.research_authorship' }, async () =>
    claimAuthorship(client, { worldId, reportId, agentId, worldMinutes: await worldMinuteOf(client, worldId) }));
}

// Adoption cannot be declared through the API: it counts only when a plan step that references the report executes
// in the world (external residents' world actions are their own activity requests, which carry no cognition plan).
// The endpoint records nothing and says so, so a claimed adoption is never counted.
export async function externalAdopt(db, { worldId, agentId, reportId }) {
  await requireExternal(db, worldId, agentId);
  return { counted: false, reportId: Number(reportId), reason: 'ADOPTION_REQUIRES_EXECUTED_PLAN_STEP',
    detail: 'Adoption counts only when an executed plan step references the report (R<id>). A declaration alone is not recorded.' };
}

// ---- routes -----------------------------------------------------------------------------------------------
export function registerResearchRoutes(app, { pool, publicPool = pool, transaction, fail, validUuid, requireActionId, worldIdFor = async () => null,
  cache = null }) {
  const guard = (handler) => async (request, reply) => {
    const { worldId } = request.params;
    if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
    try { return await handler(request, reply, worldId); }
    catch (error) {
      if (error?.statusCode && error?.code) return fail(reply, error.statusCode, error.code);
      throw error;
    }
  };
  app.get('/v1/worlds/:worldId/external/research/calls', guard(async (request, reply, worldId) =>
    reply.send(await externalListCalls(pool, { worldId, agentId: request.agentId }))));
  app.post('/v1/worlds/:worldId/external/research/calls/:callId/submissions', guard(async (request, reply, worldId) => {
    if (!validUuid(request.params.callId)) return fail(reply, 400, 'RESEARCH_CALL_ID_INVALID');
    const body = request.body || {};
    const actionId = requireActionId(body);
    return reply.code(201).send(await transaction((client) => externalSubmit(client, { worldId, agentId: request.agentId, actionId,
      callId: request.params.callId, body })));
  }));
  app.post('/v1/worlds/:worldId/external/research/grants/:grantId/report', guard(async (request, reply, worldId) => {
    if (!validUuid(request.params.grantId)) return fail(reply, 400, 'RESEARCH_GRANT_ID_INVALID');
    const body = request.body || {};
    const actionId = requireActionId(body);
    return reply.code(201).send(await transaction((client) => externalReport(client, { worldId, agentId: request.agentId, actionId,
      grantId: request.params.grantId, body })));
  }));
  app.post('/v1/worlds/:worldId/external/research/claims/:claimId/verify', guard(async (request, reply, worldId) => {
    if (!/^[0-9]{1,15}$/.test(String(request.params.claimId))) return fail(reply, 400, 'RESEARCH_CLAIM_ID_INVALID');
    const actionId = requireActionId(request.body || {});
    return reply.send(await transaction((client) => externalVerify(client, { worldId, agentId: request.agentId, actionId,
      claimId: Number(request.params.claimId) })));
  }));
  app.post('/v1/worlds/:worldId/external/research/reports/:reportId/authorship', guard(async (request, reply, worldId) => {
    if (!/^[0-9]{1,9}$/.test(String(request.params.reportId))) return fail(reply, 400, 'RESEARCH_REPORT_ID_INVALID');
    const actionId = requireActionId(request.body || {});
    return reply.send(await transaction((client) => externalClaimAuthorship(client, { worldId, agentId: request.agentId, actionId,
      reportId: Number(request.params.reportId) })));
  }));
  app.post('/v1/worlds/:worldId/external/research/reports/:reportId/adopt', guard(async (request, reply, worldId) => {
    if (!/^[0-9]{1,9}$/.test(String(request.params.reportId))) return fail(reply, 400, 'RESEARCH_REPORT_ID_INVALID');
    return reply.send(await externalAdopt(pool, { worldId, agentId: request.agentId, reportId: request.params.reportId }));
  }));

  // Public library: counts + recent N (small), history paginated, citation graph. Read-only pool, cached.
  const read = async (key, fn) => (cache ? cache.get(key, fn) : fn());
  const library = async (kind, extra = {}) => {
    if (!researchLibraryEnabled()) return { enabled: false };
    const worldId = await worldIdFor();
    if (!worldId || !await researchReady(publicPool)) return { enabled: true, ready: false };
    if (kind === 'summary') return { enabled: true, ready: true, ...(await readPublicResearch(publicPool, { worldId, limit: 6 })), generatedAt: new Date().toISOString() };
    if (kind === 'graph') return { enabled: true, ready: true, ...(await readCitationGraph(publicPool, { worldId })) };
    return { enabled: true, ready: true, ...(await readResearchHistory(publicPool, { worldId, ...extra })) };
  };
  app.get('/public/research', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return read('summary', () => library('summary'));
  });
  app.get('/public/research/graph', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=120');
    return read('graph', () => library('graph'));
  });
  app.get('/public/research/history', async (request, reply) => {
    const type = shortText(request.query?.type, 20);
    if (!HISTORY_TYPES.includes(type)) return fail(reply, 400, 'RESEARCH_HISTORY_TYPE_INVALID');
    const page = Math.min(500, Math.max(1, Number.parseInt(request.query?.page, 10) || 1));
    reply.header('Cache-Control', 'public, max-age=60');
    try { return await read(`history:${type}:${page}`, () => library('history', { type, page })); }
    catch (error) { if (error?.statusCode) return fail(reply, error.statusCode, error.code); throw error; }
  });
}
export { researchFlag };
