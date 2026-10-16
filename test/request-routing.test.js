import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { enforcePublicApiReadiness, isReadinessGatedPublicApiPath,
  requestNeedsAgentAuth, requestPathOnly } from '../src/request-routing.js';

test('known public routes bypass auth while unknown routes remain true 404s', async () => {
  const app = Fastify();
  let ready = true;
  app.addHook('preHandler', async (request, reply) => {
    const pathOnly = requestPathOnly(request.raw.url);
    if (!requestNeedsAgentAuth({ is404: request.is404, pathOnly })) {
      await enforcePublicApiReadiness({ pathOnly, readReadiness: async () => ({ ready }), reply });
      return;
    }
    if (request.headers.authorization !== 'valid') return reply.code(401).send({ error: 'AUTH_HEADERS_INVALID' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'NOT_FOUND' }));
  app.get('/public/map-data', async () => ({ public: true }));
  app.get('/public/stats', async () => ({ public: true }));
  app.get('/protected', async () => ({ protected: true }));

  for (const path of ['/public/map-data', '/public/stats']) {
    const response = await app.inject({ url: path });
    assert.equal(response.statusCode, 200);
  }
  ready = false;
  const unavailable = await app.inject({ url: '/public/map-data' });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: 'SERVICE_NOT_READY' });
  ready = true;
  const unknown = await app.inject({ url: '/non-existent-route' });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: 'NOT_FOUND' });
  const missingAuth = await app.inject({ url: '/protected' });
  assert.equal(missingAuth.statusCode, 401);
  assert.deepEqual(missingAuth.json(), { error: 'AUTH_HEADERS_INVALID' });
  const validAuth = await app.inject({ url: '/protected', headers: { authorization: 'valid' } });
  assert.equal(validAuth.statusCode, 200);
  await app.close();
});

test('local auth exemptions require the existing loopback boundary and public APIs are readiness gated', () => {
  assert.equal(requestNeedsAgentAuth({ pathOnly: '/robots.txt' }), false);
  assert.equal(requestNeedsAgentAuth({ pathOnly: '/health' }), false);
  assert.equal(requestNeedsAgentAuth({ pathOnly: '/local/map-data', allowLocalRoutes: false }), true);
  assert.equal(requestNeedsAgentAuth({ pathOnly: '/local/map-data', allowLocalRoutes: true }), false);
  assert.equal(isReadinessGatedPublicApiPath('/public/map-data'), true);
  assert.equal(isReadinessGatedPublicApiPath('/public/stats'), true);
  assert.equal(isReadinessGatedPublicApiPath('/robots.txt'), false);
});
