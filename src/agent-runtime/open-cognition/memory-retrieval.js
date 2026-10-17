import { createHash } from 'node:crypto';
import { materialCognitionFingerprint } from './schedule.js';

const MAX_CACHE_ENTRIES = 256;
const selectionCache = new Map();

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokens(value) {
  const normalized = String(value || '').toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]{1,}/gu) || [];
  const result = new Set(normalized.filter((part) => part.length > 1));
  for (const part of normalized.filter((item) => /^[\u3400-\u9fff]+$/u.test(item))) {
    for (let index = 0; index < part.length - 1; index += 1) result.add(part.slice(index, index + 2));
  }
  return result;
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.sqrt(left.size * right.size);
}

function relevantText(context) {
  const goals = (context.prior?.goals || []).filter((goal) => goal.status === 'active');
  const plans = (context.prior?.plans || []).filter((plan) => ['active','blocked'].includes(plan.status));
  const questions = (context.prior?.openQuestions || []).filter((question) => ['open','exploring'].includes(question.status));
  const relationships = (context.relationships || []).map((item) => item.name);
  const projects = (context.projects || []).map((item) => `${item.title || ''} ${item.goal || ''}`);
  return {
    goalText: goals.map((goal) => `${goal.title || ''} ${goal.why || ''}`).join(' '),
    planText: plans.map((plan) => `${plan.summary || ''} ${plan.steps?.[plan.currentStep]?.description || ''}`).join(' '),
    questionText: questions.map((question) => question.question).join(' '),
    relationshipText: relationships.join(' '), projectText: projects.join(' ')
  };
}

export function prefilterMemoryCandidates(candidates, context) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const relevance = relevantText(context);
  const goalTokens = tokens(relevance.goalText);
  const planTokens = tokens(relevance.planText);
  const questionTokens = tokens(relevance.questionText);
  const relationshipTokens = tokens(relevance.relationshipText);
  const projectTokens = tokens(relevance.projectText);
  const worldMinute = Number(context.world?.minute) || 0;
  const ranked = rows.map((memory) => {
    const memoryTokens = tokens(`${memory.type || ''} ${memory.summary || ''}`);
    const age = Math.max(0, worldMinute - (Number(memory.worldMinute) || 0));
    const recency = Math.exp(-age / 50_000);
    const goal = overlap(memoryTokens, goalTokens);
    const plan = overlap(memoryTokens, planTokens);
    const question = overlap(memoryTokens, questionTokens);
    const relationship = overlap(memoryTokens, relationshipTokens);
    const project = overlap(memoryTokens, projectTokens);
    const typeBoost = (memory.type === 'goal' || memory.type === 'failure' ? 0.2 : 0)
      + (memory.type === 'relationship' ? relationship * 0.9 : 0)
      + (memory.type === 'project' ? project * 0.9 : 0);
    const importance = Math.max(0, Math.min(1, Number(memory.importance) || 0));
    return { memory, score: 3 * goal + 3.4 * plan + 2.6 * question
      + 0.9 * relationship + 0.9 * project + 0.2 * recency + 0.35 * importance + typeBoost };
  }).sort((a, b) => b.score - a.score
    || Number(b.memory.worldMinute || 0) - Number(a.memory.worldMinute || 0)
    || String(a.memory.id).localeCompare(String(b.memory.id)));

  // Relevance determines the shortlist size. There is no fixed memory-count cap:
  // strong matches and explicitly important older evidence remain available.
  const relevanceFloor = Math.max(0.72, (ranked[0]?.score || 0) * 0.32);
  const selected = [];
  const selectedTypes = new Set();
  for (const item of ranked) {
    const diverseEvidence = !selectedTypes.has(item.memory.type)
      && (item.score >= relevanceFloor * 0.82 || Number(item.memory.importance) >= 0.8);
    if (item.score >= relevanceFloor || Number(item.memory.importance) >= 0.8 || diverseEvidence) {
      selected.push(item.memory);
      selectedTypes.add(item.memory.type);
    }
  }
  if (!selected.length && ranked[0]) selected.push(ranked[0].memory);
  return selected;
}

export function memorySelectionCacheKey({ agentId, context, candidates }) {
  const relevant = relevantText(context);
  const candidateHash = hash((candidates || []).map((item) => [item.id,item.type,item.summary,
    item.worldMinute,item.importance]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
  return hash({ agentId, candidateHash, relevant,
    materialFingerprint: materialCognitionFingerprint(context),
    selfModel: context.prior?.selfModel, beliefs: context.prior?.beliefs,
    values: context.prior?.values, questions: context.prior?.openQuestions });
}

export function getCachedMemorySelection(key) {
  const cached = selectionCache.get(key);
  if (!cached) return null;
  selectionCache.delete(key);
  selectionCache.set(key, cached);
  return [...cached.ids];
}

export function setCachedMemorySelection(key, ids) {
  selectionCache.delete(key);
  selectionCache.set(key, { ids: [...ids] });
  while (selectionCache.size > MAX_CACHE_ENTRIES) selectionCache.delete(selectionCache.keys().next().value);
}

export function clearMemorySelectionCacheForTests() {
  selectionCache.clear();
}
