import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).Products.desc as Record<string, string>;
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8')).Products.desc as Record<string, string>;
const css = readFileSync('src/app/globals.css', 'utf8');

test('catalog blurbs held to two lines at 390px keep keywords and a length cap', () => {
  assert.equal(en['color-boxes'].includes('Full-color'), true);
  assert.equal(en['color-boxes'].includes('folding cartons'), true);
  assert.ok([...en['color-boxes']].length <= 88);
  assert.equal(en['corrugated-boxes'].includes('single'), true);
  assert.equal(en['corrugated-boxes'].includes('double wall'), true);
  assert.ok([...en['corrugated-boxes']].length <= 84);
  assert.equal(ru['corrugated-boxes'].includes('трёх- и пятислойные'), true);
  assert.ok([...ru['corrugated-boxes']].length <= 78);
  assert.equal(ru['christmas-merchandise'].includes('Новогодние'), true);
  assert.equal(ru['christmas-merchandise'].includes('адвент-календари'), true);
  assert.ok([...ru['christmas-merchandise']].length <= 74);
  assert.equal(ru['gift-boxes'].includes('на заказ'), true);
  assert.equal(ru['gift-boxes'].includes('ложемент'), true);
  assert.equal(ru['gift-boxes'].includes('с\u00A0'), true);
  assert.equal(ru['gift-boxes'].includes('с '), false);
  assert.ok([...ru['gift-boxes']].length <= 74);
  assert.equal(ru['wine-boxes'].includes('вина'), true);
  assert.equal(ru['wine-boxes'].includes('бутылок'), true);
  assert.ok([...ru['wine-boxes']].length <= 76);
  assert.equal(ru['color-boxes'].includes('полноцветной'), true);
  assert.equal(ru['color-boxes'].includes('косметики'), true);
  assert.ok([...ru['color-boxes']].length <= 80);
});

test('ru product-card specs name three- and five-layer board and keep non-breaking spaces', () => {
  const specs = JSON.parse(readFileSync('messages/ru.json', 'utf8')).Products.specs as Record<string, string[]>;
  assert.equal(specs['corrugated-boxes'][0], 'Трёх- и пятислойный гофрокартон (E/B/C)');
  assert.equal(specs['corrugated-boxes'][1].includes('до\u00A04\u00A0цветов'), true);
  assert.equal(specs['corrugated-boxes'][1].includes('до 4 цветов'), false);
  assert.equal(specs['gift-boxes'][0].includes('1,5\u2060–\u20602,5\u00A0мм'), true);
  assert.equal(specs['gift-boxes'][0].includes('2,5 мм'), false);
  assert.equal(ru['gift-boxes'].includes('с\u00A0тиснением'), true);
  assert.equal(ru['gift-boxes'].includes('с тиснением'), false);
});

test('product card description no longer uses a negative margin, and the title gap stays clear of the link', () => {
  const body = css.match(/\.product-grid \.card \.body\{[^}]+\}/)?.[0] ?? '';
  const desc = css.match(/\.product-grid \.card \.body \.desc\{[^}]+\}/)?.[0] ?? '';
  assert.match(body, /gap:10px/);
  assert.doesNotMatch(body, /gap:12px/);
  assert.match(desc, /margin:0/);
  assert.doesNotMatch(desc, /margin:-/);
  assert.match(desc, /-webkit-line-clamp:2/);
  assert.match(desc, /line-clamp:2/);
});
