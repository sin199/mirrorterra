import test from 'node:test';
import assert from 'node:assert/strict';
import { MIRRORTERRA_CANONICAL_URL, publicHostPolicy } from '../src/public-host-policy.js';

test('www requests redirect to the canonical HTTPS brand URL with path and query intact', () => {
  assert.deepEqual(publicHostPolicy('www.mirrorterra.com', '/world?view=map'), {
    action: 'redirect', location: `${MIRRORTERRA_CANONICAL_URL}/world?view=map`
  });
});

test('www redirects cannot be turned into an external open redirect', () => {
  assert.deepEqual(publicHostPolicy('www.mirrorterra.com', '//attacker.example/'), {
    action: 'redirect', location: `${MIRRORTERRA_CANONICAL_URL}/`
  });
});

test('public host exposes minimal health and hides all local-only endpoints', () => {
  assert.equal(publicHostPolicy('mirrorterra.com', '/health?verbose=1'), null);
  assert.deepEqual(publicHostPolicy('mirrorterra.com', '/health/details'), { action: 'not_found' });
  assert.deepEqual(publicHostPolicy('mirrorterra.com', '/local/research-status'), { action: 'not_found' });
  assert.deepEqual(publicHostPolicy('mirrorterra.com', '/local/cognition-diagnostics'), { action: 'not_found' });
  assert.deepEqual(publicHostPolicy('mirrorterra.com', '/local/map-data'), { action: 'not_found' });
  assert.equal(publicHostPolicy('mirrorterra.com', '/public/map-data'), null);
  assert.equal(publicHostPolicy('mirrorterra.com', '/public/residents/agent-id'), null);
  assert.equal(publicHostPolicy('mirrorterra.com', '/v1/worlds/discover'), null);
});

test('host matching ignores port and does not restrict local or unrelated hosts', () => {
  assert.equal(publicHostPolicy('mirrorterra.com:8788', '/health'), null);
  assert.equal(publicHostPolicy('127.0.0.1:8788', '/health'), null);
  assert.equal(publicHostPolicy('other.example', '/health'), null);
});
