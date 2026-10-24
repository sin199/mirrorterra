// skillwork: residents' skills drive world-building (unit tests, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_SKILL_FULL_SUM, MATERIALS_PER_SESSION, MATERIALS_PER_WORK_MAX, MATERIAL_MAX_BONUS_PER_SESSION,
  boundedMaterialBonuses, builderSkillScore, consumeBuildMaterials, consumeBuildMaterialsSafely, fairnessFactor,
  materialBonus, materialsAllowed, practiceSkillOrder, skillBuildersEnabled, skillMaterialsEnabled }
  from '../src/public-works-skills.js';
import { advancePublicWork, bidSkill, chooseWinningBid, effectiveBidCost, heuristicBid } from '../src/public-works.js';
import { SKILL_OUTPUT_EXPIRY_BATCH, SKILL_OUTPUT_EXPIRY_SECONDS, SKILL_OUTPUT_GLOBAL_SWEEP_MS, consumerDrives, expireStaleOutputs,
  outputExpired, outputExpiryEnabled, pickProductionSkill, practiceLibrarySkill, sweepStaleOutputsGlobally }
  from '../src/world-skill-library.js';
import { LUNA_BACKOFF_CAP_MS, LUNA_BACKOFF_START_MS, LUNA_QUOTA_BACKOFF_CODE, createQuotaBackoff, isQuotaError,
  lunaQuotaBackoffEnabled } from '../src/agent-runtime/open-cognition/quota-backoff.js';
import { configuredCognitionCatalog, createCognitionModelRouter } from '../src/agent-runtime/open-cognition/provider.js';

const BUILDER = '00000000-0000-4000-8000-0000000000b1';
const PRODUCER = '00000000-0000-4000-8000-0000000000c1';
const WORK = '00000000-0000-4000-8000-0000000000d1';

function fakeClient(script) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    for (const [match, rows] of script) if (sql.includes(match)) {
      if (rows instanceof Error) throw rows;
      const value = typeof rows === 'function' ? rows(params, sql) : rows;
      return { rows: value, rowCount: value.length };
    }
    return { rows: [], rowCount: 0 };
  } };
}

// ---- fix 1: materials -------------------------------------------------------------------------------
test('materials: each output adds a modest bonus (1-4), a session adds at most 6 and never passes 100%', () => {
  assert.deepEqual([1, 2, 3, 5, 6, 8, 9, 10].map(materialBonus), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(materialBonus(0), 1);
  assert.equal(materialBonus(99), 4);
  assert.deepEqual(boundedMaterialBonuses([10, 10], 100), [4, 2], 'per-session cap 6');
  assert.equal(MATERIAL_MAX_BONUS_PER_SESSION, 6);
  assert.deepEqual(boundedMaterialBonuses([10, 10], 3), [3, 0], 'never past 100%');
  assert.deepEqual(boundedMaterialBonuses([2], 0), [0]);
  assert.equal(materialsAllowed({ used: 0, remaining: 50 }), MATERIALS_PER_SESSION);
  assert.equal(materialsAllowed({ used: MATERIALS_PER_WORK_MAX - 1, remaining: 50 }), 1, 'per-work cap');
  assert.equal(materialsAllowed({ used: MATERIALS_PER_WORK_MAX, remaining: 50 }), 0);
  assert.equal(materialsAllowed({ used: 0, remaining: 0 }), 0, 'a finished work takes nothing');
});

test('materials: claims suitable outputs of others (never survival, never own), links work<->output, rewards the producer', async () => {
  const client = fakeClient([
    ['UPDATE world_skill_outputs o SET consumer_id', [
      { outputId: '41', producerId: PRODUCER, skillId: 'onet:iwa:4.A.3.b.2.b', drive: 'creation', quality: 6,
        skillName: 'Design structures or facilities', rootGwa: 'onet:gwa:4.A.3.b.2' },
      { outputId: '42', producerId: PRODUCER, skillId: 'onet:gwa:4.A.3.b.6', drive: 'contribution', quality: 2,
        skillName: 'Documenting/Recording Information', rootGwa: 'onet:gwa:4.A.3.b.6' }]],
    ["'world.skill_output_delivered'", [{ id: 901 }]]
  ]);
  const result = await consumeBuildMaterials(client, { worldId: 'w', builderId: BUILDER, remaining: 40, worldMinutes: 100,
    work: { id: WORK, name: 'Road Repair', scene_name: 'Road', position: {} }, env: {} });
  assert.equal(result.consumed.length, 2);
  assert.deepEqual(result.consumed.map((item) => item.bonus), [3, 1]);
  assert.equal(result.bonus, 4);
  assert.equal(result.consumed[0].craft, true);
  const claim = client.calls.find((call) => call.sql.includes('UPDATE world_skill_outputs o SET consumer_id'));
  assert.equal(claim.params[1], BUILDER, 'the builder is the consumer (reward evidence rule)');
  assert.match(claim.sql, /c\.producer_id<>\$2/);
  assert.match(claim.sql, /SKIP LOCKED/);
  assert.deepEqual(claim.params[2], ['creation', 'mastery', 'contribution']);
  assert.ok(claim.params[3].includes('onet:gwa:4.A.3.b.2'), 'craft/engineering roots qualify');
  assert.deepEqual(claim.params[4], ['survival'], 'survival outputs feed residents, never materials');
  assert.equal(claim.params[5], SKILL_OUTPUT_EXPIRY_SECONDS, 'expired outputs are not materials');
  assert.equal(claim.params[6], MATERIALS_PER_SESSION);
  const events = client.calls.filter((call) => call.sql.includes('INSERT INTO world_events'));
  const link = events.filter((call) => call.params[2] === 'world.public_work_material');
  assert.equal(link.length, 2);
  assert.equal(link[0].params[4], `public-work:${WORK}:material:41`);
  assert.equal(JSON.parse(link[0].params[3]).workId, WORK);
  const delivered = events.filter((call) => call.sql.includes("'world.skill_output_delivered'"));
  assert.equal(delivered.length, 2, 'the normal used-output reward path runs once per output');
  assert.equal(delivered[0].params[1], PRODUCER);
  assert.equal(delivered[0].params[2].consumerId, BUILDER);
  assert.equal(delivered[0].params[2].publicWorkId, WORK);
  const writes = client.calls.filter((call) => /^\s*(UPDATE|INSERT)/.test(call.sql)).map((call) => call.sql);
  assert.ok(!writes.some((sql) => /ledger|treasury_entries|payout|mint|issu/i.test(sql)), 'no new money path');
});

test('materials: kill switch off, nothing to claim, or a full work -> no claim at all', async () => {
  const off = fakeClient([]);
  assert.deepEqual(await consumeBuildMaterialsSafely(off, { worldId: 'w', builderId: BUILDER, remaining: 40,
    work: { id: WORK }, env: { MIRRORTERRA_SKILL_MATERIALS: 'off' } }), { consumed: [], bonus: 0 });
  assert.equal(off.calls.length, 0);
  assert.equal(skillMaterialsEnabled({}), true);
  assert.equal(skillMaterialsEnabled({ MIRRORTERRA_SKILL_MATERIALS: 'OFF' }), false);
  const full = fakeClient([]);
  await consumeBuildMaterials(full, { worldId: 'w', builderId: BUILDER, remaining: 40,
    work: { id: WORK, position: { materials: { count: MATERIALS_PER_WORK_MAX } } }, env: {} });
  assert.equal(full.calls.length, 0);
  const broken = fakeClient([['UPDATE world_skill_outputs o', new Error('boom')]]);
  assert.deepEqual(await consumeBuildMaterialsSafely(broken, { worldId: 'w', builderId: BUILDER, remaining: 40,
    work: { id: WORK }, env: {} }), { consumed: [], bonus: 0 });
  assert.ok(broken.calls.some((call) => call.sql === 'ROLLBACK TO SAVEPOINT public_work_materials'));
});

function workRow(extra = {}) {
  return { id: WORK, kind: 'road', name: 'Road Repair', project_key: 'repair:road:1', required_skill: 'engineering',
    position: {}, progress: 30, sessions: 3, milestones_paid: 2, paid_raw: '0', contract_price_raw: '1000000',
    builder_agent_id: BUILDER, reassignments: 0, scene_id: null, scene_name: 'Road', builder_name: 'MirrorTerra-02',
    target_work_id: null, building_type: 'road', work_type: 'build', ...extra };
}

test('materials: a construction session adds the base gain plus the bounded material bonus; off = old progress', async () => {
  const script = (materials) => [
    ['FOR UPDATE OF work', [workRow()]],
    ['FROM world_agent_skills', [{ value: 100 }]],
    ['UPDATE world_skill_outputs o SET consumer_id', materials],
    ["'world.skill_output_delivered'", [{ id: 1 }]]
  ];
  const mats = [{ outputId: '7', producerId: PRODUCER, skillId: 'onet:gwa:4.A.3.a.2', drive: 'mastery', quality: 10,
    rootGwa: 'onet:gwa:4.A.3.a.2' }, { outputId: '8', producerId: PRODUCER, skillId: 'x', drive: 'creation', quality: 10, rootGwa: 'r' }];
  const on = await advancePublicWork(fakeClient(script(mats)), { worldId: 'w', agentId: BUILDER, place: 'Road', worldMinutes: 10,
    env: { MIRRORTERRA_SKILL_BUILDERS: 'off' } });
  const off = await advancePublicWork(fakeClient(script(mats)), { worldId: 'w', agentId: BUILDER, place: 'Road', worldMinutes: 10,
    env: { MIRRORTERRA_SKILL_BUILDERS: 'off', MIRRORTERRA_SKILL_MATERIALS: 'off' } });
  assert.equal(on.gain - off.gain, 6, 'two quality-10 outputs add 4+2 = the 6-point session cap');
  assert.equal(on.materials.consumed.length, 2);
  assert.equal(off.materials, undefined);
  assert.ok(off.gain >= 20 && off.gain <= 24, 'base construction gain unchanged (legacy skill 100)');
});

// ---- fix 2: skills decide who builds -----------------------------------------------------------------
const skills08 = [
  { skillId: 'onet:gwa:4.A.3.a.4', rootGwa: 'onet:gwa:4.A.3.a.4', name: 'Operating Vehicles', level: 4 },
  { skillId: 'onet:gwa:4.A.3.b.5', rootGwa: 'onet:gwa:4.A.3.b.5', name: 'Repairing Electronic', level: 3 },
  { skillId: 'onet:gwa:4.A.3.b.4', rootGwa: 'onet:gwa:4.A.3.b.4', name: 'Repairing Mechanical', level: 2 },
  { skillId: 'onet:gwa:4.A.3.a.2', rootGwa: 'onet:gwa:4.A.3.a.2', name: 'Handling and Moving Objects', level: 2 },
  { skillId: 'onet:iwa:4.A.3.a.2.a', rootGwa: 'onet:gwa:4.A.3.a.2', name: 'Build structures', level: 2 },
  { skillId: 'onet:gwa:4.A.4.a.5', rootGwa: 'onet:gwa:4.A.4.a.5', name: 'Assisting and Caring', level: 5 }];
const skills09 = [{ skillId: 'onet:gwa:4.A.3.a.4', rootGwa: 'onet:gwa:4.A.3.a.4', name: 'Operating Vehicles', level: 2 },
  { skillId: 'onet:gwa:4.A.3.a.2', rootGwa: 'onet:gwa:4.A.3.a.2', name: 'Handling and Moving Objects', level: 1 }];

test('builder score comes from relevant library skills, weighted per job (repair vs build), capped at 100', () => {
  const build = builderSkillScore(skills08, { workType: 'build', requiredSkill: 'engineering' });
  const repair = builderSkillScore(skills08, { workType: 'repair', requiredSkill: 'engineering' });
  assert.ok(build.score > 0 && build.score <= 100);
  assert.ok(repair.score > build.score, 'repair weights repairing skills more');
  assert.equal(build.top[0].name, 'Build structures', 'a direct construction activity counts 1.5x');
  assert.ok(!build.top.some((skill) => skill.name === 'Assisting and Caring'), 'unrelated skills do not count for a road');
  const clinic = builderSkillScore(skills08, { workType: 'build', requiredSkill: 'social' });
  assert.ok(clinic.score > build.score, 'social works get a small domain bonus');
  assert.ok(builderSkillScore(skills09, { workType: 'build' }).score < build.score);
  assert.equal(builderSkillScore([], { workType: 'build' }).score, 0);
  const maxed = Array.from({ length: 8 }, (_, index) => ({ skillId: `onet:iwa:4.A.3.a.2.${index}`, rootGwa: 'onet:gwa:4.A.3.a.2', level: 10 }));
  assert.equal(builderSkillScore(maxed, { workType: 'build' }).score, 100);
  assert.equal(BUILD_SKILL_FULL_SUM, 25);
});

test('award: the skilled resident beats a slightly cheaper unskilled one; fairness penalises recent winners and busy builders', () => {
  const s08 = builderSkillScore(skills08, { workType: 'build' }).score;
  const s09 = builderSkillScore(skills09, { workType: 'build' }).score;
  const bids = [{ id: 1, agentId: 'r09', bidRaw: '6000000', skillValue: s09, credible: true },
    { id: 2, agentId: 'r08', bidRaw: '6300000', skillValue: s08, credible: true },
    { id: 3, agentId: 'r03', bidRaw: '6400000', skillValue: s08 * 0.9, credible: true }];
  assert.equal(chooseWinningBid(bids).agentId, 'r08', 'skill matters, not the saturated legacy 100');
  // r08 won 2 of the last 4 repair awards -> 1.3^2 = 1.69x; r03 is now cheapest after adjustment.
  const recentWinners = ['r08', 'r08', 'r06', 'r09'];
  const withFairness = bids.map((bid) => ({ ...bid, fairness: fairnessFactor({ agentId: bid.agentId, recentWinners, active: 0 }) }));
  assert.equal(fairnessFactor({ agentId: 'r08', recentWinners, active: 0 }), 1.69);
  assert.equal(fairnessFactor({ agentId: 'r03', recentWinners, active: 0 }), 1);
  assert.equal(fairnessFactor({ agentId: 'r03', recentWinners, active: 1 }), 1.2);
  assert.equal(fairnessFactor({ agentId: 'r03', recentWinners, active: 2 }), null, '>=2 active jobs: skipped');
  assert.equal(chooseWinningBid(withFairness).agentId, 'r03', 'work spreads beyond the usual winners');
  assert.ok(effectiveBidCost({ bidRaw: '1000000', skillValue: 50, fairness: 1.3 }) > effectiveBidCost({ bidRaw: '1000000', skillValue: 50 }));
  // If everyone is penalised the cheapest adjusted bid still wins (fairness never cancels a tender).
  assert.ok(chooseWinningBid(bids.map((bid) => ({ ...bid, fairness: 1.69 }))));
});

test('heuristic bids use the same score: a more skilled builder bids lower', () => {
  const common = { priceRaw: 10_000_000n, balanceRaw: 5_000_000n, medianBalanceRaw: 5_000_000n, workKey: 'k' };
  assert.ok(heuristicBid({ ...common, agentId: 'a', skillValue: 80 }) < heuristicBid({ ...common, agentId: 'a', skillValue: 10 }));
});

test('bidSkill: library score by default (LLM and heuristic bids alike); legacy value when the switch is off', async () => {
  const client = fakeClient([
    ['FROM world_agent_library_skills p JOIN world_skill_library l', skills08.map((skill) => ({ ...skill }))],
    ['FROM world_agent_skills', [{ value: 100 }]]]);
  const work = { work_type: 'build', required_skill: 'engineering' };
  const lib = await bidSkill(client, { worldId: 'w', agentId: 'r08', work, env: {}, inTransaction: false });
  assert.equal(lib.source, 'library');
  assert.equal(lib.skillValue, builderSkillScore(skills08, { workType: 'build' }).score);
  const legacy = await bidSkill(client, { worldId: 'w', agentId: 'r08', work, env: { MIRRORTERRA_SKILL_BUILDERS: 'off' } });
  assert.deepEqual([legacy.source, legacy.skillValue], ['legacy', 100]);
  assert.equal(skillBuildersEnabled({}), true);
});

test('construction practises the most relevant held skill, else an always-unlocked root', () => {
  const order = practiceSkillOrder(skills08, { workType: 'repair' });
  assert.equal(order[0], 'onet:iwa:4.A.3.a.2.a', 'a direct construction activity (1.5x) leads');
  assert.ok(order.indexOf('onet:gwa:4.A.3.b.4') < order.indexOf('onet:gwa:4.A.3.a.4'), 'repairing before vehicles for a repair');
  assert.ok(!order.includes('onet:gwa:4.A.4.a.5'), 'unrelated skills are never practised by construction');
  assert.ok(order.includes('onet:gwa:4.A.1.b.2'), 'roots the builder lacks follow as fallbacks');
  assert.equal(practiceSkillOrder([], { workType: 'build' })[0], 'onet:gwa:4.A.3.a.1');
});

test('a construction session grants library XP through the existing practice/level path', async () => {
  const client = fakeClient([
    ['FOR UPDATE OF work', [workRow()]],
    ['FROM world_agent_skills', [{ value: 100 }]],
    ['l.root_gwa=ANY', [{ skillId: 'onet:iwa:4.A.3.a.2.a', name: 'Build structures', tier: 2, rootGwa: 'onet:gwa:4.A.3.a.2', level: 2, status: 'learning' }]],
    ['p.skill_id=ANY', [{ skillId: 'onet:iwa:4.A.3.a.2.a', xp: 95, level: 2, practiceCount: 9, name: 'Build structures', tier: 2,
      drives: ['survival'], status: 'learning' }]]]);
  const result = await advancePublicWork(client, { worldId: 'w', agentId: BUILDER, place: 'Road', worldMinutes: 10,
    env: { MIRRORTERRA_SKILL_MATERIALS: 'off' } });
  assert.equal(result.practiced.skillId, 'onet:iwa:4.A.3.a.2.a');
  const xp = client.calls.find((call) => call.sql.includes('UPDATE world_agent_library_skills SET xp'));
  assert.ok(xp && xp.params[3] > 95, 'XP grows');
  const noXp = fakeClient([['FOR UPDATE OF work', [workRow()]], ['FROM world_agent_skills', [{ value: 100 }]]]);
  await advancePublicWork(noXp, { worldId: 'w', agentId: BUILDER, place: 'Road', worldMinutes: 10,
    env: { MIRRORTERRA_SKILL_MATERIALS: 'off', MIRRORTERRA_SKILL_BUILDERS: 'off' } });
  assert.ok(!noXp.calls.some((call) => call.sql.includes('world_agent_library_skills')));
});

// ---- fix 3: expiry + multi-drive matching -------------------------------------------------------------
test('expiry: 48 world hours = 2880 s; expired = consumed_at set, consumer stays NULL, rows locked elsewhere skipped', async () => {
  assert.equal(SKILL_OUTPUT_EXPIRY_SECONDS, 2880);
  const now = Date.parse('2026-10-22T05:00:00Z');
  assert.equal(outputExpired(new Date(now - 2881_000), now), true);
  assert.equal(outputExpired(new Date(now - 2000_000), now), false);
  const client = fakeClient([['UPDATE world_skill_outputs SET consumed_at=now()', [{ outputId: '1' }, { outputId: '2' }]]]);
  assert.equal(await expireStaleOutputs(client, { worldId: 'w', producerId: PRODUCER }), 2);
  const sql = client.calls[0].sql;
  assert.match(sql, /SET consumed_at=now\(\)/);
  assert.ok(!/consumer_id=/.test(sql.split('WHERE')[0]), 'consumer_id is never set: no reward, not "used"');
  assert.match(sql, /SKIP LOCKED/);
  assert.ok(!/DELETE/i.test(sql));
  assert.equal(client.calls[0].params[2], 2880);
});

test('expiry runs only for a producer at the open cap, then re-counts, so a capped producer produces again; off = old cap behaviour', async () => {
  const script = (counts) => [
    ['FROM world_members m', [{ discipline: 1, curiosity: 0 }]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 'onet:task:1', name: 'Task', tier: 4, drives: ['creation'], xp: 40,
      level: 2, practiceCount: 4 }]],
    ['UPDATE world_skill_outputs SET consumed_at=now()', [{ outputId: '1' }]],
    ['count(*)::int AS n FROM world_skill_outputs', () => [{ n: counts.length > 1 ? counts.shift() : counts[0] }]],
    ['INSERT INTO world_skill_outputs', [{ outputId: '9' }]]];
  // at the cap (5): sweep (bounded, LIMIT), re-count (4), produce
  const on = fakeClient(script([5, 4]));
  const result = await practiceLibrarySkill(on, { worldId: 'w', agentId: 'a', action: 'work', env: {} });
  const counts = on.calls.map((call, index) => (call.sql.includes('count(*)::int AS n FROM world_skill_outputs') ? index : -1)).filter((i) => i >= 0);
  const sweep = on.calls.findIndex((call) => call.sql.includes('UPDATE world_skill_outputs SET consumed_at=now()'));
  assert.equal(counts.length, 2);
  assert.ok(counts[0] < sweep && sweep < counts[1]);
  assert.match(on.calls[sweep].sql, /ORDER BY o\.created_at LIMIT \$4/);
  assert.equal(on.calls[sweep].params[3], SKILL_OUTPUT_EXPIRY_BATCH);
  assert.equal(result.produced.drive, 'creation');
  // below the cap: no expiry write at all on the production path
  const below = fakeClient(script([4]));
  const produced = await practiceLibrarySkill(below, { worldId: 'w', agentId: 'a', action: 'work', env: {} });
  assert.ok(!below.calls.some((call) => call.sql.includes('UPDATE world_skill_outputs SET consumed_at=now()')));
  assert.equal(produced.produced.drive, 'creation');
  // kill switch off: at the cap nothing expires and nothing is produced (old behaviour)
  const off = fakeClient(script([5]));
  const old = await practiceLibrarySkill(off, { worldId: 'w', agentId: 'a', action: 'work', env: { MIRRORTERRA_OUTPUT_EXPIRY: 'off' } });
  assert.ok(!off.calls.some((call) => call.sql.includes('UPDATE world_skill_outputs SET consumed_at=now()')));
  assert.ok(!old.produced);
  assert.equal(outputExpiryEnabled({ MIRRORTERRA_OUTPUT_EXPIRY: 'off' }), false);
});

// ---- skillwork3: resident 03 (level-0 practised skill) + world-wide bounded sweep ------------------------
test('pickProductionSkill: level>=1 practised skill is kept; level 0 falls back to the highest-level held skill sharing a drive', () => {
  const practised = { skillId: 'onet:dwa:new', level: 0, drives: ['creation', 'curiosity'], practiceCount: 10 };
  assert.equal(pickProductionSkill({ ...practised, level: 2 }).level, 2);
  const held = [
    { skillId: 'onet:iwa:b', level: 3, xp: 220, drives: ['creation', 'curiosity'] },
    { skillId: 'onet:gwa:think', level: 4, xp: 490, drives: ['creation', 'curiosity'], name: 'Thinking Creatively', tier: 1 },
    { skillId: 'onet:gwa:drive', level: 5, xp: 900, drives: ['survival', 'mastery'] },
    { skillId: 'onet:gwa:zero', level: 0, xp: 15, drives: ['creation'] }];
  const picked = pickProductionSkill(practised, held);
  assert.equal(picked.skillId, 'onet:gwa:think', 'highest level among drive matches; a stronger non-matching skill is ignored');
  assert.equal(picked.fallback, true);
  assert.equal(picked.practiceCount, 10);
  assert.equal(pickProductionSkill(practised, held.filter((row) => row.skillId === 'onet:gwa:zero' || row.skillId === 'onet:gwa:drive')), null);
  assert.equal(pickProductionSkill({ ...practised, drives: [] }, held), null);
});

test('resident 03 case: a level-0 practised skill produces from its best matching held skill and sweeps its stale outputs at the cap', async () => {
  const script = ({ counts = [5, 4], fallback = [{ skillId: 'onet:gwa:4.A.2.b.2', level: 4, xp: 490.99, name: 'Thinking Creatively',
    tier: 1, drives: ['creation', 'curiosity'] }] } = {}) => [
    ['FROM world_members m', [{ discipline: 0.5, curiosity: 1 }]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 'onet:dwa:4.A.2.b.2.o.19', name: 'Create maps', tier: 3,
      drives: ['creation', 'curiosity'], xp: 14.47, level: 0, practiceCount: 9 }]],
    ['l.drives && $3::text[]', fallback],
    ['UPDATE world_skill_outputs SET consumed_at=now()', [{ outputId: '1' }, { outputId: '2' }]],
    ['count(*)::int AS n FROM world_skill_outputs', () => [{ n: counts.length > 1 ? counts.shift() : counts[0] }]],
    ['INSERT INTO world_skill_outputs', [{ outputId: '77' }]]];
  const on = fakeClient(script());
  const result = await practiceLibrarySkill(on, { worldId: 'w', agentId: 'a03', action: 'learn', env: {} });
  assert.equal(result.practiced[0].level, 0, 'the practised (curiosity-picked) skill is still level 0');
  assert.equal(result.practiced[0].practiceCount, 10);
  assert.equal(result.produced.skillId, 'onet:gwa:4.A.2.b.2');
  assert.equal(result.produced.quality, 4);
  assert.equal(result.produced.fallbackFrom, 'onet:dwa:4.A.2.b.2.o.19');
  assert.ok(['creation', 'curiosity'].includes(result.produced.drive));
  const fb = on.calls.find((call) => call.sql.includes('l.drives && $3::text[]'));
  assert.match(fb.sql, /p\.level >= 1/);
  assert.match(fb.sql, /LIMIT 1/);
  assert.deepEqual(fb.params[2], ['creation', 'curiosity']);
  assert.ok(on.calls.some((call) => call.sql.includes('UPDATE world_skill_outputs SET consumed_at=now()')), 'cap sweep now reachable');
  const insert = on.calls.find((call) => call.sql.includes('INSERT INTO world_skill_outputs'));
  assert.equal(insert.params[2], 'onet:gwa:4.A.2.b.2');
  assert.equal(insert.params[4], 4);
  // nothing at level >= 1 sharing a drive -> no production, no insert
  const none = fakeClient(script({ fallback: [] }));
  const nothing = await practiceLibrarySkill(none, { worldId: 'w', agentId: 'a03', action: 'learn', env: {} });
  assert.equal(nothing.produced, null);
  assert.ok(!none.calls.some((call) => call.sql.includes('INSERT INTO world_skill_outputs')));
  // kill switch off: old behaviour, a level-0 practised skill never produces and the fallback is never read
  const off = fakeClient(script());
  const old = await practiceLibrarySkill(off, { worldId: 'w', agentId: 'a03', action: 'learn', env: { MIRRORTERRA_OUTPUT_EXPIRY: 'off' } });
  assert.equal(old.produced, null);
  assert.ok(!off.calls.some((call) => call.sql.includes('l.drives && $3::text[]')));
  assert.ok(!off.calls.some((call) => call.sql.includes('INSERT INTO world_skill_outputs')));
  // not a production beat (practiceCount 10 -> 11): no fallback read at all
  const offBeat = fakeClient(script().map(([m, r]) => (m.startsWith("p.status='learning'")
    ? [m, [{ skillId: 'onet:dwa:x', name: 'X', tier: 3, drives: ['creation'], xp: 14, level: 0, practiceCount: 10 }]] : [m, r])));
  await practiceLibrarySkill(offBeat, { worldId: 'w', agentId: 'a03', action: 'learn', env: {} });
  assert.ok(!offBeat.calls.some((call) => call.sql.includes('l.drives && $3::text[]')));
});

test('world-wide sweep: all producers, bounded LIMIT 20, SKIP LOCKED, 5-min timer; off with either kill switch', async () => {
  assert.equal(SKILL_OUTPUT_GLOBAL_SWEEP_MS, 300_000);
  const pool = fakeClient([['UPDATE world_skill_outputs SET consumed_at=now()', [{ outputId: '1' }, { outputId: '2' }, { outputId: '3' }]]]);
  assert.equal(await sweepStaleOutputsGlobally(pool, { worldId: 'w', env: {} }), 3);
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].params[1], null, 'no producer filter');
  assert.equal(pool.calls[0].params[2], 2880);
  assert.equal(pool.calls[0].params[3], 20);
  assert.match(pool.calls[0].sql, /SKIP LOCKED/);
  for (const env of [{ MIRRORTERRA_OUTPUT_EXPIRY: 'off' }, { MIRRORTERRA_SKILL_LIBRARY: 'off' }]) {
    const quiet = fakeClient([]);
    assert.equal(await sweepStaleOutputsGlobally(quiet, { worldId: 'w', env }), 0);
    assert.equal(quiet.calls.length, 0);
  }
  assert.equal(await sweepStaleOutputsGlobally(fakeClient([]), { worldId: null, env: {} }), 0);
});

test('consumers match any of their top-3 drives (>= 0.35), strongest first, never expired; off = strongest only', async () => {
  const drives = { survival: 0.1, security: 0.4, belonging: 0.5, esteem: 0.45, curiosity: 0.2, creation: 0.6, mastery: 0.3, contribution: 0.1 };
  assert.deepEqual(consumerDrives(drives), ['creation', 'belonging', 'esteem']);
  assert.deepEqual(consumerDrives(drives, { multi: false }), ['creation']);
  assert.deepEqual(consumerDrives({ ...drives, belonging: 0.2, esteem: 0.1, security: 0.1 }), ['creation']);
  const script = () => [
    ['FROM world_members m', [{ energy: 90, food: 90, social: 10, sociability: 1, curiosity: 1, ambition: 1, fun: 0, happiness: 0 }]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 's', name: 'S', tier: 4, drives: ['mastery'], xp: 1, level: 0, practiceCount: 1 }]],
    ['UPDATE world_skill_outputs SET consumer_id', [{ outputId: '9', producerId: 'b', skillId: 'k', drive: 'esteem', quality: 3 }]]];
  const on = fakeClient(script());
  const result = await practiceLibrarySkill(on, { worldId: 'w', agentId: 'a', action: 'work', env: { MIRRORTERRA_SYNC_ECONOMY: 'off' } });
  const claim = on.calls.find((call) => call.sql.includes('UPDATE world_skill_outputs SET consumer_id'));
  assert.equal(claim.params[2].length, 3);
  assert.equal(claim.params[3], 2880);
  assert.match(claim.sql, /array_position\(\$3::text\[\], o\.drive\)/);
  assert.equal(result.used.drive, 'esteem');
  const off = fakeClient(script());
  await practiceLibrarySkill(off, { worldId: 'w', agentId: 'a', action: 'work', env: { MIRRORTERRA_OUTPUT_EXPIRY: 'off', MIRRORTERRA_SYNC_ECONOMY: 'off' } });
  const old = off.calls.find((call) => call.sql.includes('UPDATE world_skill_outputs SET consumer_id'));
  assert.equal(old.params[2].length, 1);
  assert.equal(old.params[3], null);
});

// ---- fix 4: Luna quota backoff -----------------------------------------------------------------------
const quota = { status: 400, providerErrorCode: 'insufficient_user_quota', code: 'provider_request_failed' };

test('backoff: quota errors pause all calls 5 -> 10 -> 20 -> 40 -> 60 (cap) min; success resets; one log line per change', () => {
  let clock = 0;
  const lines = [];
  const backoff = createQuotaBackoff({ now: () => clock, log: (line) => lines.push(line), env: {} });
  assert.equal(isQuotaError(quota), true);
  assert.equal(isQuotaError({ status: 429 }), true);
  assert.equal(isQuotaError({ status: 400, providerErrorCode: 'unsupported_parameter' }), false);
  assert.equal(isQuotaError({ status: 500 }), false);
  backoff.check();
  assert.equal(backoff.onFailure(quota), true);
  assert.equal(backoff.status().pauseMs, LUNA_BACKOFF_START_MS);
  for (let i = 0; i < 20; i += 1) assert.throws(() => backoff.check(), (error) => error.code === LUNA_QUOTA_BACKOFF_CODE);
  assert.equal(backoff.onFailure(quota), false, 'an in-flight failure during the pause does not extend it');
  assert.equal(lines.length, 1, 'one line, not one per call');
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    clock = Date.parse(backoff.status().pausedUntil) + 1;
    backoff.check();
    backoff.onFailure({ status: 429 });
    seen.push(backoff.status().pauseMs / 60_000);
  }
  assert.deepEqual(seen, [10, 20, 40, 60, 60, 60]);
  assert.equal(LUNA_BACKOFF_CAP_MS, 60 * 60_000);
  clock = Date.parse(backoff.status().pausedUntil) + 1;
  assert.equal(backoff.onSuccess(), true);
  assert.equal(backoff.status().pauseMs, 0);
  assert.equal(backoff.onSuccess(), false, 'success without a pause logs nothing');
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.map((line) => line.event), ['paused', 'extended', 'extended', 'extended', 'extended', 'extended', 'extended', 'resumed']);
  backoff.onFailure(quota);
  assert.equal(backoff.status().pauseMs, LUNA_BACKOFF_START_MS, 'after a reset it starts at 5 min again');
});

test('backoff kill switch off: no pause', () => {
  const backoff = createQuotaBackoff({ now: () => 0, log: () => {}, env: { MIRRORTERRA_LUNA_QUOTA_BACKOFF: 'off' } });
  assert.equal(backoff.onFailure(quota), false);
  backoff.check();
  assert.equal(lunaQuotaBackoffEnabled({ MIRRORTERRA_LUNA_QUOTA_BACKOFF: 'off' }), false);
  assert.equal(lunaQuotaBackoffEnabled({}), true);
});

test('router: a 400 insufficient_user_quota pauses the next call before any provider request; success after the pause resets', async () => {
  let clock = 1_000;
  const backoff = createQuotaBackoff({ now: () => clock, log: () => {}, env: {} });
  let fetches = 0;
  let mode = 'quota';
  const fetchImpl = async () => {
    fetches += 1;
    if (mode === 'quota') return new Response(JSON.stringify({ error: { code: 'insufficient_user_quota', message: 'quota' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ model: 'gpt-6-luna', choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const router = createCognitionModelRouter({ apiKey: 'fixture', catalog: configuredCognitionCatalog('gpt-6-luna'),
    fetchImpl, quotaBackoff: backoff });
  const messages = [{ role: 'system', content: 'x' }, { role: 'user', content: 'json please' }];
  await assert.rejects(router({ tier: 'routine', messages }));
  assert.equal(fetches, 1);
  await assert.rejects(router({ tier: 'routine', messages }), (error) => error.code === LUNA_QUOTA_BACKOFF_CODE);
  assert.equal(fetches, 1, 'paused: no provider call');
  clock += LUNA_BACKOFF_START_MS + 1;
  mode = 'ok';
  const result = await router({ tier: 'routine', messages });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(backoff.status().pauseMs, 0);
});
