// skillwork: residents' real skills drive world-building.
//  fix 1 (MIRRORTERRA_SKILL_MATERIALS): a public work under construction consumes suitable unused skill
//    outputs of other residents as building materials. Each one adds a small, bounded amount of progress,
//    and its producer earns the normal used-output reward through the existing path (rewardDeliveredOutput
//    -> issueResidentReward, 0.1 x quality, external residents 0). No new money source.
//  fix 2 (MIRRORTERRA_SKILL_BUILDERS): bids and awards weight the resident's O*NET skill-library levels
//    in construction/repair work (not the legacy world_agent_skills, which are all 100), a fairness
//    factor spreads awards, and construction sessions practise the builder's relevant library skill.
// Unset = on; 'off' restores the old behaviour. Every database step runs in its own savepoint and can
// never break a world tick.
import { gambitsEnabled } from './gambit-flags.js';
import { SKILL_OUTPUT_EXPIRY_SECONDS, outputExpiryEnabled, practiceChosenLibrarySkill, rewardDeliveredOutput }
  from './world-skill-library.js';

const flag = (env, name) => String(env?.[name] ?? 'on').toLowerCase() !== 'off';
export const skillMaterialsEnabled = (env = process.env) => flag(env, 'MIRRORTERRA_SKILL_MATERIALS');
export const skillBuildersEnabled = (env = process.env) => flag(env, 'MIRRORTERRA_SKILL_BUILDERS');

const gwa = (code) => `onet:gwa:4.A.${code}`;
const iwa = (code) => `onet:iwa:4.A.${code}`;

// ---- which library skills matter for a job --------------------------------------------------------
// Root O*NET Generalized Work Activities relevant to building / expanding, and to repairing. A child
// skill (tier 2-4) counts with its root's weight.
export const BUILD_SKILL_ROOTS = Object.freeze({
  build: Object.freeze({ [gwa('3.a.2')]: 1, [gwa('3.a.1')]: 1, [gwa('3.b.2')]: 1, [gwa('3.a.3')]: 0.8,
    [gwa('1.b.2')]: 0.6, [gwa('3.b.4')]: 0.6, [gwa('3.b.5')]: 0.4, [gwa('3.a.4')]: 0.4 }),
  repair: Object.freeze({ [gwa('3.b.4')]: 1, [gwa('1.b.2')]: 1, [gwa('3.b.5')]: 0.8, [gwa('3.a.2')]: 0.8,
    [gwa('3.a.1')]: 0.7, [gwa('3.a.3')]: 0.6, [gwa('3.b.2')]: 0.5, [gwa('3.a.4')]: 0.3 })
});
// A smaller domain bonus from the legacy job class (a park/clinic is social, a school research, ...).
export const REQUIRED_SKILL_ROOTS = Object.freeze({
  engineering: Object.freeze({}),
  social: Object.freeze({ [gwa('4.a.5')]: 0.4, [gwa('4.b.1')]: 0.4 }),
  research: Object.freeze({ [gwa('2.b.2')]: 0.4, [gwa('2.a.4')]: 0.4 }),
  trading: Object.freeze({ [gwa('4.a.6')]: 0.4, [gwa('4.c.3')]: 0.4 })
});
// O*NET work activities that ARE construction / repair count 1.5x.
export const DIRECT_BUILD_SKILLS = Object.freeze(new Set([
  iwa('3.a.1.g'), // Perform general construction or extraction activities
  iwa('3.a.2.a'), // Build structures
  iwa('3.b.2.b'), // Design structures or facilities
  iwa('3.a.3.c'), // Operate construction or excavation equipment
  iwa('4.b.4.i'), // Direct construction or extraction activities
  iwa('3.b.4.a'), // Maintain facilities or equipment
  iwa('1.b.2.e'), // Inspect facilities or equipment
  iwa('3.a.2.ao'), // Position materials or components for assembly
  iwa('3.a.2.l'), // Cut materials
  iwa('3.a.2.am') // Apply materials to fill gaps or imperfections
]));
export const DIRECT_BUILD_FACTOR = 1.5;
export const BUILD_SKILL_TOP = 5;
export const BUILD_SKILL_FULL_SUM = 25; // five relevant skills at level 5 = score 100

export function jobRoots({ workType = 'build', requiredSkill = 'engineering' } = {}) {
  const base = workType === 'repair' ? BUILD_SKILL_ROOTS.repair : BUILD_SKILL_ROOTS.build;
  const extra = REQUIRED_SKILL_ROOTS[requiredSkill] || {};
  const roots = { ...base };
  for (const [root, weight] of Object.entries(extra)) roots[root] = Math.max(roots[root] || 0, weight);
  return roots;
}

export function buildSkillWeight(skill, job = {}) {
  const roots = jobRoots(job);
  const root = skill?.rootGwa || skill?.root_gwa || skill?.skillId;
  const weight = Number(roots[root]) || 0;
  if (!weight) return 0;
  return weight * (DIRECT_BUILD_SKILLS.has(skill?.skillId) ? DIRECT_BUILD_FACTOR : 1);
}

// Pure: the builder skill score (0-100) for a job from the resident's library skills: the sum of the top
// five weighted levels, scaled so that five relevant skills at level 5 make 100.
export function builderSkillScore(skills = [], job = {}) {
  const weighted = (skills || []).map((skill) => {
    const weight = buildSkillWeight(skill, job);
    const level = Math.max(0, Math.min(10, Number(skill?.level) || 0));
    return { skillId: skill.skillId, name: skill.name || null, level, weight, value: weight * level };
  }).filter((skill) => skill.weight > 0 && skill.value > 0)
    .sort((a, b) => b.value - a.value || String(a.skillId).localeCompare(String(b.skillId)));
  const top = weighted.slice(0, BUILD_SKILL_TOP);
  const sum = top.reduce((total, skill) => total + skill.value, 0);
  return { score: Math.min(100, Math.round(sum / BUILD_SKILL_FULL_SUM * 10000) / 100), top };
}

// Pure: which skill a construction session practises: the most relevant held, non-mastered skill (by
// weight, then lowest level so practice spreads), else the job's top-weighted root (always unlocked).
export function practiceSkillOrder(skills = [], job = {}) {
  const held = (skills || []).map((skill) => ({ ...skill, weight: buildSkillWeight(skill, job) }))
    .filter((skill) => skill.weight > 0 && skill.status !== 'mastered')
    .sort((a, b) => b.weight - a.weight || (Number(a.level) || 0) - (Number(b.level) || 0)
      || String(a.skillId).localeCompare(String(b.skillId)))
    .map((skill) => skill.skillId);
  const roots = Object.entries(jobRoots(job)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([root]) => root);
  return [...new Set([...held, ...roots])];
}

export async function readBuilderSkills(client, { worldId, agentId, job = {} }) {
  const roots = Object.keys(jobRoots(job));
  const rows = await client.query(`SELECT p.skill_id AS "skillId",l.name,l.tier,l.root_gwa AS "rootGwa",p.level,p.status
    FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
    WHERE p.world_id=$1 AND p.agent_id=$2 AND (l.root_gwa=ANY($3::text[]) OR l.skill_id=ANY($3::text[]))`,
  [worldId, agentId, roots]);
  return rows.rows || [];
}

export async function readBuilderScore(client, { worldId, agentId, workType = 'build', requiredSkill = 'engineering' }) {
  const job = { workType, requiredSkill };
  const skills = await readBuilderSkills(client, { worldId, agentId, job });
  return { ...builderSkillScore(skills, job), skills };
}

export function describeBuilderScore({ score = 0, top = [] } = {}, max = 3) {
  const names = top.slice(0, max).map((skill) => `${String(skill.name || skill.skillId).slice(0, 40)} L${skill.level}`);
  return `build skill ${Math.round(score)}${names.length ? ` (${names.join(', ')})` : ' (no construction skills yet)'}`;
}

// ---- fairness -------------------------------------------------------------------------------------
// A resident who won one of the last FAIRNESS_RECENT_AWARDS awards in the same category (repair / build /
// expand) has their effective cost raised by 30% per such win; one active contract adds 20%; two or more
// active contracts skip them. It never cancels a tender on its own: the cheapest adjusted bid still wins.
export const FAIRNESS_RECENT_AWARDS = 4;
export const FAIRNESS_RECENT_WIN_FACTOR = 1.3;
export const FAIRNESS_ACTIVE_JOB_FACTOR = 1.2;
export const FAIRNESS_MAX_ACTIVE = 2;

export function fairnessFactor({ agentId, recentWinners = [], active = 0 } = {}) {
  if (Number(active) >= FAIRNESS_MAX_ACTIVE) return null;
  const wins = (recentWinners || []).filter((id) => id === agentId).length;
  const factor = FAIRNESS_RECENT_WIN_FACTOR ** wins * (Number(active) >= 1 ? FAIRNESS_ACTIVE_JOB_FACTOR : 1);
  return Math.round(factor * 1000) / 1000;
}

export async function readRecentAwardWinners(client, { worldId, workType = 'build', excludeWorkId = null,
  limit = FAIRNESS_RECENT_AWARDS }) {
  const rows = await client.query(`SELECT work.builder_agent_id::text AS agent_id FROM world_public_works work
    LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.awarded_world_minute IS NOT NULL AND work.builder_agent_id IS NOT NULL
      AND COALESCE(meta.work_type,CASE WHEN work.kind='expansion' THEN 'expand' ELSE 'build' END)=$2
      AND ($3::uuid IS NULL OR work.id<>$3::uuid)
    ORDER BY work.awarded_world_minute DESC,work.id LIMIT $4`, [worldId, workType, excludeWorkId, limit]);
  return (rows.rows || []).map((row) => row.agent_id);
}

// ---- fix 1: skill outputs as building materials ----------------------------------------------------
export const MATERIAL_DRIVES = Object.freeze(['creation', 'mastery', 'contribution']);
// Survival outputs feed residents' food and energy; they are never taken for building.
export const MATERIAL_EXCLUDED_DRIVES = Object.freeze(['survival']);
// Outputs of craft / engineering skills qualify whatever their drive (except survival).
export const CRAFT_ENGINEERING_ROOTS = Object.freeze(Object.keys(BUILD_SKILL_ROOTS.build));
export const MATERIALS_PER_SESSION = 2;
export const MATERIAL_MAX_BONUS_PER_SESSION = 6;  // progress points per construction session
export const MATERIALS_PER_WORK_MAX = 12;         // outputs one work can absorb in total

// Pure: progress points one output adds (quality 1-2 -> 1, 3-5 -> 2, 6-8 -> 3, 9-10 -> 4).
export function materialBonus(quality) {
  const q = Math.max(1, Math.min(10, Math.trunc(Number(quality) || 1)));
  return Math.min(4, 1 + Math.floor(q / 3));
}

// Pure: bounded bonuses for the claimed outputs: at most MATERIAL_MAX_BONUS_PER_SESSION per session and
// never past 100% progress.
export function boundedMaterialBonuses(qualities = [], remaining = 100) {
  let left = Math.max(0, Math.min(MATERIAL_MAX_BONUS_PER_SESSION, Math.trunc(Number(remaining) || 0)));
  return (qualities || []).map((quality) => {
    const bonus = Math.min(left, materialBonus(quality));
    left -= bonus;
    return bonus;
  });
}

// Pure: how many outputs this session may claim.
export function materialsAllowed({ used = 0, remaining = 100 } = {}) {
  if (Number(remaining) <= 0) return 0;
  return Math.max(0, Math.min(MATERIALS_PER_SESSION, MATERIALS_PER_WORK_MAX - (Number(used) || 0)));
}

export function materialsUsedOf(work) {
  const materials = work?.position?.materials;
  return Math.max(0, Number(materials?.count) || 0);
}

async function reservationsReady(client) {
  const result = await client.query(`SELECT to_regclass('public.world_material_reservations') IS NOT NULL AS ok`);
  return Boolean(result.rows?.[0]?.ok);
}

async function recordEvent(client, { worldId, actorId, type, actionId, data }) {
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, actorId, type, JSON.stringify(data), String(actionId).slice(0, 180)]);
}

// Claims up to two suitable unused outputs of other residents for this work (rows being claimed elsewhere
// are skipped), records the work <-> output link, and rewards each producer through the existing path.
// The builder is the output's consumer (consumer_id), so the 0027 reward evidence rules hold unchanged.
export async function consumeBuildMaterials(client, { worldId, work, builderId, remaining, worldMinutes, env = process.env }) {
  const none = { consumed: [], bonus: 0 };
  if (!skillMaterialsEnabled(env)) return none;
  const allowed = materialsAllowed({ used: materialsUsedOf(work), remaining });
  if (!allowed) return none;
  const expiry = outputExpiryEnabled(env);
  // gambit1 P2: with resident gambits on, an output a resident sold to a builder is reserved for that builder:
  // others skip it and the buyer takes it first. Switch off: the exact modelab1 query.
  const reserved = gambitsEnabled(env) && await reservationsReady(client);
  const claimed = await client.query(`UPDATE world_skill_outputs o SET consumer_id=$2,consumed_at=now()
    FROM world_skill_library l
    WHERE o.output_id IN (SELECT c.output_id FROM world_skill_outputs c JOIN world_skill_library cl ON cl.skill_id=c.skill_id
        WHERE c.world_id=$1 AND c.consumed_at IS NULL AND c.producer_id<>$2 AND NOT (c.drive=ANY($5::text[]))
          AND (c.drive=ANY($3::text[]) OR cl.root_gwa=ANY($4::text[]))
          AND ($6::int IS NULL OR c.created_at >= now() - make_interval(secs => $6::int))${reserved ? `
          AND NOT EXISTS (SELECT 1 FROM world_material_reservations r WHERE r.world_id=c.world_id AND r.output_id=c.output_id AND r.buyer_id<>$2)` : ''}
        ORDER BY ${reserved ? `EXISTS (SELECT 1 FROM world_material_reservations r WHERE r.world_id=c.world_id AND r.output_id=c.output_id AND r.buyer_id=$2) DESC,` : ''}(cl.root_gwa=ANY($4::text[])) DESC,COALESCE(array_position($3::text[],c.drive),99),c.created_at
        LIMIT $7 FOR UPDATE OF c SKIP LOCKED)
      AND l.skill_id=o.skill_id AND o.consumed_at IS NULL
    RETURNING o.output_id::text AS "outputId",o.producer_id::text AS "producerId",o.skill_id AS "skillId",o.drive,
      o.quality,l.name AS "skillName",l.root_gwa AS "rootGwa"`,
  [worldId, builderId, MATERIAL_DRIVES, CRAFT_ENGINEERING_ROOTS, MATERIAL_EXCLUDED_DRIVES,
    expiry ? SKILL_OUTPUT_EXPIRY_SECONDS : null, allowed]);
  const outputs = claimed.rows || [];
  if (!outputs.length) return none;
  const bonuses = boundedMaterialBonuses(outputs.map((output) => output.quality), remaining);
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const consumed = [];
  for (const [index, output] of outputs.entries()) {
    const bonus = bonuses[index];
    const craft = CRAFT_ENGINEERING_ROOTS.includes(output.rootGwa);
    const link = { publicWorkId: String(work.id), use: 'public_work_material' };
    await recordEvent(client, { worldId, actorId: builderId, type: 'world.skill_output_used',
      actionId: `${builderId}:use:${output.outputId}`, data: { outputId: output.outputId, producerId: output.producerId,
        skillId: output.skillId, skillName: output.skillName || null, drive: output.drive, quality: Number(output.quality),
        effect: { progress: bonus }, place: work.scene_name || null, ...link, workName: work.name,
        source: 'O*NET 31.0 (CC BY 4.0)' } });
    await recordEvent(client, { worldId, actorId: builderId, type: 'world.public_work_material',
      actionId: `public-work:${work.id}:material:${output.outputId}`, data: { workId: String(work.id), name: work.name,
        outputId: output.outputId, producerId: output.producerId, skillId: output.skillId, skillName: output.skillName || null,
        drive: output.drive, quality: Number(output.quality), craft, progressBonus: bonus, worldMinutes: minute } });
    const reward = await rewardDeliveredOutput(client, { worldId, consumerId: builderId, env, extra: link,
      output: { outputId: output.outputId, producerId: output.producerId, skillId: output.skillId, drive: output.drive,
        quality: Number(output.quality) } });
    consumed.push({ outputId: output.outputId, producerId: output.producerId, skillId: output.skillId, drive: output.drive,
      quality: Number(output.quality), craft, bonus, ...(reward ? { reward: { created: reward.created ?? null,
        skipped: reward.skipped || null, error: reward.rewardError || null } } : {}) });
  }
  return { consumed, bonus: bonuses.reduce((sum, value) => sum + value, 0) };
}

async function inSavepoint(client, name, fn, fallback) {
  try { await client.query(`SAVEPOINT ${name}`); } catch { return fallback; }
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    } catch { /* The enclosing transaction reports its own failure. */ }
    return fallback;
  }
}

export function consumeBuildMaterialsSafely(client, input) {
  if (!skillMaterialsEnabled(input?.env || process.env)) return Promise.resolve({ consumed: [], bonus: 0 });
  return inSavepoint(client, 'public_work_materials', () => consumeBuildMaterials(client, input), { consumed: [], bonus: 0 });
}

// fix 2: a construction / repair session practises the builder's most relevant library skill.
export function practiceBuildSkillSafely(client, { worldId, agentId, workType, requiredSkill, place = null, env = process.env }) {
  if (!skillBuildersEnabled(env)) return Promise.resolve(null);
  return inSavepoint(client, 'public_work_skill_xp', async () => {
    const job = { workType, requiredSkill };
    const skills = await readBuilderSkills(client, { worldId, agentId, job });
    return practiceChosenLibrarySkill(client, { worldId, agentId, skillIds: practiceSkillOrder(skills, job), place, action: 'work' });
  }, null);
}

// fix 2: the builder score a bid uses (library skills), or null so the caller falls back to legacy.
// Inside a transaction the read runs in a savepoint; on a pool (no transaction) a plain try/catch.
export async function readBuilderScoreSafely(client, input, { inTransaction = true } = {}) {
  if (inTransaction) return inSavepoint(client, 'public_work_builder_score', () => readBuilderScore(client, input), null);
  try { return await readBuilderScore(client, input); } catch { return null; }
}
