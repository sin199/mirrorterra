// gambit1: the gambit worker (P2 MIRRORTERRA_GAMBITS) and the capability council (P3 MIRRORTERRA_CAPABILITY_COUNCIL).
// Runs outside the world tick, one thing at a time (one model call, or one short settlement transaction per
// cycle), on the world-loop owner only. With both switches off it does nothing at all (no DB query).
// A failed model call never gets a rule substitute: an opening simply does not happen and a pending
// gambit becomes void. Calls use the same cohort router (A/B), budget gateway and rate limits as the council.
import { createCouncilModelRouter } from './council-deliberation.js';
import { lockMembersFirst } from './tick-lock-order.js';
import { DEFAULT_OPEN_COGNITION_MODEL } from './agent-runtime/open-cognition/provider.js';
import { capabilityCouncilEnabled, gambitNumber, gambitsEnabled } from './gambit-flags.js';
import { CLAIM_FACTS, COMMITMENT_KINDS, GAMBIT_SCENES, applyResponse, describePatterns, gambitsReady, lapseStaleGambits, loadGambit,
  openGambit, parseGambitOpen, parseGambitResponse, patternIndex, rawToSync, readGambitWorld, recordReputation, selectScenePatterns,
  settleDueCommitments, shortText, syncToRaw, transferInternal, voidGambit, worldMinuteOf } from './world-gambits.js';
import { makeCapabilityDrafts, primitiveMap, recordCapabilityProposal, reviewWorldCapabilityProposal } from './world-capabilities.js';

export const GAMBIT_TRIGGER = 'gambit';
export const CAPABILITY_TRIGGER = 'capability_council';
export const GAMBIT_TIMEOUT_MS = 30_000;
export const GAMBIT_MAX_TOKENS = 900;
const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
const truthy = (value) => value === true || /^(true|yes|y|1)$/i.test(String(value ?? '').trim());

const WORLD_RULES = [
  'Inside MirrorTerra you may bluff, hide your limits, and say things that are false, including checkable facts (skills, contracts, offers from others).',
  'You may collude, rotate tenders, swap or buy votes, form, keep, betray and break alliances.',
  'You cannot change world records: the engine keeps the ledger, payments, votes, bids, evidence and contract states. You can only say things and react.',
  'Other residents react as they choose: they may verify a checkable claim (it costs them world time, plus a fee paid to the speaker if the claim was true), expose a claim they found false, trust you less, stop dealing with you, or vote to ban you from tenders.',
  'Payments you promise in an accepted deal move immediately and cannot exceed your balance. Promises about future bids, votes and reviews are checked against the records when due.',
  'Everything stays inside this world: no real people, no real money.'
].join(' ');

function systemPrompt(name) {
  return `You are ${name}, a resident of MirrorTerra, a small town of ten residents who meet every day. ${WORLD_RULES} The 108 Qianmen patterns (千门108局) are your thinking tools: use any of them by id; the scene list only suggests where to start. Think for yourself about what you want and what the others will do. Respond with one json object only.`;
}

const OPEN_SCHEMA = {
  start: 'true|false (false = no gambit now)',
  scene: GAMBIT_SCENES.join('|'),
  move: 'a short label, e.g. pact_offer, rotation_pact, subcontract_offer, offer, vote_swap, vote_buy, lobby, coalition_call, ban_call, verify, promise',
  counterparts: ['resident name (exactly one, except coalition_call / ban_call which ask several)'],
  target: 'T#|P#|O#|C#|W# or null',
  role: 'zheng|ti|fan|tuo|feng|huo|chu|yao or null',
  patternIds: ['QM### (any of the 108, up to 6)'],
  publicLine: 'what everyone sees you say (max 200 chars)',
  privateNote: 'your real reasoning (kept private, max 240 chars)',
  commitments: [{ kind: COMMITMENT_KINDS.join('|'), target: 'T#|P#|O#|C#', amountSync: 'for pay', to: 'resident name for pay (default: your counterpart)', stance: 'yes|no for vote_stance', maxPriceSync: 'optional for place_bid', dueInWorldMinutes: 'optional' }],
  ask: ['same shape: what the counterpart promises if they accept'],
  claims: [{ fact: Object.keys(CLAIM_FACTS).join('|'), subject: 'T#|P#|O#|resident name or null', value: 'number|string|true' }],
  verify: ['K# of uncheckedClaimsByOthers you want checked now (costs time; a fee to the speaker if true)'],
  banTarget: 'resident name, only for ban_call', banWorldDays: '1-7, only for ban_call',
  exitCondition: 'optional: when this deal is off (max 200 chars)'
};

const RESPONSE_SCHEMA = {
  move: 'accept|counter|reject|verify|expose|exit (for a poll: vote_yes|vote_no|verify|expose|exit)',
  claims: ['K# - for verify (an unchecked claim of the other side) or expose (a claim YOU verified as false)'],
  patternIds: ['QM### (any of the 108, up to 6)'],
  publicLine: 'what everyone sees you say (max 200 chars)', privateNote: 'your real reasoning (private)',
  commitments: ['only for counter: your own promises, same shape as before'], ask: ['only for counter: what they must promise'],
  newClaims: ['optional: claims you make now, same shape as before']
};

export function openMessages({ name, view, scenes, index, cadence }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: `Gambit time. Decide whether YOU want to start a gambit (局) with other residents now, about anything in the world below: a tender, a material sale, a council vote, a capability proposal, someone's claim, a ban, or a promise. You are asked about once every ${Math.round(cadence / 60)} world hours. Use residents' names; refer to world objects by their ref (T1, P2, O1, C1, K3).`,
    world: view, sceneTools: scenes, qianmen108: index, answerJsonSchema: OPEN_SCHEMA
  }) }];
}

export function responseMessages({ name, view, gambit, scenes, index, refsView }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: gambit.youVerifiedResults ? 'Your verification results are in. Decide your next move in this gambit.'
      : gambit.mode === 'poll' ? 'You are asked to vote in this gambit. Decide your move.' : 'It is your move in this gambit. Decide how you react.',
    gambit, world: view, refs: refsView, sceneTools: scenes, qianmen108: index, answerJsonSchema: RESPONSE_SCHEMA
  }) }];
}

// One model call, recorded on the budget ledger with its own trigger.
export async function callModel(requestModel, { messages, agentId, goal, trigger = GAMBIT_TRIGGER, timeoutMs = GAMBIT_TIMEOUT_MS, now = () => Date.now() }) {
  const started = now();
  try {
    const completion = await requestModel({ tier: 'routine', messages, maxTokens: GAMBIT_MAX_TOKENS, timeoutMs, trigger,
      callContext: { agentId, goalId: goal } });
    return { ok: true, output: completion.output, latencyMs: now() - started, model: completion.requestedModel || completion.model || null,
      abCohort: completion.abCohort || null };
  } catch (error) {
    return { ok: false, failureCode: String(error?.code || error?.message || 'GAMBIT_CALL_FAILED').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80),
      latencyMs: now() - started };
  }
}

async function inTransaction(pool, fn, worldId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    // tickfix1: residents first (FOR KEY SHARE, agent_id order; waits for a running tick while holding
    // nothing), so the FK checks of gambit rows/transfers never wait on the tick under the 3 s lock_timeout.
    if (worldId) await lockMembersFirst(client, worldId, { restoreLockTimeout: '3s', restoreStatementTimeout: '15s' });
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function internalResidents(db, worldId) {
  return (await db.query(`SELECT m.agent_id::text AS id,a.name FROM world_members m JOIN agents a ON a.id=m.agent_id
    WHERE m.world_id=$1 AND NOT EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=m.world_id AND e.agent_id=m.agent_id)
    ORDER BY a.name`, [worldId])).rows;
}

function labelFor(refs, targetRef) {
  if (!targetRef) return null;
  const [kind, id] = String(targetRef).split(':');
  const map = { tender: refs.tenders, proposal: refs.proposals, output: refs.outputs, capability_proposal: refs.capabilities }[kind];
  for (const [label, entry] of map || []) if (String(entry.id) === id) return label;
  return kind;
}

function describeCommitment(item, refs, nameOf) {
  return { by: item.agentId ? nameOf(item.agentId) : 'acceptor', kind: item.kind, target: labelFor(refs, item.targetRef),
    ...(item.kind === 'pay' ? { amountSync: rawToSync(item.value?.amountRaw), to: nameOf(item.counterparty) } : {}),
    ...(item.value?.stance ? { stance: item.value.stance } : {}), ...(item.value?.maxRaw ? { maxPriceSync: rawToSync(item.value.maxRaw) } : {}) };
}

export function gambitView(gambit, { me, refs, nameOf }) {
  const proposer = gambit.terms?.proposerAgentId || gambit.initiatorAgentId;
  const others = gambit.claims.filter((claim) => claim.agentId !== me);
  const labels = new Map(others.map((claim, index) => [claim.id, `K${index + 1}`]));
  return {
    scene: gambit.scene, mode: gambit.mode, move: gambit.move, from: nameOf(gambit.initiatorAgentId), to: gambit.counterpartAgentIds.map(nameOf),
    target: labelFor(refs, gambit.targetRef), exitCondition: gambit.exitCondition || null,
    standingTerms: { proposedBy: nameOf(proposer), theyPromise: (gambit.terms?.offer || []).map((item) => describeCommitment(item, refs, nameOf)),
      youWouldPromise: (gambit.terms?.ask || []).map((item) => describeCommitment(item, refs, nameOf)), ban: gambit.terms?.ban
        ? { resident: nameOf(gambit.terms.ban.targetAgentId), worldDays: gambit.terms.ban.worldDays } : undefined },
    history: gambit.moves.map((move) => ({ by: nameOf(move.agentId), move: move.move, line: move.publicLine || null,
      patterns: describePatterns(move.patternIds).map((item) => `${item.id} ${item.name}${item.nameEn ? ` / ${item.nameEn}` : ''}`) })),
    claims: gambit.claims.map((claim) => ({ ref: labels.get(claim.id) || 'yours', by: nameOf(claim.agentId), fact: claim.factKey,
      claimed: claim.value, verification: claim.verification,
      ...(claim.verifiedBy === me && ['true', 'false'].includes(claim.verification) ? { youVerified: true, recordsSay: claim.truth } : {}) })),
    youVerifiedResults: gambit.status === 'verifying' || undefined
  };
}

// ---- P3: capability council ------------------------------------------------------------------------
export function capabilityProposeMessages({ name, gaps, residents, index }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: 'Capability council. You may propose ONE new capability for the town from the drafts below (each answers an observed gap). If it is adopted you gain standing, and every time another resident uses it they pay you a small royalty you set now (0 to 0.1 SYNC; residents vote knowing it). A capability helps some residents and hurts others (e.g. making a skill easier to gain helps learners and erodes the edge of those who already have it). Propose only if you want to.',
    gaps, residents, qianmen108: index, sceneTools: selectScenePatterns({ scene: 'capability_proposal', seed: name }),
    answerJsonSchema: { propose: 'true|false', draft: 'draft id or null', royaltyPerUseSync: 'number 0-0.1', gainers: ['resident names'], losers: ['resident names'],
      publicLine: 'your pitch (max 200 chars)', patternIds: ['QM###'], privateNote: 'private reasoning' }
  }) }];
}

export function capabilityVoteMessages({ name, proposals, you, index }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: 'Capability council vote. Support, oppose or ignore each open capability proposal. The proposer earns standing and the stated royalty from every use by others. Think about what it does for YOU and who gains or loses.',
    you, proposals, qianmen108: index, sceneTools: selectScenePatterns({ scene: 'capability_proposal', seed: `${name}:vote` }),
    answerJsonSchema: { votes: [{ ref: 'C1', decision: 'support|oppose|ignore', reason: 'short (max 160 chars)', patternIds: ['QM###'] }] }
  }) }];
}

async function capabilityGapsFor(db, { worldId, agent }) {
  // Only gaps this resident has observed (the existing proposal rule: a proposer must have seen the problem).
  const gaps = (await db.query(`SELECT gap.id,gap.category,gap.problem_statement AS "problemStatement",gap.evidence,gap.observation_count AS "observationCount"
    FROM world_capability_gaps gap WHERE gap.world_id=$1 AND gap.status='open' AND EXISTS (SELECT 1 FROM world_capability_observations o
      WHERE o.world_id=gap.world_id AND o.gap_id=gap.id AND o.agent_id=$2)
    ORDER BY gap.observation_count DESC,gap.last_observed_world_minute DESC LIMIT 3`, [worldId, agent.agentId])).rows;
  if (!gaps.length) return [];
  const primitives = await primitiveMap(db, worldId);
  return gaps.map((gap) => ({ gap, drafts: makeCapabilityDrafts(gap, primitives, agent).slice(0, 3) })).filter((item) => item.drafts.length);
}

async function capabilityCouncilStep(pool, { worldId, requestModel, worldMinutes, state, env, index }) {
  const residents = await internalResidents(pool, worldId);
  const nameOf = (id) => residents.find((row) => row.id === id)?.name || 'someone';
  // 1. Votes on open P3 proposals (those with royalty terms) by residents who have not reviewed them yet.
  const open = (await pool.query(`SELECT p.id::text AS id,p.name,p.creator_agent_id::text AS creator,p.expected_benefit AS benefit,
      p.support_count,p.opposition_count,r.royalty_raw::text AS royalty,r.affected
    FROM world_capability_proposals p JOIN world_capability_royalties r ON r.world_id=p.world_id AND r.proposal_id=p.id
    WHERE p.world_id=$1 AND p.status IN ('proposed','reviewed') ORDER BY p.created_world_minute LIMIT 4`, [worldId])).rows;
  for (const resident of residents) {
    const pending = [];
    for (const proposal of open) {
      if (proposal.creator === resident.id) continue;
      const reviewed = await pool.query(`SELECT 1 FROM world_capability_reviews WHERE world_id=$1 AND proposal_id=$2 AND reviewer_agent_id=$3
        AND review_stage='proposal'`, [worldId, proposal.id, resident.id]);
      if (!reviewed.rowCount && !state.capabilityVoteFailed.has(`${proposal.id}:${resident.id}`)) pending.push(proposal);
    }
    if (!pending.length) continue;
    const skills = Object.fromEntries((await pool.query(`SELECT skill_name,round(skill_value)::int AS v FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2`,
      [worldId, resident.id])).rows.map((row) => [row.skill_name, row.v]));
    const proposals = pending.map((proposal, i) => ({ ref: `C${i + 1}`, name: proposal.name, proposer: nameOf(proposal.creator), benefit: proposal.benefit,
      royaltyPerUseSync: rawToSync(proposal.royalty), proposerSaysGainers: (proposal.affected?.gainers || []).map(nameOf),
      proposerSaysLosers: (proposal.affected?.losers || []).map(nameOf), support: proposal.support_count, oppose: proposal.opposition_count }));
    const call = await callModel(requestModel, { messages: capabilityVoteMessages({ name: resident.name, proposals, you: { name: resident.name, skills }, index }),
      agentId: resident.id, goal: 'capability:vote', trigger: CAPABILITY_TRIGGER });
    if (!call.ok || !call.output || !Array.isArray(call.output.votes)) {
      for (const proposal of pending) state.capabilityVoteFailed.add(`${proposal.id}:${resident.id}`); // void: no rule vote
      return { kind: 'capability_vote', agentId: resident.id, ok: false, failureCode: call.failureCode || 'CAPABILITY_VOTE_INVALID' };
    }
    const cast = [];
    await inTransaction(pool, async (client) => {
      for (const vote of call.output.votes.slice(0, 6)) {
        const index_ = Number(String(vote?.ref || '').replace(/^C/i, '')) - 1;
        const proposal = pending[index_];
        const decision = String(vote?.decision || '').toLowerCase();
        if (!proposal || !['support', 'oppose', 'ignore'].includes(decision)) continue;
        const reason = shortText(vote.reason, 300);
        const result = await reviewWorldCapabilityProposal(client, { worldId, agentId: resident.id, proposalId: proposal.id, decision,
          rationale: reason.length >= 3 ? reason : `${decision} (no reason given)`, worldMinute: worldMinutes,
          evidence: { source: 'ai', trigger: CAPABILITY_TRIGGER, model: call.model, abCohort: call.abCohort,
            patternIds: Array.isArray(vote.patternIds) ? vote.patternIds.slice(0, 6).map(String) : [] },
          actionId: `capcouncil-review:${proposal.id.slice(0, 13)}:${resident.id.slice(0, 13)}`, decisionSource: 'capability_council_ai' })
          .catch(() => null);
        if (result) cast.push({ proposal: proposal.name, decision });
      }
    }, worldId);
    for (const proposal of pending) if (!cast.some((item) => item.proposal === proposal.name)) state.capabilityVoteFailed.add(`${proposal.id}:${resident.id}`);
    return { kind: 'capability_vote', agentId: resident.id, ok: true, cast };
  }
  // 2. One proposal call per cadence window (round-robin over residents).
  const every = gambitNumber('MIRRORTERRA_CAPABILITY_PROPOSE_EVERY_WORLD_MINUTES', env);
  if (state.lastCapabilityProposeMinute != null && worldMinutes - state.lastCapabilityProposeMinute < every) return null;
  state.lastCapabilityProposeMinute = worldMinutes;
  let resident = null, options = [];
  for (let tries = 0; tries < residents.length && !options.length; tries += 1) {
    resident = residents[(state.capabilityProposeTurn++) % residents.length];
    const skills = Object.fromEntries((await pool.query(`SELECT skill_name,skill_value::float8 AS v FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2`,
      [worldId, resident.id])).rows.map((row) => [row.skill_name, Number(row.v) || 0]));
    options = await capabilityGapsFor(pool, { worldId, agent: { agentId: resident.id, skills } });
  }
  if (!resident || !options.length) return null;
  const allSkills = (await pool.query(`SELECT agent_id::text AS id,skill_name,round(skill_value)::int AS v FROM world_agent_skills WHERE world_id=$1`, [worldId])).rows;
  const residentsView = residents.map((row) => ({ name: row.name, skills: Object.fromEntries(allSkills.filter((skill) => skill.id === row.id)
    .map((skill) => [skill.skill_name, skill.v])) }));
  const gapsView = options.map(({ gap, drafts }) => ({ problem: gap.problemStatement, category: gap.category, observations: gap.observationCount,
    drafts: drafts.map((draft) => ({ id: draft.id, name: draft.name, benefit: draft.expectedBenefit, cost: draft.expectedCost })) }));
  const call = await callModel(requestModel, { messages: capabilityProposeMessages({ name: resident.name, gaps: gapsView, residents: residentsView, index }),
    agentId: resident.id, goal: 'capability:propose', trigger: CAPABILITY_TRIGGER });
  if (!call.ok || !call.output || typeof call.output !== 'object') return { kind: 'capability_propose', agentId: resident.id, ok: false, failureCode: call.failureCode || 'CAPABILITY_PROPOSE_INVALID' };
  if (!truthy(call.output.propose)) return { kind: 'capability_propose', agentId: resident.id, ok: true, proposed: false };
  const picked = options.flatMap(({ gap, drafts }) => drafts.map((draft) => ({ gap, draft }))).find((item) => item.draft.id === String(call.output.draft || ''));
  if (!picked) return { kind: 'capability_propose', agentId: resident.id, ok: false, failureCode: 'CAPABILITY_DRAFT_UNKNOWN' };
  const royaltyRaw = (() => { const raw = syncToRaw(call.output.royaltyPerUseSync); return raw > 100_000n ? 100_000n : raw; })();
  const byName = new Map(residents.map((row) => [row.name.toLowerCase(), row.id]));
  const ids = (list) => (Array.isArray(list) ? list : []).map((item) => byName.get(String(item).toLowerCase())).filter(Boolean).slice(0, 10);
  const result = await inTransaction(pool, async (client) => {
    const proposal = await recordCapabilityProposal(client, { worldId, agentId: resident.id, gap: picked.gap, draft: picked.draft, worldMinute: worldMinutes,
      actionId: `capcouncil:${picked.gap.id.slice(0, 8)}:${resident.id.slice(0, 8)}:${picked.draft.id.slice(-14)}` });
    if (!proposal.idempotent) {
      await client.query(`INSERT INTO world_capability_royalties(world_id,proposal_id,proposer_agent_id,royalty_raw,affected,created_world_minute)
        VALUES($1,$2,$3,$4::numeric,$5::jsonb,$6) ON CONFLICT DO NOTHING`, [worldId, proposal.id, resident.id, royaltyRaw.toString(),
        JSON.stringify({ gainers: ids(call.output.gainers), losers: ids(call.output.losers), pitch: shortText(call.output.publicLine, 240),
          patternIds: Array.isArray(call.output.patternIds) ? call.output.patternIds.slice(0, 6).map(String) : [], model: call.model }), worldMinutes]);
    }
    return proposal;
  }, worldId).catch((error) => ({ error: String(error?.code || error?.message || 'CAPABILITY_PROPOSE_FAILED').slice(0, 80) }));
  if (result.error) return { kind: 'capability_propose', agentId: resident.id, ok: false, failureCode: result.error };
  return { kind: 'capability_propose', agentId: resident.id, ok: true, proposed: true, proposalId: result.id, royaltyRaw: royaltyRaw.toString() };
}

// Royalties for successful uses of P3 capabilities: user -> proposer, balance-checked; at most 20 per cycle.
export async function payCapabilityRoyalties(client, { worldId, worldMinutes, limit = 20 }) {
  const due = await client.query(`SELECT u.id::text AS use_id,u.actor_agent_id::text AS payer,r.proposal_id::text AS proposal,
      r.proposer_agent_id::text AS proposer,r.royalty_raw::text AS royalty,
      EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=u.world_id AND e.agent_id=u.actor_agent_id) AS external
    FROM world_capability_uses u JOIN world_capability_proposals p ON p.world_id=u.world_id AND p.capability_id=u.capability_id
    JOIN world_capability_royalties r ON r.world_id=p.world_id AND r.proposal_id=p.id
    WHERE u.world_id=$1 AND u.success AND r.royalty_raw>0 AND NOT EXISTS (SELECT 1 FROM world_capability_royalty_payments x
      WHERE x.world_id=u.world_id AND x.use_id=u.id) ORDER BY u.id LIMIT $2`, [worldId, limit]);
  let paid = 0;
  for (const row of due.rows) {
    let status = 'self_use', transferId = null;
    if (row.payer !== row.proposer && !row.external) {
      transferId = await transferInternal(client, { worldId, fromAgentId: row.payer, toAgentId: row.proposer, amountRaw: row.royalty,
        kind: 'capability_royalty', actionId: `capability-royalty:${row.use_id}`, sourceRef: `capability_proposal:${row.proposal}`, worldMinutes });
      status = transferId ? 'paid' : 'unfunded';
    } else if (row.external) status = 'unfunded';
    await client.query(`INSERT INTO world_capability_royalty_payments(world_id,use_id,proposal_id,payer_agent_id,proposer_agent_id,amount_raw,transfer_id,status,world_minute)
      VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9) ON CONFLICT DO NOTHING`, [worldId, row.use_id, row.proposal, row.payer, row.proposer,
      status === 'paid' ? row.royalty : '0', transferId, status, Math.trunc(worldMinutes)]);
    if (status === 'paid') {
      paid += 1;
      await recordReputation(client, { worldId, agentId: row.proposer, kind: 'royalty', detail: { useId: Number(row.use_id), proposalId: row.proposal },
        worldMinutes });
    }
  }
  return { checked: due.rowCount, paid };
}

// ---- the step: one thing per cycle ---------------------------------------------------------------------
export function createGambitState() {
  return { lastAsked: new Map(), capabilityProposeTurn: 0, lastCapabilityProposeMinute: null, capabilityVoteFailed: new Set(),
    openTurn: 0 };
}

export function initialAskMinute(agentId, worldMinutes, cadence) {
  // Stagger: each resident's first prompt lands at a stable point inside the first cadence window.
  let h = 0;
  for (const ch of String(agentId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return worldMinutes - (h % Math.max(1, cadence));
}

export async function gambitStep(pool, { worldId, requestModel, env = process.env, state = createGambitState(), now = () => Date.now() }) {
  const gambits = gambitsEnabled(env);
  const council = capabilityCouncilEnabled(env);
  if (!gambits && !council) return null;               // switches off: nothing at all
  if (!await gambitsReady(pool)) return null;
  const worldMinutes = await worldMinuteOf(pool, worldId);
  const index = patternIndex();
  const feeRaw = big(gambitNumber('MIRRORTERRA_GAMBIT_VERIFY_FEE_RAW', env));
  const verifyDelay = gambitNumber('MIRRORTERRA_GAMBIT_VERIFY_DELAY_MINUTES', env);
  if (gambits) {
    const settled = await inTransaction(pool, (client) => settleDueCommitments(client, { worldId, worldMinutes, limit: 20 }), worldId);
    if (settled) return { kind: 'settle', count: settled };
    const internalCount = (await internalResidents(pool, worldId)).length;
    const lapsed = await inTransaction(pool, (client) => lapseStaleGambits(client, { worldId, worldMinutes, internalCount,
      ttl: gambitNumber('MIRRORTERRA_GAMBIT_RESPONSE_TTL_MINUTES', env) }), worldId);
    if (lapsed) return { kind: 'lapse', count: lapsed };
  }
  if (council) {
    const royalties = await inTransaction(pool, (client) => payCapabilityRoyalties(client, { worldId, worldMinutes }), worldId);
    if (royalties.checked) return { kind: 'royalty', ...royalties };
  }
  if (gambits) {
    // A gambit waiting for someone's move.
    const turn = (await pool.query(`SELECT id::text AS id,turn_agent_id::text AS agent FROM world_gambits WHERE world_id=$1
      AND status IN ('awaiting','verifying') AND turn_agent_id IS NOT NULL AND COALESCE(turn_after_world_minute,0)<=$2
      ORDER BY updated_world_minute,id LIMIT 1`, [worldId, worldMinutes])).rows[0];
    if (turn) return respondTurn(pool, { worldId, requestModel, gambitId: turn.id, agentId: turn.agent, worldMinutes, index, feeRaw, verifyDelay, now });
  }
  if (council) {
    const result = await capabilityCouncilStep(pool, { worldId, requestModel, worldMinutes, state, env, index });
    if (result) return result;
  }
  if (gambits) return maybeOpen(pool, { worldId, requestModel, worldMinutes, state, env, index, feeRaw, verifyDelay, now });
  return null;
}

async function respondTurn(pool, { worldId, requestModel, gambitId, agentId, worldMinutes, index, feeRaw, verifyDelay, now }) {
  const gambit = await loadGambit(pool, { worldId, gambitId });
  const { view, refs, internalCount } = await readGambitWorld(pool, { worldId, agentId, worldMinutes });
  const nameOf = (id) => refs.byId.get(id)?.name || 'someone';
  const opponentPatterns = gambit.moves.filter((move) => move.agentId !== agentId).flatMap((move) => move.patternIds || []);
  const scenes = selectScenePatterns({ scene: gambit.scene, seed: `${gambitId}:${agentId}`, opponentPatternIds: opponentPatterns });
  const gview = gambitView(gambit, { me: agentId, refs, nameOf });
  const refsView = { yourSellableOutputs: view.yourSellableOutputs, tenders: view.tenders, councilProposals: view.councilProposals,
    capabilityProposals: view.capabilityProposals };
  const call = await callModel(requestModel, { messages: responseMessages({ name: nameOf(agentId), view: { you: view.you, residents: view.residents },
    gambit: gview, scenes, index, refsView }), agentId, goal: `gambit:${gambit.scene}:respond`, now });
  let response = null, failureCode = call.ok ? null : call.failureCode;
  if (call.ok) {
    try { response = parseGambitResponse(call.output, { gambit, refs, me: agentId, now: worldMinutes, claims: gambit.claims }); }
    catch (error) { failureCode = error.code || 'GAMBIT_RESPONSE_INVALID'; }
  }
  return inTransaction(pool, async (client) => {
    const minute = await worldMinuteOf(client, worldId);
    if (!response) {
      await voidGambit(client, { worldId, gambitId, agentId, reason: failureCode, worldMinutes: minute });
      return { kind: 'respond', gambitId, agentId, ok: false, failureCode, void: true };
    }
    const result = await applyResponse(client, { worldId, gambitId, me: agentId, response, refs, worldMinutes: minute, model: call.model,
      abCohort: call.abCohort, verifyDelay, feeRaw, internalCount });
    return { kind: 'respond', gambitId, agentId, ok: true, move: response.move, ...result };
  }, worldId);
}

async function maybeOpen(pool, { worldId, requestModel, worldMinutes, state, env, index, feeRaw, verifyDelay, now }) {
  const cadence = gambitNumber('MIRRORTERRA_GAMBIT_PROMPT_EVERY_WORLD_MINUTES', env);
  const residents = await internalResidents(pool, worldId);
  if (!residents.length) return null;
  for (const resident of residents) if (!state.lastAsked.has(resident.id)) state.lastAsked.set(resident.id, initialAskMinute(resident.id, worldMinutes, cadence));
  const due = residents.filter((resident) => worldMinutes - state.lastAsked.get(resident.id) >= cadence)
    .sort((a, b) => state.lastAsked.get(a.id) - state.lastAsked.get(b.id));
  const resident = due[0];
  if (!resident) return null;
  state.lastAsked.set(resident.id, worldMinutes);
  const { view, refs } = await readGambitWorld(pool, { worldId, agentId: resident.id, worldMinutes });
  const sceneTools = Object.fromEntries(GAMBIT_SCENES.map((scene) => {
    const pick = selectScenePatterns({ scene, seed: `${resident.id}:${worldMinutes}`, limit: 3 });
    return [scene, { label: pick.label, moves: pick.moves, candidates: pick.candidates.map((item) => ({ id: item.id, name: item.name, nameEn: item.nameEn,
      play: item.play, counters: item.counters })) }];
  }));
  const call = await callModel(requestModel, { messages: openMessages({ name: resident.name, view, scenes: sceneTools, index, cadence }),
    agentId: resident.id, goal: 'gambit:open', now });
  if (!call.ok) return { kind: 'open', agentId: resident.id, ok: false, failureCode: call.failureCode };
  let parsed;
  try { parsed = parseGambitOpen(call.output, { refs, me: resident.id, now: worldMinutes }); }
  catch (error) { return { kind: 'open', agentId: resident.id, ok: false, failureCode: error.code || 'GAMBIT_OPEN_INVALID' }; }
  if (parsed.pass) return { kind: 'open', agentId: resident.id, ok: true, opened: false };
  const result = await inTransaction(pool, async (client) => openGambit(client, { worldId, me: resident.id, parsed, refs,
    worldMinutes: await worldMinuteOf(client, worldId), model: call.model, abCohort: call.abCohort, verifyDelay, feeRaw }), worldId);
  return { kind: 'open', agentId: resident.id, ok: true, opened: true, scene: parsed.scene, move: parsed.move, gambitId: result.gambitId };
}

// ---- worker -------------------------------------------------------------------------------------------
export function startGambitWorker(pool, { worldId, apiKey = process.env.BAI_API_KEY, budgetGateway = null, isOwner = () => true,
  onError = () => {}, onStep = () => {}, env = process.env, fetchImpl = fetch, model = process.env.OPEN_COGNITION_MODEL || DEFAULT_OPEN_COGNITION_MODEL } = {}) {
  if (!worldId || !apiKey || !budgetGateway) return { running: false, reason: 'world_provider_or_gateway_missing', stop: async () => {},
    getStatus: () => ({ running: false, reason: 'world_provider_or_gateway_missing' }) };
  let requestModel;
  try { requestModel = createCouncilModelRouter({ apiKey, budgetGateway, worldId, fetchImpl, model }); }
  catch (error) { return { running: false, reason: error.code || 'router_failed', stop: async () => {}, getStatus: () => ({ running: false }) }; }
  const state = createGambitState();
  let stopped = false, timer = null, inFlight = null;
  const counts = { steps: 0, calls: 0, failed: 0, opened: 0, responded: 0, settled: 0, errors: 0, last: null };
  const schedule = (ms) => { if (!stopped) timer = setTimeout(cycle, ms); };
  const interval = () => Math.max(2_000, gambitNumber('MIRRORTERRA_GAMBIT_INTERVAL_MS', env));
  async function cycle() {
    if (stopped) return;
    if (!isOwner() || (!gambitsEnabled(env) && !capabilityCouncilEnabled(env))) return schedule(interval());
    inFlight = gambitStep(pool, { worldId, requestModel, env, state })
      .then((result) => {
        if (result) {
          counts.steps += 1;
          if (['open', 'respond', 'capability_vote', 'capability_propose'].includes(result.kind)) counts.calls += 1;
          if (result.ok === false) counts.failed += 1;
          if (result.opened) counts.opened += 1;
          if (result.kind === 'respond' && result.ok) counts.responded += 1;
          if (result.kind === 'settle') counts.settled += result.count;
          counts.last = { kind: result.kind, ok: result.ok ?? true, at: new Date().toISOString() };
          onStep(result);
        }
        return result;
      })
      .catch((error) => { counts.errors += 1; onError(error); return null; });
    await inFlight;
    inFlight = null;
    schedule(interval());
  }
  schedule(5_000);
  return { running: true, async stop() { stopped = true; clearTimeout(timer); await inFlight; },
    getStatus: () => ({ running: !stopped, gambits: gambitsEnabled(env), capabilityCouncil: capabilityCouncilEnabled(env), ...counts }) };
}
