import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLD_DISPLAY_NAME } from '../src/product-config.js';
import { currentPlaceDisplayName, presentPublicMapData, presentPublicResidentDetail,
  presentPublicStats } from '../src/public-display.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('public current display aliases all ten resident names and eleven place labels without changing IDs', () => {
  const residents = Array.from({ length: 10 }, (_, index) => ({
    id: `resident-${index + 1}`,
    name: `Synterra-${String(index + 1).padStart(2, '0')}`,
    location: `Synterra-${String(index + 1).padStart(2, '0')}'s Garden`
  }));
  const scenes = residents.map((resident) => ({ id: `scene-${resident.id}`,
    name: `${resident.name}'s Garden` })).concat({ id: 'data-center', name: 'Synterra Data Center' });
  const payload = { world: { id: 'world-id', name: 'Synterra' }, scenes, residents,
    events: [{ place: "Synterra-01's Garden", title: "Opened at Synterra-01's Garden" }],
    dataCenterLogs: [{ place: 'Synterra Data Center' }],
    worldEvolution: {
      opportunities: [{ id: 'opportunity-id', sceneName: "Synterra-02's Garden" }],
      history: [{ title: "Opened at Synterra-01's Garden", detail: 'Immutable Synterra history.' }],
      agentTokenIssuance: { intents: [{ name: 'Synterra Common', meaning: 'Historical Synterra proposal.' }] },
      economy: { businesses: [{ id: 'business-id', placeName: "Synterra-03's Garden" }] }
    } };

  const presented = presentPublicMapData(payload);

  assert.equal(presented.world.name, WORLD_DISPLAY_NAME);
  assert.deepEqual(presented.residents.map((resident) => resident.name),
    Array.from({ length: 10 }, (_, index) => `MirrorTerra-${String(index + 1).padStart(2, '0')}`));
  assert.equal(presented.scenes.length, 11);
  assert.ok(presented.scenes.every((scene) => !/Synterra/.test(scene.name)));
  assert.deepEqual(presented.scenes.map((scene) => scene.id), scenes.map((scene) => scene.id));
  assert.equal(presented.events[0].place, "MirrorTerra-01's Garden");
  assert.equal(presented.dataCenterLogs[0].place, 'MirrorTerra Data Center');
  assert.equal(presented.worldEvolution.opportunities[0].sceneName, "MirrorTerra-02's Garden");
  assert.equal(presented.worldEvolution.economy.businesses[0].placeName, "MirrorTerra-03's Garden");
  assert.equal(presented.worldEvolution.history[0].title, "Opened at Synterra-01's Garden");
  assert.equal(presented.worldEvolution.history[0].detail, 'Immutable Synterra history.');
  assert.equal(presented.worldEvolution.agentTokenIssuance.intents[0].name, 'Synterra Common');
  assert.equal(payload.scenes[0].name, "Synterra-01's Garden", 'presentation does not mutate source state');
});

test('public resident detail aliases current identity and place ownership while preserving historical memories', () => {
  const payload = { resident: { id: 'resident-id', name: 'Synterra-07', location: "Synterra-06's Garden" },
    relationships: [{ agentId: 'other-id', name: 'Synterra-02' }],
    recentMemories: [{ summary: "Met at Synterra-06's Garden", location: "Synterra-06's Garden" }],
    economy: { ownership: [{ assetType: 'place', assetId: 'place-id', name: "Synterra-04's Cafe" }] } };

  const presented = presentPublicResidentDetail(payload);

  assert.equal(presented.resident.name, 'MirrorTerra-07');
  assert.equal(presented.resident.location, "MirrorTerra-06's Garden");
  assert.equal(presented.relationships[0].name, 'MirrorTerra-02');
  assert.equal(presented.economy.ownership[0].name, "MirrorTerra-04's Cafe");
  assert.equal(presented.recentMemories[0].summary, "Met at Synterra-06's Garden");
  assert.equal(presented.recentMemories[0].location, "Synterra-06's Garden");
});

test('public stats carries the canonical display brand and legacy compatibility remains scoped', async () => {
  assert.deepEqual(presentPublicStats({ openWorlds: 1, residents: 10 }),
    { worldName: 'MirrorTerra', openWorlds: 1, residents: 10 });
  assert.equal(currentPlaceDisplayName('SYNTERRA_STATE_DIR'), 'SYNTERRA_STATE_DIR');
  const [html, app, world3d] = await Promise.all([
    readFile(path.join(root, 'site/index.html'), 'utf8'),
    readFile(path.join(root, 'site/app.js'), 'utf8'),
    readFile(path.join(root, 'site/world3d.js'), 'utf8')
  ]);
  assert.doesNotMatch(html, /Synterra/i);
  assert.doesNotMatch(app, /Synterra/i);
  assert.deepEqual([...world3d.matchAll(/synterra/gi)].map((match) => match[0]), ['synterra']);
  assert.match(world3d, /rng\('synterra-nature'\)/, 'legacy invisible RNG seed remains stable');
});
