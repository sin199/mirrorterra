import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryLevelForXp, libraryXpForLevel, libraryPracticeGain, practiceLibrarySkill,
  practiceLibrarySkillSafely, skillLibraryEnabled } from '../src/world-skill-library.js';

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

test('starts an unlocked skill when no active skill matches and records an event', async () => {
  const client = fakeClient([
    ["p.status='learning' AND $3 = ANY", []],
    ['count(*)::int AS n', [{ n: 0 }]],
    ['ORDER BY l.tier DESC', [{ skillId: 'onet:gwa:4.A.1.a.1', name: 'Getting Information', tier: 1 }]]
  ]);
  const result = await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'learn' });
  assert.equal(result.started, true);
  assert.equal(result.skillId, 'onet:gwa:4.A.1.a.1');
  assert.ok(client.calls.some((c) => c.sql.includes('INSERT INTO world_agent_library_skills')));
  assert.ok(client.calls.some((c) => c.sql.includes('INSERT INTO world_events') && c.params[2] === 'world.skill_started'));
});

test('respects the active-skill limit and ignores non-library actions', async () => {
  const client = fakeClient([["p.status='learning' AND $3 = ANY", []], ['count(*)::int AS n', [{ n: 3 }]]]);
  assert.equal(await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'work' }), null);
  assert.equal(await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'eat' }), null);
});

test('practice on an active skill levels up and masters at the cap', async () => {
  const client = fakeClient([["p.status='learning' AND $3 = ANY",
    [{ skillId: 'onet:task:1', name: 'Task', tier: 4, xp: libraryXpForLevel(10, 4) - 0.5, level: 9, practiceCount: 10 }]]]);
  const result = await practiceLibrarySkill(client, { worldId: 'w', agentId: 'a', action: 'work' });
  assert.equal(result.level, 10);
  assert.equal(result.mastered, true);
  assert.ok(client.calls.some((c) => c.params?.[2] === 'world.skill_mastered'));
});

test('safe wrapper rolls back to its savepoint and never throws', async () => {
  const client = fakeClient([["p.status='learning' AND $3 = ANY", new Error('relation does not exist')]]);
  assert.equal(await practiceLibrarySkillSafely(client, { worldId: 'w', agentId: 'a', action: 'learn' }, {}), null);
  assert.ok(client.calls.some((c) => c.sql === 'ROLLBACK TO SAVEPOINT world_skill_library'));
  assert.equal(skillLibraryEnabled({ MIRRORTERRA_SKILL_LIBRARY: 'off' }), false);
  const off = fakeClient([]);
  assert.equal(await practiceLibrarySkillSafely(off, { worldId: 'w', agentId: 'a', action: 'learn' },
    { MIRRORTERRA_SKILL_LIBRARY: 'off' }), null);
  assert.equal(off.calls.length, 0);
});
