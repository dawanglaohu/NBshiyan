import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchPath, safeLocaleHref, switchHref } from '../src/lib/i18n/localeSwitch';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

const c = categoryMeta[0];

test('category page en -> ru and ru -> en use the other locale slug', () => {
  assert.equal(switchPath(`/products/${c.en.slug}`, 'en', 'ru', null, categoryMeta, true), `/products/${c.ru.slug}`);
  assert.equal(switchPath(`/products/${c.ru.slug}`, 'ru', 'en', null, categoryMeta, true), `/products/${c.en.slug}`);
  assert.equal(switchPath(`/en/products/${c.en.slug}`, 'en', 'ru', null, categoryMeta, true), `/products/${c.ru.slug}`, 'accepts locale prefix');
});

test('custom-gift-boxes (#bug) never keeps the en slug in ru', () => {
  const r = switchPath('/products/custom-gift-boxes', 'en', 'ru');
  assert.notEqual(r, '/products/custom-gift-boxes');
  assert.ok(r === '/products' || r.startsWith('/products/'));
});

test('category pages not live yet: fall back to /products', () => {
  assert.equal(switchPath(`/products/${c.en.slug}`, 'en', 'ru', null, categoryMeta, false), '/products');
});

test('unknown product slug falls back to the listing', () => {
  assert.equal(switchPath('/products/nope', 'en', 'ru'), '/products');
  assert.equal(switchPath('/products/nope', 'ru', 'en'), '/products');
});

test('articles/solutions use page alternates (hreflang data)', () => {
  assert.equal(switchPath('/articles/hello', 'en', 'ru', { en: '/articles/hello', ru: '/articles/privet' }), '/articles/privet');
  assert.equal(switchPath('/solutions/privet', 'ru', 'en', { en: '/solutions/hello', ru: '/solutions/privet' }), '/solutions/hello');
});

test('no counterpart: fall back to target listing, never the same slug', () => {
  assert.equal(switchPath('/articles/hello', 'en', 'ru', { en: '/articles/hello', ru: null }), '/articles');
  assert.equal(switchPath('/articles/hello', 'en', 'ru'), '/articles');
  assert.equal(switchPath('/solutions/x', 'ru', 'en'), '/solutions');
});

test('pages with the same path in both locales are kept', () => {
  assert.equal(switchPath('/', 'en', 'ru'), '/');
  assert.equal(switchPath('/products', 'en', 'ru'), '/products');
  assert.equal(switchPath('/contact', 'ru', 'en'), '/contact');
  assert.equal(switchPath('/articles', 'ru', 'en'), '/articles');
});


test('open-redirect inputs stay in-site', () => {
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/%2F%2Fevil.com', '/ru//evil.com', '/ru/%2F%2Fevil.com', '/ru/%5Cevil.com', 'javascript:alert(1)', '/ru/../x', '/de/x', '/ruevil'])
    assert.equal(safeLocaleHref(bad, 'ru'), '/ru', bad);
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/%2F%2Fevil.com'])
    assert.equal(switchHref('/articles/a', 'en', 'ru', { ru: bad }), '/ru', bad);
});
test('valid hrefs pass', () => {
  assert.equal(safeLocaleHref('/ru', 'ru'), '/ru');
  assert.equal(safeLocaleHref('/ru/articles/privet', 'ru'), '/ru/articles/privet');
  assert.equal(safeLocaleHref('/en/products', 'ru'), '/ru', 'wrong locale');
  assert.equal(switchHref('/', 'en', 'ru'), '/ru');
});
