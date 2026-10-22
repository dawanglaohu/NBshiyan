import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryLocaleAlternates } from '../src/lib/seo/categoryPages';
import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { switchHref } from '../src/lib/i18n/localeSwitch';

test('category page: switcher /en/products/custom-gift-boxes → /ru/products/podarochnye-korobki', () => {
  const c = categoryMeta.find((m) => m.en.slug === 'custom-gift-boxes')!;
  const alts = categoryLocaleAlternates(c.key)!;
  assert.deepEqual(alts, { en: '/products/custom-gift-boxes', ru: '/products/podarochnye-korobki' });
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru', alts), '/ru/products/podarochnye-korobki');
  assert.equal(switchHref('/ru/products/podarochnye-korobki', 'ru', 'en', alts), '/en/products/custom-gift-boxes');
});

test('category page: every category maps both ways', () => {
  for (const c of categoryMeta) {
    const alts = categoryLocaleAlternates(c.key)!;
    assert.equal(switchHref(`/en/products/${c.en.slug}`, 'en', 'ru', alts), `/ru/products/${c.ru.slug}`);
  }
  assert.equal(categoryLocaleAlternates('no-such-key'), null);
});

test('category page renders <LocaleAlternates> with categoryLocaleAlternates after notFound()', () => {
  const src = readFileSync(new URL('../src/app/[locale]/products/[slug]/page.tsx', import.meta.url), 'utf8');
  assert.ok(src.indexOf('<LocaleAlternates') > src.indexOf('notFound();'));
  assert.match(src, /categoryLocaleAlternates\(c\.key\)/);
});
