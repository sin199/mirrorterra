import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerPublicSystemRoutes } from '../src/public-system-routes.js';

async function systemApp(readiness) {
  const app = Fastify();
  registerPublicSystemRoutes(app, { readReadiness: async () => readiness });
  return app;
}

test('robots is public plain text and disallows local routes', async () => {
  const app = await systemApp({ status: 'starting', ready: false });
  const response = await app.inject({ url: '/robots.txt' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/plain/);
  assert.equal(response.body, 'User-agent: *\nAllow: /\nDisallow: /local/\n');
  await app.close();
});

test('public health is minimal and returns 200 only when ready', async () => {
  const readyApp = await systemApp({ status: 'ok', ready: true });
  const ready = await readyApp.inject({ url: '/health' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ok', service: 'mirrorterra', ready: true });
  assert.equal(ready.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(ready.json()).sort(), ['ready', 'service', 'status']);
  await readyApp.close();

  const startingApp = await systemApp({ status: 'starting', ready: false });
  const starting = await startingApp.inject({ url: '/health' });
  assert.equal(starting.statusCode, 503);
  assert.deepEqual(starting.json(), { status: 'starting', service: 'mirrorterra', ready: false });
  await startingApp.close();
});
