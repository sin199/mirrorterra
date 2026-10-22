// MirrorTerra Central Bank as a real world place, and its governor's working day.
// The bank already stands on the world-centre plaza (site/world3d.js BANK_ANGLE/BANK_RADIUS);
// this makes that spot a world_scenes row so residents can walk there. It is created by an
// idempotent in-tick ensure, the same pattern as the beach landmark (ensureBeach), so no
// migration is needed: scene_type 'central_bank' is accepted by the open check from 0025.
//
// The bank keeps the world's books (SYNC is booked internally). Governor routing: during world
// working hours (calendar.isWorkHours, weekdays 09:00-17:00) bookkeeping is MirrorTerra-01's
// primary work. The economic fallback is skipped for 01 in those hours, its routine fallback set
// is narrowed to bookkeeping-eligible work/learn plus eat/rest (governorShiftCandidates), and a
// plain routine work/learn is carried out at the bank instead of wherever it was aimed. The action
// itself is unchanged, so the existing need, learning and reward rules apply; nothing here pays anyone.
// Survival interruptions and plan-grounded (LLM) choices are never overridden.
// Kill switch: MIRRORTERRA_BANK_GOVERNOR=off disables the routing and the ensure.
// No SYNC ledger, reward-commit, wallet or chain logic is touched here.
import { SYNC_GENESIS_ISSUER_AGENT_ID } from './arc/sync-tokenomics.js';
import { SYNC_CENTRAL_BANK_NAME } from './arc/sync-resident-rewards.js';
import { writeWorldHistory } from './world-domain.js';
import { destinationFeasible } from './world-environment.js';

export const CENTRAL_BANK_SCENE_TYPE = 'central_bank';
export const CENTRAL_BANK_PLACE_NAME = SYNC_CENTRAL_BANK_NAME;
export const CENTRAL_BANK_GOVERNOR_ID = SYNC_GENESIS_ISSUER_AGENT_ID;
// Normalised world coordinates of the bank building: angle -0.21 rad, just off the world centre
// (the plaza's Exchange sits at 0,0). Travel distances use these; the 3D/2D maps draw the bank
// at their own fixed plaza spot and never re-place it.
export const CENTRAL_BANK_POSITION = Object.freeze({ x: 0.176, z: -0.037, plaza: true, angle: -0.21 });
export const CENTRAL_BANK_HOURS = Object.freeze({ weekday: [[8, 18]], weekend: [[10, 16]] });
export const CENTRAL_BANK_FEATURES = Object.freeze({
  kind: CENTRAL_BANK_SCENE_TYPE, institution: 'central_bank', origin: 'institution', accent: '#d9b44a',
  // Visitors meet whoever is there, as at any social place.
  action: 'socialize', governorAgentId: SYNC_GENESIS_ISSUER_AGENT_ID, openingHours: CENTRAL_BANK_HOURS
});
export const CENTRAL_BANK_DESCRIPTION = 'The MirrorTerra Central Bank on the world-centre plaza keeps the world\'s books: every resident\'s SYNC is booked here.';
export const CENTRAL_BANK_PURPOSE = 'Governor MirrorTerra-01 reconciles the ledger and audits resident accounts here on working days; residents may visit.';

// What the governor does there: bookkeeping. The engine action stays work or learn.
export const BANK_GOVERNOR_WORK = Object.freeze({
  work: { variant: 'ledger_reconciling', goal: 'Reconcile the Central Bank ledger for the working day.',
    description: 'Reconciling the ledger at the Central Bank.' },
  learn: { variant: 'accounts_audit', goal: 'Audit resident SYNC accounts in the Central Bank books.',
    description: 'Auditing resident accounts at the Central Bank.' }
});
// Kept during the governor's shift so needs can still be met (survival interruptions also stay).
const SHIFT_NEEDS_ACTIONS = Object.freeze(new Set(['eat', 'rest']));
// Activities that carry their own target (projects, businesses, work orders, partners...) are never rerouted.
const OWN_TARGET_KEYS = Object.freeze(['opportunityId', 'projectId', 'projectProposal', 'businessId', 'serviceId', 'jobId',
  'employmentId', 'workOrderId', 'capabilityId', 'organizationId', 'agreementId', 'commitmentId', 'socialPartnerId',
  'institutionalTrace']);

export function bankGovernorEnabled(env = process.env) {
  return String(env?.MIRRORTERRA_BANK_GOVERNOR ?? '').trim().toLowerCase() !== 'off';
}

export function isCentralBankScene(scene) {
  return (scene?.sceneType || scene?.scene_type) === CENTRAL_BANK_SCENE_TYPE;
}

export function findCentralBankScene(scenes = []) {
  return (Array.isArray(scenes) ? scenes : []).find((scene) => isCentralBankScene(scene) && scene.status === 'active') || null;
}

const bookkeepingEligible = (activity) => Boolean(activity && BANK_GOVERNOR_WORK[activity.action] && !activity.home
  && !OWN_TARGET_KEYS.some((key) => activity[key] !== undefined && activity[key] !== null));

// Pure and deterministic: true while the governor's bank shift is on (governor, kill switch on,
// world weekday 09-17, the bank place is active and reachable).
export function governorBankShiftActive({ agent, scenes, environment, env = process.env } = {}) {
  if (!bankGovernorEnabled(env) || agent?.agentId !== CENTRAL_BANK_GOVERNOR_ID) return false;
  if (!environment?.calendar?.isWorkHours) return false;
  const bank = findCentralBankScene(scenes);
  if (!bank) return false;
  return Boolean(destinationFeasible({ targetLocation: bank.name }, agent, scenes, environment));
}

// Pure: during the shift the routine fallback set keeps only bookkeeping-eligible work/learn
// plus eat/rest. If no bookkeeping candidate exists the set is returned unchanged.
export function governorShiftCandidates(candidates, { active = false } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!active) return list;
  if (!list.some(bookkeepingEligible)) return list;
  return list.filter((candidate) => bookkeepingEligible(candidate) || SHIFT_NEEDS_ACTIONS.has(candidate?.action));
}

// Pure and deterministic. Returns the activity unchanged unless every condition holds.
export function routeBankGovernorActivity(activity, { agent, scenes, environment, decisionLayer = null, env = process.env } = {}) {
  if (!activity || !bankGovernorEnabled(env)) return activity;
  if (agent?.agentId !== CENTRAL_BANK_GOVERNOR_ID) return activity;
  if (decisionLayer === 'survival_interruption') return activity;
  const work = BANK_GOVERNOR_WORK[activity.action];
  if (!work || activity.home) return activity;
  if (OWN_TARGET_KEYS.some((key) => activity[key] !== undefined && activity[key] !== null)) return activity;
  if (!environment?.calendar?.isWorkHours) return activity;
  const bank = findCentralBankScene(scenes);
  if (!bank || activity.targetLocation === bank.name && activity.bankGovernor) return activity;
  if (!destinationFeasible({ targetLocation: bank.name }, agent, scenes, environment)) return activity;
  // The id is kept so plan bookkeeping and Fruitfly learning still match the chosen candidate.
  return { ...activity, targetLocation: bank.name, goal: work.goal, description: work.description,
    bankGovernor: true, routedFrom: activity.targetLocation ?? null };
}

export async function ensureCentralBankPlace(client, { worldId, worldMinutes = 0, env = process.env }) {
  if (!worldId || !bankGovernorEnabled(env)) return null;
  const existing = await client.query(`SELECT id FROM world_scenes WHERE world_id=$1
    AND (scene_type=$2 OR name=$3) LIMIT 1`, [worldId, CENTRAL_BANK_SCENE_TYPE, CENTRAL_BANK_PLACE_NAME]);
  if (existing.rowCount) return null;
  const governor = await client.query(`SELECT m.agent_id FROM world_members m WHERE m.world_id=$1 AND m.agent_id=$2`,
    [worldId, CENTRAL_BANK_GOVERNOR_ID]);
  if (!governor.rowCount) return null;
  const inserted = await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,
      purpose,capacity,features,position,created_world_minutes)
    VALUES($1,$2,$3,$4,$5,'active',$6,12,$7::jsonb,$8::jsonb,$9)
    ON CONFLICT(world_id,name) DO NOTHING
    RETURNING id,name,scene_type AS "sceneType"`,
  [worldId, CENTRAL_BANK_GOVERNOR_ID, CENTRAL_BANK_PLACE_NAME, CENTRAL_BANK_SCENE_TYPE, CENTRAL_BANK_DESCRIPTION,
    CENTRAL_BANK_PURPOSE, JSON.stringify(CENTRAL_BANK_FEATURES), JSON.stringify(CENTRAL_BANK_POSITION),
    Math.max(0, Math.trunc(Number(worldMinutes) || 0))]);
  const scene = inserted.rows[0];
  if (!scene) return null;
  await writeWorldHistory(client, { worldId, eventKey: `place:central-bank:${scene.id}:created`, eventType: 'place_created',
    actorAgentId: CENTRAL_BANK_GOVERNOR_ID, entityType: 'place', entityId: scene.id, worldTime: worldMinutes,
    title: CENTRAL_BANK_PLACE_NAME, detail: 'The Central Bank on the world-centre plaza opened its doors.',
    metadata: { sceneType: CENTRAL_BANK_SCENE_TYPE } });
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'scene.created',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, CENTRAL_BANK_GOVERNOR_ID, JSON.stringify({ id: scene.id, name: scene.name, sceneType: scene.sceneType,
    worldTime: worldMinutes }), 'landmark:central-bank']);
  return scene;
}

// Isolated in a savepoint: the ensure can never break a world tick.
export async function ensureCentralBankPlaceSafely(client, input) {
  if (!bankGovernorEnabled(input?.env)) return null;
  try { await client.query('SAVEPOINT world_central_bank_place'); } catch { return null; }
  try {
    const scene = await ensureCentralBankPlace(client, input);
    await client.query('RELEASE SAVEPOINT world_central_bank_place');
    return scene;
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT world_central_bank_place');
      await client.query('RELEASE SAVEPOINT world_central_bank_place');
    } catch { /* surrounding transaction reports its own failure */ }
    return { error: error?.message || String(error) };
  }
}
