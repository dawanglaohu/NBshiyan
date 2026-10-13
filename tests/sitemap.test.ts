import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSitemap } from '../src/lib/seo/sitemapEntries';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

const opts = { siteUrl: 'https://example.com/', locales: ['en', 'ru'] as const, defaultLocale: 'en' as const };

test('static pages only by default, with en/ru/x-default alternates', () => {
  const s = buildSitemap(opts);
  assert.equal(s.length, 6);
  for (const e of s) {
    const l = e.alternates!.languages as Record<string, string>;
    assert.ok(l.en && l.ru && l['x-default']);
    assert.equal(l['x-default'], l.en);
    assert.ok(e.url.startsWith('https://example.com/'));
  }
  assert.ok(s.some((e) => e.url === 'https://example.com/en'));
});

test('category pages use each locale slug and cross-link', () => {
  const s = buildSitemap({ ...opts, includeCategories: true });
  assert.equal(s.length, 6 + categoryMeta.length * 2);
  for (const c of categoryMeta) {
    const en = s.find((e) => e.url === `https://example.com/en/products/${c.en.slug}`);
    const ru = s.find((e) => e.url === `https://example.com/ru/products/${c.ru.slug}`);
    assert.ok(en && ru, c.key);
    assert.deepEqual(en.alternates, ru.alternates);
    assert.equal((ru.alternates!.languages as Record<string, string>).en, en.url);
  }
});

test('noindex / placeholder paths never appear', () => {
  const s = buildSitemap({ ...opts, includeCategories: true });
  for (const e of s) assert.doesNotMatch(new URL(e.url).pathname, /\/(privacy|s|industries|factory|case-studies|admin|api)(\/|$)/);
});

import { buildCmsEntries } from '../src/lib/seo/sitemapEntries';
const cms = { ...opts, base: '/articles' };

test('cms: Sanity not configured (null) → no entries', () => {
  assert.deepEqual(buildCmsEntries({ ...cms, docs: null }), []);
  assert.deepEqual(buildCmsEntries({ ...cms, docs: [] }), []);
});

test('cms: detail pages use per-locale slug, lastModified, alternates; noindex skipped', () => {
  const s = buildCmsEntries({ ...cms, docs: [
    { updatedAt: '2026-10-01T00:00:00Z', slug: { en: 'how-to', ru: 'kak' } },
    { updatedAt: '2026-10-05T00:00:00Z', slug: { en: 'en-only' } },
    { updatedAt: '2026-10-09T00:00:00Z', noindex: true, slug: { en: 'hidden', ru: 'skryto' } }
  ] });
  const urls = s.map((e) => e.url);
  assert.ok(!urls.some((u) => /hidden|skryto/.test(u)));
  const ru = s.find((e) => e.url === 'https://example.com/ru/articles/kak')!;
  assert.deepEqual(ru.alternates!.languages, { en: 'https://example.com/en/articles/how-to', ru: 'https://example.com/ru/articles/kak', 'x-default': 'https://example.com/en/articles/how-to' });
  assert.equal((ru.lastModified as Date).toISOString(), '2026-10-01T00:00:00.000Z');
  const enOnly = s.find((e) => e.url.endsWith('/en/articles/en-only'))!;
  assert.deepEqual(Object.keys(enOnly.alternates!.languages!).sort(), ['en', 'x-default']);
  assert.ok(!urls.includes('https://example.com/ru/articles/en-only'));
  // list pages: both locales have docs → both listed; en list lastModified = newest indexable doc
  const enList = s.find((e) => e.url === 'https://example.com/en/articles')!;
  assert.equal((enList.lastModified as Date).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.ok(urls.includes('https://example.com/ru/articles'));
});

test('cms: list page omitted for a locale with no docs', () => {
  const s = buildCmsEntries({ ...cms, docs: [{ slug: { en: 'a' } }] });
  assert.ok(s.some((e) => e.url === 'https://example.com/en/articles'));
  assert.ok(!s.some((e) => e.url === 'https://example.com/ru/articles'));
});

import { categoryPagePath, CATEGORY_PAGES_LIVE } from '../src/lib/seo/categoryPages';
test('categoryPagePath: null when not live or unknown key; per-locale slug when live', () => {
  assert.equal(CATEGORY_PAGES_LIVE, false);
  assert.equal(categoryPagePath('en', 'gift-boxes'), null);
  assert.equal(categoryPagePath('ru', 'gift-boxes', true), '/ru/products/podarochnye-korobki');
  assert.equal(categoryPagePath('en', 'nope', true), null);
});

test('cms: list page omitted when a locale only has noindex docs (#207)', () => {
  const s = buildCmsEntries({ ...cms, docs: [{ slug: { en: 'a' } }, { noindex: true, slug: { ru: 'b' } }] });
  assert.ok(s.some((e) => e.url === 'https://example.com/en/articles'));
  assert.ok(!s.some((e) => e.url.startsWith('https://example.com/ru/')));
});
