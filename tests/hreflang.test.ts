import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listLanguages, withXDefault } from '../src/lib/seo/hreflang';

const locales = ['en', 'ru'] as const;
const href = (l: string) => `/${l}/articles`;

test('withXDefault: x-default → en only when en exists; empty values dropped', () => {
  assert.deepEqual(withXDefault<'en' | 'ru'>({ en: '/en/a', ru: '/ru/b' }, 'en'), { en: '/en/a', ru: '/ru/b', 'x-default': '/en/a' });
  assert.deepEqual(withXDefault<'en' | 'ru'>({ ru: '/ru/b' }, 'en'), { ru: '/ru/b' });
  assert.deepEqual(withXDefault<'en' | 'ru'>({ en: undefined, ru: '/ru/b' }, 'en'), { ru: '/ru/b' });
  assert.deepEqual(withXDefault({}, 'en'), {});
});

test('listLanguages: current page noindex → no hreflang at all', () => {
  assert.deepEqual(listLanguages({ current: 'ru', locales, indexable: ['en'], defaultLocale: 'en', href }), {});
  assert.deepEqual(listLanguages({ current: 'en', locales, indexable: [], defaultLocale: 'en', href }), {});
});

test('listLanguages: only indexable locales; x-default only if en indexable', () => {
  assert.deepEqual(listLanguages({ current: 'ru', locales, indexable: ['en', 'ru'], defaultLocale: 'en', href }), { en: '/en/articles', ru: '/ru/articles', 'x-default': '/en/articles' });
  assert.deepEqual(listLanguages({ current: 'en', locales, indexable: ['en'], defaultLocale: 'en', href }), { en: '/en/articles', 'x-default': '/en/articles' });
  assert.deepEqual(listLanguages({ current: 'ru', locales, indexable: ['ru'], defaultLocale: 'en', href }), { ru: '/ru/articles' });
});

test('cmsPages uses the shared hreflang helpers (HTML and sitemap stay consistent)', () => {
  const src = readFileSync(new URL('../src/components/cms/cmsPages.tsx', import.meta.url), 'utf8');
  assert.match(src, /withXDefault\(languages, (routing\.defaultLocale|DEFAULT_PUBLISHED_LOCALE)\)/);
  assert.match(src, /listLanguages\(\{/);
  assert.doesNotMatch(src, /alternates: alternatesFor\(locale, base\)/);
  const sm = readFileSync(new URL('../src/lib/seo/sitemapEntries.ts', import.meta.url), 'utf8');
  assert.match(sm, /from '\.\/hreflang'/);
  assert.doesNotMatch(sm, /have\[0\]/);
});
