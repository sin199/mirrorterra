// placewear1: places built by resident projects (createProjectPlace) join the public works wear and repair
// system (user decision 2026-10-24 00:50 CST, option 2). Mock clients only; no DB, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PROJECT_PLACE_WEAR_KEY, createProjectPlaceWearFlags, projectPlaceWearEnabled } from '../src/project-place-wear-flags.js';
import { PLACE_USE_ACTIONS, PLACE_USE_HOURS_KEPT, completeProjectPlaceRepair, initialPlaceWear, isProjectPlaceScene,
  placeUsesSince, projectPlaceEffectFactor, projectPlaceFacility, projectPlaceRepairDue, readProjectPlaceFacilities,
  runProjectPlaceWearHour, stepPlaceWear } from '../src/project-place-wear.js';
import { BASE_WEAR_PER_HOUR, REPAIR_THRESHOLD, REPAIR_USE_WINDOW_MINUTES, USE_WEAR, conditionFactor, repairPriceRaw }
  from '../src/public-works-growth.js';
import { advancePublicWork, projectPlaceRepairNeeds, repairNeeds, runGrowthHour } from '../src/public-works.js';
import { buildActivityCandidates } from '../src/world-engine.js';

const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const ON = { [PROJECT_PLACE_WEAR_KEY]: 'on', MIRRORTERRA_TICKFIX_FLAGS_FILE: '/nonexistent/placewear1-flags.json' };
const OFF = { [PROJECT_PLACE_WEAR_KEY]: 'off', MIRRORTERRA_TICKFIX_FLAGS_FILE: '/nonexistent/placewear1-flags.json' };
const sceneId = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const studio = (n, name, wear = null) => ({ id: sceneId(n), name, sceneType: 'studio', status: 'active',
  features: wear ? { placeWear: wear } : {} });

function mockClient(handlers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      for (const [pattern, reply] of handlers) {
        if (pattern.test(String(sql))) {
          const out = typeof reply === 'function' ? reply(String(sql), params) : reply;
          return { rows: out?.rows || [], rowCount: out?.rowCount ?? (out?.rows || []).length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test('kill switch: env, file wins over env, bad file ignored, default on', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'placewear1-'));
  try {
    const file = path.join(dir, 'flags.json');
    assert.equal(createProjectPlaceWearFlags({ env: {}, file }).enabled(), true);
    assert.equal(createProjectPlaceWearFlags({ env: { [PROJECT_PLACE_WEAR_KEY]: 'off' }, file }).enabled(), false);
    writeFileSync(file, JSON.stringify({ [PROJECT_PLACE_WEAR_KEY]: 'on' }));
    assert.equal(createProjectPlaceWearFlags({ env: { [PROJECT_PLACE_WEAR_KEY]: 'off' }, file }).enabled(), true);
    writeFileSync(file, JSON.stringify({ [PROJECT_PLACE_WEAR_KEY]: 'off' }));
    assert.equal(createProjectPlaceWearFlags({ env: {}, file }).enabled(), false);
    writeFileSync(file, '{not json');
    assert.equal(createProjectPlaceWearFlags({ env: {}, file }).enabled(), true);
    assert.equal(projectPlaceWearEnabled(OFF), false);
    assert.equal(projectPlaceWearEnabled(ON), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lazy default state, standing + use wear, never rises, 96 h of use buckets', () => {
  const start = initialPlaceWear({ worldMinutes: 1000, eventCursor: 42 });
  assert.deepEqual({ c: start.condition, r: start.repairs, u: start.usesTotal, cur: start.eventCursor }, { c: 100, r: 0, u: 0, cur: 42 });
  const day = stepPlaceWear(start, { worldMinutes: 1000 + 1440, uses: [{ worldMinutes: 1100 }, { worldMinutes: 2000 }], eventCursor: 50 });
  assert.equal(day.condition, Math.round((100 - BASE_WEAR_PER_HOUR * 24 - USE_WEAR * 2) * 100) / 100); // 97.7
  assert.equal(day.usesTotal, 2);
  assert.equal(day.eventCursor, 50);
  assert.equal(day.lastUseWorldMinute, 2000);
  assert.equal(day.wearWorldMinute, 2440);
  // Same minute again: no further wear; a lower cursor never moves it back.
  const again = stepPlaceWear(day, { worldMinutes: 2440, uses: [], eventCursor: 10 });
  assert.equal(again.condition, day.condition);
  assert.equal(again.eventCursor, 50);
  // A stored state above 100 or a negative step never raises the condition.
  assert.ok(stepPlaceWear({ ...day, condition: 40 }, { worldMinutes: 2440 + 600 }).condition < 40);
  // Buckets older than PLACE_USE_HOURS_KEPT are pruned; 24h/72h windows count from them.
  const far = 2440 + (PLACE_USE_HOURS_KEPT + 2) * 60;
  const pruned = stepPlaceWear(day, { worldMinutes: far, uses: [{ worldMinutes: far - 30 }] });
  assert.deepEqual(Object.keys(pruned.useHours), [String(Math.floor((far - 30) / 60))]);
  assert.equal(placeUsesSince(pruned, far, 1440), 1);
  assert.equal(placeUsesSince(pruned, far, REPAIR_USE_WINDOW_MINUTES), 1);
  // From 100 an unused place reaches the repair threshold after 15 world days and full decay after 50.
  let s = initialPlaceWear({ worldMinutes: 0 });
  s = stepPlaceWear(s, { worldMinutes: 15 * 1440 });
  assert.equal(s.condition, 70);
  s = stepPlaceWear(s, { worldMinutes: 50 * 1440 });
  assert.equal(s.condition, 0);
});

test('effect factor follows the public works rule (full from 60, 35% at 0); off or no state = 1', () => {
  const scene = (condition) => studio(1, 'Workshop Annex', { condition });
  assert.equal(projectPlaceEffectFactor(scene(100)), 1);
  assert.equal(projectPlaceEffectFactor(scene(60)), 1);
  assert.equal(projectPlaceEffectFactor(scene(30)), conditionFactor(30));
  assert.equal(projectPlaceEffectFactor(scene(0)), 0.35);
  assert.equal(projectPlaceEffectFactor(scene(0), { enabled: false }), 1);
  assert.equal(projectPlaceEffectFactor(studio(2, 'Plain')), 1);
  assert.equal(isProjectPlaceScene(studio(2, 'Plain')), false);
  assert.equal(isProjectPlaceScene(scene(50)), true);
});

test('repair only below 70 AND used in the last 72 world hours; price = workshop value x wear x 1.5', () => {
  const minute = 100_000;
  const hour = Math.floor((minute - 300) / 60);
  const used = projectPlaceFacility(studio(1, 'Workshop Annex', { condition: 66.5, repairs: 2, usesTotal: 40,
    useHours: { [hour]: 3 } }), minute);
  const unused = projectPlaceFacility(studio(2, 'Foundry Studio 4', { condition: 20, repairs: 0, usesTotal: 2,
    useHours: { [Math.floor((minute - REPAIR_USE_WINDOW_MINUTES - 120) / 60)]: 2 } }), minute);
  const fresh = projectPlaceFacility(studio(3, 'Foundry Studio', { condition: 75, useHours: { [hour]: 9 } }), minute);
  assert.equal(used.type, 'workshop');
  assert.equal(used.uses72h, 3);
  assert.equal(unused.uses72h, 0);
  assert.deepEqual(projectPlaceRepairDue(used), { due: true });
  assert.equal(projectPlaceRepairDue(unused).reason, 'unused_72h');
  assert.equal(projectPlaceRepairDue(fresh).reason, 'condition_ok');
  const needs = projectPlaceRepairNeeds({ places: [unused, fresh, used], open: [] });
  assert.equal(needs.length, 1);
  const [need] = needs;
  assert.equal(need.projectKey, `placerepair:${sceneId(1).slice(0, 8)}:3`);
  assert.match(need.projectKey, /^[a-z0-9_:.-]{3,80}$/);
  assert.equal(need.workType, 'repair');
  assert.equal(need.kind, 'expansion');
  assert.equal(need.targetWorkId, null);
  assert.equal(need.sceneId, sceneId(1));
  assert.equal(need.buildingType, 'workshop');
  assert.equal(need.baseRaw, repairPriceRaw(20, 1, 66.5).toString());
  assert.equal(Number(need.baseRaw) / 1e6, 10.05); // 20 x 0.335 x 1.5
  assert.match(need.reason, /Workshop Annex .* condition 66\.5\/100/);
  // One open repair per place; a public building repair (with a target) does not block it.
  assert.equal(projectPlaceRepairNeeds({ places: [used], open: [{ workType: 'repair', targetWorkId: null, sceneId: sceneId(1) }] }).length, 0);
  assert.equal(projectPlaceRepairNeeds({ places: [used], open: [{ workType: 'repair', targetWorkId: 'x', sceneId: sceneId(1) }] }).length, 1);
  // The public building rule is unchanged (project places are not in demand.facilities).
  assert.deepEqual(repairNeeds({ demand: { facilities: [] }, open: [] }), []);
});

test('hourly step: switch off = no query at all; on = lazy creation, events counted once, one UPDATE', async () => {
  const off = mockClient();
  assert.deepEqual(await runProjectPlaceWearHour(off, { worldId: WORLD, worldMinutes: 5000, env: OFF }), { skipped: 'disabled' });
  assert.equal(off.calls.length, 0);
  assert.deepEqual(await readProjectPlaceFacilities(off, { worldId: WORLD, worldMinutes: 5000, env: OFF }), []);
  assert.equal(off.calls.length, 0);

  const old = { ...initialPlaceWear({ worldMinutes: 3000, eventCursor: 100 }), condition: 80 };
  const scenes = [studio(1, 'Workshop Annex', old), studio(2, 'Foundry Studio 4')];
  let updatePayload = null;
  const client = mockClient([
    [/FROM world_scenes WHERE world_id=\$1 AND created_by_project_id IS NOT NULL/, { rows: scenes }],
    [/SELECT COALESCE\(max\(id\),0\)::bigint AS id FROM world_events/, { rows: [{ id: 130 }] }],
    [/FROM world_events WHERE world_id=\$1 AND id>\$2/, (sql, params) => {
      assert.equal(params[1], 100); // lowest cursor of the places that already had a state
      assert.equal(params[2], 130);
      assert.deepEqual(params[5], PLACE_USE_ACTIONS);
      assert.match(sql, /NOT \(COALESCE\(data->'work','\{\}'::jsonb\) \? 'publicWork'\)/);
      return { rows: [{ id: 101, place: 'Workshop Annex', minute: 3100 }, { id: 120, place: 'Workshop Annex', minute: 3500 },
        { id: 125, place: 'Foundry Studio 4', minute: 3600 }] };
    }],
    [/UPDATE world_scenes scene SET features=jsonb_set/, (sql, params) => { updatePayload = JSON.parse(params[1]); return { rowCount: 2 }; }]
  ]);
  const result = await runProjectPlaceWearHour(client, { worldId: WORLD, worldMinutes: 3000 + 600, env: ON });
  assert.deepEqual(result, { places: 2, created: 1, uses: 2, cursor: 130 });
  const annex = updatePayload.find((row) => row.id === sceneId(1)).wear;
  const fresh = updatePayload.find((row) => row.id === sceneId(2)).wear;
  assert.equal(annex.usesTotal, 2);
  assert.equal(annex.condition, Math.round((80 - BASE_WEAR_PER_HOUR * 10 - USE_WEAR * 2) * 100) / 100);
  assert.equal(annex.eventCursor, 130);
  // The new place starts at the default 100 with its cursor at the head: its earlier event (id 125) is not counted.
  assert.equal(fresh.condition, 100);
  assert.equal(fresh.usesTotal, 0);
  assert.equal(fresh.eventCursor, 130);
  // Exactly one write, to world_scenes features only; nothing touches money or the conditions table.
  const writes = client.calls.filter((call) => /^\s*(UPDATE|INSERT|DELETE)/i.test(call.sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /LEAST\(upd\.wear->'condition'/);
  assert.match(writes[0].sql, /GREATEST\(upd\.wear->'repairs'/);
  assert.ok(!client.calls.some((call) => /treasury|ledger|balances|world_public_work_conditions/i.test(call.sql)));
});

test('completed repair restores the place (repairs + 1); public building repair path untouched', async () => {
  const client = mockClient([[/UPDATE world_scenes SET features=jsonb_set\(features,'\{placeWear\}'/, { rowCount: 1 }]]);
  assert.equal(await completeProjectPlaceRepair(client, { worldId: WORLD, sceneId: sceneId(1), worldMinutes: 9000 }), true);
  assert.match(client.calls[0].sql, /'condition',100/);
  assert.match(client.calls[0].sql, /'repairs',COALESCE\(\(features->'placeWear'->>'repairs'\)::int,0\)\+1/);

  // A builder's last repair session at the studio completes the contract through advancePublicWork.
  const work = { id: 'w1', kind: 'expansion', name: 'Workshop Annex Repair', project_key: 'placerepair:aaaaaaaa:1',
    required_skill: 'engineering', position: {}, progress: 99, sessions: 3, milestones_paid: 4, paid_raw: '9000000',
    contract_price_raw: '9000000', builder_agent_id: 'b1', reassignments: 0, scene_id: sceneId(1), scene_name: 'Workshop Annex',
    builder_name: 'MirrorTerra-05', target_work_id: null, building_type: 'workshop', work_type: 'repair' };
  const engine = mockClient([[/FROM world_public_works work JOIN world_scenes scene ON scene.id=work.scene_id/, { rows: [work] }],
    [/UPDATE world_public_works SET status='completed'/, { rowCount: 1 }],
    [/UPDATE world_scenes SET features=jsonb_set\(features,'\{placeWear\}'/, { rowCount: 1 }]]);
  const out = await advancePublicWork(engine, { worldId: WORLD, agentId: 'b1', place: 'Workshop Annex', worldMinutes: 9000,
    env: { MIRRORTERRA_SKILL_MATERIALS: 'off', MIRRORTERRA_SKILL_BUILDERS: 'off' } });
  assert.equal(out.completed, true);
  assert.ok(engine.calls.some((call) => /'\{placeWear\}'/.test(call.sql)));
  assert.ok(!engine.calls.some((call) => /world_public_work_conditions/.test(call.sql)));
  assert.ok(!engine.calls.some((call) => /'\{publicWork\}'/.test(call.sql)));
  // No money moved in this session (all milestones were already paid): no treasury entry.
  assert.ok(!engine.calls.some((call) => /world_sync_treasury_entries/.test(call.sql)));
});

test('worn studios are less attractive (x effect factor); switch off = identical scores', () => {
  const agent = { agentId: 'r1', status: 'idle', goal: 'wealth', primaryGoal: 'BUILD_WEALTH', riskTolerance: 0.5,
    sociability: 0.5, curiosity: 0.5, discipline: 0.5, ambition: 0.5, energy: 80, food: 80, social: 70, happiness: 60,
    knowledge: 20, internalUnits: '0', usdc: '10000', skills: { trading: 10, research: 10, engineering: 10, social: 10 },
    relationships: [], recentMemories: [] };
  const scenes = [studio(1, 'Workshop Annex', { condition: 90 }), studio(2, 'Foundry Studio 4', { condition: 0 }),
    studio(3, 'Maker Commons 6', { condition: 30 }), { id: 'w', name: 'Workshop', sceneType: 'workshop', status: 'active', features: {} }];
  const plain = scenes.map((scene) => ({ ...scene, features: {} }));
  const score = (list, place) => list.find((option) => option.action === 'work' && option.targetLocation === place).score;
  const prior = process.env[PROJECT_PLACE_WEAR_KEY];
  try {
    process.env[PROJECT_PLACE_WEAR_KEY] = 'on';
    const on = buildActivityCandidates(agent, scenes, { tick: 1, worldMinutes: 500 });
    const base = buildActivityCandidates(agent, plain, { tick: 1, worldMinutes: 500 });
    assert.equal(score(on, 'Workshop Annex'), score(base, 'Workshop Annex'));
    assert.equal(score(on, 'Workshop'), score(base, 'Workshop'));
    // The shift's own base utility (>= 28) is multiplied by the factor; shared adjustments (goals, jitter) follow.
    const opt = (list, place) => list.find((option) => option.action === 'work' && option.targetLocation === place);
    assert.equal(opt(on, 'Foundry Studio 4').placeEffectFactor, 0.35);
    assert.equal(opt(on, 'Maker Commons 6').placeEffectFactor, conditionFactor(30));
    assert.equal(opt(on, 'Workshop Annex').placeEffectFactor, undefined);
    assert.ok(score(base, 'Foundry Studio 4') - score(on, 'Foundry Studio 4') >= 0.65 * 28);
    assert.ok(score(base, 'Maker Commons 6') - score(on, 'Maker Commons 6') >= (1 - conditionFactor(30)) * 28);
    assert.ok(score(on, 'Foundry Studio 4') < score(on, 'Maker Commons 6'));
    process.env[PROJECT_PLACE_WEAR_KEY] = 'off';
    const offScores = buildActivityCandidates(agent, scenes, { tick: 1, worldMinutes: 500 });
    for (const place of ['Workshop Annex', 'Foundry Studio 4', 'Maker Commons 6', 'Workshop']) {
      assert.equal(score(offScores, place), score(base, place));
    }
  } finally {
    if (prior === undefined) delete process.env[PROJECT_PLACE_WEAR_KEY]; else process.env[PROJECT_PLACE_WEAR_KEY] = prior;
  }
});

test('growth hour with the switch off issues no project-place query (ctxfix2 behaviour)', async () => {
  const client = mockClient([[/to_regclass/, { rows: [{ ready: true }] }]]);
  await runGrowthHour(client, { worldId: WORLD, worldMinutes: 5000, stats: { residents: [] }, env: OFF }).catch(() => null);
  assert.ok(client.calls.length > 0);
  assert.ok(!client.calls.some((call) => /created_by_project_id|placeWear|project_place_wear/.test(call.sql)));
});

test('the three really used studios get repaired; the unused new ones decay (prod-shaped numbers)', () => {
  // Uses in the last 72 world hours as measured on 10-24 00:56 CST (world minute 1,573,473).
  const minute = 1_573_473;
  const h = Math.floor((minute - 600) / 60);
  const mk = (n, name, uses72h, condition) => projectPlaceFacility(studio(n, name, { condition,
    useHours: uses72h ? { [h]: uses72h } : {} }), minute);
  const places = [mk(1, 'Workshop Annex', 4, 69), mk(2, 'Foundry Studio', 7, 69), mk(3, 'Maker Commons 2', 1, 69),
    mk(4, 'Foundry Studio 4', 0, 69), mk(5, 'Workshop Annex 4', 0, 69)];
  // placewear1 rule (any use in 72 h); drivefix1 keeps it reachable with minUses 1.
  const needs = projectPlaceRepairNeeds({ places, open: [], minUses: 1 });
  assert.deepEqual(needs.map((need) => need.targetName).sort(), ['Foundry Studio', 'Maker Commons 2', 'Workshop Annex']);
  // drivefix1 default: at least 3 uses in 72 h -> Maker Commons 2 (1 use) is no longer repaired.
  const tight = projectPlaceRepairNeeds({ places, open: [], minUses: 3 });
  assert.deepEqual(tight.map((need) => need.targetName).sort(), ['Foundry Studio', 'Workshop Annex']);
  for (const need of needs) assert.ok(Number(need.baseRaw) / 1e6 >= 9 && Number(need.baseRaw) / 1e6 <= 9.5);
  assert.ok(REPAIR_THRESHOLD > 60); // repair is tendered while the place still has full effect
});

test('commission: a project-place repair is stored with scene_id = the place and meta work_type repair', async () => {
  const minute = 200_000;
  const place = projectPlaceFacility(studio(1, 'Workshop Annex', { condition: 65, repairs: 0,
    useHours: { [Math.floor((minute - 100) / 60)]: 3 } }), minute);
  const [need] = projectPlaceRepairNeeds({ places: [place] });
  let inserted = null, meta = null;
  const client = mockClient([
    [/balance_raw FROM world_sync_treasury_balances/, { rows: [{ balance_raw: '9000000000' }] }],
    [/AS escrow/, { rows: [{ escrow: '0' }] }],
    [/INSERT INTO world_public_works\(/, (sql, params) => { inserted = { sql, params }; return { rows: [{ id: 'new-work' }] }; }],
    [/INSERT INTO world_public_work_meta/, (sql, params) => { meta = params; return { rowCount: 1 }; }],
    [/COALESCE\(max\(\(position->>'district'\)::int\),1\) AS districts/, { rows: [{ districts: 1 }] }]
  ]);
  const prior = process.env[PROJECT_PLACE_WEAR_KEY];
  process.env[PROJECT_PLACE_WEAR_KEY] = 'on';
  try {
    const { commissionPublicWork } = await import('../src/public-works.js');
    const out = await commissionPublicWork(client, { worldId: WORLD, worldMinutes: minute, projectKey: need.projectKey,
      priceRaw: need.baseRaw, reason: need.reason, source: 'governor_fallback', stats: { residents: [] },
      demand: { worldMinutes: minute, facilities: [], projectPlaces: [place], newestDistrict: 1 } });
    assert.equal(out.workType, 'repair');
    assert.match(inserted.sql, /position,scene_id\)/);
    assert.equal(inserted.params[13], sceneId(1));      // scene_id = the studio
    assert.equal(inserted.params[8], null);            // no target public work
    assert.equal(inserted.params[2], 'expansion');
    assert.equal(meta[2], 'workshop');
    assert.equal(meta[3], 'repair');
  } finally {
    if (prior === undefined) delete process.env[PROJECT_PLACE_WEAR_KEY]; else process.env[PROJECT_PLACE_WEAR_KEY] = prior;
  }
});
