import test from 'node:test';
import assert from 'node:assert/strict';
import { readMirrorterraEnv } from '../src/product-config.js';

test('MIRRORTERRA environment values take precedence over legacy SYNTERRA aliases', () => {
  assert.equal(readMirrorterraEnv('MIRRORTERRA_SCHEMA_MODE', 'apply', {
    MIRRORTERRA_SCHEMA_MODE: 'validate', SYNTERRA_SCHEMA_MODE: 'apply'
  }), 'validate');
});

test('legacy SYNTERRA values remain readable during the configuration transition', () => {
  assert.equal(readMirrorterraEnv('MIRRORTERRA_STATE_DIR', '.synterra', {
    SYNTERRA_STATE_DIR: '/private/state/.synterra'
  }), '/private/state/.synterra');
});

test('an empty new variable falls back to a configured legacy alias', () => {
  assert.equal(readMirrorterraEnv('MIRRORTERRA_API_URL', 'http://127.0.0.1:8787', {
    MIRRORTERRA_API_URL: '', SYNTERRA_API_URL: 'https://mirrorterra.com'
  }), 'https://mirrorterra.com');
});

test('missing branded and legacy configuration uses the explicit fallback', () => {
  assert.equal(readMirrorterraEnv('MIRRORTERRA_STATE_DIR', '.synterra', {}), '.synterra');
});

test('only MIRRORTERRA variable names are accepted', () => {
  assert.throws(() => readMirrorterraEnv('SYNTERRA_STATE_DIR', '.synterra', {}), /MIRRORTERRA_/);
});
