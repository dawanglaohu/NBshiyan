import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withEnFallback } from '../src/i18n/messages-fallback';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8'));
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8'));

test('missing keys fall back to en, present keys keep the locale copy (deep)', () => {
  const out = withEnFallback({ A: { x: 'X', y: 'Y' }, B: 'b' }, { A: { x: 'ИКС' } });
  assert.deepEqual(out, { A: { x: 'ИКС', y: 'Y' }, B: 'b' });
});

test('ru today: merged messages are exactly ru.json (parity, no copy changed)', () => {
  assert.deepEqual(withEnFallback(en, ru), ru);
  assert.equal(JSON.stringify(withEnFallback(en, ru)).includes('Запросить расчёт'), JSON.stringify(ru).includes('Запросить расчёт'));
});

test('prototype keys are ignored', () => {
  const out = withEnFallback({ a: '1' }, JSON.parse('{"__proto__": {"polluted": true}, "a": "2"}'));
  assert.deepEqual(out, { a: '2' });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('request config resolves only published locales and merges en as base', () => {
  const src = readFileSync('src/i18n/request.ts', 'utf8');
  assert.match(src, /isPublishedLocale\(requested\) \? requested : DEFAULT_PUBLISHED_LOCALE/);
  assert.match(src, /withEnFallback\(/);
});
