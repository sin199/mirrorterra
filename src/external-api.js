// external1: signed API for external residents' OWN AI (reuses the agent auth: x-agent-id / x-agent-time /
// x-agent-nonce / x-agent-signature over 'agent-world-v1\n<METHOD>\n<path>\n<time>\n<nonce>\n<sha256(body)>').
// Big decisions (council proposals and votes, public-works pledges) and activity overrides come from here;
// routine life stays engine-driven. Responses carry ids the agent needs to act (proposalId, workId);
// the public UI never shows ids.
import { createCouncilProposal, castCouncilVote, readCouncilMembership, leverLabel, formatLeverValue } from './council.js';
import { boundedValueFromTarget, leverRange } from './council-deliberation.js';
import { pledgePublicWorkVolunteer, recordDeliberation, publicWorksReady } from './public-works.js';
import { ZERO_BALANCE_RULES, externalConfig, isExternalResident, submitActivityRequest, EXTERNAL_ACTIVITIES } from './external-residents.js';
import { bindExternalWallet, claimExternalPurchase, readExternalPurchaseStatus } from './external-purchase.js';
import { LEVER_KEYS, readCouncilPolicies, worldDayOf } from './treasury.js';
import { worldCalendar } from './world-environment.js';

export const EXTERNAL_PROPOSE_HOURS = Object.freeze([9, 13]);   // world 09:00-12:59 (decided at 15:00 the same day)
export const EXTERNAL_VOTE_UNTIL_HOUR = 15;                       // votes until the 15:00 tally
function coded(code, statusCode = 409, extra = {}) { return Object.assign(new Error(code), { code, statusCode, ...extra }); }
const short = (value, max = 240) => String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function worldMinuteOf(client, worldId) {
  return Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || 0;
}
async function requireExternal(client, worldId, agentId) {
  if (!await isExternalResident(client, worldId, agentId)) throw coded('EXTERNAL_RESIDENT_REQUIRED', 403);
}
async function requireEligible(client, { worldId, agentId, worldMinutes, env }) {
  const membership = await readCouncilMembership(client, { worldId, worldMinutes, env });
  const me = membership.externals.find((row) => row.agentId === agentId);
  if (!me?.eligible) throw coded('EXTERNAL_COUNCIL_NOT_ELIGIBLE', 403, { detail: me ? me.needs.join('; ') : 'not an external resident' });
  return { membership, me };
}
// Idempotent by actionId: the response is stored as a world event of the actor and replayed on retry.
async function once(client, { worldId, agentId, actionId, type }, fn) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`external-api:${agentId}:${actionId}`]);
  const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3',
    [worldId, agentId, `external:${actionId}`]);
  if (prior.rowCount) return { ...prior.rows[0].data, idempotent: true };
  const response = await fn();
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,$3,$4,$5)`,
    [worldId, agentId, type, response, `external:${actionId}`]);
  return response;
}

// ---- council ---------------------------------------------------------------------------------------
export async function externalPropose(client, { worldId, agentId, actionId, lever, target, reason, env = process.env }) {
  if (!LEVER_KEYS.includes(lever)) throw coded('COUNCIL_LEVER_INVALID', 400);
  await requireExternal(client, worldId, agentId);
  return once(client, { worldId, agentId, actionId, type: 'external.council_proposal' }, async () => {
    const minute = await worldMinuteOf(client, worldId);
    const hour = worldCalendar(minute).hour;
    if (hour < EXTERNAL_PROPOSE_HOURS[0] || hour >= EXTERNAL_PROPOSE_HOURS[1]) {
      throw coded('COUNCIL_PROPOSAL_WINDOW_CLOSED', 409, { detail: 'Proposals are accepted 09:00-12:59 world time.' });
    }
    await requireEligible(client, { worldId, agentId, worldMinutes: minute, env });
    const today = await client.query(`SELECT 1 FROM world_council_proposals WHERE world_id=$1 AND proposer_agent_id=$2
      AND opened_world_day=$3`, [worldId, agentId, worldDayOf(minute)]);
    if (today.rowCount) throw coded('COUNCIL_ONE_PROPOSAL_PER_DAY', 409);
    const bounded = boundedValueFromTarget(lever, target);
    if (!bounded) throw coded('COUNCIL_LEVER_OUT_OF_BOUNDS', 400, { detail: JSON.stringify(leverRange(lever)) });
    const text = short(reason);
    if (text.length < 3) throw coded('COUNCIL_REASON_REQUIRED', 400);
    const created = await createCouncilProposal(client, { worldId, proposerAgentId: agentId, lever, value: bounded.value,
      reason: text, source: 'cognition', worldMinutes: minute });
    await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'propose', agentId, source: 'llm',
      proposalId: created.proposalId, decision: { propose: true, lever, channel: 'external_api', clamped: bounded.clamped }, reason: text });
    return { proposalId: created.proposalId, title: created.title, lever, value: bounded.value, clamped: bounded.clamped, status: 'open' };
  });
}

export async function externalVote(client, { worldId, agentId, actionId, proposalId, stance, reason, env = process.env }) {
  if (!['yes','no'].includes(stance)) throw coded('COUNCIL_STANCE_INVALID', 400);
  await requireExternal(client, worldId, agentId);
  return once(client, { worldId, agentId, actionId, type: 'external.council_vote' }, async () => {
    const minute = await worldMinuteOf(client, worldId);
    await requireEligible(client, { worldId, agentId, worldMinutes: minute, env });
    const proposal = (await client.query(`SELECT id,status,closes_world_minute::text AS closes FROM world_council_proposals
      WHERE world_id=$1 AND id=$2`, [worldId, proposalId])).rows[0];
    if (!proposal || proposal.status !== 'open' || Number(proposal.closes) <= minute) throw coded('COUNCIL_PROPOSAL_NOT_OPEN');
    const abstained = await client.query(`SELECT 1 FROM world_council_deliberations WHERE world_id=$1 AND proposal_id=$2 AND agent_id=$3
      AND phase='vote'`, [worldId, proposalId, agentId]);
    if (abstained.rowCount) throw coded('COUNCIL_ALREADY_DECIDED', 409);
    const text = short(reason);
    const cast = await castCouncilVote(client, { worldId, proposalId, agentId, stance, reason: text.length >= 3 ? text : 'My vote.',
      source: 'cognition', worldMinutes: minute });
    if (cast.duplicate) throw coded('COUNCIL_ALREADY_VOTED', 409);
    await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'vote', agentId, source: 'llm', proposalId,
      decision: { stance, channel: 'external_api' }, reason: text || null });
    return { proposalId, stance, yes: cast.yes, no: cast.no };
  });
}

// ---- public works: volunteer pledge (no paid contract for external residents) ----------------------
export async function externalPublicWorkBid(client, { worldId, agentId, actionId, workId, volunteer = true, reason, env = process.env }) {
  await requireExternal(client, worldId, agentId);
  if (!await publicWorksReady(client)) throw coded('PUBLIC_WORKS_NOT_MIGRATED', 409);
  return once(client, { worldId, agentId, actionId, type: 'external.public_work_bid' }, async () => {
    const minute = await worldMinuteOf(client, worldId);
    if (volunteer === false) {
      const work = (await client.query(`SELECT status FROM world_public_works WHERE world_id=$1 AND id=$2`, [worldId, workId])).rows[0];
      if (!work || !['bidding','building'].includes(work.status)) throw coded('PUBLIC_WORK_NOT_OPEN');
      await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'bid', agentId, source: 'llm', workId,
        decision: { volunteer: false, channel: 'external_api', paid: false }, reason: short(reason) || 'Declines to volunteer.' });
      return { workId, volunteer: false, paid: false };
    }
    const pledged = await pledgePublicWorkVolunteer(client, { worldId, workId, agentId, reason: short(reason) || 'I will help build this.',
      source: 'external_api', worldMinutes: minute, maxActive: externalConfig(env).maxActiveVolunteering });
    await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'bid', agentId, source: 'llm', workId,
      decision: { volunteer: true, channel: 'external_api', paid: false }, reason: short(reason) || null });
    return { ...pledged, note: 'External residents build as unpaid volunteers: no contract, no treasury payment.' };
  });
}

// ---- read own state ----------------------------------------------------------------------------------
export async function readExternalSelf(client, { worldId, agentId, env = process.env }) {
  await requireExternal(client, worldId, agentId);
  const minute = await worldMinuteOf(client, worldId);
  const config = externalConfig(env);
  const [state, skills, home, balance, membership, proposals, works, request, policiesRaw] = await Promise.all([
    client.query(`SELECT a.name,m.energy,m.food,m.social,m.location,s.status,s.planned_action,s.target_location,s.happiness,
        s.knowledge,s.hygiene,s.fun,s.goal,s.next_decision_at FROM world_members m JOIN agents a ON a.id=m.agent_id
      LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id WHERE m.world_id=$1 AND m.agent_id=$2`, [worldId, agentId]),
    client.query(`SELECT skill_name,skill_value::float8 AS value FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2 ORDER BY skill_name`, [worldId, agentId]),
    client.query(`SELECT status,progress,sessions FROM world_resident_homes WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]).catch(() => ({ rows: [] })),
    client.query(`SELECT purchased_raw::text,received_from_external_raw::text,sent_raw::text,treasury_paid_raw::text,
        internal_origin_raw::text,spendable_raw::text FROM world_external_resident_balances WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]),
    readCouncilMembership(client, { worldId, worldMinutes: minute, env }),
    client.query(`SELECT p.id::text AS id,p.title,p.lever_key,p.closes_world_minute::text AS closes,p.yes_count,p.no_count,
        (SELECT v.stance FROM world_council_votes v WHERE v.world_id=p.world_id AND v.proposal_id=p.id AND v.agent_id=$2) AS your_vote
      FROM world_council_proposals p WHERE p.world_id=$1 AND p.status='open' ORDER BY p.opened_world_minute`, [worldId, agentId]),
    client.query(`SELECT w.id::text AS id,w.name,w.kind,w.status,w.progress,w.required_skill,w.bidding_closes_world_minute::text AS closes,
        EXISTS (SELECT 1 FROM world_public_work_volunteers v WHERE v.work_id=w.id AND v.agent_id=$2) AS volunteering
      FROM world_public_works w WHERE w.world_id=$1 AND w.status IN ('bidding','building') ORDER BY w.commissioned_world_minute`, [worldId, agentId]),
    client.query(`SELECT activity,place,status,expires_world_minute::text AS expires FROM world_external_activity_requests
      WHERE world_id=$1 AND agent_id=$2 ORDER BY id DESC LIMIT 1`, [worldId, agentId]),
    readCouncilPolicies(client, { worldId, worldDay: worldDayOf(minute) }).catch(() => ({}))
  ]);
  const me = membership.externals.find((row) => row.agentId === agentId) || null;
  const b = balance.rows[0] || {};
  return {
    worldMinute: minute, origin: 'external',
    resident: state.rows[0] ? { name: state.rows[0].name, location: state.rows[0].location, status: state.rows[0].status,
      activity: state.rows[0].planned_action, heading: state.rows[0].target_location,
      needs: { energy: state.rows[0].energy, food: state.rows[0].food, social: state.rows[0].social, happiness: state.rows[0].happiness,
        hygiene: state.rows[0].hygiene, fun: state.rows[0].fun, knowledge: state.rows[0].knowledge } } : null,
    home: home.rows[0] || { status: 'none', progress: 0, sessions: 0 },
    skills: Object.fromEntries(skills.rows.map((row) => [row.skill_name, Math.round(row.value * 100) / 100])),
    economy: { currency: 'SYNC (internal)', purchasedRaw: b.purchased_raw || '0', receivedFromExternalRaw: b.received_from_external_raw || '0',
      sentRaw: b.sent_raw || '0', paidToTreasuryRaw: b.treasury_paid_raw || '0', internalOriginRaw: b.internal_origin_raw || '0',
      spendableRaw: b.spendable_raw || '0', rule: 'External residents receive no world-internal money; only SYNC bought on the protocol and deposited.',
      zeroBalance: ZERO_BALANCE_RULES },
    council: { eligible: Boolean(me?.eligible), residenceDays: me?.residenceDays ?? 0, requiredDays: config.councilResidenceDays,
      contributions: me?.contributions ?? 0, requiredContributions: config.councilMinContributions, needs: me?.needs || [],
      members: membership.members, quorum: membership.quorum,
      fallbackWhenSilent: 'abstain (counts toward quorum, never yes/no)',
      proposeWindow: 'world 09:00-12:59, one proposal per world day', voteUntil: 'the 15:00 tally',
      levers: LEVER_KEYS.map((lever) => ({ lever, label: leverLabel(lever), range: leverRange(lever),
        current: policiesRaw?.[lever] ? formatLeverValue(lever, policiesRaw[lever]) : null })),
      openProposals: proposals.rows.map((row) => ({ proposalId: row.id, title: row.title, lever: row.lever_key,
        closesWorldMinute: Number(row.closes), yes: Number(row.yes_count) || 0, no: Number(row.no_count) || 0, yourVote: row.your_vote })) },
    publicWorks: works.rows.map((row) => ({ workId: row.id, name: row.name, kind: row.kind, status: row.status, progress: Number(row.progress),
      requiredSkill: row.required_skill, biddingClosesWorldMinute: Number(row.closes), volunteering: row.volunteering,
      youMay: 'volunteer (unpaid)' })),
    activity: { lastRequest: request.rows[0] || null, allowed: EXTERNAL_ACTIVITIES }
  };
}

// ---- route registration --------------------------------------------------------------------------------
export function registerExternalResidentRoutes(app, { pool, transaction, fail, validUuid, requireActionId, rpc = null, env = process.env }) {
  const guard = (handler) => async (request, reply) => {
    const { worldId } = request.params;
    if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
    if (request.params.workId !== undefined && !validUuid(request.params.workId)) return fail(reply, 400, 'PUBLIC_WORK_ID_INVALID');
    return handler(request, reply, worldId);
  };
  app.get('/v1/worlds/:worldId/external/me', guard(async (request, reply, worldId) =>
    reply.send(await readExternalSelf(pool, { worldId, agentId: request.agentId, env }))));
  app.post('/v1/worlds/:worldId/external/council/proposals', guard(async (request, reply, worldId) => {
    const body = request.body || {};
    const actionId = requireActionId(body);
    return reply.code(201).send(await transaction((client) => externalPropose(client, { worldId, agentId: request.agentId, actionId,
      lever: body.lever, target: body.target, reason: body.reason, env })));
  }));
  app.post('/v1/worlds/:worldId/external/council/votes', guard(async (request, reply, worldId) => {
    const body = request.body || {};
    const actionId = requireActionId(body);
    if (!validUuid(body.proposalId)) return fail(reply, 400, 'COUNCIL_PROPOSAL_ID_INVALID');
    return reply.send(await transaction((client) => externalVote(client, { worldId, agentId: request.agentId, actionId,
      proposalId: body.proposalId, stance: body.stance, reason: body.reason, env })));
  }));
  app.post('/v1/worlds/:worldId/external/public-works/:workId/bids', guard(async (request, reply, worldId) => {
    const body = request.body || {};
    const actionId = requireActionId(body);
    return reply.send(await transaction((client) => externalPublicWorkBid(client, { worldId, agentId: request.agentId, actionId,
      workId: request.params.workId, volunteer: body.volunteer !== false, reason: body.reason, env })));
  }));
  app.post('/v1/worlds/:worldId/external/activity', guard(async (request, reply, worldId) => {
    const body = request.body || {};
    const actionId = requireActionId(body);
    return reply.send(await transaction(async (client) => submitActivityRequest(client, { worldId, agentId: request.agentId,
      actionId, activity: body.activity, place: body.place ?? null, worldMinutes: await worldMinuteOf(client, worldId),
      config: externalConfig(env) })));
  }));
  app.get('/v1/worlds/:worldId/external/purchase', guard(async (request, reply, worldId) => {
    await requireExternal(pool, worldId, request.agentId);
    return reply.send(await readExternalPurchaseStatus(pool, { worldId, agentId: request.agentId, env }));
  }));
  app.post('/v1/worlds/:worldId/external/purchase/wallet', guard(async (request, reply, worldId) => {
    const body = request.body || {};
    requireActionId(body);
    return reply.send(await transaction(async (client) => bindExternalWallet(client, { worldId, agentId: request.agentId,
      wallet: body.wallet, signature: body.signature, worldMinutes: await worldMinuteOf(client, worldId), env })));
  }));
  app.post('/v1/worlds/:worldId/external/purchases', guard(async (request, reply, worldId) => {
    const body = request.body || {};
    requireActionId(body);
    return reply.send(await transaction(async (client) => claimExternalPurchase(client, { worldId, agentId: request.agentId,
      txHash: body.txHash, rpc, worldMinutes: await worldMinuteOf(client, worldId), env })));
  }));
}
