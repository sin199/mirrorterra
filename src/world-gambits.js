// gambit1: resident gambits ("局"), the engine side.
//
// What residents control: what they SAY (public lines, claims, offers, promises) and how they REACT
// (accept, counter, reject, verify, expose, exit, vote). They may bluff and may misstate checkable facts.
// What only the engine controls (world physics): the ledger, transfers and their balance checks, claim
// verification from world records, commitment status from world records, reservations and bans as facts.
// There are no engine penalties: a lie, a broken promise or an exposure is recorded as a public fact, and
// any change in trust is the reaction of the resident it happened to. SYNC only moves between residents
// through arc_sync_internal_transfers (balance-checked, append-only); nothing here mints SYNC, touches the
// treasury, the reward pool, the purchase entry or the chain. External residents are never asked by our
// model and are not counterparts (their own AI has no gambit interface yet).
import { validPatternIds, describePatterns, selectScenePatterns, patternIndex, SCENES } from './agent-runtime/qianmen-scenes.js';

export const GAMBIT_SCENES = SCENES;
export const RESPONSE_MOVES = Object.freeze(['accept', 'counter', 'reject', 'verify', 'expose', 'exit']);
export const POLL_MOVES = Object.freeze(['vote_yes', 'vote_no']);
export const COMMITMENT_KINDS = Object.freeze(['abstain_bid', 'place_bid', 'vote_stance', 'deliver_output', 'pay',
  'support_capability', 'oppose_capability']);
export const CLAIM_FACTS = Object.freeze({
  build_skill: { verifiable: true, about: 'your construction skill score (0-100)' },
  active_contracts: { verifiable: true, about: 'how many public-works contracts you hold now' },
  wins_count: { verifiable: true, about: 'how many tenders you have won' },
  output_quality: { verifiable: true, about: 'quality (1-10) of one of your skill outputs (subject O#)' },
  balance: { verifiable: true, about: 'your internal SYNC balance' },
  third_party_offer: { verifiable: true, about: 'another resident offered you a price (subject = that resident, value = SYNC)' },
  bid_placed: { verifiable: true, about: 'you placed a bid on a tender (subject T#)' },
  vote_cast: { verifiable: true, about: 'you voted yes/no on a proposal (subject P#)' },
  private: { verifiable: false, about: 'your own limit, intention or preference (cannot be checked)' }
});
export const MAX_BILATERAL_MOVES = 8;   // compute pacing for one gambit; a lapsed gambit can simply be reopened
export const RAW_PER_SYNC = 1_000_000n;
const ROLES = new Set(['zheng', 'ti', 'fan', 'tuo', 'feng', 'huo', 'chu', 'yao']);
// The observer's own reaction toward the subject (recorded, shown back to the observer; no engine rule reads it).
export const TRUST_REACTION = Object.freeze({ kept: 4, broken: -10, released: 0, exposed: -25, claim_true: 2,
  claim_false: -6, exit: 0 });

const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
export const shortText = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function invalid(code) { return Object.assign(new Error(code), { code }); }
const truthy = (value) => value === true || /^(true|yes|y|1)$/i.test(String(value ?? '').trim());
export function syncToRaw(value) {
  const number = Number(typeof value === 'string' ? value.replace(/sync/i, '').trim() : value);
  if (!Number.isFinite(number) || number <= 0) return 0n;
  return BigInt(Math.round(number * 1e4)) * 100n; // 0.0001 SYNC precision
}
export const rawToSync = (raw) => Math.round(Number(big(raw)) / 1e4) / 100;

// ---- pure parsing -------------------------------------------------------------------------------
// `refs` maps the short labels the resident saw to world objects:
//   residents: Map(name -> { agentId, external }), tenders/proposals/outputs/capabilities/contracts/claims:
//   Map(label -> object). `me` is the deciding resident's agentId.
function resolveResident(refs, value) {
  const key = shortText(value, 60);
  if (!key) return null;
  const direct = refs.residents.get(key);
  if (direct) return direct;
  for (const [name, entry] of refs.residents) if (name.toLowerCase() === key.toLowerCase()) return entry;
  return null;
}

function resolveTarget(refs, value) {
  const key = shortText(value, 20).toUpperCase();
  if (!key) return null;
  const kind = { T: 'tenders', P: 'proposals', O: 'outputs', C: 'capabilities', W: 'contracts' }[key[0]];
  const entry = kind && refs[kind]?.get(key);
  return entry ? { label: key, kind, ...entry } : null;
}

function dueFor(target, refs, dueInWorldMinutes, now) {
  if (target?.closesWorldMinute) return Number(target.closesWorldMinute);
  const minutes = Math.round(Number(dueInWorldMinutes));
  return now + (Number.isFinite(minutes) && minutes >= 30 && minutes <= 4_320 ? minutes : 720);
}

// One promise, by `agentId`, to `counterparty`. Returns a normalized commitment or throws.
export function parseCommitment(item, { refs, agentId, counterparty, now, scene }) {
  if (!item || typeof item !== 'object') throw invalid('GAMBIT_COMMITMENT_INVALID');
  const kind = shortText(item.kind, 30).toLowerCase();
  if (!COMMITMENT_KINDS.includes(kind)) throw invalid('GAMBIT_COMMITMENT_KIND_UNKNOWN');
  const target = item.target ? resolveTarget(refs, item.target) : null;
  const self = refs.byId.get(agentId);
  const other = counterparty ? refs.byId.get(counterparty) : null;
  if (kind === 'pay') {
    const amountRaw = syncToRaw(item.amountSync ?? item.amount ?? item.value);
    if (amountRaw <= 0n) throw invalid('GAMBIT_PAY_AMOUNT_INVALID');
    const to = item.to ? resolveResident(refs, item.to)?.agentId : counterparty;
    if (!to || to === agentId) throw invalid('GAMBIT_PAY_RECIPIENT_INVALID');
    // World physics: external residents hold no internal SYNC and can never receive it.
    if (self?.external || refs.byId.get(to)?.external) throw invalid('GAMBIT_EXTERNAL_NO_SYNC');
    const transferKind = scene === 'material_trade' ? 'material_sale' : scene === 'tender_bid' ? 'subcontract' : 'gambit_settlement';
    return { kind, agentId, counterparty: to, targetRef: target ? `${target.kind}:${target.id}` : null,
      value: { amountRaw: amountRaw.toString(), transferKind }, dueWorldMinute: now };
  }
  if (kind === 'deliver_output') {
    if (!target || target.kind !== 'outputs') throw invalid('GAMBIT_OUTPUT_TARGET_INVALID');
    if (target.producerId !== agentId) throw invalid('GAMBIT_OUTPUT_NOT_YOURS');
    if (!other || other.external) throw invalid('GAMBIT_OUTPUT_BUYER_INVALID');
    return { kind, agentId, counterparty, targetRef: `output:${target.id}`, value: { outputId: String(target.id) }, dueWorldMinute: now };
  }
  if (kind === 'abstain_bid' || kind === 'place_bid') {
    if (!target || target.kind !== 'tenders') throw invalid('GAMBIT_TENDER_TARGET_INVALID');
    const maxRaw = kind === 'place_bid' && item.maxPriceSync != null ? syncToRaw(item.maxPriceSync) : null;
    return { kind, agentId, counterparty, targetRef: `tender:${target.id}`, value: maxRaw ? { maxRaw: maxRaw.toString() } : {},
      dueWorldMinute: dueFor(target, refs, item.dueInWorldMinutes, now) };
  }
  if (kind === 'vote_stance') {
    if (!target || target.kind !== 'proposals') throw invalid('GAMBIT_PROPOSAL_TARGET_INVALID');
    const stance = shortText(item.stance ?? item.value, 5).toLowerCase();
    if (!['yes', 'no'].includes(stance)) throw invalid('GAMBIT_STANCE_INVALID');
    return { kind, agentId, counterparty, targetRef: `proposal:${target.id}`, value: { stance },
      dueWorldMinute: dueFor(target, refs, item.dueInWorldMinutes, now) };
  }
  // support_capability / oppose_capability
  if (!target || target.kind !== 'capabilities') throw invalid('GAMBIT_CAPABILITY_TARGET_INVALID');
  return { kind, agentId, counterparty, targetRef: `capability_proposal:${target.id}`, value: {},
    dueWorldMinute: dueFor(null, refs, item.dueInWorldMinutes ?? 1_440, now) };
}

export function parseClaim(item, { refs, agentId }) {
  if (!item || typeof item !== 'object') throw invalid('GAMBIT_CLAIM_INVALID');
  const fact = shortText(item.fact, 30).toLowerCase();
  if (!(fact in CLAIM_FACTS)) throw invalid('GAMBIT_CLAIM_FACT_UNKNOWN');
  let subjectRef = null;
  if (item.subject != null && item.subject !== '') {
    const target = resolveTarget(refs, item.subject);
    const resident = target ? null : resolveResident(refs, item.subject);
    if (target) subjectRef = `${target.kind}:${target.id}`;
    else if (resident) subjectRef = `resident:${resident.agentId}`;
  }
  let value = item.value;
  if (typeof value === 'string') value = shortText(value, 120);
  if (value === undefined || value === null || (typeof value === 'object' && Array.isArray(value))) throw invalid('GAMBIT_CLAIM_VALUE_MISSING');
  if (typeof value === 'object') {
    value = Object.fromEntries(Object.entries(value).slice(0, 8).filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
      .map(([key, item]) => [shortText(key, 30), typeof item === 'string' ? shortText(item, 80) : item]));
  }
  return { agentId, factKey: fact, subjectRef, value, verifiable: CLAIM_FACTS[fact].verifiable };
}

function parseList(value, limit) { return Array.isArray(value) ? value.slice(0, limit) : []; }

// A resident's answer to "do you want to start a gambit?" -> { pass } or a normalized gambit. Malformed
// parts make the whole answer invalid (the call is then wasted, no gambit).
export function parseGambitOpen(output, { refs, me, now, scenes = GAMBIT_SCENES }) {
  if (!output || typeof output !== 'object') throw invalid('GAMBIT_OUTPUT_INVALID');
  if (!truthy(output.start ?? output.open ?? output.gambit)) return { pass: true, reason: shortText(output.reason || output.thinking, 200) };
  const scene = shortText(output.scene, 30).toLowerCase();
  if (!scenes.includes(scene)) throw invalid('GAMBIT_SCENE_INVALID');
  const counterparts = [];
  for (const name of parseList(output.counterparts ?? (output.counterpart ? [output.counterpart] : []), 12)) {
    const resident = resolveResident(refs, name);
    if (!resident || resident.agentId === me || resident.external) throw invalid('GAMBIT_COUNTERPART_INVALID');
    if (!counterparts.includes(resident.agentId)) counterparts.push(resident.agentId);
  }
  if (!counterparts.length) throw invalid('GAMBIT_COUNTERPART_MISSING');
  const move = shortText(output.move, 40).toLowerCase().replace(/[^a-z_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'offer';
  const mode = ['ban_call', 'coalition_call'].includes(move) || truthy(output.poll) ? 'poll' : 'bilateral';
  if (mode === 'bilateral' && counterparts.length !== 1) throw invalid('GAMBIT_BILATERAL_NEEDS_ONE_COUNTERPART');
  const target = output.target ? resolveTarget(refs, output.target) : null;
  if (output.target && !target) throw invalid('GAMBIT_TARGET_UNKNOWN');
  const counterparty = counterparts[0];
  const offer = parseList(output.commitments ?? output.myCommitments, 6)
    .map((item) => parseCommitment(item, { refs, agentId: me, counterparty, now, scene }));
  // An ask is a commitment the counterpart(s) would make on acceptance: validated for each of them now and
  // stored in canonical form (world ids, absolute due minute), so later readers do not depend on labels.
  const askItems = parseList(output.ask, 6);
  for (const agentId of counterparts) for (const item of askItems) parseCommitment(item, { refs, agentId, counterparty: me, now, scene });
  const ask = askItems.map((item) => ({ ...parseCommitment(item, { refs, agentId: counterparts[0], counterparty: me, now, scene }), agentId: null }));
  const claims = parseList(output.claims, 6).map((item) => parseClaim(item, { refs, agentId: me }));
  const verifyRefs = parseList(output.verify ?? output.verifyClaims, 4).map((label) => refs.claims?.get(shortText(label, 12).toUpperCase()))
    .filter(Boolean);
  let ban = null;
  if (move === 'ban_call') {
    const subject = resolveResident(refs, output.banTarget ?? output.subject);
    if (!subject || subject.external || subject.agentId === me) throw invalid('GAMBIT_BAN_TARGET_INVALID');
    const days = Math.round(Number(output.banWorldDays ?? 2));
    ban = { targetAgentId: subject.agentId, worldDays: Number.isFinite(days) ? Math.max(1, Math.min(7, days)) : 2 };
  }
  const role = shortText(output.role, 10).toLowerCase();
  return {
    pass: false, scene, mode, move, counterparts, target, role: ROLES.has(role) ? role : null,
    patternIds: validPatternIds(output.patternIds ?? output.patterns ?? []),
    publicLine: shortText(output.publicLine, 240) || null, privateNote: shortText(output.privateNote ?? output.thinking, 300) || null,
    exitCondition: shortText(output.exitCondition, 240) || null,
    offer, ask, claims, verifyClaimIds: verifyRefs.map((claim) => claim.id), ban
  };
}

// A counterpart's (or, after a counter, the initiator's) reaction.
export function parseGambitResponse(output, { gambit, refs, me, now, claims = [] }) {
  if (!output || typeof output !== 'object') throw invalid('GAMBIT_OUTPUT_INVALID');
  const allowed = gambit.mode === 'poll' ? [...POLL_MOVES, 'accept', 'reject', 'verify', 'expose', 'exit'] : RESPONSE_MOVES;
  let move = shortText(output.move ?? output.response ?? output.decision, 20).toLowerCase();
  if (gambit.mode === 'poll' && move === 'accept') move = 'vote_yes';
  if (gambit.mode === 'poll' && move === 'reject') move = 'vote_no';
  if (!allowed.includes(move)) throw invalid('GAMBIT_RESPONSE_MOVE_INVALID');
  const otherClaims = claims.filter((claim) => claim.agentId !== me);
  const byLabel = new Map(otherClaims.map((claim, index) => [`K${index + 1}`, claim]));
  const pick = (labels) => parseList(labels, 6).map((label) => byLabel.get(shortText(label, 8).toUpperCase())).filter(Boolean);
  const result = { move, patternIds: validPatternIds(output.patternIds ?? output.patterns ?? []),
    publicLine: shortText(output.publicLine, 240) || null, privateNote: shortText(output.privateNote ?? output.thinking, 300) || null };
  if (move === 'verify') {
    const targets = pick(output.claims ?? output.verify).filter((claim) => claim.verification === 'unverified');
    if (!targets.length) throw invalid('GAMBIT_VERIFY_NOTHING');
    result.verifyClaimIds = targets.map((claim) => claim.id);
  }
  if (move === 'expose') {
    const targets = pick(output.claims ?? output.expose).filter((claim) => claim.verification === 'false' && claim.verifiedBy === me);
    if (!targets.length) throw invalid('GAMBIT_EXPOSE_NEEDS_A_CLAIM_YOU_FOUND_FALSE');
    result.exposeClaimIds = targets.map((claim) => claim.id);
  }
  if (move === 'counter') {
    const counterparty = gambit.initiatorAgentId === me ? gambit.counterpartAgentIds[0] : gambit.initiatorAgentId;
    result.offer = parseList(output.commitments ?? output.myCommitments, 6)
      .map((item) => parseCommitment(item, { refs, agentId: me, counterparty, now, scene: gambit.scene }));
    result.ask = parseList(output.ask, 6).map((item) => ({ ...parseCommitment(item, { refs, agentId: counterparty, counterparty: me, now,
      scene: gambit.scene }), agentId: null }));
    result.claims = parseList(output.newClaims ?? output.claimsMade, 4).map((item) => parseClaim(item, { refs, agentId: me }));
    if (!result.offer.length && !result.ask.length && !result.publicLine) throw invalid('GAMBIT_COUNTER_EMPTY');
  }
  return result;
}

// ---- pure verification --------------------------------------------------------------------------
// `actual` is what the world records say. Numbers within a small tolerance count as true.
export function judgeClaim(factKey, claimedValue, actual) {
  if (!CLAIM_FACTS[factKey]?.verifiable) return { verification: 'unverifiable', truth: null };
  if (actual === undefined) return { verification: 'unverifiable', truth: null };
  const claimed = typeof claimedValue === 'object' && claimedValue !== null && 'value' in claimedValue ? claimedValue.value : claimedValue;
  if (['bid_placed', 'third_party_offer', 'vote_cast'].includes(factKey)) {
    if (factKey === 'vote_cast') {
      const stance = String(claimed).toLowerCase();
      return { verification: actual && actual === (['yes', 'no'].includes(stance) ? stance : actual) ? 'true' : 'false', truth: actual || null };
    }
    if (factKey === 'third_party_offer') {
      const claimedNumber = Number(claimed);
      const offers = Array.isArray(actual) ? actual : [];
      const match = offers.some((offer) => Number.isFinite(claimedNumber) && Math.abs(offer - claimedNumber) <= Math.max(0.01, claimedNumber * 0.05));
      return { verification: match ? 'true' : 'false', truth: offers };
    }
    return { verification: Boolean(actual) === truthy(claimed ?? true) ? 'true' : 'false', truth: Boolean(actual) };
  }
  const number = Number(claimed);
  if (!Number.isFinite(number)) return { verification: 'false', truth: actual };
  const tolerance = factKey === 'build_skill' ? 2 : factKey === 'balance' ? Math.max(0.05, Math.abs(Number(actual)) * 0.05) : 0;
  return { verification: Math.abs(number - Number(actual)) <= tolerance ? 'true' : 'false', truth: actual };
}

// ---- pure: honesty and trust summaries ------------------------------------------------------------
export function honestyRecord(events = []) {
  const record = { kept: 0, broken: 0, released: 0, exposed: 0, exposedOthers: 0, claimsTrue: 0, claimsFalse: 0 };
  for (const event of events) {
    if (event.kind === 'kept') record.kept += 1;
    else if (event.kind === 'broken') record.broken += 1;
    else if (event.kind === 'released') record.released += 1;
    else if (event.kind === 'exposed') record.exposed += 1;
    else if (event.kind === 'exposer') record.exposedOthers += 1;
    else if (event.kind === 'claim_true') record.claimsTrue += 1;
    else if (event.kind === 'claim_false') record.claimsFalse += 1;
  }
  const promises = record.kept + record.broken;
  record.keptRate = promises ? Math.round((record.kept / promises) * 100) / 100 : null;
  return record;
}

// Pure: is a pending commitment kept, given the facts for its target. `facts` comes from the world.
export function judgeCommitment(commitment, facts) {
  switch (commitment.kind) {
    case 'abstain_bid': return facts.bid ? 'broken' : 'kept';
    case 'place_bid': return facts.bid && (!commitment.value?.maxRaw || big(facts.bid.bidRaw) <= big(commitment.value.maxRaw)) ? 'kept' : 'broken';
    case 'vote_stance': return facts.vote === commitment.value?.stance ? 'kept' : 'broken';
    case 'support_capability': return facts.review === 'support' ? 'kept' : 'broken';
    case 'oppose_capability': return facts.review === 'oppose' ? 'kept' : 'broken';
    default: return commitment.status || 'pending';
  }
}

// Pure: tally a ban poll. Passes with a strict majority of the electorate (internal residents except the target).
export function tallyBan({ yes = 0, no = 0, electorate = 1 }) {
  return { passed: yes * 2 > electorate, yes, no, electorate };
}

// ---- DB helpers ---------------------------------------------------------------------------------
export async function gambitsReady(db) {
  const result = await db.query(`SELECT to_regclass('public.world_gambits') IS NOT NULL AND to_regclass('public.world_reputation_events') IS NOT NULL
    AND to_regclass('public.world_capability_royalty_payments') IS NOT NULL AS ok`);
  return Boolean(result.rows[0]?.ok);
}

export async function worldMinuteOf(db, worldId) {
  return Number((await db.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || 0;
}

// Resident-to-resident SYNC move through the existing transfer table. The 0027/0031 triggers check the
// balance and refuse internal -> external; a refused transfer returns null (nothing moves).
export async function transferInternal(client, { worldId, fromAgentId, toAgentId, amountRaw, kind, actionId, sourceRef = null, worldMinutes }) {
  if (big(amountRaw) <= 0n || fromAgentId === toAgentId) return null;
  await client.query('SAVEPOINT gambit_transfer');
  try {
    const row = await client.query(`INSERT INTO arc_sync_internal_transfers(world_id,action_id,from_agent_id,to_agent_id,amount_raw,kind,source_ref,world_minute)
      VALUES($1,$2,$3,$4,$5::numeric,$6,$7,$8) ON CONFLICT (world_id,action_id) DO NOTHING RETURNING id`,
    [worldId, String(actionId).slice(0, 180), fromAgentId, toAgentId, big(amountRaw).toString(), kind,
      sourceRef ? String(sourceRef).slice(0, 180) : null, Math.trunc(worldMinutes)]);
    await client.query('RELEASE SAVEPOINT gambit_transfer');
    return row.rows[0]?.id || null;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT gambit_transfer');
    return null;
  }
}

export async function recordReputation(client, { worldId, agentId, observerAgentId = null, kind, deltaTrust = 0, gambitId = null, detail = {}, worldMinutes }) {
  await client.query(`INSERT INTO world_reputation_events(world_id,agent_id,observer_agent_id,kind,delta_trust,gambit_id,detail,world_minute)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [worldId, agentId, observerAgentId, kind, Math.max(-100, Math.min(100, Number(deltaTrust) || 0)),
    gambitId, JSON.stringify(detail), Math.trunc(worldMinutes)]);
}

export async function activeBan(db, { worldId, agentId, worldMinutes }) {
  const result = await db.query(`SELECT id,until_world_minute FROM world_gambit_bans WHERE world_id=$1 AND target_agent_id=$2
    AND from_world_minute<=$3 AND until_world_minute>$3 ORDER BY until_world_minute DESC LIMIT 1`, [worldId, agentId, Math.trunc(worldMinutes)]);
  return result.rows[0] || null;
}

// Facts for claims: what the world records say right now.
export async function actualFact(db, { worldId, agentId, factKey, subjectRef }) {
  const [kind, id] = String(subjectRef || '').split(':');
  if (factKey === 'build_skill') {
    const row = await db.query(`SELECT COALESCE(max(skill_value),0)::float8 AS v FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2
      AND skill_name='engineering'`, [worldId, agentId]);
    return Math.round(Number(row.rows[0]?.v) || 0);
  }
  if (factKey === 'active_contracts') {
    return Number((await db.query(`SELECT count(*)::int AS n FROM world_public_works WHERE world_id=$1 AND status='building' AND builder_agent_id=$2`,
      [worldId, agentId])).rows[0]?.n) || 0;
  }
  if (factKey === 'wins_count') {
    return Number((await db.query(`SELECT count(*)::int AS n FROM world_public_works WHERE world_id=$1 AND builder_agent_id=$2
      AND status IN ('building','completed')`, [worldId, agentId])).rows[0]?.n) || 0;
  }
  if (factKey === 'balance') {
    const row = await db.query(`SELECT spendable_raw::text AS v FROM arc_sync_internal_balances WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
    return rawToSync(row.rows[0]?.v || 0);
  }
  if (factKey === 'output_quality' && kind === 'output') {
    const row = await db.query(`SELECT quality FROM world_skill_outputs WHERE world_id=$1 AND output_id=$2 AND producer_id=$3`, [worldId, id, agentId]);
    return row.rowCount ? Number(row.rows[0].quality) : undefined;
  }
  if (factKey === 'bid_placed' && kind === 'tender') {
    return (await db.query(`SELECT 1 FROM world_public_work_bids WHERE world_id=$1 AND work_id=$2 AND agent_id=$3`, [worldId, id, agentId])).rowCount > 0;
  }
  if (factKey === 'vote_cast' && kind === 'proposal') {
    return (await db.query(`SELECT stance FROM world_council_votes WHERE world_id=$1 AND proposal_id=$2 AND agent_id=$3`, [worldId, id, agentId])).rows[0]?.stance || null;
  }
  if (factKey === 'third_party_offer' && kind === 'resident') {
    // An offer exists if that resident opened or countered a gambit with this resident containing a payment.
    const rows = await db.query(`SELECT terms FROM world_gambits WHERE world_id=$1 AND initiator_agent_id=$2 AND $3=ANY(counterpart_agent_ids)
      UNION ALL SELECT m.payload AS terms FROM world_gambit_moves m JOIN world_gambits g ON g.world_id=m.world_id AND g.id=m.gambit_id
        WHERE m.world_id=$1 AND m.agent_id=$2 AND m.move='counter' AND (g.initiator_agent_id=$3 OR $3=ANY(g.counterpart_agent_ids))
      LIMIT 50`, [worldId, id, agentId]);
    const offers = [];
    for (const row of rows.rows) {
      for (const item of [...(row.terms?.offer || [])]) if (item.kind === 'pay') offers.push(rawToSync(item.value?.amountRaw));
    }
    return offers;
  }
  return undefined;
}

export async function insertClaims(client, { worldId, gambitId = null, contextRef = null, claims = [], worldMinutes }) {
  const ids = [];
  for (const claim of claims) {
    const row = await client.query(`INSERT INTO world_gambit_claims(world_id,gambit_id,context_ref,agent_id,fact_key,subject_ref,claimed_value,
        verifiable,verification,created_world_minute) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING id`,
    [worldId, gambitId, contextRef, claim.agentId, claim.factKey, claim.subjectRef, JSON.stringify(claim.value), claim.verifiable,
      claim.verifiable ? 'unverified' : 'unverifiable', Math.trunc(worldMinutes)]);
    ids.push(Number(row.rows[0].id));
  }
  return ids;
}

// Verify claims for `verifierId`. Time cost is applied by the caller (turn delay); the SYNC fee goes from the
// verifier to the speaker only when the claim turns out true (doubting an honest claim costs you).
export async function verifyClaims(client, { worldId, claimIds, verifierId, worldMinutes, feeRaw = 10_000n, gambitId = null }) {
  const results = [];
  for (const claimId of claimIds) {
    const claim = (await client.query(`SELECT id,agent_id::text AS agent_id,fact_key,subject_ref,claimed_value,verification
      FROM world_gambit_claims WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, claimId])).rows[0];
    if (!claim || claim.verification !== 'unverified' || claim.agent_id === verifierId) continue;
    const actual = await actualFact(client, { worldId, agentId: claim.agent_id, factKey: claim.fact_key, subjectRef: claim.subject_ref });
    const judged = judgeClaim(claim.fact_key, claim.claimed_value, actual);
    await client.query(`UPDATE world_gambit_claims SET verification=$3,verified_by_agent_id=$4,verified_world_minute=$5,truth=$6::jsonb
      WHERE world_id=$1 AND id=$2`, [worldId, claim.id, judged.verification, verifierId, Math.trunc(worldMinutes),
      JSON.stringify(judged.truth ?? null)]);
    let feeTransferId = null;
    if (judged.verification === 'true' && big(feeRaw) > 0n) {
      feeTransferId = await transferInternal(client, { worldId, fromAgentId: verifierId, toAgentId: claim.agent_id, amountRaw: feeRaw,
        kind: 'verification_fee', actionId: `gambit-verify-fee:${claim.id}`, sourceRef: gambitId ? `gambit:${gambitId}` : `claim:${claim.id}`,
        worldMinutes });
    }
    if (judged.verification === 'true' || judged.verification === 'false') {
      await recordReputation(client, { worldId, agentId: claim.agent_id, observerAgentId: verifierId,
        kind: judged.verification === 'true' ? 'claim_true' : 'claim_false',
        deltaTrust: judged.verification === 'true' ? TRUST_REACTION.claim_true : TRUST_REACTION.claim_false,
        gambitId, detail: { claimId: Number(claim.id), fact: claim.fact_key, feePaid: Boolean(feeTransferId) }, worldMinutes });
    }
    results.push({ claimId: Number(claim.id), fact: claim.fact_key, claimed: claim.claimed_value, verification: judged.verification,
      truth: judged.truth ?? null, feePaid: Boolean(feeTransferId) });
  }
  return results;
}

// Expose: public record that the speaker's claim was false, made by the resident who verified it.
export async function exposeClaims(client, { worldId, claimIds, exposerId, gambitId, worldMinutes }) {
  const exposed = [];
  for (const claimId of claimIds) {
    const claim = (await client.query(`SELECT id,agent_id::text AS agent_id,fact_key,claimed_value,truth FROM world_gambit_claims
      WHERE world_id=$1 AND id=$2 AND verification='false' AND verified_by_agent_id=$3`, [worldId, claimId, exposerId])).rows[0];
    if (!claim) continue;
    await recordReputation(client, { worldId, agentId: claim.agent_id, observerAgentId: exposerId, kind: 'exposed',
      deltaTrust: TRUST_REACTION.exposed, gambitId, detail: { claimId: Number(claim.id), fact: claim.fact_key,
        claimed: claim.claimed_value, truth: claim.truth }, worldMinutes });
    await recordReputation(client, { worldId, agentId: exposerId, kind: 'exposer', gambitId,
      detail: { claimId: Number(claim.id), subject: claim.agent_id }, worldMinutes });
    exposed.push(Number(claim.id));
  }
  return exposed;
}

async function insertMove(client, { worldId, gambitId, seq, agentId, move, patternIds = [], publicLine = null, privateNote = null,
  payload = {}, model = null, abCohort = null, worldMinutes }) {
  await client.query(`INSERT INTO world_gambit_moves(world_id,gambit_id,seq,agent_id,move,pattern_ids,public_line,private_note,payload,model,ab_cohort,world_minute)
    VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9::jsonb,$10,$11,$12)`, [worldId, gambitId, seq, agentId, move, patternIds, publicLine, privateNote,
    JSON.stringify(payload), model, abCohort, Math.trunc(worldMinutes)]);
}

// Execute the commitments of an acceptance: payments now (balance-checked), output reservations now,
// the rest stays pending until due. Returns { executed, pending, failed }.
async function activateCommitments(client, { worldId, gambit, commitments, worldMinutes }) {
  const summary = { executed: [], pending: 0, failed: [] };
  for (const [index, commitment] of commitments.entries()) {
    const row = await client.query(`INSERT INTO world_gambit_commitments(world_id,gambit_id,agent_id,counterparty_agent_id,kind,target_ref,value,
        due_world_minute,created_world_minute) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
    [worldId, gambit.id, commitment.agentId, commitment.counterparty || null, commitment.kind, commitment.targetRef, JSON.stringify(commitment.value || {}),
      Math.max(Math.trunc(worldMinutes), Math.trunc(commitment.dueWorldMinute || worldMinutes)), Math.trunc(worldMinutes)]);
    const id = Number(row.rows[0].id);
    if (commitment.kind === 'pay') {
      const transferId = await transferInternal(client, { worldId, fromAgentId: commitment.agentId, toAgentId: commitment.counterparty,
        amountRaw: commitment.value.amountRaw, kind: commitment.value.transferKind || 'gambit_settlement',
        actionId: `gambit-pay:${gambit.id}:${id}:${index}`, sourceRef: `gambit:${gambit.id}`, worldMinutes });
      await settleCommitment(client, { worldId, commitment: { ...commitment, id }, status: transferId ? 'kept' : 'broken',
        evidence: transferId ? { transferId } : { reason: 'insufficient_balance' }, worldMinutes, gambitId: gambit.id });
      (transferId ? summary.executed : summary.failed).push({ id, kind: 'pay', amountRaw: commitment.value.amountRaw });
    } else if (commitment.kind === 'deliver_output') {
      const output = await client.query(`SELECT output_id FROM world_skill_outputs WHERE world_id=$1 AND output_id=$2 AND producer_id=$3
        AND consumed_at IS NULL FOR UPDATE SKIP LOCKED`, [worldId, commitment.value.outputId, commitment.agentId]);
      let reserved = false;
      if (output.rowCount) {
        const price = commitments.filter((item) => item.kind === 'pay' && item.counterparty === commitment.agentId)
          .reduce((sum, item) => sum + big(item.value.amountRaw), 0n);
        const inserted = await client.query(`INSERT INTO world_material_reservations(world_id,output_id,seller_id,buyer_id,gambit_id,price_raw,created_world_minute)
          VALUES($1,$2,$3,$4,$5,$6::numeric,$7) ON CONFLICT DO NOTHING RETURNING output_id`, [worldId, commitment.value.outputId,
          commitment.agentId, commitment.counterparty, gambit.id, price.toString(), Math.trunc(worldMinutes)]);
        reserved = inserted.rowCount > 0;
      }
      await settleCommitment(client, { worldId, commitment: { ...commitment, id }, status: reserved ? 'kept' : 'broken',
        evidence: reserved ? { reserved: true } : { reason: 'output_gone_or_reserved' }, worldMinutes, gambitId: gambit.id });
      (reserved ? summary.executed : summary.failed).push({ id, kind: 'deliver_output' });
    } else summary.pending += 1;
  }
  return summary;
}

export async function settleCommitment(client, { worldId, commitment, status, evidence = {}, worldMinutes, gambitId }) {
  const updated = await client.query(`UPDATE world_gambit_commitments SET status=$3,settled_world_minute=$4,evidence=$5::jsonb
    WHERE world_id=$1 AND id=$2 AND status='pending' RETURNING id`, [worldId, commitment.id, status, Math.trunc(worldMinutes), JSON.stringify(evidence)]);
  if (!updated.rowCount) return false;
  if (commitment.counterparty && ['kept', 'broken', 'released'].includes(status)) {
    await recordReputation(client, { worldId, agentId: commitment.agentId, observerAgentId: commitment.counterparty, kind: status,
      deltaTrust: TRUST_REACTION[status] || 0, gambitId, detail: { commitmentId: Number(commitment.id), kind: commitment.kind,
        target: commitment.targetRef || null }, worldMinutes });
  }
  return true;
}

function commitmentsFromTerms(terms, gambit, acceptorId, refs, now) {
  // offer: the proposer's own promises (already normalized); ask: promises the acceptor makes.
  const proposer = terms.proposerAgentId || gambit.initiatorAgentId;
  const offer = (terms.offer || []).map((item) => ({ ...item, agentId: proposer,
    counterparty: item.kind === 'pay' ? item.counterparty : acceptorId }));
  const ask = (terms.ask || []).map((item) => ({ ...item, agentId: acceptorId,
    counterparty: item.kind === 'pay' ? (item.counterparty && item.counterparty !== acceptorId ? item.counterparty : proposer) : proposer,
    dueWorldMinute: Math.max(Number(item.dueWorldMinute) || now, now) }));
  // Payments first, so an output delivery can record its price.
  return [...offer, ...ask].sort((a, b) => (a.kind === 'pay' ? 0 : 1) - (b.kind === 'pay' ? 0 : 1));
}

// Open a gambit (after a successful model call). Returns the gambit row summary.
export async function openGambit(client, { worldId, me, parsed, refs, worldMinutes, model = null, abCohort = null, verifyDelay = 30,
  feeRaw = 10_000n }) {
  const terms = { proposerAgentId: me, offer: parsed.offer, ask: parsed.ask, ...(parsed.ban ? { ban: parsed.ban } : {}),
    ...(parsed.target ? { target: { label: parsed.target.label, kind: parsed.target.kind, id: String(parsed.target.id) } } : {}) };
  const verifying = parsed.verifyClaimIds.length > 0;
  const gambit = (await client.query(`INSERT INTO world_gambits(world_id,scene,mode,initiator_agent_id,counterpart_agent_ids,role,pattern_ids,move,
      public_line,exit_condition,target_ref,terms,status,turn_agent_id,turn_after_world_minute,opened_world_minute,updated_world_minute,model,ab_cohort)
    VALUES($1,$2,$3,$4,$5::uuid[],$6,$7::text[],$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$16,$17,$18) RETURNING id::text AS id`,
  [worldId, parsed.scene, parsed.mode, me, parsed.counterparts, parsed.role, parsed.patternIds, parsed.move, parsed.publicLine,
    parsed.exitCondition, parsed.target ? `${parsed.target.kind}:${parsed.target.id}` : null, JSON.stringify(terms),
    verifying ? 'verifying' : 'awaiting', verifying ? me : parsed.counterparts[0],
    verifying ? Math.trunc(worldMinutes + verifyDelay) : Math.trunc(worldMinutes), Math.trunc(worldMinutes), model, abCohort])).rows[0];
  await insertMove(client, { worldId, gambitId: gambit.id, seq: 1, agentId: me, move: 'open', patternIds: parsed.patternIds,
    publicLine: parsed.publicLine, privateNote: parsed.privateNote, payload: { terms, claims: parsed.claims.length,
      verify: parsed.verifyClaimIds }, model, abCohort, worldMinutes });
  const claimIds = await insertClaims(client, { worldId, gambitId: gambit.id, claims: parsed.claims, worldMinutes });
  let verification = [];
  if (verifying) verification = await verifyClaims(client, { worldId, claimIds: parsed.verifyClaimIds, verifierId: me, worldMinutes, feeRaw,
    gambitId: gambit.id });
  return { gambitId: gambit.id, claimIds, verification };
}

export async function loadGambit(db, { worldId, gambitId, forUpdate = false }) {
  const row = (await db.query(`SELECT id::text AS id,scene,mode,initiator_agent_id::text AS "initiatorAgentId",
      counterpart_agent_ids::text[] AS "counterpartAgentIds",role,pattern_ids AS "patternIds",move,public_line AS "publicLine",
      exit_condition AS "exitCondition",target_ref AS "targetRef",terms,status,turn_agent_id::text AS "turnAgentId",
      turn_after_world_minute::text AS "turnAfter",move_count AS "moveCount",opened_world_minute::text AS "openedWorldMinute",
      updated_world_minute::text AS "updatedWorldMinute"
    FROM world_gambits WHERE world_id=$1 AND id=$2 ${forUpdate ? 'FOR UPDATE' : ''}`, [worldId, gambitId])).rows[0];
  if (!row) return null;
  const [moves, claims] = await Promise.all([
    db.query(`SELECT seq,agent_id::text AS "agentId",move,pattern_ids AS "patternIds",public_line AS "publicLine",payload,world_minute::text AS minute
      FROM world_gambit_moves WHERE world_id=$1 AND gambit_id=$2 ORDER BY seq`, [worldId, gambitId]),
    db.query(`SELECT id::text AS id,agent_id::text AS "agentId",fact_key AS "factKey",subject_ref AS "subjectRef",claimed_value AS value,
        verification,verified_by_agent_id::text AS "verifiedBy",truth FROM world_gambit_claims WHERE world_id=$1 AND (gambit_id=$2
          OR id = ANY(SELECT (jsonb_array_elements_text(COALESCE(m.payload->'verify','[]'::jsonb)))::bigint FROM world_gambit_moves m
            WHERE m.world_id=$1 AND m.gambit_id=$2 AND m.move='open')) ORDER BY id`,
    [worldId, gambitId])]);
  return { ...row, turnAfter: row.turnAfter == null ? null : Number(row.turnAfter), moves: moves.rows,
    claims: claims.rows.map((claim) => ({ ...claim, id: Number(claim.id) })) };
}

// Apply one reaction to a gambit (after a successful model call by `me`, whose turn it is).
export async function applyResponse(client, { worldId, gambitId, me, response, refs, worldMinutes, model = null, abCohort = null,
  verifyDelay = 30, feeRaw = 10_000n, internalCount = 10 }) {
  const gambit = await loadGambit(client, { worldId, gambitId, forUpdate: true });
  if (!gambit || !['awaiting', 'verifying'].includes(gambit.status) || gambit.turnAgentId !== me) return { applied: false, reason: 'not_your_turn' };
  const seq = gambit.moves.length + 1;
  const moveCount = Math.min(40, gambit.moveCount + 1);
  const update = async (fields) => {
    const sets = Object.keys(fields).map((key, index) => `${key}=$${index + 3}`);
    await client.query(`UPDATE world_gambits SET ${sets.join(',')},move_count=${moveCount},updated_world_minute=GREATEST(updated_world_minute,${Math.trunc(worldMinutes)})
      WHERE world_id=$1 AND id=$2`, [worldId, gambitId, ...Object.values(fields)]);
  };
  const payload = {};
  let verification = [];
  if (response.move === 'verify') {
    verification = await verifyClaims(client, { worldId, claimIds: response.verifyClaimIds, verifierId: me, worldMinutes, feeRaw, gambitId });
    payload.verification = verification;
  }
  if (response.move === 'expose') payload.exposed = await exposeClaims(client, { worldId, claimIds: response.exposeClaimIds, exposerId: me,
    gambitId, worldMinutes });
  if (response.move === 'counter') {
    payload.terms = { proposerAgentId: me, offer: response.offer, ask: response.ask, ...(gambit.terms?.target ? { target: gambit.terms.target } : {}) };
    if (response.claims?.length) payload.claimIds = await insertClaims(client, { worldId, gambitId, claims: response.claims, worldMinutes });
  }
  let accepted = null;
  if (gambit.mode === 'poll') {
    const answered = new Set(gambit.moves.filter((move) => ['vote_yes', 'vote_no', 'accept', 'reject', 'exit'].includes(move.move)).map((move) => move.agentId));
    if (['vote_yes', 'vote_no', 'exit', 'expose'].includes(response.move)) answered.add(me);
    if (response.move === 'vote_yes' && (gambit.terms?.ask || []).length) {
      accepted = await activateCommitments(client, { worldId, gambit, worldMinutes,
        commitments: commitmentsFromTerms({ ...gambit.terms, offer: [] }, gambit, me, refs, worldMinutes) });
      payload.commitments = accepted;
    }
    await insertMove(client, { worldId, gambitId, seq, agentId: me, move: response.move, patternIds: response.patternIds,
      publicLine: response.publicLine, privateNote: response.privateNote, payload, model, abCohort, worldMinutes });
    if (response.move === 'verify') {
      await update({ status: 'verifying', turn_after_world_minute: Math.trunc(worldMinutes + verifyDelay) });
      return { applied: true, move: response.move, verification };
    }
    const next = gambit.counterpartAgentIds.find((id) => !answered.has(id));
    if (next) { await update({ status: 'awaiting', turn_agent_id: next, turn_after_world_minute: Math.trunc(worldMinutes) }); return { applied: true, move: response.move }; }
    return { applied: true, move: response.move, closed: await closePoll(client, { worldId, gambitId, worldMinutes, internalCount }) };
  }
  await insertMove(client, { worldId, gambitId, seq, agentId: me, move: response.move, patternIds: response.patternIds,
    publicLine: response.publicLine, privateNote: response.privateNote, payload, model, abCohort, worldMinutes });
  const other = me === gambit.initiatorAgentId ? gambit.counterpartAgentIds[0] : gambit.initiatorAgentId;
  switch (response.move) {
    case 'accept': {
      if ((gambit.terms?.proposerAgentId || gambit.initiatorAgentId) === me) {
        // The proposer of the standing terms "accepting" means: go ahead and put them to the other side.
        await update({ status: 'awaiting', turn_agent_id: other, turn_after_world_minute: Math.trunc(worldMinutes) });
        return { applied: true, move: 'proceed' };
      }
      const result = await activateCommitments(client, { worldId, gambit, worldMinutes,
        commitments: commitmentsFromTerms(gambit.terms || {}, gambit, me, refs, worldMinutes) });
      const pending = Number((await client.query(`SELECT count(*)::int AS n FROM world_gambit_commitments WHERE world_id=$1 AND gambit_id=$2
        AND status='pending'`, [worldId, gambitId])).rows[0].n);
      await update({ status: pending ? 'accepted' : 'settled', turn_agent_id: null, turn_after_world_minute: null,
        ...(pending ? {} : { settled_world_minute: Math.trunc(worldMinutes) }), outcome: JSON.stringify({ acceptedBy: me, ...result }) });
      return { applied: true, move: 'accept', commitments: result };
    }
    case 'counter':
      if (moveCount >= MAX_BILATERAL_MOVES) {
        await update({ status: 'exited', turn_agent_id: null, turn_after_world_minute: null, outcome: JSON.stringify({ lapsed: 'move_limit' }) });
        return { applied: true, move: 'counter', closed: 'move_limit' };
      }
      await update({ status: 'awaiting', terms: JSON.stringify(payload.terms), turn_agent_id: other, turn_after_world_minute: Math.trunc(worldMinutes) });
      return { applied: true, move: 'counter' };
    case 'verify':
      await update({ status: 'verifying', turn_agent_id: me, turn_after_world_minute: Math.trunc(worldMinutes + verifyDelay) });
      return { applied: true, move: 'verify', verification };
    case 'expose':
      await update({ status: 'exposed', turn_agent_id: null, turn_after_world_minute: null, settled_world_minute: Math.trunc(worldMinutes),
        outcome: JSON.stringify({ exposedBy: me, claims: payload.exposed }) });
      return { applied: true, move: 'expose', exposed: payload.exposed };
    case 'reject':
      await update({ status: 'rejected', turn_agent_id: null, turn_after_world_minute: null, outcome: JSON.stringify({ rejectedBy: me }) });
      return { applied: true, move: 'reject' };
    default:
      await update({ status: 'exited', turn_agent_id: null, turn_after_world_minute: null, outcome: JSON.stringify({ exitedBy: me }) });
      return { applied: true, move: 'exit' };
  }
}

async function closePoll(client, { worldId, gambitId, worldMinutes, internalCount }) {
  const gambit = await loadGambit(client, { worldId, gambitId });
  const yes = gambit.moves.filter((move) => move.move === 'vote_yes').length + 1; // the caller votes yes
  const no = gambit.moves.filter((move) => move.move === 'vote_no').length;
  const outcome = { yes, no };
  if (gambit.terms?.ban) {
    const electorate = Math.max(1, internalCount - 1);
    const tally = tallyBan({ yes, no, electorate });
    Object.assign(outcome, tally);
    if (tally.passed) {
      await client.query(`INSERT INTO world_gambit_bans(world_id,gambit_id,target_agent_id,yes_votes,no_votes,electorate,from_world_minute,until_world_minute)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [worldId, gambitId, gambit.terms.ban.targetAgentId, yes, no, electorate,
        Math.trunc(worldMinutes), Math.trunc(worldMinutes + gambit.terms.ban.worldDays * 1_440)]);
    }
    await recordReputation(client, { worldId, agentId: gambit.terms.ban.targetAgentId, kind: tally.passed ? 'ban_passed' : 'ban_failed',
      gambitId, detail: { yes, no, electorate, worldDays: gambit.terms.ban.worldDays }, worldMinutes });
  }
  const pending = Number((await client.query(`SELECT count(*)::int AS n FROM world_gambit_commitments WHERE world_id=$1 AND gambit_id=$2 AND status='pending'`,
    [worldId, gambitId])).rows[0].n);
  await client.query(`UPDATE world_gambits SET status=$3,turn_agent_id=NULL,turn_after_world_minute=NULL,outcome=$4::jsonb,
      settled_world_minute=CASE WHEN $3='settled' THEN $5::bigint ELSE settled_world_minute END,updated_world_minute=GREATEST(updated_world_minute,$5::bigint)
    WHERE world_id=$1 AND id=$2`, [worldId, gambitId, pending ? 'accepted' : 'settled', JSON.stringify(outcome), Math.trunc(worldMinutes)]);
  return outcome;
}

// A model call failed for the resident whose turn it was: the gambit is void (no rule plays for them).
export async function voidGambit(client, { worldId, gambitId, agentId, reason, worldMinutes }) {
  const gambit = await loadGambit(client, { worldId, gambitId, forUpdate: true });
  if (!gambit || !['awaiting', 'verifying'].includes(gambit.status)) return false;
  await insertMove(client, { worldId, gambitId, seq: gambit.moves.length + 1, agentId, move: 'void', payload: { reason: shortText(reason, 80) },
    worldMinutes });
  await client.query(`UPDATE world_gambits SET status='void',turn_agent_id=NULL,turn_after_world_minute=NULL,move_count=LEAST(40,move_count+1),
      outcome=$3::jsonb,updated_world_minute=GREATEST(updated_world_minute,$4) WHERE world_id=$1 AND id=$2`,
  [worldId, gambitId, JSON.stringify({ void: shortText(reason, 80), agentId }), Math.trunc(worldMinutes)]);
  return true;
}

// Unanswered gambits lapse (void); polls close with the votes they have.
export async function lapseStaleGambits(client, { worldId, worldMinutes, ttl = 360, internalCount = 10, limit = 10 }) {
  const rows = await client.query(`SELECT id::text AS id,mode,turn_agent_id::text AS turn FROM world_gambits WHERE world_id=$1 AND status IN ('awaiting','verifying')
    AND updated_world_minute < $2 ORDER BY updated_world_minute LIMIT $3 FOR UPDATE SKIP LOCKED`, [worldId, Math.trunc(worldMinutes - ttl), limit]);
  for (const row of rows.rows) {
    if (row.mode === 'poll') await closePoll(client, { worldId, gambitId: row.id, worldMinutes, internalCount });
    else await voidGambit(client, { worldId, gambitId: row.id, agentId: row.turn, reason: 'lapsed', worldMinutes });
  }
  return rows.rowCount;
}

// Facts for a due commitment, from world records.
async function commitmentFacts(db, { worldId, commitment }) {
  const [kind, id] = String(commitment.targetRef || '').split(':');
  if (kind === 'tender') {
    const bid = (await db.query(`SELECT bid_raw::text AS "bidRaw" FROM world_public_work_bids WHERE world_id=$1 AND work_id=$2 AND agent_id=$3`,
      [worldId, id, commitment.agentId])).rows[0] || null;
    return { bid };
  }
  if (kind === 'proposal') {
    const vote = (await db.query(`SELECT stance FROM world_council_votes WHERE world_id=$1 AND proposal_id=$2 AND agent_id=$3`,
      [worldId, id, commitment.agentId])).rows[0]?.stance || null;
    return { vote };
  }
  if (kind === 'capability_proposal') {
    const review = (await db.query(`SELECT decision FROM world_capability_reviews WHERE world_id=$1 AND proposal_id=$2 AND reviewer_agent_id=$3
      AND review_stage='proposal' ORDER BY id DESC LIMIT 1`, [worldId, id, commitment.agentId])).rows[0]?.decision || null;
    return { review };
  }
  return {};
}

// Settle due commitments (no model call). Short transaction, SKIP LOCKED, at most `limit` rows.
export async function settleDueCommitments(client, { worldId, worldMinutes, limit = 20 }) {
  const due = await client.query(`SELECT id::text AS id,gambit_id::text AS "gambitId",agent_id::text AS "agentId",
      counterparty_agent_id::text AS counterparty,kind,target_ref AS "targetRef",value
    FROM world_gambit_commitments WHERE world_id=$1 AND status='pending' AND due_world_minute<=$2
    ORDER BY due_world_minute,id LIMIT $3 FOR UPDATE SKIP LOCKED`, [worldId, Math.trunc(worldMinutes), limit]);
  const touched = new Set();
  for (const commitment of due.rows) {
    const facts = await commitmentFacts(client, { worldId, commitment });
    const status = judgeCommitment(commitment, facts);
    if (!['kept', 'broken'].includes(status)) continue;
    await settleCommitment(client, { worldId, commitment, status, evidence: facts, worldMinutes, gambitId: commitment.gambitId });
    touched.add(commitment.gambitId);
  }
  for (const gambitId of touched) {
    await client.query(`UPDATE world_gambits SET status='settled',settled_world_minute=$3,updated_world_minute=GREATEST(updated_world_minute,$3)
      WHERE world_id=$1 AND id=$2 AND status='accepted' AND NOT EXISTS (SELECT 1 FROM world_gambit_commitments c
        WHERE c.world_id=$1 AND c.gambit_id=$2 AND c.status='pending')`, [worldId, gambitId, Math.trunc(worldMinutes)]);
  }
  return due.rowCount;
}

// ---- context for a resident's gambit decision -----------------------------------------------------
export async function readGambitWorld(db, { worldId, agentId, worldMinutes }) {
  const residents = (await db.query(`SELECT m.agent_id::text AS id,a.name,
      EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=m.world_id AND e.agent_id=m.agent_id) AS external
    FROM world_members m JOIN agents a ON a.id=m.agent_id WHERE m.world_id=$1 ORDER BY a.name`, [worldId])).rows;
  const refs = { residents: new Map(), byId: new Map(), tenders: new Map(), proposals: new Map(), outputs: new Map(),
    capabilities: new Map(), contracts: new Map(), claims: new Map() };
  for (const row of residents) { refs.residents.set(row.name, { agentId: row.id, external: row.external, name: row.name });
    refs.byId.set(row.id, { agentId: row.id, external: row.external, name: row.name }); }
  const nameOf = (id) => refs.byId.get(id)?.name || 'someone';
  const [events, myTrust, tenders, proposals, outputs, contracts, capabilityProposals, publicClaims, mine, recent, balance, bans] = await Promise.all([
    db.query(`SELECT agent_id::text AS agent,kind FROM world_reputation_events WHERE world_id=$1 AND world_minute>$2`, [worldId, Math.trunc(worldMinutes - 30 * 1_440)]),
    db.query(`SELECT agent_id::text AS agent,sum(delta_trust)::float8 AS delta FROM world_reputation_events WHERE world_id=$1 AND observer_agent_id=$2 GROUP BY 1`, [worldId, agentId]),
    db.query(`SELECT w.id::text AS id,w.name,w.price_raw::text AS price,w.bidding_closes_world_minute::text AS closes,
        (SELECT count(*)::int FROM world_public_work_bids b WHERE b.work_id=w.id) AS bids
      FROM world_public_works w WHERE w.world_id=$1 AND w.status='bidding' ORDER BY w.commissioned_world_minute LIMIT 5`, [worldId]),
    db.query(`SELECT p.id::text AS id,p.title,p.closes_world_minute::text AS closes,p.proposer_agent_id::text AS proposer,
        (SELECT jsonb_object_agg(v.agent_id::text,v.stance) FROM world_council_votes v WHERE v.world_id=p.world_id AND v.proposal_id=p.id) AS votes
      FROM world_council_proposals p WHERE p.world_id=$1 AND p.status='open' ORDER BY p.opened_world_minute LIMIT 6`, [worldId]),
    db.query(`SELECT o.output_id::text AS id,o.drive,o.quality,l.name AS skill FROM world_skill_outputs o JOIN world_skill_library l ON l.skill_id=o.skill_id
      WHERE o.world_id=$1 AND o.producer_id=$2 AND o.consumed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM world_material_reservations r WHERE r.world_id=o.world_id AND r.output_id=o.output_id)
      ORDER BY o.quality DESC,o.created_at DESC LIMIT 4`, [worldId, agentId]),
    db.query(`SELECT w.id::text AS id,w.name,w.builder_agent_id::text AS builder,w.progress,w.contract_price_raw::text AS price
      FROM world_public_works w WHERE w.world_id=$1 AND w.status='building' ORDER BY w.awarded_world_minute LIMIT 6`, [worldId]),
    db.query(`SELECT p.id::text AS id,p.name,p.creator_agent_id::text AS creator,p.support_count,p.opposition_count,r.royalty_raw::text AS royalty
      FROM world_capability_proposals p LEFT JOIN world_capability_royalties r ON r.world_id=p.world_id AND r.proposal_id=p.id
      WHERE p.world_id=$1 AND p.status IN ('proposed','reviewed') ORDER BY p.created_world_minute DESC LIMIT 4`, [worldId]),
    db.query(`SELECT c.id::text AS id,c.agent_id::text AS agent,c.fact_key,c.claimed_value,c.subject_ref,c.context_ref
      FROM world_gambit_claims c WHERE c.world_id=$1 AND c.verification='unverified' AND c.agent_id<>$2 AND c.created_world_minute>$3
      ORDER BY c.id DESC LIMIT 6`, [worldId, agentId, Math.trunc(worldMinutes - 3 * 1_440)]),
    db.query(`SELECT id::text AS id FROM world_gambits WHERE world_id=$1 AND (initiator_agent_id=$2 OR $2=ANY(counterpart_agent_ids))
      AND status IN ('awaiting','verifying','accepted') ORDER BY updated_world_minute DESC LIMIT 4`, [worldId, agentId]),
    db.query(`SELECT g.scene,g.move,g.status,g.initiator_agent_id::text AS initiator,g.counterpart_agent_ids::text[] AS counterparts,
        g.pattern_ids,g.public_line,g.outcome FROM world_gambits g WHERE g.world_id=$1 AND g.status IN ('settled','exposed','rejected','exited','accepted')
      ORDER BY g.updated_world_minute DESC LIMIT 6`, [worldId]),
    db.query(`SELECT spendable_raw::text AS v FROM arc_sync_internal_balances WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]),
    db.query(`SELECT target_agent_id::text AS agent,until_world_minute::text AS until FROM world_gambit_bans WHERE world_id=$1 AND until_world_minute>$2`,
      [worldId, Math.trunc(worldMinutes)])
  ]);
  const byAgent = new Map();
  for (const event of events.rows) byAgent.set(event.agent, [...(byAgent.get(event.agent) || []), event]);
  const trust = new Map(myTrust.rows.map((row) => [row.agent, Math.round(Number(row.delta) * 10) / 10]));
  tenders.rows.forEach((row, index) => refs.tenders.set(`T${index + 1}`, { id: row.id, closesWorldMinute: Number(row.closes) }));
  proposals.rows.forEach((row, index) => refs.proposals.set(`P${index + 1}`, { id: row.id, closesWorldMinute: Number(row.closes) }));
  outputs.rows.forEach((row, index) => refs.outputs.set(`O${index + 1}`, { id: row.id, producerId: agentId }));
  contracts.rows.forEach((row, index) => refs.contracts.set(`W${index + 1}`, { id: row.id, builder: row.builder }));
  capabilityProposals.rows.forEach((row, index) => refs.capabilities.set(`C${index + 1}`, { id: row.id }));
  publicClaims.rows.forEach((row, index) => refs.claims.set(`K${index + 1}`, { id: Number(row.id), agentId: row.agent }));
  const residentsView = residents.filter((row) => row.id !== agentId && !row.external).map((row) => ({ name: row.name,
    publicRecord: honestyRecord(byAgent.get(row.id) || []), yourTrustChangeFromDealings: trust.get(row.id) || 0,
    banned: bans.rows.some((ban) => ban.agent === row.id) || undefined }));
  const view = {
    you: { name: nameOf(agentId), balanceSync: rawToSync(balance.rows[0]?.v || 0), publicRecord: honestyRecord(byAgent.get(agentId) || []) },
    residents: residentsView,
    tenders: tenders.rows.map((row, index) => ({ ref: `T${index + 1}`, name: row.name, maxPriceSync: rawToSync(row.price), bidsSoFar: row.bids,
      closesInWorldMinutes: Number(row.closes) - worldMinutes })),
    councilProposals: proposals.rows.map((row, index) => ({ ref: `P${index + 1}`, title: row.title, proposer: nameOf(row.proposer),
      closesInWorldMinutes: Number(row.closes) - worldMinutes, votesCast: Object.fromEntries(Object.entries(row.votes || {}).map(([id, stance]) => [nameOf(id), stance])) })),
    yourSellableOutputs: outputs.rows.map((row, index) => ({ ref: `O${index + 1}`, skill: row.skill, drive: row.drive, quality: row.quality })),
    contractsUnderWay: contracts.rows.map((row, index) => ({ ref: `W${index + 1}`, name: row.name, builder: nameOf(row.builder), progress: row.progress,
      priceSync: rawToSync(row.price) })),
    capabilityProposals: capabilityProposals.rows.map((row, index) => ({ ref: `C${index + 1}`, name: row.name, proposer: nameOf(row.creator),
      support: row.support_count, oppose: row.opposition_count, royaltyPerUseSync: row.royalty ? rawToSync(row.royalty) : null })),
    uncheckedClaimsByOthers: publicClaims.rows.map((row, index) => ({ ref: `K${index + 1}`, by: nameOf(row.agent), fact: row.fact_key,
      claimed: row.claimed_value, about: row.subject_ref?.startsWith('resident:') ? nameOf(row.subject_ref.slice(9)) : row.subject_ref ? row.subject_ref.split(':')[0] : null,
      where: row.context_ref ? row.context_ref.split(':')[0] : 'gambit' })),
    yourOpenGambits: mine.rows.length,
    recentPublicGambits: recent.rows.map((row) => ({ scene: row.scene, move: row.move, status: row.status, from: nameOf(row.initiator),
      to: row.counterparts.map(nameOf), patterns: row.pattern_ids, line: row.public_line })),
    bans: bans.rows.map((ban) => ({ resident: nameOf(ban.agent), untilInWorldMinutes: Number(ban.until) - worldMinutes }))
  };
  return { view, refs, internalCount: residents.filter((row) => !row.external).length };
}

// The engine's public view (website): latest gambits, alliances, exposures, honesty, pattern usage.
export async function readPublicGambits(db, { worldId, limit = 50 }) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 50));
  const [gambits, moves, exposures, events, patterns, names] = await Promise.all([
    db.query(`SELECT id::text AS id,scene,mode,move,status,initiator_agent_id::text AS initiator,counterpart_agent_ids::text[] AS counterparts,
        pattern_ids AS "patternIds",public_line AS "publicLine",opened_world_minute::text AS opened,updated_world_minute::text AS updated,outcome
      FROM world_gambits WHERE world_id=$1 ORDER BY opened_world_minute DESC,id LIMIT $2`, [worldId, lim]),
    db.query(`SELECT m.gambit_id::text AS gambit,m.seq,m.agent_id::text AS agent,m.move,m.pattern_ids AS "patternIds",m.public_line AS "publicLine"
      FROM world_gambit_moves m JOIN (SELECT id FROM world_gambits WHERE world_id=$1 ORDER BY opened_world_minute DESC LIMIT $2) g ON g.id=m.gambit_id
      WHERE m.world_id=$1 ORDER BY m.gambit_id,m.seq`, [worldId, lim]),
    db.query(`SELECT e.agent_id::text AS subject,e.observer_agent_id::text AS exposer,e.detail,e.world_minute::text AS minute,e.gambit_id::text AS gambit
      FROM world_reputation_events e WHERE e.world_id=$1 AND e.kind='exposed' ORDER BY e.world_minute DESC LIMIT 20`, [worldId]),
    db.query(`SELECT agent_id::text AS agent,kind,count(*)::int AS n FROM world_reputation_events WHERE world_id=$1 GROUP BY 1,2`, [worldId]),
    db.query(`SELECT p AS id,count(*)::int AS uses FROM (SELECT unnest(pattern_ids) AS p FROM world_gambit_moves WHERE world_id=$1
      AND created_at > now() - interval '7 days') x GROUP BY p ORDER BY uses DESC LIMIT 12`, [worldId]),
    db.query(`SELECT m.agent_id::text AS id,a.name FROM world_members m JOIN agents a ON a.id=m.agent_id WHERE m.world_id=$1`, [worldId])
  ]);
  const nameOf = new Map(names.rows.map((row) => [row.id, row.name]));
  const movesBy = new Map();
  for (const move of moves.rows) movesBy.set(move.gambit, [...(movesBy.get(move.gambit) || []), { agent: nameOf.get(move.agent) || null,
    move: move.move, patterns: describePatterns(move.patternIds).map((item) => ({ id: item.id, name: item.name, nameEn: item.nameEn })),
    line: move.publicLine }]);
  const pairs = new Map();
  for (const gambit of gambits.rows) {
    for (const counterpart of gambit.counterparts) {
      const key = [gambit.initiator, counterpart].sort().join('|');
      const entry = pairs.get(key) || { a: nameOf.get(key.split('|')[0]), b: nameOf.get(key.split('|')[1]), deals: 0, kept: 0, broken: 0, open: 0 };
      entry.deals += 1;
      if (gambit.status === 'settled') entry.kept += 1;
      if (['exposed'].includes(gambit.status)) entry.broken += 1;
      if (['awaiting', 'verifying', 'accepted'].includes(gambit.status)) entry.open += 1;
      pairs.set(key, entry);
    }
  }
  const honesty = new Map();
  for (const row of events.rows) {
    const entry = honesty.get(row.agent) || { name: nameOf.get(row.agent), kept: 0, broken: 0, exposed: 0, exposedOthers: 0, claimsTrue: 0, claimsFalse: 0 };
    const key = { kept: 'kept', broken: 'broken', exposed: 'exposed', exposer: 'exposedOthers', claim_true: 'claimsTrue', claim_false: 'claimsFalse' }[row.kind];
    if (key) entry[key] += row.n;
    honesty.set(row.agent, entry);
  }
  return {
    gambits: gambits.rows.map((row) => ({ id: row.id, scene: row.scene, mode: row.mode, move: row.move, status: row.status,
      from: nameOf.get(row.initiator) || null, to: row.counterparts.map((id) => nameOf.get(id) || null),
      patterns: describePatterns(row.patternIds).map((item) => ({ id: item.id, name: item.name, nameEn: item.nameEn })),
      line: row.publicLine, openedWorldMinute: Number(row.opened), updatedWorldMinute: Number(row.updated), moves: movesBy.get(row.id) || [] })),
    alliances: [...pairs.values()].sort((a, b) => b.deals - a.deals).slice(0, 30),
    exposed: exposures.rows.map((row) => ({ subject: nameOf.get(row.subject) || null, exposer: nameOf.get(row.exposer) || null,
      fact: row.detail?.fact || null, claimed: row.detail?.claimed ?? null, truth: row.detail?.truth ?? null, worldMinute: Number(row.minute) })),
    honesty: [...honesty.values()].map((entry) => ({ ...entry, keptRate: entry.kept + entry.broken ? Math.round(entry.kept / (entry.kept + entry.broken) * 100) / 100 : null }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    patternUsage: patterns.rows.map((row) => ({ ...describePatterns([row.id])[0], uses: row.uses }))
  };
}

export { selectScenePatterns, patternIndex, describePatterns };
export const big_ = big;

// gambit1 P4: a short summary of the resident's own gambits for the open-cognition context (<= ~1.5 kB).
export const COGNITION_GAMBIT_BYTES = 1_500;
export async function readCognitionGambits(db, { worldId, agentId, worldMinutes }) {
  const [open, events, names] = await Promise.all([
    db.query(`SELECT scene,move,status,initiator_agent_id::text AS initiator,counterpart_agent_ids::text[] AS counterparts,public_line,
        turn_agent_id::text AS turn FROM world_gambits WHERE world_id=$1 AND (initiator_agent_id=$2 OR $2=ANY(counterpart_agent_ids))
        AND status IN ('awaiting','verifying','accepted') ORDER BY updated_world_minute DESC LIMIT 5`, [worldId, agentId]),
    db.query(`SELECT agent_id::text AS agent,observer_agent_id::text AS observer,kind,detail FROM world_reputation_events
      WHERE world_id=$1 AND (agent_id=$2 OR observer_agent_id=$2) AND world_minute>$3 ORDER BY world_minute DESC LIMIT 8`,
    [worldId, agentId, Math.trunc(worldMinutes - 3 * 1_440)]),
    db.query(`SELECT m.agent_id::text AS id,a.name FROM world_members m JOIN agents a ON a.id=m.agent_id WHERE m.world_id=$1`, [worldId])
  ]);
  const nameOf = new Map(names.rows.map((row) => [row.id, row.name]));
  const summary = {
    note: 'Your gambits (局) with other residents. Promises are checked against the records when due; claims can be verified and exposed by others.',
    open: open.rows.map((row) => ({ scene: row.scene, move: row.move, status: row.status, with: [row.initiator, ...row.counterparts]
      .filter((id) => id !== agentId).map((id) => nameOf.get(id)), line: shortText(row.public_line, 120) || undefined,
      yourTurn: row.turn === agentId || undefined })),
    recent: events.rows.map((row) => row.agent === agentId
      ? { you: row.kind, by: row.observer ? nameOf.get(row.observer) : undefined }
      : { resident: nameOf.get(row.agent), what: row.kind, toYou: true })
  };
  while (JSON.stringify(summary).length > COGNITION_GAMBIT_BYTES && (summary.recent.length || summary.open.length)) {
    if (summary.recent.length) summary.recent.pop(); else summary.open.pop();
  }
  return summary;
}
