import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { libraryLevelForXp, libraryXpForLevel, libraryPracticeGain, practiceLibrarySkill,
  practiceLibrarySkillSafely, skillLibraryEnabled, computeDrives, strongestDrives, rankSkillChoices,
  outputNeedEffect, SKILL_DRIVES, SKILL_LIBRARY_PRACTICE_PER_ACTION } from '../src/world-skill-library.js';

test('level curve is monotonic, capped, and tier scaled', () => {
  assert.equal(libraryLevelForXp(0), 0);
  assert.equal(libraryLevelForXp(libraryXpForLevel(3, 3), 3), 3);
  assert.equal(libraryLevelForXp(1e9, 1), 10);
  assert.ok(libraryXpForLevel(5, 1) > libraryXpForLevel(5, 4));
});

test('practice gain is deterministic and bounded', () => {
  const a = libraryPracticeGain({ agentId: 'a', skillId: 's', practiceCount: 1 });
  assert.equal(a, libraryPracticeGain({ agentId: 'a', skillId: 's', practiceCount: 1 }));
  assert.ok(a >= 1 && a <= 1.5);
  assert.ok(libraryPracticeGain({ agentId: 'a', skillId: 's', practiceCount: 1, hadPartner: true }) > a);
});

test('drives follow needs, traits and goal and stay in [0,1]', () => {
  const hungry = computeDrives({ energy: 70, food: 5, social: 80, curiosity: 0.2 });
  assert.equal(strongestDrives(hungry, 1)[0].drive, 'survival');
  const lonely = computeDrives({ energy: 90, food: 90, social: 2, sociability: 0.9, curiosity: 0.1 });
  assert.equal(strongestDrives(lonely, 1)[0].drive, 'belonging');
  const scholar = computeDrives({ energy: 90, food: 90, social: 90, curiosity: 1, fun: 10, goal: 'learn' });
  assert.equal(strongestDrives(scholar, 1)[0].drive, 'curiosity');
  for (const value of Object.values(computeDrives({ energy: -50, food: 500, risk_tolerance: 'x' }))) {
    assert.ok(value >= 0 && value <= 1);
  }
  assert.deepEqual(Object.keys(computeDrives({})).sort(), [...SKILL_DRIVES].sort());
});

test('ranking practises at most three skills and curiosity favours a new one', () => {
  const learning = [1, 2, 3, 4].map((i) => ({ skillId: `s${i}`, drives: ['mastery'], level: 2, practiceCount: 60, xp: 80 }));
  const candidate = { skillId: 'new', drives: ['curiosity'], tier: 2 };
  const curious = computeDrives({ curiosity: 1, fun: 0, discipline: 0, goal: 'learn' });
  const picked = rankSkillChoices({ learning, candidate, drives: curious, agentId: 'a' });
  assert.equal(picked.length, SKILL_LIBRARY_PRACTICE_PER_ACTION);
  assert.equal(picked[0].skillId, 'new');
  const disciplined = computeDrives({ curiosity: 0, fun: 100, discipline: 1 });
  const deep = rankSkillChoices({ learning, candidate, drives: disciplined, agentId: 'a' });
  assert.ok(!deep.some((s) => s.isNew));
});

test('output effects only touch world needs', () => {
  assert.ok(outputNeedEffect('survival', 4).food > 0);
  assert.ok(outputNeedEffect('belonging', 4).social > 0);
  for (const drive of SKILL_DRIVES) {
    const effect = outputNeedEffect(drive, 10);
    assert.deepEqual(Object.keys(effect).sort(), ['energy', 'food', 'fun', 'happiness', 'knowledge', 'social']);
    assert.ok(Object.values(effect).every((v) => v >= 0 && v <= 13));
  }
});

function fakeClient(script) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    for (const [match, rows] of script) if (sql.includes(match)) {
      if (rows instanceof Error) throw rows;
      return { rows: typeof rows === 'function' ? rows(params) : rows };
    }
    return { rows: [] };
  } };
}

test('starts a drive-chosen skill with no active-skill cap and records the motive', async () => {
  const client = fakeClient([
    ['FROM world_members m', [{ energy: 80, food: 80, social: 80, curiosity: 0.9, fun: 20 }]],
    ["p.status='learning' AND $3 = ANY", []],
    ['l.tier*0.05', [{ skillId: 'onet:gwa:4.A.1.a.1', name: 'Getting Information', tier: 1, drives: ['curiosity'] }]]
  ]);
  const result = await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'learn' });
  assert.equal(result.started, true);
  assert.equal(result.skillId, 'onet:gwa:4.A.1.a.1');
  assert.ok(!client.calls.some((c) => c.sql.includes('count(*)::int AS n FROM world_agent_library_skills')));
  const event = client.calls.find((c) => c.sql.includes('INSERT INTO world_events') && c.params[2] === 'world.skill_started');
  assert.ok(event);
  assert.ok(event.params[3].motivatedBy.includes('curiosity'));
});

test('ignores non-library actions', async () => {
  const client = fakeClient([]);
  assert.equal(await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'eat' }), null);
  assert.equal(client.calls.length, 0);
});

test('practice on an active skill levels up, masters, and produces an output', async () => {
  const client = fakeClient([
    ['FROM world_members m', [{ discipline: 1, curiosity: 0 }]],
    ["p.status='learning' AND $3 = ANY",
      [{ skillId: 'onet:task:1', name: 'Task', tier: 4, drives: ['creation'], xp: libraryXpForLevel(10, 4) - 0.5,
        level: 9, practiceCount: 4 }]],
    ['count(*)::int AS n FROM world_skill_outputs', [{ n: 0 }]],
    ['INSERT INTO world_skill_outputs', [{ outputId: '7' }]]
  ]);
  const result = await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'work' });
  assert.equal(result.level, 10);
  assert.equal(result.mastered, true);
  assert.equal(result.produced.drive, 'creation');
  assert.ok(client.calls.some((c) => c.params?.[2] === 'world.skill_mastered'));
});

test('a strong drive uses another resident\'s output and updates only world needs', async () => {
  const client = fakeClient([
    ['FROM world_members m', [{ energy: 90, food: 3, social: 90 }]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 's', name: 'S', tier: 4, drives: ['mastery'], xp: 1, level: 0, practiceCount: 1 }]],
    ['UPDATE world_skill_outputs', [{ outputId: '9', producerId: 'b', skillId: 'k', drive: 'survival', quality: 3 }]],
    ['SELECT name FROM world_skill_library', [{ name: 'Cook food' }]]
  ]);
  const result = await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'work' });
  assert.equal(result.used.drive, 'survival');
  assert.ok(result.used.effect.food > 0);
  const writes = client.calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.sql)).map((c) => c.sql);
  assert.ok(writes.every((sql) => /world_(members|agent_states|agent_library_skills|skill_outputs|events)/.test(sql)));
  assert.ok(!writes.some((sql) => /ledger|usdc|wallet|payout/i.test(sql)));
});

test('safe wrapper rolls back to its savepoint and never throws', async () => {
  const client = fakeClient([['FROM world_members m', new Error('column l.drives does not exist')]]);
  assert.equal(await practiceLibrarySkillSafely(client, { worldId: 'w', agentId: 'a', action: 'learn' }, {}), null);
  assert.ok(client.calls.some((c) => c.sql === 'ROLLBACK TO SAVEPOINT world_skill_library'));
  assert.equal(skillLibraryEnabled({ MIRRORTERRA_SKILL_LIBRARY: 'off' }), false);
  const off = fakeClient([]);
  assert.equal(await practiceLibrarySkillSafely(off, { worldId: 'w', agentId: 'a', action: 'learn' },
    { MIRRORTERRA_SKILL_LIBRARY: 'off' }), null);
  assert.equal(off.calls.length, 0);
});

test('migration maps every O*NET GWA to a known drive and stays additive', () => {
  const sql = readFileSync(new URL('../migrations/0024_world_skill_drives.sql', import.meta.url), 'utf8');
  const mapped = [...sql.matchAll(/\('onet:gwa:([0-9A-Za-z.]+)', ARRAY\[([^\]]+)\]\)/g)];
  assert.equal(mapped.length, 41);
  for (const [, , list] of mapped) {
    for (const drive of list.split(',').map((d) => d.trim().replace(/'/g, ''))) assert.ok(SKILL_DRIVES.includes(drive));
  }
  assert.ok(!/\b(DROP|TRUNCATE)\b|DELETE FROM/i.test(sql));
});
