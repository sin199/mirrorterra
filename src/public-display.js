import { WORLD_DISPLAY_NAME } from './product-config.js';

const LEGACY_RESIDENT_NAME = /^Synterra-(\d{2})$/;
const LEGACY_RESIDENT_PLACE = /^Synterra-(\d{2})('s .+)$/;
const LEGACY_DATA_CENTER = /^Synterra Data Center$/;
const LEGACY_RESIDENT_REFERENCE = /\bSynterra-(\d{2})\b/g;
const LEGACY_DATA_CENTER_REFERENCE = /\bSynterra Data Center\b/g;

export function currentResidentDisplayName(value) {
  if (typeof value !== 'string') return value;
  return value.replace(LEGACY_RESIDENT_NAME, `${WORLD_DISPLAY_NAME}-$1`);
}

export function currentPlaceDisplayName(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(LEGACY_RESIDENT_PLACE, `${WORLD_DISPLAY_NAME}-$1$2`)
    .replace(LEGACY_DATA_CENTER, `${WORLD_DISPLAY_NAME} Data Center`);
}

export function currentDisplayText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(LEGACY_RESIDENT_REFERENCE, `${WORLD_DISPLAY_NAME}-$1`)
    .replace(LEGACY_DATA_CENTER_REFERENCE, `${WORLD_DISPLAY_NAME} Data Center`);
}

function presentResident(resident) {
  if (!resident || typeof resident !== 'object') return resident;
  const placeFields = ['location', 'targetLocation', 'lastEventPlace', 'locationLabel', 'targetLocationLabel'];
  const currentTextFields = ['goal', 'currentGoal', 'primaryGoal', 'shortGoal', 'currentAction', 'currentStatus'];
  return Object.fromEntries(Object.entries(resident).map(([key, value]) => [key,
    key === 'name' ? currentResidentDisplayName(value)
      : placeFields.includes(key) ? currentPlaceDisplayName(value)
        : currentTextFields.includes(key) ? currentDisplayText(value) : value]));
}

function presentPlaceRecord(record, fields) {
  if (!record || typeof record !== 'object') return record;
  return Object.fromEntries(Object.entries(record).map(([key, value]) =>
    [key, fields.includes(key) ? currentPlaceDisplayName(value) : value]));
}

export function presentPublicMapData(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const scenes = (payload.scenes || []).map((scene) => presentPlaceRecord(scene, ['name']));
  const worldEvolution = payload.worldEvolution;
  const economy = worldEvolution?.economy;
  return {
    ...payload,
    world: payload.world ? { ...payload.world, name: WORLD_DISPLAY_NAME } : payload.world,
    scenes,
    residents: (payload.residents || []).map(presentResident),
    events: (payload.events || []).map((event) => presentPlaceRecord(event, ['place', 'placeLabel'])),
    dataCenterLogs: (payload.dataCenterLogs || []).map((event) => presentPlaceRecord(event, ['place', 'placeLabel'])),
    ...(worldEvolution ? { worldEvolution: {
      ...worldEvolution,
      dashboard: { ...worldEvolution.dashboard, places: scenes.length },
      opportunities: (worldEvolution.opportunities || []).map((item) => ({ ...presentPlaceRecord(item, ['sceneName']),
        title: currentDisplayText(item.title), description: currentDisplayText(item.description) })),
      ...(economy ? { economy: { ...economy,
        businesses: (economy.businesses || []).map((business) => presentPlaceRecord(business, ['placeName'])) } } : {})
    } } : {})
  };
}

export function presentPublicResidentDetail(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    resident: presentResident(payload.resident),
    relationships: (payload.relationships || []).map((relationship) => ({ ...relationship,
      name: currentResidentDisplayName(relationship.name) })),
    economy: payload.economy ? { ...payload.economy,
      ownership: (payload.economy.ownership || []).map((asset) => asset.assetType === 'place'
        ? { ...asset, name: currentPlaceDisplayName(asset.name) } : asset) } : payload.economy
  };
}

export function presentPublicStats(stats) {
  return { worldName: WORLD_DISPLAY_NAME, ...stats };
}

// Current observer context only. Event titles, historical memories and provenance stay untouched.
export function presentPublicObserverResident(resident) {
  const value = presentResident(resident);
  if (!value) return value;
  return { ...value, currentGoal: typeof value.currentGoal === 'object' && value.currentGoal
      ? { ...value.currentGoal, title: currentDisplayText(value.currentGoal.title) }
      : currentDisplayText(value.currentGoal),
    currentPlan: currentDisplayText(value.currentPlan),
    currentProject: typeof value.currentProject === 'object' && value.currentProject
      ? { ...value.currentProject, title: currentDisplayText(value.currentProject.title) }
      : currentDisplayText(value.currentProject),
    otherGoals: value.otherGoals?.map((goal) => ({ ...goal, title: currentDisplayText(goal.title) })),
    activePlan: value.activePlan ? { ...value.activePlan, summary: currentDisplayText(value.activePlan.summary),
      steps: value.activePlan.steps?.map((step) => ({ ...step, description: currentDisplayText(step.description),
        blocker: currentDisplayText(step.blocker) })) } : value.activePlan,
    collaborators: Array.isArray(value.collaborators) ? value.collaborators.map((person) => ({ ...person,
      name: currentResidentDisplayName(person.name) })) : currentDisplayText(value.collaborators) };
}
