import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { publicResponseEtag, sendPublicMapSnapshot } from '../src/public-response-validator.js';
import { authoritativePlaceCount, createMapSnapshotLoader, createResidentDetailStore,
  MAP_REFRESH_INTERVAL_MS } from '../site/public-view-state.js';

const payload = { world: { id: 'world' }, scenes: [{ id: 'bank' }], residents: [],
  worldEvolution: { dashboard: { places: 1 } } };

test('conditional public map responses have no body on 304 and replace validators only on changed data', async () => {
  const app = Fastify();
  let entry = { payload, etag: publicResponseEtag(payload) };
  app.get('/public/map-data', (request, reply) => sendPublicMapSnapshot(request, reply, entry));
  const first = await app.inject('/public/map-data');
  assert.equal(first.statusCode, 200);
  const tag = first.headers.etag;
  const next = await app.inject({ url: '/public/map-data', headers: { 'if-none-match': tag } });
  assert.equal(next.statusCode, 304);
  assert.equal(next.body, '');
  const changed = { ...payload, generatedAt: 'next' };
  entry = { payload: changed, etag: publicResponseEtag(changed) };
  const update = await app.inject({ url: '/public/map-data', headers: { 'if-none-match': tag } });
  assert.equal(update.statusCode, 200);
  assert.notEqual(update.headers.etag, tag);
  await app.close();
});

test('map loader skips hidden tabs, coalesces requests, and does not parse or redraw a 304', async () => {
  let visible = false, sends = 0, finish;
  const loader = createMapSnapshotLoader({ visible: () => visible,
    fetchImpl: async (_path, options) => {
      sends++;
      if (sends === 1) return new Promise((resolve) => { finish = () => resolve(new Response(JSON.stringify(payload),
        { headers: { etag: 'W/"same"' } })); });
      assert.equal(options.headers['If-None-Match'], 'W/"same"');
      return { status: 304, json() { throw new Error('must not parse 304'); } };
    } });
  assert.equal((await loader.load()).skipped, true);
  assert.equal(sends, 0);
  visible = true;
  const first = loader.load();
  assert.equal(loader.load(), first);
  finish();
  assert.deepEqual((await first).data, payload);
  assert.equal((await loader.load()).unchanged, true);
  assert.equal(sends, 2);
  assert.equal(MAP_REFRESH_INTERVAL_MS, 10_000);
});

test('resident refresh errors preserve last-known-good genesis details and recover on success', () => {
  const store = createResidentDetailStore({ now: () => 42 });
  const genesis = { economy: { currency: { symbol: 'SYNC' } }, resident: { name: 'Ada' } };
  store.success('ada', genesis);
  const failed = store.failure('ada');
  assert.equal(failed.state, 'stale');
  assert.equal(failed.data, genesis);
  assert.equal(failed.updatedAt, 42);
  assert.equal(store.failure('new-resident').data, null);
  assert.equal(store.get('new-resident').state, 'error');
  assert.equal(store.get('ada').data.economy.currency.symbol, 'SYNC');
  assert.equal(store.success('ada', genesis).state, 'ready');
});

test('map and society share the authoritative count including an existing Central Bank once', () => {
  assert.equal(authoritativePlaceCount(payload), 1);
  assert.equal(authoritativePlaceCount({ scenes: [{ id: 'bank' }, { id: 'garden' }] }), 2);
});

test('a partial resident response cannot replace the last-known-good snapshot', () => {
  const store = createResidentDetailStore();
  const detail = { resident: { name: 'Ada' }, economy: { currency: { symbol: 'SYNC' } } };
  store.success('ada', detail);
  assert.throws(() => store.success('ada', {}), /Incomplete resident detail/);
  assert.equal(store.failure('ada').data, detail);
});

test('mobile section menu is accessible without changing the desktop navigation', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.match(html, /aria-controls="main-navigation"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(css, /nav\.is-open/);
  assert.match(css, /max-width:\s*860px/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /mainNavigation\?\.addEventListener\('click'/);
});
