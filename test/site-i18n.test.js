import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hasTranslation, LOCALES, normalizeLocale, translateText } from '../site/i18n.js';
import { isAuthExemptRoutePath } from '../src/request-routing.js';

test('supported browser languages resolve to the site locale and unsupported ones fall back to English', () => {
  assert.deepEqual(LOCALES.map(({ code }) => code), ['en', 'zh-CN', 'ko', 'ja', 'vi']);
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalizeLocale('ko-KR'), 'ko');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('vi-VN'), 'vi');
  assert.equal(normalizeLocale('fr-FR'), 'en');
});

test('locale dictionary translates public copy, dynamic placeholders, and preserves unknown world text', () => {
  for (const locale of ['zh-CN', 'ko', 'ja', 'vi']) {
    assert.notEqual(translateText('Enter the world', locale), 'Enter the world', locale);
    assert.notEqual(translateText('Read the protocol', locale), 'Read the protocol', locale);
    assert.notEqual(translateText('World Health', locale), 'World Health', locale);
    assert.equal(translateText('MirrorTerra-01', locale), 'MirrorTerra-01');
    assert.equal(translateText('Resident authored project title', locale), 'Resident authored project title');
    assert.match(translateText('Refresh temporarily unavailable · showing details from 08:30. Retrying automatically.', locale), /08:30/);
  }
  assert.equal(translateText('Enter the world', 'en'), 'Enter the world');
});

test('market canvas and observer status copy have translations in all added locales', () => {
  const fixedUiCopy = [
    'MIRRORTERRA · MARKET', '1H CANDLES · LAST 24H', 'LIVE', 'DELAYED', 'OFFLINE',
    'Live feed unavailable', 'No prices shown until a real quote arrives', 'Waiting for hourly candles',
    'Provider requests today', 'Provider requests today (sample)', 'Goal progress', 'Observer unavailable',
    'MIRRORTERRA VISITOR · OWN AI', 'MIRRORTERRA RESIDENT', 'RUNNING', 'PAUSED',
    'Live world snapshot', 'SIM DAY 42', 'Updated 08:15', 'Last updated 08:15',
    '3 sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.',
    'Could not load this page. Use Load more to retry; previously loaded events are kept.'
  ];
  for (const locale of ['zh-CN', 'ko', 'ja', 'vi']) {
    for (const source of fixedUiCopy) assert.notEqual(translateText(source, locale), source, `${locale}: ${source}`);
    assert.notEqual(translateText('updated', locale), 'updated');
  }
});

test('homepage static copy has translations and an accessible five-language selector', async () => {
  const [html, server, routing] = await Promise.all([
    '../site/index.html', '../src/server.js', '../src/request-routing.js'
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const decoded = (value) => value.replaceAll('&amp;', '&').replaceAll('&nbsp;', ' ')
    .replace(/\s+/g, ' ').trim();
  const textNodes = [...html.matchAll(/>([^<>]+)</g)].map((match) => decoded(match[1])).filter(Boolean);
  const descriptions = [...html.matchAll(/<meta name="description" content="([^"]+)"/g)].map((match) => decoded(match[1]));
  assert.equal(descriptions.length, 1);
  assert.ok(hasTranslation(descriptions[0]), 'page description is localized');
  const headCopy = [
    ...html.matchAll(/<title>([^<]+)<\/title>/g),
    ...html.matchAll(/<meta (?:property|name)="(?:og|twitter):(?:title|description)" content="([^"]+)"/g)
  ].map((match) => decoded(match[1]));
  assert.ok(headCopy.length >= 5, 'title and social descriptions are present');
  const languageNamesAndCode = new Set(['Mirror', 'Terra', 'MIRRORTERRA', 'English', '中文', '한국어', '日本語', 'Tiếng Việt', 'V7', 'V6',
      'HTTPS · JSON · Ed25519', 'POST /v1/agents/challenges', 'POST /v1/agents', 'GET /v1/worlds/discover',
      'X-Agent-Id · X-Agent-Time · X-Agent-Nonce · X-Agent-Signature',
      'POST /v1/worlds/:id/mines · GET /v1/worlds/:id/observe',
      'POST /v1/worlds/:id/actions { action: "work", mineId }']);
  for (const { code } of LOCALES.filter(({ code }) => code !== 'en')) {
    for (const value of headCopy) assert.notEqual(translateText(value, code), value, `${code}: head copy ${value}`);
    const untranslated = [...new Set(textNodes.filter((value) => !/^[\d\s:→—✳↓]+$/.test(value)
      && !languageNamesAndCode.has(value) && translateText(value, code) === value))];
    assert.deepEqual(untranslated, [], `${code}: all homepage static copy has translations`);
  }
  for (const [code, label] of [['en', 'English'], ['zh-CN', '中文'], ['ko', '한국어'], ['ja', '日本語'], ['vi', 'Tiếng Việt']]) {
    assert.match(html, new RegExp(`<option value="${code}">${label}</option>`));
  }
  assert.match(html, /id="language-selector"[^>]*aria-label="Language"/);
  assert.match(server, /app\.get\('\/i18n\.js'/);
  assert.match(routing, /'\/i18n\.js'/);
  assert.equal(isAuthExemptRoutePath('/i18n.js'), true);
  const i18n = await readFile(new URL('../site/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /scan\(document\.documentElement\)/, 'head and body are scanned for localization');
});
