import { WORLD_DISPLAY_NAME } from './product-config.js';

const LEGACY_RESIDENT_NAME = /^Synterra-(\d{2})$/;
const LEGACY_RESIDENT_PLACE = /^Synterra-(\d{2})('s .+)$/;
const LEGACY_DATA_CENTER = /^Synterra Data Center$/;

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

function presentResident(resident) {
  if (!resident || typeof resident !== 'object') return resident;
  const placeFields = ['location', 'targetLocation', 'lastEventPlace', 'locationLabel', 'targetLocationLabel'];
  return Object.fromEntries(Object.entries(resident).map(([key, value]) => [key,
    key === 'name' ? currentResidentDisplayName(value)
      : placeFields.includes(key) ? currentPlaceDisplayName(value) : value]));
}

function presentPlaceRecord(record, fields) {
  if (!record || typeof record !== 'object') return record;
  return Object.fromEntries(Object.entries(record).map(([key, value]) =>
    [key, fields.includes(key) ? currentPlaceDisplayName(value) : value]));
}

export function presentPublicMapData(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const worldEvolution = payload.worldEvolution;
  const economy = worldEvolution?.economy;
  return {
    ...payload,
    world: payload.world ? { ...payload.world, name: WORLD_DISPLAY_NAME } : payload.world,
    scenes: (payload.scenes || []).map((scene) => presentPlaceRecord(scene, ['name'])),
    residents: (payload.residents || []).map(presentResident),
    events: (payload.events || []).map((event) => presentPlaceRecord(event, ['place', 'placeLabel'])),
    dataCenterLogs: (payload.dataCenterLogs || []).map((event) => presentPlaceRecord(event, ['place', 'placeLabel'])),
    ...(worldEvolution ? { worldEvolution: {
      ...worldEvolution,
      opportunities: (worldEvolution.opportunities || []).map((item) => presentPlaceRecord(item, ['sceneName'])),
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
