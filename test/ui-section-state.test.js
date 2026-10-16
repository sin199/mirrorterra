import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UI_SECTION_STATE, collectionPresentation, resolveCollectionState } from '../site/ui-section-state.js';

test('collection state distinguishes loading, empty, ready, and error', () => {
  assert.equal(resolveCollectionState({ loading: true, items: [] }), UI_SECTION_STATE.LOADING);
  assert.equal(resolveCollectionState({ loading: false, items: [] }), UI_SECTION_STATE.EMPTY);
  assert.equal(resolveCollectionState({ items: [{ id: 1 }] }), UI_SECTION_STATE.READY);
  assert.equal(resolveCollectionState({ error: new Error('downstream failed'), items: [] }), UI_SECTION_STATE.ERROR);
});

test('empty presentation is compact for meaningful sections and hidden for list-only sections', () => {
  assert.deepEqual(collectionPresentation({ state: UI_SECTION_STATE.EMPTY, emptyText: 'Not yet emerged.' }),
    { hidden: false, text: 'Not yet emerged.' });
  assert.deepEqual(collectionPresentation({ state: UI_SECTION_STATE.EMPTY, emptyMode: 'hidden' }),
    { hidden: true, text: null });
  assert.equal(collectionPresentation({ state: UI_SECTION_STATE.LOADING }).text, 'Loading…');
  assert.equal(collectionPresentation({ state: UI_SECTION_STATE.ERROR }).text, 'Temporarily unavailable.');
  assert.equal(collectionPresentation({ state: UI_SECTION_STATE.ERROR }).hidden, false,
    'an error is never misrepresented as an empty section');
});

test('a section recovers from empty or error when later data arrives', () => {
  const states = [
    resolveCollectionState({ items: [] }),
    resolveCollectionState({ items: [{ id: 'first-record' }] }),
    resolveCollectionState({ error: new Error('temporary') }),
    resolveCollectionState({ items: [{ id: 'recovered-record' }] })
  ];
  assert.deepEqual(states, [UI_SECTION_STATE.EMPTY, UI_SECTION_STATE.READY, UI_SECTION_STATE.ERROR, UI_SECTION_STATE.READY]);
  assert.equal(collectionPresentation({ state: states.at(-1), emptyMode: 'hidden' }).hidden, false);
});

test('public UI serves the state helper and does not equate an empty array with loading', async () => {
  const [app, server, routing] = await Promise.all([
    readFile(new URL('../site/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/request-routing.js', import.meta.url), 'utf8')
  ]);
  assert.match(app, /resolveCollectionState/);
  assert.match(app, /renderInitialMapError/);
  assert.match(app, /emptyMode: 'hidden'/);
  assert.match(server, /app\.get\('\/ui-section-state\.js'/);
  assert.match(routing, /'\/ui-section-state\.js'/);
  assert.doesNotMatch(app, /if\s*\(!entries\?\.length\)\s*\{[\s\S]{0,160}Loading/);
});
