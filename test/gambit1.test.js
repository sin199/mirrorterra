// gambit1 unit tests (no database). Integration flows on a real migrated database live in
// test/gambit1.integration.test.js (skipped without GAMBIT1_TEST_DATABASE_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectQianmenPatterns } from '../src/agent-runtime/qianmen-eight-generals.js';
import { describePatterns, patternIndex, scenesAvailable, selectScenePatterns, validPatternIds, validateScenes } from '../src/agent-runtime/qianmen-scenes.js';
import { createFlagReader, FLAG_DEFAULTS } from '../src/gambit-flags.js';
import { bidClaims, bidMessages, leverChoices, proposeMessages, qianmenTag, qianmenToolsFor, voteMessages } from '../src/council-deliberation.js';
import { personalLeverImpact } from '../src/council-stakes.js';
import { CLAIM_FACTS, honestyRecord, judgeClaim, judgeCommitment, parseGambitOpen, parseGambitResponse, readCognitionGambits,
  COGNITION_GAMBIT_BYTES, syncToRaw, rawToSync, tallyBan } from '../src/world-gambits.js';
import { gambitStep, gambitView, initialAskMinute, startGambitWorker } from '../src/gambit-deliberation.js';
import { capabilityHonesty, readWorldCapabilitySummary } from '../src/world-capabilities.js';
import { consumeBuildMaterials } from '../src/public-works-skills.js';
import { placePublicWorkBid } from '../src/public-works.js';
import { translateText } from '../site/i18n.js';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const OFF = { MIRRORTERRA_GAMBIT_FLAGS_FILE: '/nonexistent/gambit-flags.json' };
const ON = { ...OFF, MIRRORTERRA_QIANMEN_COUNCIL: 'on', MIRRORTERRA_GAMBITS: 'on', MIRRORTERRA_CAPABILITY_COUNCIL: 'on', MIRRORTERRA_GAMBIT_COGNITION: 'on' };

// ---- Qianmen data -------------------------------------------------------------------------------
test('patterns.json is unchanged (108 patterns, modelab1 checksum) and the old selector output is byte-identical', () => {
  const file = readFileSync(new URL('../src/agent-runtime/skills/qianmen-eight-generals-108/patterns.json', import.meta.url));
  assert.equal(createHash('sha256').update(file).digest('hex'), '32f89dff8cfe44594d89ad49b482503d33529cd0bf5db3d13fe13cba11582f1d');
  assert.equal(JSON.parse(file).length, 108);
  // Snapshot computed from bea9d24-modelab1's selectQianmenPatterns on the same inputs.
  assert.equal(sha([selectQianmenPatterns({ goal: 'trade with neighbours', stakes: 'high' }), selectQianmenPatterns({ consent_state: 'revoked' }),
    selectQianmenPatterns({ goal: '学习研究' })]), 'adb467c8d7acd08055aec0235973b3197a8e5fcea0e915256c6b0c2ae3884313');
});

test('scenes.json validates, names all 108 in English, and every one of the 108 ids can be used', () => {
  assert.equal(scenesAvailable(), true);
  assert.equal(patternIndex().length, 108);
  assert.match(patternIndex()[36], /^QM037 最小联盟 \/ Minimal coalition$/);
  assert.deepEqual(validPatternIds(['qm001', 'QM108', 'QM109', 'XX', 'QM001']), ['QM001', 'QM108']);
  const scenes = JSON.parse(readFileSync(new URL('../src/agent-runtime/skills/qianmen-eight-generals-108/scenes.json', import.meta.url), 'utf8'));
  assert.ok(validateScenes(scenes));
  assert.equal(validateScenes({ ...scenes, patternsEn: { ...scenes.patternsEn, QM999: 'x' } }), null);
  const broken = structuredClone(scenes); broken.scenes.tender_bid.patterns.QM999 = { play: 'nope', counter: [] };
  assert.equal(validateScenes(broken), null);
});

test('scene candidates are deterministic per seed and include counters to the opponent patterns', () => {
  const a = selectScenePatterns({ scene: 'tender_bid', seed: 'R1:42', opponentPatternIds: ['QM040'] });
  const b = selectScenePatterns({ scene: 'tender_bid', seed: 'R1:42', opponentPatternIds: ['QM040'] });
  assert.deepEqual(a, b);
  assert.equal(a.anyIdAllowed, true);
  assert.ok(a.candidates.length >= 1 && a.candidates.length <= 5);
  assert.deepEqual(a.counters.map((item) => item.id).sort(), ['QM045', 'QM106']);
  assert.equal(describePatterns(['QM106'])[0].nameEn, 'Anomaly sentinel');
});

// ---- switches -----------------------------------------------------------------------------------
test('switches: P0 on and P1-P4 off by default; a JSON file overrides env without a restart; bad file = env only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gambit1-'));
  const file = path.join(dir, 'flags.json');
  let t = 0;
  const reader = createFlagReader({ file, now: () => t });
  assert.deepEqual(Object.keys(FLAG_DEFAULTS).filter((key) => reader.enabled(key, {})), ['MIRRORTERRA_CAPABILITY_HONESTY']);
  assert.equal(reader.enabled('MIRRORTERRA_GAMBITS', { MIRRORTERRA_GAMBITS: 'on' }), true);
  writeFileSync(file, JSON.stringify({ MIRRORTERRA_GAMBITS: 'on', MIRRORTERRA_CAPABILITY_HONESTY: 'off', NOT_A_FLAG: 'x' }));
  t += 20_000;
  assert.equal(reader.enabled('MIRRORTERRA_GAMBITS', {}), true);
  assert.equal(reader.enabled('MIRRORTERRA_CAPABILITY_HONESTY', {}), false);
  assert.equal(reader.raw('NOT_A_FLAG', {}), undefined);
  writeFileSync(file, '{broken');
  t += 20_000;
  assert.equal(reader.enabled('MIRRORTERRA_GAMBITS', {}), false);
  assert.equal(reader.number('MIRRORTERRA_GAMBIT_VERIFY_FEE_RAW', {}), 10_000);
  assert.equal(reader.number('MIRRORTERRA_GAMBIT_PROMPT_EVERY_WORLD_MINUTES', { MIRRORTERRA_GAMBIT_PROMPT_EVERY_WORLD_MINUTES: '720' }), 720);
});

// ---- P1: council messages ------------------------------------------------------------------------
const resident = { name: 'MirrorTerra-04', balance: '1.20 SYNC', skills: { engineering: 30 } };
const context = { lastWorldDay: { incomeTotal: '3 SYNC' } };
const work = { name: 'Harbor Hall', kind: 'market_hall', price_raw: '5000000', required_skill: 'engineering', bid_count: 2, work_type: 'build' };

test('switch off: council propose/vote/bid messages are byte-identical to bea9d24-modelab1', () => {
  // Hashes computed from modelab1's council-deliberation.js with exactly these inputs.
  assert.equal(sha(proposeMessages({ resident, context, levers: leverChoices({}, new Set()),
    suggestions: [{ lever: 'tax.income', value: { bps: 500 }, reason: 'raise revenue' }], cooldowns: [] })),
  '098bdcf5eab7e18fe83884452497123a57e61d9edf91568d486266a33ead6626');
  assert.equal(sha(voteMessages({ resident, context, proposals: [{ id: 'x', title: 'Income tax 0% -> 5%', reason: 'revenue' }] })),
    'd34f4000a8502c1bc814af9812372f418139768aabb5a6d3f6783f1ab22d4d43');
  assert.equal(sha(bidMessages({ resident, context, work, skillValue: 31, busy: false, sessionsEstimate: 7, buildSkills: ['Build L3'] })),
    'e4b270c8787339d057dc56739445a1131a83f791ffc5b5a5aa8893e9e4b343aa');
  assert.equal(sha(bidMessages({ resident, context, work, skillValue: 31, busy: false, sessionsEstimate: 7 })),
    'b90bf6ab1290624f43f759ffb32c6d1c6b03dc657046154ece8e261618573431');
});

test('switch on: council calls carry the personal stake, the Qianmen tools (all 108) and accept claims/lines', () => {
  const qianmen = qianmenToolsFor('council_vote', 'R4:1');
  const vote = JSON.parse(voteMessages({ resident, context, proposals: [{ id: 'x', title: 't', reason: 'r' }],
    stakes: [{ dailySyncDelta: -0.12, direction: 'loss' }], qianmen })[1].content);
  assert.equal(vote.proposals[0].yourStake.dailySyncDelta, -0.12);
  assert.equal(vote.qianmen.all108.length, 108);
  assert.ok(vote.answerJsonSchema.votes[0].patternIds);
  const bid = JSON.parse(bidMessages({ resident, context, work, skillValue: 31, busy: false, sessionsEstimate: 7,
    qianmen: qianmenToolsFor('tender_bid', 'x'), rivals: [{ resident: 'MirrorTerra-08', said: 'mine', claims: [] }] })[1].content);
  assert.equal(bid.rivalsSaidPublicly[0].resident, 'MirrorTerra-08');
  assert.ok(bid.answerJsonSchema.claims);
  assert.deepEqual(qianmenTag({ patternIds: ['QM025', 'bad'], publicLine: '  I want this one ' }), { qianmen: { patternIds: ['QM025'], publicLine: 'I want this one' } });
  const claims = bidClaims({ claims: [{ fact: 'build_skill', value: 60 }, { fact: 'third_party_offer', value: 1 }, { fact: 'private', value: 'my floor is 3' }] }, 'A');
  assert.deepEqual(claims.map((claim) => [claim.factKey, claim.verifiable]), [['build_skill', true], ['private', false]]);
});

test('personal stake: income tax, reward multiplier and wealth tax from the resident\'s own income', () => {
  const me = { incomeRaw: '2000000', balanceRaw: '500000000000', incomeBySourceRaw: { research_project: '1000000' }, ownedServiceTypes: ['food_service'] };
  assert.deepEqual(personalLeverImpact(me, { lever_key: 'tax.income', previous_value: { bps: 0 }, proposed_value: { bps: 500 } }),
    { dailySyncDelta: -0.1, direction: 'loss', basis: 'income tax on your reward income last world day' });
  assert.equal(personalLeverImpact(me, { lever_key: 'multiplier.research_project', previous_value: { milli: 1000 }, proposed_value: { milli: 1500 } }).dailySyncDelta, 0.5);
  assert.equal(personalLeverImpact(me, { lever_key: 'price.food_service', previous_value: { milli: 1000 }, proposed_value: { milli: 1200 } }).direction, 'gain');
  assert.equal(personalLeverImpact(me, { lever_key: 'tax.wealth', previous_value: { bps: 0 }, proposed_value: { bps: 300 } }).direction, 'loss');
});

// ---- P2: parsing, verification, commitments ---------------------------------------------------------
function makeRefs() {
  const residents = new Map([['MirrorTerra-01', { agentId: 'A', external: false, name: 'MirrorTerra-01' }],
    ['MirrorTerra-04', { agentId: 'B', external: false, name: 'MirrorTerra-04' }], ['MirrorTerra-08', { agentId: 'C', external: false, name: 'MirrorTerra-08' }],
    ['Visitor-Hark', { agentId: 'X', external: true, name: 'Visitor-Hark' }]]);
  return { residents, byId: new Map([...residents.values()].map((entry) => [entry.agentId, entry])),
    tenders: new Map([['T1', { id: 'w1', closesWorldMinute: 1200 }]]), proposals: new Map([['P1', { id: 'p1', closesWorldMinute: 1500 }]]),
    outputs: new Map([['O1', { id: '77', producerId: 'A' }]]), capabilities: new Map([['C1', { id: 'c1' }]]), contracts: new Map(),
    claims: new Map([['K1', { id: 9, agentId: 'C' }]]) };
}

test('opening a gambit: bluffs and checkable claims are allowed; refs must be real; externals never move SYNC', () => {
  const refs = makeRefs();
  assert.deepEqual(parseGambitOpen({ start: false, reason: 'not now' }, { refs, me: 'A', now: 1000 }).pass, true);
  const pact = parseGambitOpen({ start: true, scene: 'tender_bid', move: 'rotation_pact', counterparts: ['MirrorTerra-08'], target: 'T1',
    patternIds: ['QM040', 'QM037', 'QM999'], publicLine: 'Take turns?', commitments: [{ kind: 'abstain_bid', target: 'T1' }],
    ask: [{ kind: 'pay', amountSync: 0.25 }], claims: [{ fact: 'build_skill', value: 90 }, { fact: 'private', value: 'floor 2 SYNC' }] },
  { refs, me: 'A', now: 1000 });
  assert.equal(pact.mode, 'bilateral');
  assert.deepEqual(pact.patternIds, ['QM040', 'QM037']);
  assert.equal(pact.offer[0].dueWorldMinute, 1200);
  assert.equal(pact.ask[0].value.amountRaw, '250000');
  assert.equal(pact.ask[0].value.transferKind, 'subcontract');
  assert.deepEqual(pact.claims.map((claim) => claim.verifiable), [true, false]);
  assert.throws(() => parseGambitOpen({ start: true, scene: 'tender_bid', counterparts: ['Nobody'] }, { refs, me: 'A', now: 1 }), /COUNTERPART_INVALID/);
  assert.throws(() => parseGambitOpen({ start: true, scene: 'tender_bid', counterparts: ['Visitor-Hark'] }, { refs, me: 'A', now: 1 }), /COUNTERPART_INVALID/);
  assert.throws(() => parseGambitOpen({ start: true, scene: 'council_vote', counterparts: ['MirrorTerra-04'],
    commitments: [{ kind: 'pay', amountSync: 1, to: 'Visitor-Hark' }] }, { refs, me: 'A', now: 1 }), /EXTERNAL_NO_SYNC/);
  const sale = parseGambitOpen({ start: true, scene: 'material_trade', counterparts: ['MirrorTerra-04'], commitments: [{ kind: 'deliver_output', target: 'O1' }],
    ask: [{ kind: 'pay', amountSync: '0.3 SYNC' }] }, { refs, me: 'A', now: 1 });
  assert.equal(sale.ask[0].value.transferKind, 'material_sale');
  const ban = parseGambitOpen({ start: true, scene: 'council_vote', move: 'ban_call', counterparts: ['MirrorTerra-04', 'MirrorTerra-08'],
    banTarget: 'MirrorTerra-08', banWorldDays: 30 }, { refs, me: 'A', now: 1 });
  assert.equal(ban.mode, 'poll');
  assert.deepEqual(ban.ban, { targetAgentId: 'C', worldDays: 7 });
  const check = parseGambitOpen({ start: true, scene: 'verification', move: 'verify', counterparts: ['MirrorTerra-08'], verify: ['K1'] }, { refs, me: 'A', now: 1 });
  assert.deepEqual(check.verifyClaimIds, [9]);
});

test('responses: verify needs an unchecked claim of the other side; expose needs a claim YOU found false', () => {
  const refs = makeRefs();
  const gambit = { scene: 'tender_bid', mode: 'bilateral', initiatorAgentId: 'A', counterpartAgentIds: ['C'] };
  const claims = [{ id: 1, agentId: 'A', verification: 'unverified' }, { id: 2, agentId: 'C', verification: 'unverified' }];
  assert.deepEqual(parseGambitResponse({ move: 'verify', claims: ['K1'] }, { gambit, refs, me: 'C', now: 1, claims }).verifyClaimIds, [1]);
  assert.throws(() => parseGambitResponse({ move: 'verify', claims: ['K9'] }, { gambit, refs, me: 'C', now: 1, claims }), /VERIFY_NOTHING/);
  const checked = [{ id: 1, agentId: 'A', verification: 'false', verifiedBy: 'C' }];
  assert.deepEqual(parseGambitResponse({ move: 'expose', claims: ['K1'] }, { gambit, refs, me: 'C', now: 1, claims: checked }).exposeClaimIds, [1]);
  assert.throws(() => parseGambitResponse({ move: 'expose', claims: ['K1'] }, { gambit, refs, me: 'C', now: 1,
    claims: [{ id: 1, agentId: 'A', verification: 'false', verifiedBy: 'B' }] }), /EXPOSE_NEEDS/);
  const counter = parseGambitResponse({ move: 'counter', ask: [{ kind: 'pay', amountSync: 0.5 }], publicLine: 'More.' }, { gambit, refs, me: 'C', now: 1, claims });
  assert.equal(counter.ask[0].counterparty, 'C');
  assert.throws(() => parseGambitResponse({ move: 'dance' }, { gambit, refs, me: 'C', now: 1, claims }), /MOVE_INVALID/);
  assert.equal(parseGambitResponse({ move: 'accept' }, { gambit: { ...gambit, mode: 'poll' }, refs, me: 'C', now: 1, claims }).move, 'vote_yes');
});

test('claim verification from records; promises judged from records; ban tally; honesty record', () => {
  assert.equal(judgeClaim('build_skill', 41, 40).verification, 'true');
  assert.equal(judgeClaim('build_skill', 60, 40).verification, 'false');
  assert.equal(judgeClaim('active_contracts', 0, 1).verification, 'false');
  assert.equal(judgeClaim('third_party_offer', 0.5, [0.3, 0.5]).verification, 'true');
  assert.equal(judgeClaim('third_party_offer', 0.9, [0.3]).verification, 'false');
  assert.equal(judgeClaim('vote_cast', 'yes', 'no').verification, 'false');
  assert.equal(judgeClaim('private', 'x', 1).verification, 'unverifiable');
  assert.equal(CLAIM_FACTS.private.verifiable, false);
  assert.equal(judgeCommitment({ kind: 'abstain_bid' }, { bid: null }), 'kept');
  assert.equal(judgeCommitment({ kind: 'abstain_bid' }, { bid: { bidRaw: '1' } }), 'broken');
  assert.equal(judgeCommitment({ kind: 'vote_stance', value: { stance: 'yes' } }, { vote: 'yes' }), 'kept');
  assert.equal(judgeCommitment({ kind: 'place_bid', value: { maxRaw: '100' } }, { bid: { bidRaw: '200' } }), 'broken');
  assert.deepEqual(tallyBan({ yes: 5, no: 3, electorate: 9 }), { passed: true, yes: 5, no: 3, electorate: 9 });
  assert.equal(tallyBan({ yes: 4, no: 0, electorate: 9 }).passed, false);
  assert.deepEqual(honestyRecord([{ kind: 'kept' }, { kind: 'broken' }, { kind: 'exposed' }, { kind: 'claim_false' }]),
    { kept: 1, broken: 1, released: 0, exposed: 1, exposedOthers: 0, claimsTrue: 0, claimsFalse: 1, keptRate: 0.5 });
  assert.equal(syncToRaw(0.3).toString(), '300000');
  assert.equal(rawToSync('250000'), 0.25);
});

test('gambit view labels the other side\'s claims K1.. and shows verification results only to the verifier', () => {
  const refs = makeRefs();
  const nameOf = (id) => refs.byId.get(id)?.name;
  const view = gambitView({ scene: 'tender_bid', mode: 'bilateral', move: 'pact_offer', initiatorAgentId: 'A', counterpartAgentIds: ['C'],
    targetRef: 'tender:w1', status: 'verifying', terms: { proposerAgentId: 'A', offer: [{ kind: 'abstain_bid', agentId: 'A', targetRef: 'tender:w1', value: {} }], ask: [] },
    moves: [{ agentId: 'A', move: 'open', patternIds: ['QM040'], publicLine: 'deal?' }],
    claims: [{ id: 5, agentId: 'A', factKey: 'build_skill', value: 90, verification: 'false', verifiedBy: 'C', truth: 12 }] }, { me: 'C', refs, nameOf });
  assert.equal(view.target, 'T1');
  assert.equal(view.claims[0].ref, 'K1');
  assert.equal(view.claims[0].recordsSay, 12);
  assert.equal(view.youVerifiedResults, true);
  assert.match(view.history[0].patterns[0], /QM040 轮值主持/);
});

// ---- switches off: no DB activity, identical SQL -----------------------------------------------------
function recorder(rowsFor = () => []) {
  const sql = [];
  const client = { sql, query: async (text) => { sql.push(String(text?.text || text).replace(/\s+/g, ' ')); const rows = rowsFor(String(text)); return { rows, rowCount: rows.length }; },
    connect: async () => client, release: () => {} };
  return client;
}

test('switches off: the gambit step and worker do nothing and touch no table', async () => {
  const pool = recorder();
  assert.equal(await gambitStep(pool, { worldId: 'w', requestModel: async () => { throw new Error('no call'); }, env: OFF }), null);
  assert.equal(pool.sql.length, 0);
  const worker = startGambitWorker(pool, { worldId: 'w', apiKey: 'k', budgetGateway: { admit: async () => ({}) }, env: OFF });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await worker.stop();
  assert.equal(pool.sql.length, 0);
  assert.equal(initialAskMinute('abc', 5000, 1440), initialAskMinute('abc', 5000, 1440));
});

test('switches off: build-material claims and tender bids run exactly the modelab1 SQL', async () => {
  const c1 = recorder();
  await consumeBuildMaterials(c1, { worldId: 'w', work: { id: 'x', progress: 10, position: {} }, builderId: 'b', remaining: 50, worldMinutes: 100,
    env: { ...OFF, MIRRORTERRA_SKILL_MATERIALS: 'on' } });
  assert.equal(sha(c1.sql), '542093f8fde8f66fd2ac8f98ff4df09c8a08481580894f7983b2ac4062ff1e70');
  const c2 = recorder((text) => text.includes('FROM world_public_works work LEFT JOIN') ? [{ id: 'x', status: 'closed' }] : []);
  await placePublicWorkBid(c2, { worldId: 'w', workId: 'x', agentId: 'a', bidRaw: '1000000', reason: 'my bid', source: 'llm', worldMinutes: 5,
    env: { ...OFF, MIRRORTERRA_SKILL_MATERIALS: 'on' } }).catch((error) => c2.sql.push(`ERR ${error.code}`));
  assert.equal(sha(c2.sql), '6cd0b9cc7f93e470e6ccfc491fa70bb19d1653c4a67ada771c2f0364085fee25');
  // With gambits on, the reservation filter is added and a ban is checked before a bid.
  const c3 = recorder((text) => text.includes('to_regclass') ? [{ ok: true }] : []);
  await consumeBuildMaterials(c3, { worldId: 'w', work: { id: 'x', progress: 10, position: {} }, builderId: 'b', remaining: 50, worldMinutes: 100,
    env: { ...ON, MIRRORTERRA_SKILL_MATERIALS: 'on' } });
  assert.ok(c3.sql.some((text) => text.includes('world_material_reservations')));
  const c4 = recorder((text) => text.includes('to_regclass') ? [{ ok: true }] : text.includes('world_gambit_bans') ? [{ id: 1 }] : []);
  await assert.rejects(placePublicWorkBid(c4, { worldId: 'w', workId: 'x', agentId: 'a', bidRaw: '1000000', reason: 'my bid', source: 'llm', worldMinutes: 5, env: ON }),
    /PUBLIC_WORK_BIDDER_BANNED/);
});

test('P4 cognition summary stays under its byte cap', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ scene: 'tender_bid', move: 'pact_offer', status: 'awaiting', initiator: 'A', counterparts: ['B'],
    public_line: 'x'.repeat(200), turn: i % 2 ? 'A' : 'B' }));
  const db = { query: async (text) => ({ rows: text.includes('FROM world_gambits') ? many.slice(0, 5)
    : text.includes('world_reputation_events') ? Array.from({ length: 8 }, () => ({ agent: 'A', observer: 'B', kind: 'kept', detail: {} }))
      : [{ id: 'A', name: 'MirrorTerra-01' }, { id: 'B', name: 'MirrorTerra-04' }] }) };
  const summary = await readCognitionGambits(db, { worldId: 'w', agentId: 'A', worldMinutes: 10_000 });
  assert.ok(JSON.stringify(summary).length <= COGNITION_GAMBIT_BYTES);
  assert.ok(summary.open.length >= 1);
});

// ---- P0: capability page honesty ------------------------------------------------------------------------
test('P0: expired-without-votes, paused-since date, and rule vs AI votes', () => {
  const result = capabilityHonesty({
    proposals: [{ id: 'p1', status: 'abandoned', supportCount: 0, oppositionCount: 0 }, { id: 'p2', status: 'adopted', supportCount: 3, oppositionCount: 1 }],
    totals: [{ source: 'rule', decision: 'support', n: 381 }, { source: 'rule', decision: 'ignore', n: 257 }, { source: 'rule', decision: 'oppose', n: 23 },
      { source: 'ai', decision: 'support', n: 10 }],
    perProposal: [{ proposalId: 'p2', ruleVotes: 3, aiVotes: 1 }],
    lastProposal: { createdAt: '2026-10-14T16:05:00Z', openTotal: 0, expiredWithoutVotes: 3308 }, now: new Date('2026-10-23T03:00:00Z') });
  assert.equal(result.honesty.processPaused, true);
  assert.equal(result.honesty.pausedSince, '2026-10-15'); // 16:05 UTC = 00:05 CST on the 15th
  assert.equal(result.honesty.expiredWithoutVotes, 3308);
  assert.deepEqual(result.honesty.voteSources.rule, { support: 381, oppose: 23, ignore: 257, modify: 0 });
  assert.equal(result.proposals[0].expiredWithoutVotes, true);
  assert.equal(result.proposals[1].expiredWithoutVotes, false);
  assert.deepEqual([result.proposals[1].ruleVotes, result.proposals[1].aiVotes], [3, 1]);
  const active = capabilityHonesty({ proposals: [], lastProposal: { createdAt: new Date().toISOString(), openTotal: 2 } });
  assert.equal(active.honesty.processPaused, false);
});

test('P0: the summary carries honesty by default and exactly the modelab1 keys when switched off', async () => {
  const client = { query: async (text) => ({ rows: text.includes('max(created_at)') ? [{ createdAt: '2026-10-14T16:05:00Z', openTotal: 0, expiredWithoutVotes: 1 }]
    : text.includes('count(*) FILTER (WHERE status=') ? [{ active: 1 }] : [] }) };
  const on = await readWorldCapabilitySummary(client, { worldId: 'w', env: OFF });
  assert.equal(on.honesty.enabled, true);
  const off = await readWorldCapabilitySummary(client, { worldId: 'w', env: { ...OFF, MIRRORTERRA_CAPABILITY_HONESTY: 'off' } });
  assert.deepEqual(Object.keys(off), ['epoch', 'capabilities', 'proposals', 'experiments', 'gaps', 'counts', 'recentEvents']);
});

test('P0: page has the honesty slot and renders translated labels (English UI, Chinese via i18n)', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="world-capability-honesty"/);
  assert.match(html, /id="world-gambits-card"[^>]*hidden/);
  assert.match(html, /app\.js\?v=gambit1-20261023/);
  for (const label of ["'Expired without votes'", "'Rule votes'", "'AI votes'", 'Proposal process paused since']) assert.ok(app.includes(label), label);
  assert.equal(translateText('Expired without votes', 'zh-CN'), '未投票即过期');
  assert.equal(translateText('Proposal process paused since 2026-10-15', 'zh-CN'), '提案流程自 2026-10-15 起暂停');
  assert.equal(translateText('Rule votes: 381 support · 257 ignore · 23 oppose', 'zh-CN'), '规则票：支持 381 · 忽略 257 · 反对 23');
  assert.equal(translateText('AI votes: 15 support · 0 ignore · 0 oppose', 'zh-CN'), 'AI 票：支持 15 · 忽略 0 · 反对 0');
  assert.equal(translateText('Expired without votes', 'en'), 'Expired without votes');
  assert.ok(!html.includes('og.jpg?') || html.includes('og.jpg'));
});
