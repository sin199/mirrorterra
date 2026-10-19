import { createHash } from 'node:crypto';

// Real-world skill library (O*NET 31.0, CC BY 4.0). Skills are data compiled to the
// four base world actions; practising one only changes world-internal progress rows.
export const SKILL_LIBRARY_ACTIONS = Object.freeze(['learn', 'work', 'cooperate', 'socialize']);
export const SKILL_LIBRARY_MAX_ACTIVE = 3;
export const SKILL_LIBRARY_MAX_LEVEL = 10;
export const SKILL_LIBRARY_UNLOCK_LEVEL = 3;
const XP_PER_LEVEL_UNIT = 20;
const TIER_XP_SCALE = Object.freeze({ 1: 1.5, 2: 1.2, 3: 1, 4: 0.6 });

export function skillLibraryEnabled(env = process.env) {
  return String(env.MIRRORTERRA_SKILL_LIBRARY ?? 'on').toLowerCase() !== 'off';
}

function unit(value) {
  return createHash('sha256').update(String(value)).digest().readUInt32BE(0) / 0xffffffff;
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

async function chooseNextSkill(client, { worldId, agentId, action }) {
  // Unlocked = top-level skills, or children of a skill this resident reached the unlock level in.
  // Prefer the deepest unlocked tier so residents specialise along what they actually do.
  const result = await client.query(`SELECT l.skill_id AS "skillId",l.name,l.tier
    FROM world_skill_library l
    WHERE $3 = ANY(l.actions)
      AND (l.parent_id IS NULL OR l.parent_id IN (SELECT p.skill_id FROM world_agent_library_skills p
        WHERE p.world_id=$1 AND p.agent_id=$2 AND p.level >= $4))
      AND NOT EXISTS (SELECT 1 FROM world_agent_library_skills q
        WHERE q.world_id=$1 AND q.agent_id=$2 AND q.skill_id=l.skill_id)
    ORDER BY l.tier DESC, md5(l.skill_id || $2::text) LIMIT 1`,
  [worldId, agentId, action, SKILL_LIBRARY_UNLOCK_LEVEL]);
  return result.rows[0] || null;
}

export async function practiceLibrarySkill(client, { worldId, agentId, action, place = null, hadPartner = false }) {
  if (!SKILL_LIBRARY_ACTIONS.includes(action)) return null;
  const active = await client.query(`SELECT p.skill_id AS "skillId",p.xp::float8 AS xp,p.level,
      p.practice_count AS "practiceCount",l.name,l.tier
    FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
    WHERE p.world_id=$1 AND p.agent_id=$2 AND p.status='learning' AND $3 = ANY(l.actions)
    ORDER BY p.last_practiced_at DESC NULLS LAST,p.started_at DESC LIMIT 1`, [worldId, agentId, action]);
  let skill = active.rows[0] || null;
  let started = false;
  if (!skill) {
    const count = await client.query(`SELECT count(*)::int AS n FROM world_agent_library_skills
      WHERE world_id=$1 AND agent_id=$2 AND status='learning'`, [worldId, agentId]);
    if (count.rows[0].n >= SKILL_LIBRARY_MAX_ACTIVE) return null;
    const next = await chooseNextSkill(client, { worldId, agentId, action });
    if (!next) return null;
    await client.query(`INSERT INTO world_agent_library_skills(world_id,agent_id,skill_id,last_action)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [worldId, agentId, next.skillId, action]);
    skill = { ...next, xp: 0, level: 0, practiceCount: 0 };
    started = true;
  }
  const gain = libraryPracticeGain({ agentId, skillId: skill.skillId, practiceCount: skill.practiceCount, hadPartner });
  const xp = Math.round((Number(skill.xp) + gain) * 100) / 100;
  const level = libraryLevelForXp(xp, skill.tier);
  const mastered = level >= SKILL_LIBRARY_MAX_LEVEL;
  await client.query(`UPDATE world_agent_library_skills SET xp=$4,level=$5,practice_count=practice_count+1,
      last_action=$6,last_practiced_at=now(),status=$7,
      mastered_at=CASE WHEN $7='mastered' THEN COALESCE(mastered_at,now()) ELSE mastered_at END
    WHERE world_id=$1 AND agent_id=$2 AND skill_id=$3`,
  [worldId, agentId, skill.skillId, xp, level, action, mastered ? 'mastered' : 'learning']);
  const levelUp = level > Number(skill.level || 0);
  if (started || levelUp) {
    const type = started ? 'world.skill_started' : mastered ? 'world.skill_mastered' : 'world.skill_level_up';
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
    [worldId, agentId, type, { skillId: skill.skillId, skillName: skill.name, tier: skill.tier, level, action, place,
      source: 'O*NET 31.0 (CC BY 4.0)' }, `${agentId}:skill:${skill.skillId}:${started ? 'start' : `L${level}`}`]);
  }
  return { skillId: skill.skillId, name: skill.name, tier: skill.tier, xp, level, started, levelUp, mastered };
}

// Never lets the skill library break a world tick: isolated in a savepoint, and a
// missing table or any error simply skips library progress for this action.
export async function practiceLibrarySkillSafely(client, input, env = process.env) {
  if (!skillLibraryEnabled(env)) return null;
  try { await client.query('SAVEPOINT world_skill_library'); }
  catch { return null; }
  try {
    const result = await practiceLibrarySkill(client, input);
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
    return { source: 'O*NET 31.0 Database, U.S. Department of Labor, CC BY 4.0',
      ...totals.rows[0], skills: skills.rows };
  } catch {
    return null;
  }
}
