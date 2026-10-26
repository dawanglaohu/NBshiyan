import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).Products.desc as Record<string, string>;
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8')).Products.desc as Record<string, string>;
const css = readFileSync('src/app/globals.css', 'utf8');

test('catalog blurbs held to two lines at 390px keep these exact sentences', () => {
  assert.equal(en['color-boxes'], 'Full-color printed folding cartons and retail boxes for cosmetics, food and electronics.');
  assert.equal(en['corrugated-boxes'], 'Custom corrugated shipping boxes in single and double wall, printed with your brand.');
  assert.equal(ru['corrugated-boxes'], 'Гофрокороба и почтовые коробки на заказ, трёх- и пятислойные, печать логотипа.');
  assert.equal(ru['christmas-merchandise'], 'Новогодние коробки, тубусы, адвент-календари и сезонная упаковка на заказ.');
  assert.equal(ru['gift-boxes'], 'Жёсткие и магнитные подарочные коробки на заказ с\u00A0тиснением фольгой и ложементами.');
  assert.equal(ru['wine-boxes'], 'Премиальные коробки для вина и крепких напитков на одну и более бутылок.');
  assert.ok([...ru['wine-boxes']].length <= 76);
  assert.equal(ru['color-boxes'], 'Картонные коробки с полноцветной печатью для косметики, продуктов и электроники.');
});

test('ru product-card specs name three- and five-layer board and keep non-breaking spaces', () => {
  const specs = JSON.parse(readFileSync('messages/ru.json', 'utf8')).Products.specs as Record<string, string[]>;
  assert.equal(specs['corrugated-boxes'][0], 'Трёх- и пятислойный гофрокартон (E/B/C)');
  assert.equal(specs['corrugated-boxes'][1].includes('до\u00A04\u00A0цветов'), true);
  assert.equal(specs['corrugated-boxes'][1].includes('до 4 цветов'), false);
  assert.equal(specs['gift-boxes'][0].includes('2,5\u00A0мм'), true);
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
