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
