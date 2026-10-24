// council3: residents think with Luna; no free money; the treasury pays only for building public works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COUNCIL_GOVERNOR_ID, buildEconomyStats, deterministicStance } from '../src/council.js';
import { LEVER_KEYS, TREASURY_OUTFLOW_KINDS, defaultLeverValue, issueResidentReward } from '../src/treasury.js';
import { MILESTONES, PUBLIC_WORK_CATALOG, applyPublicWorksNeedBonus, bidCredible, chooseWinningBid, constructionGain,
  fallbackCommission, heuristicBid, milestonePayments, publicWorkCandidates, publicWorksEffectsFromScenes,
  publicWorksLearnMultiplier, publicWorksNeeds, publicWorksSalesBonus, publicWorksTravelFactor, validateCommission }
  from '../src/public-works.js';
import { LUNA_TIMEOUT_MS, callLuna, createCouncilModelRouter, economyContext, leverChoices, parseBid, parseCommission,
  parseProposal, parseVotes, proposeMessages, valueFromTarget, voteMessages } from '../src/council-deliberation.js';

const SYNC = 1_000_000n;
const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ids = Array.from({ length: 10 }, (_, i) => (i === 0 ? COUNCIL_GOVERNOR_ID
  : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
const defaults = Object.fromEntries(LEVER_KEYS.map((lever) => [lever, defaultLeverValue(lever)]));
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const code = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('--')).join('\n');

// growth1: needs come only from measured demand. A town with no road but many trips into District 1
// and enough latent demand for every use category.
const demandAll = { residents: 10, lowEnergy: 7, lowEnergyFarByDistrict: {}, housing: { homeless: 0, beds: 0 }, facilities: [],
  categories: { care: { buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 7 },
    learn: { buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 14 },
    leisure: { buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 13 },
    social: { buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 13 },
    market: { buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 4 },
    craft: { buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 16 } },
  districtTrips: [{ district: 1, trips24h: 60, walkMinutes: 16, hasRoad: false, hasBridge: false },
    { district: 2, trips24h: 20, walkMinutes: 20, hasRoad: true, hasBridge: false }], newestDistrict: 3, uses24h: 0, saturated: [],
  // growth2: where residents go (all of them live, work and show each kind of demand near district 1).
  worldMinutes: 100_000, reach: { districtTraffic: { 1: { visits: 80, residents: 10 } },
    anchors: Array.from({ length: 10 }, (_, i) => ({ agentId: `r${i}`, home: { x: 1.389 * Math.cos(0.84), z: 1.389 * Math.sin(0.84) }, work: null })),
    points: Object.fromEntries(['care','learn','leisure','social','market','craft','all'].map((key) => [key,
      Array.from({ length: 20 }, () => ({ x: 1.389 * Math.cos(0.84), z: 1.389 * Math.sin(0.84) }))])), taken: [] } };

function stats({ energy = 45, knowledge = 30, fun = 60, social = 50, spending = 1n * SYNC } = {}) {
  return buildEconomyStats({ pool: ids.map((agentId) => ({ source_type: 'research_project', agent_id: agentId, amount: String(8n * SYNC) })),
    spendingRaw: spending, balances: ids.map((agentId, index) => ({ agent_id: agentId, name: `Synterra-${String(index + 1).padStart(2, '0')}`,
      balance_raw: String(BigInt(200 + index * 20) * SYNC), goal: 'balanced', energy, food: 60, social, happiness: 60, knowledge, fun,
      hygiene: 70, sociability: 0.5, curiosity: 0.5, discipline: 0.5, ambition: 0.5 })), treasuryBalanceRaw: '0', memberCount: 10 });
}

test('no grants or prizes: the treasury pays rewards to nobody, only construction milestones leave it', async () => {
  const [council, works, treasury, migration, deliberation] = await Promise.all(['../src/council.js', '../src/public-works.js',
    '../src/treasury.js', '../migrations/0030_public_works.sql', '../src/council-deliberation.js'].map(read));
  // The only treasury outflow entry posted anywhere in the council3 code is kind 'public_works'.
  for (const source of [council, works, treasury, deliberation]) {
    const kinds = [...code(source).matchAll(/kind: '([a-z_]+)',\s*\n?\s*toAgentId/g)].map((match) => match[1]);
    assert.ok(kinds.every((kind) => kind === 'public_works'), `only public_works outflows (${kinds})`);
    for (const kind of ['grant','subsidy','bounty','service_purchase','reward_bonus']) {
      assert.doesNotMatch(code(source), new RegExp(`kind: '${kind}'`), `${kind} is never posted`);
    }
  }
  assert.ok(TREASURY_OUTFLOW_KINDS.includes('public_works'));
  // A full treasury does not pay a reward: rewards go down the unchanged pool path.
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return sql.includes('INSERT INTO arc_sync_resident_reward_contributions')
    ? { rowCount: 1, rows: [{ id: 'c1', status: 'queued' }] } : { rowCount: 1, rows: [{ ready: true, balance_raw: '999999999999' }] }; } };
  const reward = await issueResidentReward(client, { worldId: WORLD, agentId: ids[1], sourceType: 'research_project',
    sourceEventId: '1', sourceEntityId: '2', rewardWeight: '1' }, { env: {} });
  assert.equal(reward.funding, 'pool');
  assert.ok(!calls.some((sql) => sql.includes('world_sync_treasury_entries')));
  // The multiplier lever no longer pays a treasury bonus above 1x and such a proposal is refused.
  assert.doesNotMatch(code(council), /kind: 'reward_bonus'/);
  assert.match(council, /COUNCIL_NO_TREASURY_BONUS/);
  assert.equal(valueFromTarget('multiplier.research_project', 1.5), null);
  assert.deepEqual(valueFromTarget('multiplier.research_project', 0.75), { milli: 750 });
  // Migration 0030 is additive: no change to any existing object; no chain/outbox/ledger/gate.
  const sql = code(migration);
  assert.doesNotMatch(sql, /\b(DROP|ALTER TABLE|ALTER FUNCTION|CREATE OR REPLACE)\b/i);
  assert.doesNotMatch(sql, /world_sync_treasury_entries|arc_sync_|planned_action|world_council_votes|world_council_proposals/);
  assert.match(sql, /CREATE TABLE world_public_works/);
  assert.match(sql, /RAISE EXCEPTION 'Public work progress and payments only grow'/);
  assert.match(sql, /paid_raw <= price_raw/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE/);
  assert.doesNotMatch(council + works + treasury + deliberation, /MAINNET_WRITE_GATE|SYNC_COMMITTED_PAYOUT_WRITE_GATE|SYNC_RESIDENT_REWARD_COMMIT_ENABLED|arc_sync_payout_outbox|arc_sync_ledger_postings/);
  assert.doesNotMatch(code(works + deliberation), /daily cap|DAILY_CAP|per day limit/i);
});

test('payment only on construction milestones: 25/50/75/100%, totals exactly the contract, reassignment keeps the bound', () => {
  const contract = 6_200_000n;
  assert.deepEqual(milestonePayments({ progress: 24, milestonesPaid: 0, contractPriceRaw: contract, paidRaw: 0n }), [],
    'no payment before the first milestone (none at commissioning or award)');
  const first = milestonePayments({ progress: 31, milestonesPaid: 0, contractPriceRaw: contract, paidRaw: 0n });
  assert.deepEqual(first.map((item) => item.milestone), [1]);
  assert.equal(first[0].amountRaw, contract / 4n);
  const jump = milestonePayments({ progress: 100, milestonesPaid: 1, contractPriceRaw: contract, paidRaw: first[0].amountRaw });
  assert.deepEqual(jump.map((item) => item.milestone), [2, 3, 4]);
  assert.equal(first[0].amountRaw + jump.reduce((sum, item) => sum + item.amountRaw, 0n), contract, 'total = contract price');
  // An odd contract still totals exactly (the last milestone pays the remainder).
  const odd = milestonePayments({ progress: 100, milestonesPaid: 0, contractPriceRaw: 7_777_777n, paidRaw: 0n });
  assert.equal(odd.length, MILESTONES);
  assert.equal(odd.reduce((sum, item) => sum + item.amountRaw, 0n), 7_777_777n);
  // After a reassignment (new contract = paid + new bid share), the rest is split over the unpaid milestones.
  const after = milestonePayments({ progress: 75, milestonesPaid: 2, contractPriceRaw: 9_000_000n, paidRaw: 3_100_000n });
  assert.deepEqual(after.map((item) => [item.milestone, item.amountRaw]), [[3, 2_950_000n]]);
  // Construction gain is skill-based and needs several real work sessions.
  const low = constructionGain({ agentId: ids[2], workKey: 'road:1', sessions: 0, skillValue: 0 });
  const high = constructionGain({ agentId: ids[2], workKey: 'road:1', sessions: 0, skillValue: 60 });
  assert.ok(low >= 10 && low <= 14 && high >= 16 && high <= 20, `${low} ${high}`);
  // Builders get a construction affordance for their own site only (and only when they can work).
  const works = [{ id: 'w1', builder_agent_id: ids[3], status: 'building', scene_name: 'Town Paths', name: 'Town Paths', progress: 30,
    contract_price_raw: '6200000', paid_raw: '1550000' }];
  const mine = publicWorkCandidates({ agentId: ids[3], energy: 60, food: 60, location: 'Library' }, works);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].action, 'work');
  assert.equal(mine[0].targetLocation, 'Town Paths');
  assert.equal(mine[0].publicWorkId, 'w1');
  assert.equal(publicWorkCandidates({ agentId: ids[4], energy: 60, food: 60 }, works).length, 0);
  assert.equal(publicWorkCandidates({ agentId: ids[3], energy: 10, food: 60 }, works).length, 0);
});

test('commission, bids and award: what the world lacks, full price funded first, lowest credible (skill-adjusted) bid wins', () => {
  assert.deepEqual(publicWorksNeeds({ completed: [], open: [], stats: stats({ energy: 30 }), districts: 3 }), [],
    'growth1: nothing measured -> nothing offered');
  const needs = publicWorksNeeds({ completed: [], open: [], demand: demandAll, districts: 3 });
  assert.equal(needs[0].kind, 'road', 'paths first: 60 trips a day into a district without a road');
  for (const kind of ['road','bridge','park','market_hall','clinic','school','public_building']) {
    assert.ok(needs.some((need) => need.kind === kind), `${kind} is offered`);
  }
  assert.ok(needs.every((need) => /\d/.test(need.reason)), 'every reason states measured numbers');
  assert.ok(needs.every((need) => BigInt(need.minRaw) <= BigInt(need.baseRaw) && BigInt(need.baseRaw) <= BigInt(need.maxRaw)));
  // An open road is not commissioned twice; a built clinic can be expanded.
  const later = publicWorksNeeds({ open: [{ kind: 'road', projectKey: 'road:1' }], districts: 1,
    demand: { ...demandAll, facilities: [{ workId: 'aaaaaaaa-1111-4000-8000-000000000001', type: 'clinic', storedKind: 'clinic',
      name: 'Public Clinic', level: 1, condition: 90, uses24h: 7, usesPrev24h: 7, renewedMinute: 0, capacity: 8, utilization: 0.875 }] } });
  assert.ok(!later.some((need) => need.kind === 'road'));
  assert.ok(later.some((need) => need.kind === 'expansion' && need.targetKind === 'clinic'));
  // Construction waits until revenue arrives: nothing affordable -> no commission.
  assert.equal(fallbackCommission({ needs, freeRaw: 2n * SYNC }), null);
  const pick = fallbackCommission({ needs, freeRaw: 30n * SYNC });
  assert.equal(pick.projectKey, needs[0].projectKey);
  assert.throws(() => validateCommission({ needs, freeRaw: 5n * SYNC, projectKey: 'road:1', priceRaw: 8n * SYNC }), /PUBLIC_WORK_UNFUNDED/);
  assert.equal(validateCommission({ needs, freeRaw: 40n * SYNC, projectKey: 'road:1', priceRaw: 999n * SYNC }).priceRaw, 16n * SYNC,
    'clamped to 2x base');
  // Bids: governor, busy, unskilled and too-low bids are not credible.
  assert.equal(bidCredible({ bidRaw: 6n * SYNC, priceRaw: 8n * SYNC, skillValue: 20, agentId: ids[2] }), true);
  assert.equal(bidCredible({ bidRaw: 6n * SYNC, priceRaw: 8n * SYNC, skillValue: 20, agentId: COUNCIL_GOVERNOR_ID }), false);
  assert.equal(bidCredible({ bidRaw: 3n * SYNC, priceRaw: 8n * SYNC, skillValue: 20, agentId: ids[2] }), false);
  assert.equal(bidCredible({ bidRaw: 6n * SYNC, priceRaw: 8n * SYNC, skillValue: 1, agentId: ids[2] }), false);
  assert.equal(bidCredible({ bidRaw: 6n * SYNC, priceRaw: 8n * SYNC, skillValue: 20, busy: true, agentId: ids[2] }), false);
  const winner = chooseWinningBid([
    { id: 1, agentId: ids[2], bidRaw: '5000000', skillValue: 4, credible: true },
    { id: 2, agentId: ids[3], bidRaw: '5400000', skillValue: 60, credible: true },
    { id: 3, agentId: ids[4], bidRaw: '3000000', skillValue: 60, credible: false }]);
  assert.equal(winner.agentId, ids[3], 'a skilled builder beats a slightly cheaper unskilled one');
  assert.equal(chooseWinningBid([{ id: 1, agentId: ids[2], bidRaw: '5000000', skillValue: 30, credible: true }], new Set([ids[2]])), null);
  const bid = heuristicBid({ agentId: ids[5], priceRaw: 10n * SYNC, skillValue: 30, balanceRaw: 100n * SYNC, medianBalanceRaw: 300n * SYNC, workKey: 'park:1' });
  assert.ok(bid >= 4n * SYNC && bid <= 10n * SYNC);
});

test('completion creates a place with its benefit: roads/bridges speed travel, schools learning, clinics health, parks/halls mood, market halls sales', () => {
  const site = { status: 'inactive', features: { origin: 'public_works', publicWork: { stage: 'building', kind: 'road', progress: 75 } } };
  assert.deepEqual(publicWorksEffectsFromScenes([site]), publicWorksEffectsFromScenes([]), 'a construction site has no effect yet');
  const built = (kind, level = 1) => ({ status: 'active', features: { origin: 'public_works', archetype: PUBLIC_WORK_CATALOG[kind].archetype,
    publicWork: { stage: 'built', kind, level } } });
  const effects = publicWorksEffectsFromScenes([built('road'), built('road'), built('bridge'), built('school'), built('clinic', 2),
    built('park'), built('market_hall'), built('public_building'), { status: 'active', features: { origin: 'skill_demand' } }]);
  assert.deepEqual(effects, { roads: 2, bridges: 1, parks: 1, marketHalls: 1, clinics: 2, schools: 1, halls: 1 });
  assert.equal(publicWorksTravelFactor(effects, { x: 0.1, z: 0 }, { x: 0.5, z: 0 }), 0.84, 'two roads: 16% faster');
  assert.equal(publicWorksTravelFactor(effects, { x: 0.1, z: 0 }, { x: 1.9, z: 0 }), 0.672, 'plus a bridge to the outer districts');
  assert.equal(publicWorksTravelFactor({ roads: 20 }), 0.6, 'bounded');
  assert.equal(publicWorksLearnMultiplier(effects), 1.25);
  assert.equal(publicWorksSalesBonus(effects), 6);
  const tired = applyPublicWorksNeedBonus({ energy: 30, food: 50, social: 40, hygiene: 50, fun: 50, happiness: 60 }, effects, 1);
  assert.deepEqual([tired.energy, tired.hygiene, tired.fun, tired.social], [34, 52, 51, 42]);
  const rested = applyPublicWorksNeedBonus({ energy: 90, food: 50, social: 99, hygiene: 50, fun: 50 }, effects, 1);
  assert.equal(rested.energy, 90, 'the clinic helps tired residents only');
  assert.equal(rested.social, 100, 'capped at 100');
});

test('Luna vote path: the provider path with the json hint, rate-limited gateway; parsed votes; fallback only on failure', async () => {
  // A real router (same provider code path as open cognition) with a fake transport and budget gateway.
  const requests = [];
  const gatewayCalls = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model: 'gpt-6-luna', usage: { prompt_tokens: 900, completion_tokens: 60 },
      choices: [{ message: { content: '{"votes":[{"id":"P1","stance":"no","reason":"A sales tax hits my small shop."},{"id":"P2","stance":"yes","reason":"Roads need revenue."}]}' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const budgetGateway = { runRequest: async (input, execute) => { gatewayCalls.push(input); return execute(); },
    recordApplicationResult: async () => {} };
  const requestModel = createCouncilModelRouter({ apiKey: 'test-key', budgetGateway, worldId: WORLD, fetchImpl, model: 'gpt-6-luna' });
  const proposals = [{ id: 'p1', title: 'Sales tax: 0% → 3%', reason: 'Fund roads.' }, { id: 'p2', title: 'Income tax: 0% → 5%', reason: 'Fund a clinic.' }];
  const s = stats();
  const context = economyContext({ stats: s, policies: defaults, treasuryRaw: 70_000n, openProposals: proposals, needs: [] });
  const messages = voteMessages({ resident: { name: 'MirrorTerra-04' }, context, proposals });
  const call = await callLuna(requestModel, { messages, agentId: ids[3], phase: 'vote' });
  assert.equal(call.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, 'gpt-6-luna');
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.ok(requests[0].body.messages.some((message) => message.role !== 'system' && /json/i.test(message.content)), 'json hint present');
  assert.equal(gatewayCalls[0].source, 'openCognition', 'same budget gateway source and rate limits');
  assert.equal(gatewayCalls[0].trigger, 'council_deliberation');
  assert.equal(gatewayCalls[0].timeoutMs, LUNA_TIMEOUT_MS);
  const votes = parseVotes(call.output, proposals);
  assert.deepEqual(votes.get('p1'), { stance: 'no', reason: 'A sales tax hits my small shop.' });
  assert.equal(votes.get('p2').stance, 'yes');
  assert.doesNotMatch(JSON.stringify(messages), UUID, 'no ids in the prompt');
  // Failure (timeout / provider error) -> ok:false with a code; the caller uses the deterministic stance.
  const failing = async () => { throw Object.assign(new Error('timeout'), { code: 'BAI_COMPLETION_UNAVAILABLE' }); };
  const failed = await callLuna(failing, { messages, agentId: ids[3], phase: 'vote' });
  assert.equal(failed.ok, false);
  assert.equal(failed.failureCode, 'BAI_COMPLETION_UNAVAILABLE');
  const fallback = deterministicStance({ proposal: { id: 'p1', lever_key: 'tax.sales', proposed_value: { bps: 300 },
    previous_value: { bps: 0 } }, resident: s.residents[3], stats: s });
  assert.ok(['yes','no'].includes(fallback.stance) && fallback.reason.length >= 3);
  // A vote missing for a proposal is filled by the fallback for that proposal only.
  assert.equal(parseVotes({ votes: [{ id: 'P2', stance: 'yes', reason: 'Roads need revenue.' }] }, proposals).has('p1'), false);
  assert.throws(() => parseVotes({ nope: 1 }, proposals), /LUNA_OUTPUT_INVALID/);
});

test('Luna proposals, commissions and bids: bounded levers only, invalid output -> fallback', () => {
  assert.deepEqual(parseProposal({ propose: true, lever: 'tax.sales', target: 3, reason: 'Fund the road.' }),
    { propose: true, lever: 'tax.sales', value: { bps: 300 }, reason: 'Fund the road.' });
  assert.deepEqual(parseProposal({ propose: false, reason: 'Nothing to change.' }), { propose: false, reason: 'Nothing to change.' });
  // council4: a near miss (45% > 30%) is clamped into range; a far miss is still refused.
  assert.deepEqual(parseProposal({ propose: true, lever: 'tax.sales', target: 45, reason: 'x y z' }).value, { bps: 3000 });
  assert.throws(() => parseProposal({ propose: true, lever: 'tax.sales', target: 300, reason: 'x y z' }), /LUNA_TARGET_OUT_OF_BOUNDS/);
  assert.throws(() => parseProposal({ propose: true, lever: 'treasury.grants', target: 1, reason: 'x y z' }), /LUNA_LEVER_INVALID/);
  assert.throws(() => parseProposal({ propose: true, lever: 'tax.sales', target: 3, reason: 'x y z' }, { blocked: new Set(['tax.sales']) }), /LUNA_LEVER_BUSY/);
  assert.deepEqual(valueFromTarget('good.tools', 2.5), { priceRaw: '2500000' });
  assert.deepEqual(valueFromTarget('good.tools', null), { offered: false });
  assert.deepEqual(valueFromTarget('treasury.guidance', 'public works'), { mode: 'public_works' });
  assert.ok(leverChoices(defaults).some((choice) => choice.lever === 'multiplier.research_project' && /above 1 is not allowed/.test(choice.target)));
  const messages = proposeMessages({ resident: { name: 'MirrorTerra-02' }, context: economyContext({ stats: stats(), policies: defaults }),
    levers: leverChoices(defaults), suggestions: [] });
  assert.match(messages[0].content, /never hands out money/);
  assert.match(messages[1].content, /incomeBySource/);
  const needs = publicWorksNeeds({ demand: demandAll, districts: 1 });
  const road = needs.find((need) => need.kind === 'road');
  assert.deepEqual(parseCommission({ commission: true, project: road.projectKey, priceSync: 7.5, reason: 'Paths first.' }, needs, 20n * SYNC),
    { commission: true, projectKey: road.projectKey, priceRaw: 7_500_000n, reason: 'Paths first.' });
  assert.throws(() => parseCommission({ commission: true, project: road.projectKey, priceSync: 9, reason: 'x' }, needs, 8n * SYNC), /UNFUNDED/);
  assert.throws(() => parseCommission({ commission: true, project: road.projectKey, priceSync: 1, reason: 'x' }, needs, 20n * SYNC), /OUT_OF_RANGE/);
  assert.equal(parseCommission({ commission: false, reason: 'Wait for taxes.' }, needs, 20n * SYNC).commission, false);
  assert.deepEqual(parseBid({ bid: true, priceSync: 99, reason: 'I can build it.' }, { price_raw: '8000000' }),
    { bid: true, bidRaw: 8_000_000n, reason: 'I can build it.' });
  assert.equal(parseBid({ bid: 'no', reason: 'Busy.' }, { price_raw: '8000000' }).bid, false);
});

test('wiring: engine hooks, worker startup, startup schema 0030, UI version and panel', async () => {
  const [engine, server, schema, environment, businesses, places, app, index, world3d] = await Promise.all(['../src/world-engine.js',
    '../src/server.js', '../src/startup-schema.js', '../src/world-environment.js', '../src/world-businesses.js',
    '../site/world-places3d.js', '../site/app.js', '../site/index.html', '../site/world3d.js'].map(read));
  assert.match(engine, /advancePublicWork\(client, \{ worldId, agentId: agent\.agentId, place/);
  assert.match(engine, /applyPublicWorksNeedBonus\(/);
  assert.match(engine, /publicWorksTravelFactor\(currentPublicWorksEffects\(\)/);
  assert.match(engine, /publicWorksLearnMultiplier\(currentPublicWorksEffects\(\)\)/);
  assert.match(engine, /publicWorks: publicWorksBuilding/);
  assert.match(environment, /if \(candidate\.publicWorkId\) return true;/);
  assert.match(businesses, /publicWorksSalesBonus\(currentPublicWorksEffects\(\)\)/);
  assert.match(server, /startCouncilDeliberationWorker\(pool, \{ worldId: observerWorldId,\s+budgetGateway: baiBudgetGateway/);
  assert.match(schema, /'0030_public_works\.sql',\s+'0031_external_residents\.sql'(, '0032_public_works_growth\.sql')?\]/);
  assert.match(schema, /\['world_public_works', 'world_public_work_update_check'\]/);
  assert.match(places, /function construction\(b, accent, r, scene\)/);
  assert.match(places, /road, bridge, park, construction[,\s}]/);
  for (const text of [app, index, world3d]) assert.match(text, /v=growth4-20261022/);
});
