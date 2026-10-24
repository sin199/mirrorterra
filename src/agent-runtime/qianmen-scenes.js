// gambit1: scene-based access to the 108 Qianmen patterns as in-world thinking tools.
// patterns.json is not modified. scenes.json adds English names and per-scene starting candidates.
// Residents may call ANY of the 108 patterns by id; the scene list only keeps the prompt short.
// A scenes.json that fails validation disables the scene candidates only (the full index still works
// while patterns.json is valid); the old selectQianmenPatterns() is untouched.
import { readFileSync } from 'node:fs';
import { qianmenPatterns } from './qianmen-eight-generals.js';

export const SCENES = Object.freeze(['tender_bid', 'material_trade', 'council_vote', 'capability_proposal',
  'reputation', 'verification', 'exit']);
const ID = /^QM\d{3}$/;

export function validateScenes(parsed, patterns = qianmenPatterns()) {
  if (!patterns || !parsed || typeof parsed !== 'object' || !parsed.scenes || !parsed.patternsEn) return null;
  const byId = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  const en = parsed.patternsEn;
  if (Object.keys(en).length !== 108 || Object.entries(en).some(([id, name]) => !byId.has(id)
    || typeof name !== 'string' || !name.trim() || name.length > 60)) return null;
  for (const scene of SCENES) {
    const entry = parsed.scenes[scene];
    if (!entry || !entry.patterns || typeof entry.patterns !== 'object' || !Array.isArray(entry.moves)) return null;
    const families = new Set([...(entry.families || []), ...(entry.counterFamilies || [])]);
    for (const [id, item] of Object.entries(entry.patterns)) {
      if (!byId.has(id) || !item || typeof item.play !== 'string' || item.play.length > 160 || item.play.length < 3) return null;
      if (!Array.isArray(item.counter) || item.counter.some((counter) => !byId.has(counter))) return null;
      // A scene candidate may come from any family, but the declared families must be real ones.
      if ([...families].some((family) => !patterns.some((pattern) => pattern.family_zh === family))) return null;
    }
  }
  return parsed;
}

function loadScenes() {
  try {
    return validateScenes(JSON.parse(readFileSync(new URL('./skills/qianmen-eight-generals-108/scenes.json', import.meta.url), 'utf8')));
  } catch { return null; }
}
const SCENE_FILE = loadScenes();

export function scenesAvailable() { return Boolean(SCENE_FILE); }
export function patternNameEn(id) { return SCENE_FILE?.patternsEn?.[id] || null; }
export function sceneLabel(scene) { return SCENE_FILE?.scenes?.[scene]?.label || scene; }
export function sceneMoves(scene) { return SCENE_FILE?.scenes?.[scene]?.moves || []; }

// Compact index of all 108 patterns ("QM037 最小联盟 / Minimal coalition"), so a resident can pick any id.
export function patternIndex() {
  const patterns = qianmenPatterns();
  if (!patterns) return [];
  return patterns.map((pattern) => `${pattern.id} ${pattern.name_zh}${patternNameEn(pattern.id) ? ` / ${patternNameEn(pattern.id)}` : ''}`);
}

export function describePatterns(ids = []) {
  const patterns = qianmenPatterns();
  if (!patterns) return [];
  const byId = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  return [...new Set(ids)].filter((id) => byId.has(id)).map((id) => {
    const pattern = byId.get(id);
    return { id, name: pattern.name_zh, nameEn: patternNameEn(id), family: pattern.family_zh, familyEn: pattern.family_en || null,
      summary: pattern.summary_zh };
  });
}

// Pure: the ids among `ids` that are real patterns (any of the 108), deduplicated, at most `limit`.
export function validPatternIds(ids, limit = 6) {
  const patterns = qianmenPatterns();
  if (!patterns || !Array.isArray(ids)) return [];
  const known = new Set(patterns.map((pattern) => pattern.id));
  return [...new Set(ids.map((id) => String(id || '').trim().toUpperCase()).filter((id) => ID.test(id) && known.has(id)))].slice(0, limit);
}

function seeded(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}

// Pure, deterministic for the same seed: scene candidates (play + counters) for one decision, plus the
// counters to the opponent's announced patterns. Nothing is excluded: `anyIdAllowed` tells the resident
// it may use any of the 108 by id.
export function selectScenePatterns({ scene, seed = '', opponentPatternIds = [], limit = 5 } = {}) {
  const entry = SCENE_FILE?.scenes?.[scene];
  if (!entry) return { scene, available: false, candidates: [], counters: [], anyIdAllowed: Boolean(qianmenPatterns()) };
  const ids = Object.keys(entry.patterns);
  const random = seeded(`${scene}:${seed}`);
  const order = ids.map((id) => ({ id, key: random() })).sort((a, b) => a.key - b.key).map((item) => item.id);
  const candidates = order.slice(0, Math.max(1, Math.min(limit, order.length))).map((id) => ({
    ...describePatterns([id])[0], play: entry.patterns[id].play, counters: entry.patterns[id].counter }));
  const counters = [];
  for (const opponent of validPatternIds(opponentPatternIds)) {
    for (const value of Object.values(SCENE_FILE.scenes)) {
      for (const id of value.patterns[opponent]?.counter || []) if (!counters.includes(id)) counters.push(id);
    }
  }
  return { scene, available: true, label: entry.label, moves: entry.moves, candidates,
    counters: describePatterns(counters.slice(0, 4)), anyIdAllowed: true };
}
