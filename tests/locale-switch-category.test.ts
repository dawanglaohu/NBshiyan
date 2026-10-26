import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchHref } from '../src/lib/i18n/localeSwitch';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

const gift = categoryMeta.find((c) => c.en.slug === 'custom-gift-boxes')!;
const map = { en: `/products/${gift.en.slug}`, ru: `/products/${gift.ru.slug}` };

test('category page: per-locale map from categoryMeta → localized ru category page', () => {
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru', map), '/ru/products/podarochnye-korobki');
  assert.equal(switchHref('/ru/products/podarochnye-korobki', 'ru', 'en', map), '/en/products/custom-gift-boxes');
});

test('category page: live map by default; CATEGORY_PAGES_LIVE=false falls back to /ru/products', () => {
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru', null, categoryMeta, false), '/ru/products');
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru'), '/ru/products/podarochnye-korobki');
});
