import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advanceHomeBuild, homeBuildGain, HOME_BUILD_STEP } from '../src/world-resident-homes.js';
import { activityVariant, activityNeedEffects, homeActivityCandidates } from '../src/world-environment.js';

const calendar = { minuteOfDay: 10 * 60, weekdayIndex: 1, phase: 'morning', isNight: false, isWorkHours: true, isMealTime: false };
const environment = { calendar, weather: { condition: 'clear', travelFactor: 1 } };

test('a resident without a finished house gets a build option at their own plot', () => {
  const agent = { agentId: 'a1', energy: 80, food: 70, hygiene: 80, location: 'Cafe', homeStatus: 'none', homeProgress: 0 };
  const build = homeActivityCandidates(agent, { environment }).find((option) => option.id === 'work:home:a1');
  assert.ok(build);
  assert.equal(build.action, 'work');
  assert.equal(build.targetLocation, 'home:a1');
  const built = homeActivityCandidates({ ...agent, homeStatus: 'built' }, { environment });
  assert.equal(built.some((option) => option.id === 'work:home:a1'), false);
  const tired = homeActivityCandidates({ ...agent, energy: 10 }, { environment });
  assert.equal(tired.some((option) => option.id === 'work:home:a1'), false);
});

test('building at home has its own variant and effects', () => {
  assert.equal(activityVariant({ action: 'work', location: 'home:a1', calendar, weather: {} }), 'home_building');
  assert.ok(activityNeedEffects({ action: 'work', variant: 'home_building' }).fun > 0);
});

test('a house takes about four sessions and is announced once', async () => {
  assert.ok(homeBuildGain('a', 0) >= HOME_BUILD_STEP && homeBuildGain('a', 0) < HOME_BUILD_STEP + 8);
  const state = { status: 'building', progress: 0, sessions: 0, exists: false };
  const events = [];
  const client = { async query(sql, params) {
    if (/INSERT INTO world_resident_homes/.test(sql)) { state.exists = true; return { rowCount: 1, rows: [] }; }
    if (/SELECT status,progress,sessions/.test(sql)) return { rowCount: 1, rows: [{ ...state }] };
    if (/UPDATE world_resident_homes/.test(sql)) { state.progress = params[2]; state.status = params[3]; state.sessions += 1; return { rowCount: 1 }; }
    if (/INSERT INTO world_events/.test(sql)) { events.push(params[2]); return { rowCount: 1 }; }
    return { rowCount: 1, rows: [] };
  } };
  let result;
  for (let i = 0; i < 6 && state.status !== 'built'; i += 1) result = await advanceHomeBuild(client, { worldId: 'w', agentId: 'a1' });
  assert.equal(state.status, 'built');
  assert.equal(result.justBuilt, true);
  assert.ok(state.sessions >= 3 && state.sessions <= 4);
  assert.equal(events.filter((type) => type === 'world.home_built').length, 1);
  assert.equal((await advanceHomeBuild(client, { worldId: 'w', agentId: 'a1' })).justBuilt, false);
});

test('migration 0026 is additive', () => {
  const sql = readFileSync(new URL('../migrations/0026_world_resident_homes.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS world_resident_homes/);
  assert.doesNotMatch(sql, /DROP|DELETE FROM|TRUNCATE/i);
});
