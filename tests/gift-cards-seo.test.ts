import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

const FORBIDDEN = [/gift card/i, /voucher/i, /подарочн\S*\s+карт/i, /сертификат/i];

test('gift-cards category uses greeting-card slugs and meta within SERP limits', () => {
  const c = categoryMeta.find((m) => m.key === 'gift-cards');
  assert.ok(c);
  assert.equal(c.key, 'gift-cards');
  assert.equal(c.en.slug, 'custom-greeting-cards');
  assert.equal(c.ru.slug, 'otkrytki-na-zakaz');
  assert.equal(c.en.keyword, 'custom greeting cards');
  assert.equal(c.ru.keyword, 'открытки на заказ');
  assert.equal(c.ru.draft, true);
  for (const l of ['en', 'ru'] as const) {
    assert.ok(c[l].title.length <= 60, `${l} title ${c[l].title.length}`);
    assert.ok(c[l].description.length <= 160, `${l} description ${c[l].description.length}`);
    assert.ok(c[l].title.endsWith('| PackJoyU'));
  }
  assert.ok(c.en.description.endsWith('Request a quote.'));
  assert.ok(c.ru.description.endsWith('Запросите расчёт.'));
});

test('categoryMeta en/ru does not call greeting cards gift cards, vouchers, or certificates', () => {
  for (const c of categoryMeta) for (const l of ['en', 'ru'] as const) {
    const text = [c[l].slug, c[l].title, c[l].description, c[l].keyword].join('\n');
    for (const re of FORBIDDEN) assert.doesNotMatch(text, re, `${c.key}/${l} ${re}`);
  }
});
