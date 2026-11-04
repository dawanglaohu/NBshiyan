import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchHref } from '../src/lib/i18n/localeSwitch';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

const gift = categoryMeta.find((c) => c.en.slug === 'custom-gift-boxes')!;
const map = { en: `/products/${gift.en.slug}`, ru: `/products/${gift.ru.slug}` };

test('category page: per-locale map from categoryMeta → localized ru category page', () => {
  // 页面显式给出的 alternates 优先生效（例如页面自己声明的对应路径）。
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru', map), '/ru/products/podarochnye-korobki');
  assert.equal(switchHref('/ru/products/podarochnye-korobki', 'ru', 'en', map), '/en/products/custom-gift-boxes');
});

test('category page: live map by default; CATEGORY_PAGES_LIVE=false falls back to /ru/products', () => {
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru', null, categoryMeta, false), '/ru/products');
  // fix1 口径：ru 品类页未上线，en → ru 必须回退到 ru 的 3D 目录，而不是指向将来 404 的 ru 品类页。
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru'), '/ru/products');
  // 已上线的 en 方向仍给出真实品类页。
  assert.equal(
    switchHref('/ru/products/podarochnye-korobki', 'ru', 'en'),
    '/en/products/custom-gift-boxes',
  );
});
