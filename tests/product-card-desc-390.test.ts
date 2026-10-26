import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).Products.desc as Record<string, string>;
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8')).Products.desc as Record<string, string>;
const css = readFileSync('src/app/globals.css', 'utf8');

test('390px catalog blurbs that overflowed two lines are the shortened sentences', () => {
  assert.equal(en['color-boxes'], 'Full-color printed folding cartons and retail boxes for cosmetics, food and electronics.');
  assert.equal(ru['corrugated-boxes'], 'Гофрокороба и почтовые коробки на заказ, трёх- и пятислойные, печать логотипа.');
  assert.equal(ru['christmas-merchandise'], 'Новогодние коробки, тубусы, адвент-календари и сезонная упаковка на заказ.');
  assert.equal(en['corrugated-boxes'], 'Custom corrugated shipping and mailer boxes in single and double wall, printed with your brand.');
  assert.equal(ru['color-boxes'], 'Картонные коробки с полноцветной печатью для косметики, продуктов и электроники.');
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
