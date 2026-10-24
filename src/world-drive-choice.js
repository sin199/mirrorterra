// Drives take part in where residents go and what they do, not just which skill they practise.
// Pure and deterministic: a bounded bonus on top of the existing Utility scores; Fruitfly still chooses.
import { computeDrives } from './world-skill-library.js';

export const DRIVE_BONUS_MAX = 14;
const SOCIAL_TYPES = new Set(['cafe', 'garden', 'commons', 'beach', 'plaza', 'exchange']);
const LEARN_TYPES = new Set(['library', 'observatory', 'school', 'lab']);
const MAKE_TYPES = new Set(['workshop', 'data_center', 'studio', 'workshop_floor']);

// How much each drive is served by one candidate (weights in [0,1]).
export function driveProfileFor(option, scene = null) {
  const action = option?.action;
  const type = scene?.sceneType || '';
  const features = scene?.features || {};
  const skillPlace = features.origin === 'skill_demand';
  // growth2: the public workshop district is a making place like a workshop (creation/mastery drives).
  const publicWorkshop = features.origin === 'public_works' && (features.publicWork?.kind || features.kind) === 'workshop';
  const home = typeof option?.targetLocation === 'string' && option.targetLocation.startsWith('home:');
  const w = {};
  if (action === 'eat') w.survival = 1;
  if (action === 'rest') { w.survival = 0.8; if (type === 'beach' || SOCIAL_TYPES.has(type)) w.belonging = 0.2; }
  if (action === 'socialize') { w.belonging = 1; w.esteem = 0.2; }
  if (action === 'cooperate') { w.belonging = 0.5; w.contribution = 0.8; w.creation = 0.4; }
  if (action === 'learn') { w.curiosity = 0.9; w.mastery = 0.6; if (skillPlace) w.mastery = 0.9; }
  if (action === 'work') {
    w.security = 0.8; w.esteem = 0.4;
    if (MAKE_TYPES.has(type) || skillPlace || publicWorkshop) { w.creation = 0.6; w.mastery = 0.4; }
    if (home) { w.security = 1; w.creation = 0.9; w.survival = 0.3; }
  }
  if (action === 'trade' || action === 'buy' || action === 'sell') w.security = 0.7;
  if (option?.socialPartnerId && action !== 'socialize') w.belonging = Math.max(w.belonging || 0, 0.4);
  if (LEARN_TYPES.has(type) && action !== 'learn') w.curiosity = Math.max(w.curiosity || 0, 0.3);
  if (/initiative|contribut|commons|help/i.test(String(option?.id || '') + String(option?.goal || ''))) w.contribution = Math.max(w.contribution || 0, 0.5);
  return w;
}

// Heat and cold make some places more or less attractive than the clock and opening hours alone do.
export function weatherPlaceBonus(option, scene, weather) {
  if (!scene || !weather) return 0;
  const temperature = Number(weather.temperatureC);
  const type = scene.sceneType, outdoor = ['garden', 'beach', 'commons'].includes(type);
  let bonus = 0;
  if (Number.isFinite(temperature) && temperature >= 30) {
    if (type === 'beach' && ['rest', 'socialize', 'eat'].includes(option.action)) bonus += 10;
    if (type === 'cafe' && ['rest', 'eat', 'socialize'].includes(option.action)) bonus += 5;
    if (outdoor && type !== 'beach' && option.action === 'work') bonus -= 5;
  }
  if (Number.isFinite(temperature) && temperature <= 5 && outdoor) bonus -= 6;
  if (weather.condition === 'storm' && outdoor) bonus -= 8;
  return bonus;
}

export function driveActivityBonus(option, drives, scene = null) {
  const profile = driveProfileFor(option, scene);
  let raw = 0;
  for (const [drive, weight] of Object.entries(profile)) raw += (Number(drives?.[drive]) || 0) * weight;
  // Centre around a typical drive level so the bonus can also discourage poorly matched options.
  const centred = (raw - 0.35 * Object.values(profile).reduce((sum, value) => sum + value, 0)) * 18;
  return Math.max(-DRIVE_BONUS_MAX, Math.min(DRIVE_BONUS_MAX, Math.round(centred * 100) / 100));
}

export function applyDrivesToCandidates(options, agent, scenes, { personality = {}, weather = null } = {}) {
  if (process.env.MIRRORTERRA_DRIVE_CHOICE === 'off') return options;
  const drives = computeDrives({ ...agent, ...personality, risk_tolerance: personality.riskTolerance ?? agent.risk_tolerance,
    goal: agent.goal || agent.currentGoal });
  const byName = new Map((scenes || []).map((scene) => [scene.name, scene]));
  for (const option of options) {
    const scene = byName.get(option.targetLocation) || null;
    const bonus = driveActivityBonus(option, drives, scene) + weatherPlaceBonus(option, scene, weather);
    option.score += bonus;
    option.driveBonus = Math.round(bonus * 100) / 100;
  }
  return options;
}
