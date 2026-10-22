import { createHash } from 'node:crypto';
import { skillOutputRewardWeight, syncEconomyEnabled } from './arc/sync-resident-rewards.js';
import { issueResidentReward } from './treasury.js';

// Real-world skill library (O*NET 31.0, CC BY 4.0). Skills are data compiled to the
// four base world actions; practising one only changes world-internal progress rows.
// Drives (survival ... contribution) decide WHICH skills a resident reaches for; there is
// no cap on how many skills a resident may learn, only on how many one action practises.
export const SKILL_LIBRARY_ACTIONS = Object.freeze(['learn', 'work', 'cooperate', 'socialize']);
export const SKILL_LIBRARY_PRACTICE_PER_ACTION = 3;
export const SKILL_LIBRARY_MAX_LEVEL = 10;
export const SKILL_LIBRARY_UNLOCK_LEVEL = 3;
export const SKILL_DRIVES = Object.freeze(['survival', 'security', 'belonging', 'esteem',
  'curiosity', 'creation', 'mastery', 'contribution']);
export const SKILL_OUTPUT_EVERY = 5;
export const SKILL_OUTPUT_OPEN_CAP = 5;
export const SKILL_OUTPUT_MIN_DRIVE = 0.35;
// skillwork (fix 3): an unused output older than 48 world hours expires. One world minute is one real
// second, so 48 world hours = 2880 real seconds. Expired = consumed_at set with consumer_id NULL (no
// deletion, no schema change): it no longer counts toward the open cap and nobody can claim it.
export const SKILL_OUTPUT_EXPIRY_WORLD_MINUTES = 48 * 60;
export const REAL_SECONDS_PER_WORLD_MINUTE = 1;
export const SKILL_OUTPUT_EXPIRY_SECONDS = SKILL_OUTPUT_EXPIRY_WORLD_MINUTES * REAL_SECONDS_PER_WORLD_MINUTE;
export const SKILL_OUTPUT_MATCH_DRIVES = 3;
const XP_PER_LEVEL_UNIT = 20;
const TIER_XP_SCALE = Object.freeze({ 1: 1.5, 2: 1.2, 3: 1, 4: 0.6 });
const SECONDARY_PRACTICE_SCALE = 0.6;

export function skillLibraryEnabled(env = process.env) {
  return String(env.MIRRORTERRA_SKILL_LIBRARY ?? 'on').toLowerCase() !== 'off';
}

// Kill switch for fix 3 (expiry + top-3 drive matching). Unset = on; 'off' restores the old behaviour.
export function outputExpiryEnabled(env = process.env) {
  return String(env?.MIRRORTERRA_OUTPUT_EXPIRY ?? 'on').toLowerCase() !== 'off';
}

// Pure: which drives a consumer looks for, strongest first. Old behaviour: only the single strongest.
export function consumerDrives(drives, { multi = true } = {}) {
  return strongestDrives(drives, multi ? SKILL_OUTPUT_MATCH_DRIVES : 1)
    .filter((entry) => entry.value >= SKILL_OUTPUT_MIN_DRIVE).map((entry) => entry.drive);
}

// Pure: is an unused output past its expiry age?
export function outputExpired(createdAt, nowMs = Date.now()) {
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(created) && nowMs - created > SKILL_OUTPUT_EXPIRY_SECONDS * 1000;
}

// Marks this producer's unused outputs older than the expiry age as expired. Rows another transaction is
// claiming right now are skipped (no waiting, no deadlock); they are caught on the next pass.
// skillwork2: bounded (LIMIT, oldest first, uses world_skill_outputs_producer_idx) so it can never turn
// into a large write inside the world tick.
export const SKILL_OUTPUT_EXPIRY_BATCH = 20;
export async function expireStaleOutputs(client, { worldId, producerId = null, limit = SKILL_OUTPUT_EXPIRY_BATCH }) {
  const batch = Math.max(1, Math.min(SKILL_OUTPUT_EXPIRY_BATCH, Math.trunc(Number(limit) || SKILL_OUTPUT_EXPIRY_BATCH)));
  const result = await client.query(`UPDATE world_skill_outputs SET consumed_at=now()
    WHERE output_id IN (SELECT o.output_id FROM world_skill_outputs o
      WHERE o.world_id=$1 AND ($2::uuid IS NULL OR o.producer_id=$2::uuid) AND o.consumed_at IS NULL
        AND o.created_at < now() - make_interval(secs => $3)
      ORDER BY o.created_at LIMIT $4
      FOR UPDATE SKIP LOCKED) AND consumed_at IS NULL AND consumer_id IS NULL
    RETURNING output_id::text AS "outputId"`, [worldId, producerId, SKILL_OUTPUT_EXPIRY_SECONDS, batch]);
  return result.rows?.length || 0;
}

// skillwork3: a world-wide pass of the same bounded sweep (oldest first, LIMIT 20, SKIP LOCKED), run by the
// world engine on its own timer, outside the tick transaction, as one autocommit statement. It expires
// outputs older than 48 world hours whether or not their producer is at the open cap (a producer that
// stopped producing never reaches the cap sweep). Off with MIRRORTERRA_OUTPUT_EXPIRY=off or with the skill
// library off.
export const SKILL_OUTPUT_GLOBAL_SWEEP_MS = 5 * 60 * 1000;
export async function sweepStaleOutputsGlobally(pool, { worldId, env = process.env }) {
  if (!worldId || !skillLibraryEnabled(env) || !outputExpiryEnabled(env)) return 0;
  return expireStaleOutputs(pool, { worldId, producerId: null });
}

function unit(value) {
  return createHash('sha256').update(String(value)).digest().readUInt32BE(0) / 0xffffffff;
}

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const num = (value, fallback) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  ? fallback : Number(value));
const deficit = (value, target) => clamp01((target - value) / target);

// Pure: maps the resident's existing needs, traits and goal to eight drive strengths in [0,1].
export function computeDrives(state = {}) {
  const energy = num(state.energy, 50), food = num(state.food, 50), social = num(state.social, 50);
  const happiness = num(state.happiness, 60), knowledge = num(state.knowledge, 20);
  const hygiene = num(state.hygiene, 80), fun = num(state.fun, 70);
  const risk = num(state.risk_tolerance ?? state.riskTolerance, 0.5);
  const sociability = num(state.sociability, 0.5), curiosity = num(state.curiosity, 0.5);
  const discipline = num(state.discipline, 0.5), ambition = num(state.ambition, 0.5);
  const goal = state.goal || 'balanced';
  const drives = {
    survival: Math.max(deficit(energy, 60), deficit(food, 60), deficit(hygiene, 50)) + (goal === 'wellbeing' ? 0.1 : 0),
    security: 0.15 + 0.5 * (1 - risk) + 0.2 * deficit(happiness, 50) + (goal === 'wealth' ? 0.2 : 0),
    belonging: 0.7 * deficit(social, 70) + 0.3 * sociability,
    esteem: 0.5 * ambition + 0.5 * deficit(happiness, 70),
    curiosity: 0.6 * curiosity + 0.4 * deficit(fun, 60) + (goal === 'learn' ? 0.2 : 0),
    creation: 0.4 * curiosity + 0.3 * ambition + 0.3 * deficit(fun, 60),
    mastery: 0.6 * discipline + 0.2 * ambition + 0.2 * deficit(knowledge, 60),
    contribution: 0.1 + 0.4 * sociability + 0.2 * ambition + (goal === 'community' ? 0.3 : 0)
  };
  for (const key of SKILL_DRIVES) drives[key] = Math.round(clamp01(drives[key]) * 1000) / 1000;
  return drives;
}

export function strongestDrives(drives, count = 3) {
  return SKILL_DRIVES.map((drive) => ({ drive, value: drives[drive] }))
    .sort((a, b) => b.value - a.value || a.drive.localeCompare(b.drive)).slice(0, count);
}

export function driveScore(skillDrives = [], drives = {}) {
  return (skillDrives || []).reduce((sum, drive) => sum + (Number(drives[drive]) || 0), 0);
}

// Pure: what using another resident's output gives the user. World-internal needs only.
export function outputNeedEffect(drive, quality) {
  const q = Math.max(1, Math.min(10, Number(quality) || 1));
  const effect = { energy: 0, food: 0, social: 0, happiness: 0, knowledge: 0, fun: 0 };
  if (drive === 'survival') { effect.food = 3 + q; effect.energy = 2 + Math.round(q / 2); }
  else if (drive === 'security') effect.happiness = 2;
  else if (drive === 'belonging') effect.social = 3 + q;
  else if (drive === 'esteem') effect.happiness = 2 + Math.round(q / 3);
  else if (drive === 'curiosity') effect.knowledge = 1 + Math.round(q / 3);
  else if (drive === 'creation') effect.fun = 3 + Math.round(q / 2);
  else if (drive === 'mastery') effect.knowledge = 1 + Math.round(q / 4);
  else if (drive === 'contribution') { effect.happiness = 2; effect.social = 1; }
  return effect;
}

export function libraryXpForLevel(level, tier = 3) {
  return XP_PER_LEVEL_UNIT * level * level * (TIER_XP_SCALE[tier] || 1);
}

export function libraryLevelForXp(xp, tier = 3) {
  const scaled = Math.max(0, Number(xp) || 0) / (XP_PER_LEVEL_UNIT * (TIER_XP_SCALE[tier] || 1));
  return Math.min(SKILL_LIBRARY_MAX_LEVEL, Math.floor(Math.sqrt(scaled)));
}

export function libraryPracticeGain({ agentId, skillId, practiceCount = 0, hadPartner = false }) {
  const jitter = unit(`${agentId}:${skillId}:${practiceCount}`) * 0.5;
  return Math.round((1 + jitter + (hadPartner ? 0.5 : 0)) * 100) / 100;
}

// Pure: ranks practised skills against one new candidate. Curiosity pays a novelty bonus to
// the new skill; long plateaus on an old skill read as boredom; mastery favours depth.
export const SKILL_PLACE_FOCUS_BONUS = 1.5;

export function rankSkillChoices({ learning = [], candidate = null, drives, agentId, salt = '', focusGroup = null }) {
  const focus = (skill) => (focusGroup && skill.rootGwa === focusGroup ? SKILL_PLACE_FOCUS_BONUS : 0);
  const scored = learning.map((skill) => ({ ...skill, isNew: false,
    score: driveScore(skill.drives, drives) + focus(skill)
      + drives.mastery * 0.5 * (Number(skill.level) || 0) / SKILL_LIBRARY_MAX_LEVEL
      - drives.curiosity * 0.3 * Math.min(1, (Number(skill.practiceCount) || 0) / 50)
      + unit(`${agentId}:${skill.skillId}:${skill.practiceCount}:${salt}`) * 0.15 }));
  if (candidate) scored.push({ ...candidate, isNew: true, xp: 0, level: 0, practiceCount: 0,
    score: driveScore(candidate.drives, drives) + drives.curiosity * 0.5 + focus(candidate)
      + unit(`${agentId}:${candidate.skillId}:new:${salt}`) * 0.15 });
  return scored.sort((a, b) => b.score - a.score || String(a.skillId).localeCompare(String(b.skillId)))
    .slice(0, SKILL_LIBRARY_PRACTICE_PER_ACTION);
}

async function loadDriveState(client, worldId, agentId) {
  const result = await client.query(`SELECT m.energy,m.food,m.social,s.happiness,s.knowledge,s.hygiene,s.fun,s.goal,
      s.risk_tolerance::float8 AS risk_tolerance,p.sociability::float8 AS sociability,p.curiosity::float8 AS curiosity,
      p.discipline::float8 AS discipline,p.ambition::float8 AS ambition
    FROM world_members m
    LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
    LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
    WHERE m.world_id=$1 AND m.agent_id=$2`, [worldId, agentId]);
  return result.rows[0] || {};
}

const DRIVE_SCORE_SQL = `(SELECT COALESCE(sum(($5::jsonb->>d)::float8),0) FROM unnest(l.drives) AS d)`;

async function chooseNextSkill(client, { worldId, agentId, action, drives, focusGroup = null }) {
  // Unlocked = top-level skills, or children of a skill this resident reached the unlock level in.
  // The drives the resident feels most decide which unlocked skill it reaches for next.
  const result = await client.query(`SELECT l.skill_id AS "skillId",l.name,l.tier,l.drives,l.root_gwa AS "rootGwa"
    FROM world_skill_library l
    WHERE $3 = ANY(l.actions)
      AND (l.parent_id IS NULL OR l.parent_id IN (SELECT p.skill_id FROM world_agent_library_skills p
        WHERE p.world_id=$1 AND p.agent_id=$2 AND p.level >= $4))
      AND NOT EXISTS (SELECT 1 FROM world_agent_library_skills q
        WHERE q.world_id=$1 AND q.agent_id=$2 AND q.skill_id=l.skill_id)
    ORDER BY ${DRIVE_SCORE_SQL} + l.tier*0.05 + CASE WHEN l.root_gwa = $6 THEN 3 ELSE 0 END DESC,
      md5(l.skill_id || $2::text) LIMIT 1`,
  [worldId, agentId, action, SKILL_LIBRARY_UNLOCK_LEVEL, JSON.stringify(drives), focusGroup]);
  return result.rows[0] || null;
}

async function practiceOne(client, { worldId, agentId, action, place, hadPartner, skill, scale, drives }) {
  if (skill.isNew) {
    await client.query(`INSERT INTO world_agent_library_skills(world_id,agent_id,skill_id,last_action)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [worldId, agentId, skill.skillId, action]);
  }
  const gain = Math.round(libraryPracticeGain({ agentId, skillId: skill.skillId,
    practiceCount: skill.practiceCount, hadPartner }) * scale * 100) / 100;
  const xp = Math.round((Number(skill.xp) + gain) * 100) / 100;
  const level = libraryLevelForXp(xp, skill.tier);
  const mastered = level >= SKILL_LIBRARY_MAX_LEVEL;
  await client.query(`UPDATE world_agent_library_skills SET xp=$4,level=$5,practice_count=practice_count+1,
      last_action=$6,last_practiced_at=now(),status=$7,
      mastered_at=CASE WHEN $7='mastered' THEN COALESCE(mastered_at,now()) ELSE mastered_at END
    WHERE world_id=$1 AND agent_id=$2 AND skill_id=$3`,
  [worldId, agentId, skill.skillId, xp, level, action, mastered ? 'mastered' : 'learning']);
  const started = Boolean(skill.isNew);
  const levelUp = level > Number(skill.level || 0);
  if (started || levelUp) {
    const type = started ? 'world.skill_started' : mastered ? 'world.skill_mastered' : 'world.skill_level_up';
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
    [worldId, agentId, type, { skillId: skill.skillId, skillName: skill.name, tier: skill.tier, level, action, place,
      drives: skill.drives || [], motivatedBy: strongestDrives(drives, 2).map((d) => d.drive),
      source: 'O*NET 31.0 (CC BY 4.0)' }, `${agentId}:skill:${skill.skillId}:${started ? 'start' : `L${level}`}`]);
  }
  return { skillId: skill.skillId, name: skill.name, tier: skill.tier, drives: skill.drives || [], xp, level,
    practiceCount: Number(skill.practiceCount || 0) + 1, started, levelUp, mastered };
}

// skillwork3: pure. When the practised skill is level 0, a resident still produces from the best skill it
// already holds: the highest-level (>= 1) held skill sharing at least one drive with the practised skill
// (ties: more xp, then skill id). null = nothing qualifies, so nothing is produced.
export function pickProductionSkill(practised, held = []) {
  if (!practised) return null;
  if (Number(practised.level) >= 1) return practised;
  const wanted = new Set(practised.drives || []);
  if (!wanted.size) return null;
  const candidates = (held || []).filter((row) => Number(row.level) >= 1
    && (row.drives || []).some((drive) => wanted.has(drive)));
  candidates.sort((a, b) => Number(b.level) - Number(a.level) || Number(b.xp || 0) - Number(a.xp || 0)
    || String(a.skillId).localeCompare(String(b.skillId)));
  const best = candidates[0];
  return best ? { skillId: best.skillId, name: best.name, tier: best.tier, drives: best.drives || [],
    xp: Number(best.xp) || 0, level: Number(best.level), practiceCount: practised.practiceCount, fallback: true } : null;
}

// One bounded, pkey-prefixed read (world_id, agent_id), only on a level-0 production beat (every 5th practice).
async function loadProductionFallback(client, { worldId, agentId, practised }) {
  if (!practised?.drives?.length) return null;
  const held = await client.query(`SELECT p.skill_id AS "skillId",p.level,p.xp::float8 AS xp,l.name,l.tier,l.drives
    FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
    WHERE p.world_id=$1 AND p.agent_id=$2 AND p.level >= 1 AND l.drives && $3::text[]
    ORDER BY p.level DESC,p.xp DESC,p.skill_id LIMIT 1`, [worldId, agentId, practised.drives]);
  return pickProductionSkill(practised, held.rows || []);
}

async function produceOutput(client, { worldId, agentId, skill: practised, drives, env = process.env }) {
  if (practised.practiceCount % SKILL_OUTPUT_EVERY !== 0 || !practised.drives.length) return null;
  // Old behaviour (MIRRORTERRA_OUTPUT_EXPIRY=off): a level-0 practised skill never produces.
  let skill = practised;
  if (practised.level < 1) {
    if (!outputExpiryEnabled(env)) return null;
    skill = await loadProductionFallback(client, { worldId, agentId, practised });
    if (!skill || skill.level < 1) return null;
  }
  const openCount = async () => (await client.query(`SELECT count(*)::int AS n FROM world_skill_outputs
    WHERE world_id=$1 AND producer_id=$2 AND consumed_at IS NULL`, [worldId, agentId])).rows[0].n;
  let open = await openCount();
  // skillwork2: the expiry write runs only when this producer is actually at the open cap (it is the only
  // case where expiry changes anything), so the common production path adds no write.
  if (open >= SKILL_OUTPUT_OPEN_CAP && outputExpiryEnabled(env)
    && await expireStaleOutputs(client, { worldId, producerId: agentId }) > 0) open = await openCount();
  if (open >= SKILL_OUTPUT_OPEN_CAP) return null;
  const drive = [...skill.drives].sort((a, b) => (drives[b] || 0) - (drives[a] || 0) || a.localeCompare(b))[0];
  const row = await client.query(`INSERT INTO world_skill_outputs(world_id,producer_id,skill_id,drive,quality)
    VALUES($1,$2,$3,$4,$5) RETURNING output_id::text AS "outputId"`,
  [worldId, agentId, skill.skillId, drive, Math.max(1, Math.min(10, skill.level))]);
  return { outputId: row.rows[0]?.outputId, skillId: skill.skillId, drive, quality: skill.level,
    ...(skill.fallback ? { fallbackFrom: practised.skillId } : {}) };
}

// The producer of an output another resident used earns 1 reward weight x quality (policy v2).
// A producer-actor event is the reward evidence; the reward is isolated in its own savepoint so a
// rejected contribution never undoes the consumption itself.
export async function rewardDeliveredOutput(client, { worldId, consumerId, output, env = process.env, extra = null }) {
  if (!syncEconomyEnabled(env)) return null;
  const actionId = `${output.producerId}:delivered:${output.outputId}`;
  const inserted = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.skill_output_delivered',$3,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING
    RETURNING id`, [worldId, output.producerId, { ...(extra && typeof extra === 'object' ? extra : {}),
    outputId: String(output.outputId), consumerId,
    skillId: output.skillId, drive: output.drive, quality: Number(output.quality),
    source: 'O*NET 31.0 (CC BY 4.0)' }, actionId]);
  let eventId = inserted.rows?.[0]?.id ?? null;
  if (eventId === null) {
    const prior = await client.query(`SELECT id FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3`,
      [worldId, output.producerId, actionId]);
    eventId = prior.rows?.[0]?.id ?? null;
  }
  if (eventId === null) return null;
  try { await client.query('SAVEPOINT world_skill_output_reward'); } catch { return null; }
  try {
    // Treasury first while it holds enough (MIRRORTERRA_COUNCIL); otherwise the unchanged pool path.
    const contribution = await issueResidentReward(client, { worldId, agentId: output.producerId,
      sourceType: 'skill_output', sourceEventId: eventId, sourceEntityId: String(output.outputId),
      rewardWeight: skillOutputRewardWeight(output.quality) }, { env });
    await client.query('RELEASE SAVEPOINT world_skill_output_reward');
    return { eventId, ...contribution };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT world_skill_output_reward');
      await client.query('RELEASE SAVEPOINT world_skill_output_reward');
    } catch { /* The enclosing savepoint reports its own failure. */ }
    return { eventId, rewardError: String(error?.code || 'SYNC_REWARD_ENQUEUE_FAILED').slice(0, 80) };
  }
}

async function useOthersOutput(client, { worldId, agentId, drives, place, env = process.env }) {
  // skillwork (fix 3): match any of the top-3 drives (>= the minimum), strongest first, and never an
  // expired output. With MIRRORTERRA_OUTPUT_EXPIRY=off: the strongest drive only, no age limit (old).
  const expiry = outputExpiryEnabled(env);
  const wanted = consumerDrives(drives, { multi: expiry });
  if (!wanted.length) return null;
  const claimed = await client.query(`UPDATE world_skill_outputs SET consumer_id=$2,consumed_at=now()
    WHERE output_id=(SELECT o.output_id FROM world_skill_outputs o
      WHERE o.world_id=$1 AND o.drive=ANY($3::text[]) AND o.consumed_at IS NULL AND o.producer_id<>$2
        AND ($4::int IS NULL OR o.created_at >= now() - make_interval(secs => $4::int))
      ORDER BY array_position($3::text[], o.drive),o.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING output_id::text AS "outputId",producer_id AS "producerId",skill_id AS "skillId",drive,quality`,
  [worldId, agentId, wanted, expiry ? SKILL_OUTPUT_EXPIRY_SECONDS : null]);
  const output = claimed.rows[0];
  if (!output) return null;
  const effect = outputNeedEffect(output.drive, output.quality);
  await client.query(`UPDATE world_members SET energy=LEAST(100,energy+$3),food=LEAST(100,food+$4),
      social=LEAST(100,social+$5) WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agentId, effect.energy, effect.food, effect.social]);
  await client.query(`UPDATE world_agent_states SET happiness=LEAST(100,happiness+$3),
      knowledge=LEAST(100,knowledge+$4),fun=LEAST(100,fun+$5) WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agentId, effect.happiness, effect.knowledge, effect.fun]);
  await client.query(`UPDATE world_agent_states SET happiness=LEAST(100,happiness+1)
    WHERE world_id=$1 AND agent_id=$2`, [worldId, output.producerId]);
  const name = await client.query(`SELECT name FROM world_skill_library WHERE skill_id=$1`, [output.skillId]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.skill_output_used',$3,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, { outputId: output.outputId, producerId: output.producerId, skillId: output.skillId,
    skillName: name.rows[0]?.name || null, drive: output.drive, quality: output.quality, effect, place,
    source: 'O*NET 31.0 (CC BY 4.0)' }, `${agentId}:use:${output.outputId}`]);
  const reward = await rewardDeliveredOutput(client, { worldId, consumerId: agentId, output, env });
  return { ...output, effect, ...(reward ? { reward } : {}) };
}

// skillwork (fix 2): construction/repair work practises one of the builder's own library skills
// (the most relevant one they already hold, else a top-level one, which is always unlocked). Pure XP and
// level-up events; it never produces an output. Isolated in its own savepoint by the caller.
export async function practiceChosenLibrarySkill(client, { worldId, agentId, skillIds = [], place = null, action = 'work' }) {
  const ids = [...new Set((skillIds || []).filter(Boolean))];
  if (!ids.length) return null;
  const held = await client.query(`SELECT p.skill_id AS "skillId",p.xp::float8 AS xp,p.level,p.practice_count AS "practiceCount",
      l.name,l.tier,l.drives,p.status
    FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
    WHERE p.world_id=$1 AND p.agent_id=$2 AND p.skill_id=ANY($3::text[])`, [worldId, agentId, ids]);
  const byId = new Map(held.rows.map((row) => [row.skillId, row]));
  let skill = ids.map((id) => byId.get(id)).find((row) => row && row.status !== 'mastered') || null;
  if (!skill && !ids.some((id) => byId.has(id))) {
    const fresh = await client.query(`SELECT skill_id AS "skillId",name,tier,drives FROM world_skill_library
      WHERE skill_id=ANY($1::text[]) AND parent_id IS NULL ORDER BY array_position($1::text[], skill_id) LIMIT 1`, [ids]);
    if (fresh.rows[0]) skill = { ...fresh.rows[0], isNew: true, xp: 0, level: 0, practiceCount: 0 };
  }
  if (!skill) return null;
  const drives = computeDrives(await loadDriveState(client, worldId, agentId));
  return practiceOne(client, { worldId, agentId, action, place, hadPartner: false, drives,
    skill: { ...skill, xp: Number(skill.xp) || 0, level: Number(skill.level) || 0,
      practiceCount: Number(skill.practiceCount) || 0, drives: skill.drives || [] }, scale: 1 });
}

export async function practiceLibrarySkill(client, { worldId, agentId, action, place = null, hadPartner = false,
  env = process.env }) {
  if (!SKILL_LIBRARY_ACTIONS.includes(action)) return null;
  // A place founded for a skill family focuses practice on that family, using the family's own action.
  let focusGroup = null;
  if (typeof place === 'string' && place.startsWith('home:') && action === 'work') focusGroup = 'onet:gwa:4.A.3.a.2';
  else if (place) {
    const scene = await client.query(`SELECT features->>'skillGroup' AS "skillGroup",features->>'action' AS action
      FROM world_scenes WHERE world_id=$1 AND name=$2 LIMIT 1`, [worldId, place]);
    focusGroup = scene.rows[0]?.skillGroup || null;
    if (focusGroup && SKILL_LIBRARY_ACTIONS.includes(scene.rows[0].action)) action = scene.rows[0].action;
  }
  const drives = computeDrives(await loadDriveState(client, worldId, agentId));
  const learning = await client.query(`SELECT p.skill_id AS "skillId",p.xp::float8 AS xp,p.level,
      p.practice_count AS "practiceCount",l.name,l.tier,l.drives,l.root_gwa AS "rootGwa"
    FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
    WHERE p.world_id=$1 AND p.agent_id=$2 AND p.status='learning' AND $3 = ANY(l.actions)
    ORDER BY ${DRIVE_SCORE_SQL.replace('$5', '$4')} + CASE WHEN l.root_gwa = $5 THEN 3 ELSE 0 END DESC,
      p.last_practiced_at ASC NULLS FIRST LIMIT 12`,
  [worldId, agentId, action, JSON.stringify(drives), focusGroup]);
  const candidate = await chooseNextSkill(client, { worldId, agentId, action, drives, focusGroup });
  const chosen = rankSkillChoices({ learning: learning.rows, candidate, drives, agentId, focusGroup,
    salt: learning.rows.reduce((sum, row) => sum + Number(row.practiceCount || 0), 0) });
  if (!chosen.length) return null;
  const practiced = [];
  for (const [index, skill] of chosen.entries()) {
    practiced.push(await practiceOne(client, { worldId, agentId, action, place, hadPartner, skill, drives,
      scale: index === 0 ? 1 : SECONDARY_PRACTICE_SCALE }));
  }
  const produced = await produceOutput(client, { worldId, agentId, skill: practiced[0], drives, env });
  const used = await useOthersOutput(client, { worldId, agentId, drives, place, env });
  const first = practiced[0];
  return { ...first, practiced, drives, produced, used };
}

// Never lets the skill library break a world tick: isolated in a savepoint, and a
// missing table or any error simply skips library progress for this action.
export async function practiceLibrarySkillSafely(client, input, env = process.env) {
  if (!skillLibraryEnabled(env)) return null;
  try { await client.query('SAVEPOINT world_skill_library'); }
  catch { return null; }
  try {
    const result = await practiceLibrarySkill(client, { env, ...input });
    await client.query('RELEASE SAVEPOINT world_skill_library');
    return result;
  } catch {
    try {
      await client.query('ROLLBACK TO SAVEPOINT world_skill_library');
      await client.query('RELEASE SAVEPOINT world_skill_library');
    } catch { /* The surrounding transaction reports its own failure. */ }
    return null;
  }
}

export async function readResidentLibrarySkills(pool, { worldId, agentId, limit = 8 }) {
  try {
    const [skills, totals] = await Promise.all([
      pool.query(`SELECT l.name,l.tier,p.level,p.status,p.practice_count AS "practiceCount"
        FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
        WHERE p.world_id=$1 AND p.agent_id=$2
        ORDER BY (p.status='learning') DESC,p.level DESC,p.last_practiced_at DESC NULLS LAST LIMIT $3`,
      [worldId, agentId, limit]),
      pool.query(`SELECT count(*) FILTER (WHERE status='mastered')::int AS mastered,
          count(*) FILTER (WHERE status='learning')::int AS learning,
          (SELECT count(*)::int FROM world_skill_library) AS "libraryTotal"
        FROM world_agent_library_skills WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId])
    ]);
    const base = { source: 'O*NET 31.0 Database, U.S. Department of Labor, CC BY 4.0',
      ...totals.rows[0], skills: skills.rows };
    try {
      const [state, outputs] = await Promise.all([
        loadDriveState(pool, worldId, agentId),
        pool.query(`SELECT count(*) FILTER (WHERE producer_id=$2)::int AS made,
            count(*) FILTER (WHERE producer_id=$2 AND consumer_id IS NOT NULL)::int AS "usedByOthers",
            count(*) FILTER (WHERE consumer_id=$2)::int AS "usedFromOthers"
          FROM world_skill_outputs WHERE world_id=$1 AND (producer_id=$2 OR consumer_id=$2)`, [worldId, agentId])
      ]);
      return { ...base, drives: strongestDrives(computeDrives(state), 3), outputs: outputs.rows[0] };
    } catch {
      return base;
    }
  } catch {
    return null;
  }
}
