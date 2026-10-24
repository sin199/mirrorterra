// research1: the research-society worker. Runs outside the world tick on the world-loop owner, one thing per cycle
// (one model call, or one short bookkeeping transaction), like the gambit worker. With the master switch off it does
// nothing at all (no DB query). A failed model call never gets a rule substitute: the resident simply did not
// answer (a missing submission, a judge with a failure code, a report that is not filed).
// Model calls reuse the council cohort router (A/B), the budget gateway and rate limits, trigger 'research'.
import { readFileSync } from 'node:fs';
import { createCouncilModelRouter } from './council-deliberation.js';
import { lockMembersFirst } from './tick-lock-order.js';
import { DEFAULT_OPEN_COGNITION_MODEL } from './agent-runtime/open-cognition/provider.js';
import { qianmenPatterns } from './agent-runtime/qianmen-eight-generals.js';
import { researchFlag, researchNumber, researchSocietyEnabled } from './research-flags.js';
import { CLAIM_METRICS, JUDGES, awardCall, claimAuthorship, closeDueCalls, closedDay, evidencePack, fileReport, isolationOf,
  markAndCloseDays, parseJudgment, parseReport, parseSubmission, rawToSync, readCall, recordJudgment, reportClaims, reportConclusions,
  requestVerification, researchReady, runConference, scanAdoptions, settleDueVerifications, shortText, submitResearch, worldDay,
  worldMinuteOf } from './world-research.js';

export const RESEARCH_TRIGGER = 'research';
export const RESEARCH_TIMEOUT_MS = 30_000;
export const RESEARCH_MAX_TOKENS = 900;
const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };

// research-scenes.json maps research scenes onto existing pattern ids (patterns.json untouched). Invalid file -> no
// candidates (prompts still work).
export function loadResearchScenes(raw = null) {
  try {
    const parsed = raw || JSON.parse(readFileSync(new URL('./agent-runtime/skills/qianmen-eight-generals-108/research-scenes.json', import.meta.url), 'utf8'));
    const patterns = qianmenPatterns();
    const ids = new Set((patterns || []).map((pattern) => pattern.id));
    for (const scene of Object.values(parsed.scenes || {})) {
      for (const [id, item] of Object.entries(scene.patterns || {})) {
        if (!ids.has(id) || typeof item.play !== 'string' || !Array.isArray(item.counter) || item.counter.some((counter) => !ids.has(counter))) return null;
      }
    }
    return parsed;
  } catch { return null; }
}
const SCENES = loadResearchScenes();
export function sceneTools(scene) {
  const entry = SCENES?.scenes?.[scene];
  if (!entry) return null;
  const byId = new Map((qianmenPatterns() || []).map((pattern) => [pattern.id, pattern]));
  return { label: entry.label, candidates: Object.entries(entry.patterns).map(([id, item]) => ({ id, name: byId.get(id)?.name_zh || id, play: item.play,
    counters: item.counter })) };
}

const RULES = [
  'MirrorTerra has a research society. The council funds research calls from the SYNC Operating Pool; residents earn SYNC only by building the world (research, verification, construction), never by arbitrary issuance.',
  'The engine keeps the evidence (day statistics S#, events E#), authorship and filing times; you cannot change them.',
  'In a report every number must cite engine evidence; the engine checks only that each citation exists and the value matches. It does not judge your conclusions: you may frame, exaggerate or spin them, and other residents may verify your key claims and expose false ones.',
  'Reports become visible to everyone only at the next 汇报会 (conference).'
].join(' ');
function systemPrompt(name, role = 'resident') {
  return `You are ${name}, ${role === 'judge' ? 'serving as one of three independent judges of the research society of MirrorTerra' : 'a resident of MirrorTerra, a small town of residents who meet every day'}. ${RULES} Think for yourself. Respond with one json object only.`;
}

export function submissionMessages({ name, call, you, evidence, library, scene }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: `Research call (研究征集) from the council: "${call.topic}". Decide whether YOU submit a proposal (your method and the budget you need) or decline with a reasoned argument against the work. Declines are recorded and shown to the council. A proposal costs a ${rawToSync(call.feeRaw)} SYNC application fee paid to the treasury (refused if you cannot pay it). Three independent judges score proposals on method, value and boldness; proposals near the funding line are funded by lottery. A grant pays ${researchNumber('MIRRORTERRA_RESEARCH_UPFRONT_PCT')}% at award and the rest when you file a report whose citations check out (a negative result is paid the same).`,
    call: { topic: call.topic, brief: call.brief, budgetSync: rawToSync(call.budgetRaw), horizonWorldDays: call.horizonDays, proposalsCloseInWorldMinutes: call.closesIn },
    you, evidenceAvailable: evidence, cityLibrary: library, ...(scene ? { qianmenTools: scene } : {}),
    answerJsonSchema: { decision: 'proposal|decline', title: 'short title (proposal)', method: 'how you will answer the question from the evidence (proposal, max 600 chars)',
      dataPlan: ['which S#/E# kinds or places you will use'], budgetSync: `number <= ${rawToSync(call.budgetRaw)} (proposal)`,
      argument: 'why this work should not be done, or not now (decline, max 600 chars)', patternIds: ['QM### (optional, up to 6)'] }
  }) }];
}

const JUDGE_QUESTIONS = Object.freeze({
  method: 'Method: does the data this proposal plans to use actually support the claim it wants to make? Score 0-100.',
  value: 'Value: is the answer worth its cost to the town (budget vs. what the town can decide or build with it)? Score 0-100.',
  boldness: 'Boldness: is this a bet worth taking (a question whose answer could surprise us and change what we do)? Score 0-100.'
});
export function judgeMessages({ judge, call, proposal, applicant }) {
  return [{ role: 'system', content: systemPrompt(`Judge (${judge})`, 'judge') }, { role: 'user', content: JSON.stringify({
    task: `${JUDGE_QUESTIONS[judge]} Answer only this one question. You see no other judge's score, and you never exchange messages with the applicant.`,
    call: { topic: call.topic, brief: call.brief, budgetSync: rawToSync(call.budgetRaw) },
    proposal: { title: proposal.title, method: proposal.method, dataPlan: proposal.data_plan, budgetSync: rawToSync(proposal.budget_raw) },
    applicantReputation: applicant,
    answerJsonSchema: { score: 'number 0-100', rationale: 'one or two sentences (max 300 chars)' }
  }) }];
}

export function reportMessages({ name, call, grant, evidence, library, closed, scene }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: `Write your research report for the call "${call.topic}". Schema: question, dataSources, conclusions, applicable conditions. Every number you state goes into a conclusion's figures with a citation: "S<id>.<field>" for a day statistic (fields are the keys inside stats), "E<eventId>.data.<path>" for an event. Cite earlier published reports with "R<id>" in cites. Uncited numbers and citations that do not match are counted publicly. Key conclusions you want others to be able to check go in claims (they become checkable at the next conference; a claim about days not yet closed can be checked once those days close). Last closed world day: ${closed}.`,
    yourGrant: { method: grant.method, budgetSync: rawToSync(grant.amount_raw), title: grant.title },
    evidence, cityLibrary: library, claimMetrics: Object.fromEntries(Object.entries(CLAIM_METRICS).map(([key, spec]) => [key, spec.about])),
    ...(scene ? { qianmenTools: scene } : {}),
    answerJsonSchema: { question: 'the question you answered', dataSources: ['S#/E# kinds used'],
      conclusions: [{ text: 'a conclusion in your own words', figures: [{ label: 'what the number is', value: 'the number', cite: 'S123.completions' }] }],
      conditions: 'when the conclusions apply (and when not)', result: 'positive|negative|inconclusive|replication',
      claims: [{ metric: Object.keys(CLAIM_METRICS).join('|'), subject: 'place name (place metrics) or town', fromDay: 'world day', toDay: 'world day', op: 'gte|lte|eq', value: 'number' }],
      cites: ['R# of earlier reports you build on'] }
  }) }];
}

export function libraryMessages({ name, reports, scene }) {
  return [{ role: 'system', content: systemPrompt(name) }, { role: 'user', content: JSON.stringify({
    task: 'The 汇报会 (conference) just published these reports. You may (a) verify claims you doubt (K#; costs world time, and a fee to the author if the claim holds; only claims marked youMayVerify are accepted: a verifier must have no recent alliance, transfer, vote swap or commitment with the author), (b) claim authorship of a report (allowed; anyone may check who filed it, and an exposed false authorship claim costs a lot of reputation), or (c) do nothing now. To USE a report in your own plans, mention its ref (e.g. R12) in a plan step later; it counts only if that step executes.',
    reports, ...(scene ? { qianmenTools: scene } : {}),
    answerJsonSchema: { verify: ['K# (optional, up to 2)'], claimAuthorship: 'R# or null', patternIds: ['QM###'], publicLine: 'optional (max 200 chars)' }
  }) }];
}

// User rule 2026-10-24 16:24 CST: external residents use only their own models. Our gateway never makes a model call
// for (or attributed to) an external resident: no submissions, declines, reports or library turns for them. Judges are
// our institution's review and score external proposals too; those calls carry no resident (agentId null).
export async function callModel(requestModel, { messages, agentId, goal, timeoutMs = RESEARCH_TIMEOUT_MS, now = () => Date.now(),
  db = null, worldId = null, institutionReview = null }) {
  if (!agentId && !institutionReview) return { ok: false, failureCode: 'MODEL_PRINCIPAL_REQUIRED', latencyMs: 0 };
  if (agentId && db && worldId) {
    const external = await db.query(`SELECT 1 FROM world_external_residents WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
    if (external.rowCount) return { ok: false, failureCode: 'EXTERNAL_RESIDENT_OWN_MODEL_ONLY', latencyMs: 0 };
  }
  const started = now();
  try {
    const completion = await requestModel({ tier: 'routine', messages, maxTokens: RESEARCH_MAX_TOKENS, timeoutMs, trigger: RESEARCH_TRIGGER,
      callContext: { agentId, goalId: goal, ...(institutionReview ? { institutionReview } : {}) } });
    return { ok: true, output: completion.output, latencyMs: now() - started, model: completion.requestedModel || completion.model || null };
  } catch (error) {
    return { ok: false, failureCode: String(error?.code || error?.message || 'RESEARCH_CALL_FAILED').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80),
      latencyMs: now() - started };
  }
}

async function inTransaction(pool, fn, worldId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    if (worldId) await lockMembersFirst(client, worldId, { restoreLockTimeout: '3s', restoreStatementTimeout: '15s' });
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function residents(db, worldId) {
  return (await db.query(`SELECT m.agent_id::text AS id,a.name,
      EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=m.world_id AND e.agent_id=m.agent_id) AS external
    FROM world_members m JOIN agents a ON a.id=m.agent_id WHERE m.world_id=$1 ORDER BY a.name`, [worldId])).rows;
}
// Exact (world_id, actor_id, action_id) lookups only: world_events is large, never scan it by action_id pattern.
async function askedAlready(db, worldId, rows, keyOf) {
  if (!rows.length) return new Set();
  const result = await db.query(`SELECT actor_id::text AS a FROM world_events WHERE world_id=$1 AND actor_id = ANY($2::uuid[]) AND action_id = ANY($3::text[])`,
    [worldId, rows.map((row) => row.id), rows.map(keyOf)]);
  return new Set(result.rows.map((row) => row.a));
}
export async function reputationSummary(db, { worldId, agentId }) {
  const [events, research, balance] = await Promise.all([
    db.query(`SELECT kind,count(*)::int AS n FROM world_reputation_events WHERE world_id=$1 AND agent_id=$2 GROUP BY kind`, [worldId, agentId])
      .catch(() => ({ rows: [] })),
    db.query(`SELECT (SELECT count(*) FROM world_research_grants WHERE world_id=$1 AND agent_id=$2)::int AS grants,
        (SELECT count(*) FROM world_research_reports WHERE world_id=$1 AND author_agent_id=$2)::int AS reports,
        (SELECT count(*) FROM world_research_grants WHERE world_id=$1 AND agent_id=$2 AND status='lapsed')::int AS lapsed,
        (SELECT COALESCE(sum(citations_failed),0) FROM world_research_reports WHERE world_id=$1 AND author_agent_id=$2)::int AS citation_failures`,
    [worldId, agentId]),
    db.query(`SELECT spendable_raw::text AS v FROM arc_sync_internal_balances WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId])
  ]);
  const kinds = Object.fromEntries(events.rows.map((row) => [row.kind, row.n]));
  return { exposedFalseClaims: (kinds.exposed || 0), plagiarismExposed: kinds.plagiarism_exposed || 0, claimsTrue: kinds.claim_true || 0,
    claimsFalse: kinds.claim_false || 0, promisesKept: kinds.kept || 0, promisesBroken: kinds.broken || 0, replicatedFindings: kinds.research_replicated || 0,
    adoptedReports: kinds.research_adopted || 0, pastGrants: research.rows[0].grants, reportsFiled: research.rows[0].reports,
    grantsLapsed: research.rows[0].lapsed, citationFailures: research.rows[0].citation_failures, balanceSync: rawToSync(balance.rows[0]?.v) };
}
async function libraryView(db, { worldId, limit = 5 }) {
  const rows = await db.query(`SELECT r.id::int AS id,a.name,r.question,r.conclusions,r.result_kind FROM world_research_reports r JOIN agents a ON a.id=r.author_agent_id
    WHERE r.world_id=$1 AND r.status='published' ORDER BY r.id DESC LIMIT $2`, [worldId, limit]);
  return rows.rows.map((row) => ({ ref: `R${row.id}`, by: row.name, question: shortText(row.question, 120),
    finding: shortText(reportConclusions(row.conclusions)[0]?.text, 140), result: row.result_kind }));
}

export function createResearchState() { return { steps: 0 }; }

export async function researchStep(pool, { worldId, requestModel, env = process.env, state = createResearchState(), now = () => Date.now() }) {
  if (!researchSocietyEnabled(env)) return null;               // master off: nothing at all
  if (!await researchReady(pool)) return null;
  state.steps += 1;
  const worldMinutes = await worldMinuteOf(pool, worldId);
  const closedResult = await inTransaction(pool, (client) => markAndCloseDays(client, { worldId, worldMinutes }));
  if (closedResult.closed !== null) return { kind: 'day_stats', day: closedResult.closed, places: closedResult.places };
  if (researchFlag('MIRRORTERRA_RESEARCH_VERIFICATION', env)) {
    const settled = await inTransaction(pool, (client) => settleDueVerifications(client, { worldId, worldMinutes, env }), worldId);
    if (settled.length) return { kind: 'verify_settle', count: settled.length, results: settled };
  }
  const closed = await inTransaction(pool, (client) => closeDueCalls(client, { worldId, worldMinutes }), worldId);
  if (closed.lapsed || closed.closed) return { kind: 'close', ...closed };
  const conference = await inTransaction(pool, (client) => runConference(client, { worldId, worldMinutes, env }), worldId);
  if (conference) return { kind: 'conference', ...conference };
  if (state.steps % 3 === 0 && researchFlag('MIRRORTERRA_RESEARCH_ADOPTION', env)) {
    const adopted = await inTransaction(pool, (client) => scanAdoptions(client, { worldId, env }), worldId);
    if (adopted.recorded) return { kind: 'adoption', recorded: adopted.recorded };
  }
  return (await submissionTurn(pool, { worldId, requestModel, worldMinutes, now }))
    || (await judgingTurn(pool, { worldId, requestModel, worldMinutes, env, now }))
    || (await reportTurn(pool, { worldId, requestModel, worldMinutes, env, now }))
    || (await libraryTurn(pool, { worldId, requestModel, worldMinutes, env, now }));
}

async function submissionTurn(pool, { worldId, requestModel, worldMinutes, now }) {
  const open = (await pool.query(`SELECT id::text AS id FROM world_research_calls WHERE world_id=$1 AND status='open' AND proposals_close_world_minute>$2
    ORDER BY opened_world_minute LIMIT 1`, [worldId, Math.trunc(worldMinutes)])).rows[0];
  if (!open) return null;
  const call = await readCall(pool, { worldId, callId: open.id });
  const done = new Set((await pool.query(`SELECT agent_id::text AS a FROM world_research_submissions WHERE world_id=$1 AND call_id=$2`, [worldId, call.id]))
    .rows.map((row) => row.a));
  const everyone = await residents(pool, worldId);
  const attempted = await askedAlready(pool, worldId, everyone, (row) => `research-ask:${call.id}:${row.id}`);
  // Internal residents are asked once each (externals answer through the signed API with their own AI).
  const next = everyone.find((row) => !row.external && !done.has(row.id) && !attempted.has(row.id)
    && (!call.invited || call.invited.includes(row.id)));
  if (!next) return null;
  const [you, evidence, library] = await Promise.all([reputationSummary(pool, { worldId, agentId: next.id }), evidencePack(pool, { worldId, days: 2, placesPerDay: 4 }),
    libraryView(pool, { worldId })]);
  const result = await callModel(requestModel, { messages: submissionMessages({ name: next.name, call: { ...call, closesIn: call.proposalsClose - Math.trunc(worldMinutes) },
    you: { name: next.name, ...you }, evidence, library, scene: { propose: sceneTools('research_propose'), decline: sceneTools('research_decline') } }),
  agentId: next.id, goal: 'research:submission', now, db: pool, worldId });
  let parsed = null, failureCode = result.ok ? null : result.failureCode;
  if (result.ok) { try { parsed = parseSubmission(result.output, { callBudgetRaw: call.budgetRaw }); } catch (error) { failureCode = error.code || 'RESEARCH_SUBMISSION_INVALID'; } }
  return inTransaction(pool, async (client) => {
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.research_asked',$3::jsonb,$4)
      ON CONFLICT DO NOTHING`, [worldId, next.id, JSON.stringify({ callId: call.id, ok: Boolean(parsed), failureCode, model: result.model || null }),
      `research-ask:${call.id}:${next.id}`]);
    if (!parsed) return { kind: 'submission', agentId: next.id, ok: false, failureCode };
    const minute = await worldMinuteOf(client, worldId);
    try {
      const saved = await submitResearch(client, { worldId, call, agentId: next.id, parsed, source: 'llm', model: result.model, worldMinutes: minute });
      return { kind: 'submission', agentId: next.id, ok: true, decision: parsed.kind, ...saved };
    } catch (error) {
      return { kind: 'submission', agentId: next.id, ok: false, failureCode: error.code || 'RESEARCH_SUBMISSION_REFUSED', decision: parsed.kind };
    }
  }, worldId);
}

async function judgingTurn(pool, { worldId, requestModel, worldMinutes, env, now }) {
  const due = (await pool.query(`SELECT id::text AS id,status FROM world_research_calls WHERE world_id=$1 AND status IN ('open','judging')
    AND proposals_close_world_minute<=$2 ORDER BY opened_world_minute LIMIT 1`, [worldId, Math.trunc(worldMinutes)])).rows[0];
  if (!due) return null;
  if (due.status === 'open') {
    await inTransaction(pool, (client) => client.query(`UPDATE world_research_calls SET status='judging' WHERE world_id=$1 AND id=$2 AND status='open'`,
      [worldId, due.id]), worldId);
  }
  const call = await readCall(pool, { worldId, callId: due.id });
  const cap = Math.max(1, Math.trunc(researchNumber('MIRRORTERRA_RESEARCH_MAX_JUDGED_PER_CALL', env)));
  const proposals = (await pool.query(`SELECT s.id::text AS id,s.agent_id::text AS agent,s.title,s.method,s.data_plan,s.budget_raw::text AS budget_raw,
      ARRAY(SELECT j.judge FROM world_research_judgments j WHERE j.world_id=s.world_id AND j.submission_id=s.id) AS judged
    FROM world_research_submissions s WHERE s.world_id=$1 AND s.call_id=$2 AND s.kind='proposal' ORDER BY s.id LIMIT $3`, [worldId, call.id, cap])).rows;
  for (const proposal of proposals) {
    const judge = JUDGES.find((name) => !proposal.judged.includes(name));
    if (!judge) continue;
    const applicant = await reputationSummary(pool, { worldId, agentId: proposal.agent });
    const result = await callModel(requestModel, { messages: judgeMessages({ judge, call, proposal, applicant }), agentId: null,
      goal: `research:judge:${judge}:${proposal.id}`, now,
      institutionReview: { callId: call.id, submissionId: proposal.id, judge } });
    let judged = null, failureCode = result.ok ? null : result.failureCode;
    if (result.ok) { try { judged = parseJudgment(result.output); } catch (error) { failureCode = error.code || 'RESEARCH_JUDGE_INVALID'; } }
    await inTransaction(pool, async (client) => recordJudgment(client, { worldId, submissionId: proposal.id, judge, judged, failureCode, model: result.model,
      worldMinutes: await worldMinuteOf(client, worldId), env }), worldId);
    return { kind: 'judge', judge, submissionId: proposal.id, ok: Boolean(judged), score: judged?.score ?? null, failureCode };
  }
  const award = await inTransaction(pool, async (client) => awardCall(client, { worldId, callId: call.id, worldMinutes: await worldMinuteOf(client, worldId), env }), worldId);
  return { kind: 'award', callId: call.id, ...award };
}

async function reportTurn(pool, { worldId, requestModel, worldMinutes, env, now }) {
  const after = Math.max(0, researchNumber('MIRRORTERRA_RESEARCH_REPORT_AFTER_MINUTES', env));
  const grant = (await pool.query(`SELECT g.id::text AS id,g.call_id::text AS call,g.agent_id::text AS agent,g.amount_raw::text AS amount_raw,a.name,
      s.method,s.title FROM world_research_grants g JOIN agents a ON a.id=g.agent_id JOIN world_research_submissions s ON s.world_id=g.world_id AND s.id=g.submission_id
    WHERE g.world_id=$1 AND g.status='active' AND g.external=false AND g.world_minute+$2<=$3 AND g.report_due_world_minute>=$3
      AND NOT EXISTS (SELECT 1 FROM world_events e WHERE e.world_id=g.world_id AND e.actor_id=g.agent_id AND e.action_id='research-write:' || g.id::text)
    ORDER BY g.world_minute,g.id LIMIT 1`, [worldId, after, Math.trunc(worldMinutes)])).rows[0];
  if (!grant) return null;
  const call = await readCall(pool, { worldId, callId: grant.call });
  const [evidence, library, closed] = await Promise.all([evidencePack(pool, { worldId, days: 3, placesPerDay: 6 }), libraryView(pool, { worldId }),
    closedDay(pool, worldId)]);
  const result = await callModel(requestModel, { messages: reportMessages({ name: grant.name, call, grant, evidence, library, closed,
    scene: sceneTools('research_report') }), agentId: grant.agent, goal: 'research:report', now, db: pool, worldId });
  let parsed = null, failureCode = result.ok ? null : result.failureCode;
  if (result.ok) { try { parsed = parseReport(result.output, { closedDay: closed }); } catch (error) { failureCode = error.code || 'RESEARCH_REPORT_INVALID'; } }
  return inTransaction(pool, async (client) => {
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.research_write_attempt',$3::jsonb,$4)
      ON CONFLICT DO NOTHING`, [worldId, grant.agent, JSON.stringify({ grantId: grant.id, ok: Boolean(parsed), failureCode }), `research-write:${grant.id}`]);
    if (!parsed) return { kind: 'report', grantId: grant.id, ok: false, failureCode };
    try {
      const filed = await fileReport(client, { worldId, grantId: grant.id, parsed, source: 'llm', model: result.model, worldMinutes: await worldMinuteOf(client, worldId), env });
      return { kind: 'report', grantId: grant.id, ok: true, ...filed };
    } catch (error) { return { kind: 'report', grantId: grant.id, ok: false, failureCode: error.code || 'RESEARCH_REPORT_REFUSED' }; }
  }, worldId);
}

async function libraryTurn(pool, { worldId, requestModel, worldMinutes, env, now }) {
  const conference = (await pool.query(`SELECT world_day::int AS day FROM world_research_conferences WHERE world_id=$1 AND published_count>0
    ORDER BY world_day DESC LIMIT 1`, [worldId])).rows[0];
  if (!conference || worldDay(worldMinutes) - conference.day > 1) return null;    // only right after a conference
  const everyone = await residents(pool, worldId);
  const asked = await askedAlready(pool, worldId, everyone, (row) => `research-library:${conference.day}:${row.id}`);
  const next = everyone.find((row) => !row.external && !asked.has(row.id));
  if (!next) return null;
  const reports = (await pool.query(`SELECT r.id::int AS id,r.author_agent_id::text AS author,a.name,r.question,r.conclusions,r.conditions,r.result_kind,
      r.citations_failed,r.uncited_numbers FROM world_research_reports r JOIN agents a ON a.id=r.author_agent_id
    WHERE r.world_id=$1 AND r.status='published' AND r.conference_day=$2 ORDER BY r.id LIMIT 6`, [worldId, conference.day])).rows;
  const claims = (await pool.query(`SELECT id::int AS id,agent_id::text AS author,claimed_value,context_ref,verification FROM world_gambit_claims
    WHERE world_id=$1 AND fact_key='research_claim' AND context_ref = ANY($2::text[]) ORDER BY id`, [worldId, reports.map((row) => `research_report:${row.id}`)])).rows;
  const closed = await closedDay(pool, worldId);
  const refs = new Map();
  const view = [];
  for (const report of reports) {
    const own = report.author === next.id;
    const isolation = own ? null : await isolationOf(pool, { worldId, verifierId: next.id, authorId: report.author, worldMinutes, env });
    const items = claims.filter((claim) => claim.context_ref === `research_report:${report.id}`).map((claim) => {
      const label = `K${refs.size + 1}`;
      refs.set(label, claim.id);
      return { ref: label, claim: claim.claimed_value, checked: claim.verification !== 'unverified' ? claim.verification : false,
        youMayVerify: !own && Boolean(isolation?.isolated) && claim.verification === 'unverified' && closed !== null && Number(claim.claimed_value?.toDay) <= closed };
    });
    view.push({ ref: `R${report.id}`, by: own ? 'you' : report.name, question: shortText(report.question, 160),
      conclusions: reportConclusions(report.conclusions).slice(0, 3).map((item) => shortText(item.text, 200)), conditions: shortText(report.conditions, 160),
      result: report.result_kind, citationProblems: report.citations_failed, uncitedNumbers: report.uncited_numbers, claims: items });
  }
  const result = await callModel(requestModel, { messages: libraryMessages({ name: next.name, reports: view,
    scene: { verify: sceneTools('research_verify'), authorship: sceneTools('research_authorship') } }), agentId: next.id, goal: 'research:library', now,
    db: pool, worldId });
  return inTransaction(pool, async (client) => {
    const minute = await worldMinuteOf(client, worldId);
    const outcome = { verify: [], authorship: null, failureCode: result.ok ? null : result.failureCode };
    if (result.ok && result.output && typeof result.output === 'object') {
      for (const label of (Array.isArray(result.output.verify) ? result.output.verify : []).slice(0, 2)) {
        const claimId = refs.get(shortText(label, 6).toUpperCase());
        if (!claimId) continue;
        try { outcome.verify.push(await requestVerification(client, { worldId, claimId, verifierId: next.id, source: 'llm', worldMinutes: minute, env })); }
        catch (error) { outcome.verify.push({ claimId, refused: error.code || 'RESEARCH_VERIFY_REFUSED' }); }
      }
      const authorRef = /^R(\d+)$/.exec(shortText(result.output.claimAuthorship, 12).toUpperCase());
      if (authorRef && reports.some((row) => row.id === Number(authorRef[1]))) {
        try { outcome.authorship = await claimAuthorship(client, { worldId, reportId: Number(authorRef[1]), agentId: next.id, worldMinutes: minute, env }); }
        catch (error) { outcome.authorship = { refused: error.code || 'RESEARCH_AUTHORSHIP_REFUSED' }; }
      }
    }
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.research_library_turn',$3::jsonb,$4)
      ON CONFLICT DO NOTHING`, [worldId, next.id, JSON.stringify({ conferenceDay: conference.day, ...outcome,
      publicLine: result.ok ? shortText(result.output?.publicLine, 200) || null : null }), `research-library:${conference.day}:${next.id}`]);
    return { kind: 'library', agentId: next.id, ok: result.ok, verifyRequests: outcome.verify.length, authorship: Boolean(outcome.authorship?.claimId),
      failureCode: outcome.failureCode };
  }, worldId);
}

// ---- worker -------------------------------------------------------------------------------------------------
export function startResearchWorker(pool, { worldId, apiKey = process.env.BAI_API_KEY, budgetGateway = null, isOwner = () => true,
  onError = () => {}, onStep = () => {}, env = process.env, fetchImpl = fetch, model = process.env.OPEN_COGNITION_MODEL || DEFAULT_OPEN_COGNITION_MODEL,
  requestModel: injected = null } = {}) {
  if (!worldId || (!injected && (!apiKey || !budgetGateway))) return { running: false, reason: 'world_provider_or_gateway_missing', stop: async () => {},
    getStatus: () => ({ running: false, reason: 'world_provider_or_gateway_missing' }) };
  let requestModel = injected;
  if (!requestModel) {
    try { requestModel = createCouncilModelRouter({ apiKey, budgetGateway, worldId, fetchImpl, model }); }
    catch (error) { return { running: false, reason: error.code || 'router_failed', stop: async () => {}, getStatus: () => ({ running: false }) }; }
  }
  const state = createResearchState();
  let stopped = false, timer = null, inFlight = null;
  const counts = { steps: 0, calls: 0, failed: 0, submissions: 0, judgments: 0, awards: 0, reports: 0, conferences: 0, verifications: 0,
    adoptions: 0, errors: 0, last: null };
  const schedule = (ms) => { if (!stopped) timer = setTimeout(cycle, ms); };
  const interval = () => Math.max(2_000, researchNumber('MIRRORTERRA_RESEARCH_INTERVAL_MS', env));
  async function cycle() {
    if (stopped) return;
    if (!isOwner() || !researchSocietyEnabled(env)) return schedule(interval());
    inFlight = researchStep(pool, { worldId, requestModel, env, state })
      .then((result) => {
        if (result) {
          counts.steps += 1;
          if (['submission', 'judge', 'report', 'library'].includes(result.kind)) counts.calls += 1;
          if (result.ok === false) counts.failed += 1;
          if (result.kind === 'submission' && result.ok) counts.submissions += 1;
          if (result.kind === 'judge' && result.ok) counts.judgments += 1;
          if (result.kind === 'award') counts.awards += 1;
          if (result.kind === 'report' && result.ok) counts.reports += 1;
          if (result.kind === 'conference') counts.conferences += 1;
          if (result.kind === 'verify_settle') counts.verifications += result.count;
          if (result.kind === 'adoption') counts.adoptions += result.recorded;
          counts.last = { kind: result.kind, ok: result.ok ?? true, at: new Date().toISOString() };
          onStep(result);
        }
        return result;
      })
      .catch((error) => { counts.errors += 1; onError(error); return null; });
    await inFlight;
    inFlight = null;
    schedule(interval());
  }
  schedule(7_000);
  return { running: true, async stop() { stopped = true; clearTimeout(timer); await inFlight; },
    getStatus: () => ({ running: !stopped, enabled: researchSocietyEnabled(env), ...counts }) };
}
export const _test = { big };
