import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alternatesFor } from '../src/i18n/alternates';
import { LOCALE_META, localeDir, ogLocales } from '../src/i18n/locale-meta';
import { pathsForModelPublish, pathsForSanityDoc } from '../src/lib/seo/indexnow';
import { buildSitemap } from '../src/lib/seo/sitemapEntries';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE } from '../src/i18n/published-locales';

// 多语言第 0 期：sitemap / hreflang / IndexNow / og:locale:alternate / generateStaticParams 都由 PUBLISHED_LOCALES 驱动，en/ru 输出不变
test('hreflang alternates: en/ru + x-default=en, unchanged', () => {
  assert.deepEqual(alternatesFor('ru', '/contact'), { canonical: '/ru/contact', languages: { en: '/en/contact', ru: '/ru/contact', 'x-default': '/en/contact' } });
  assert.deepEqual(alternatesFor('en'), { canonical: '/en', languages: { en: '/en', ru: '/ru', 'x-default': '/en' } });
});

test('og:locale / og:locale:alternate unchanged for en/ru; unknown falls back to en', () => {
  assert.deepEqual(ogLocales('en'), { locale: 'en_US', alternateLocale: ['ru_RU'] });
  assert.deepEqual(ogLocales('ru'), { locale: 'ru_RU', alternateLocale: ['en_US'] });
  assert.deepEqual(ogLocales('ja'), { locale: 'en_US', alternateLocale: ['ru_RU'] });
});

test('locale meta: native names, rtl only for ar', () => {
  assert.equal(LOCALE_META.en.nativeName, 'English');
  assert.equal(LOCALE_META.ru.nativeName, 'Русский');
  assert.equal(localeDir('ar'), 'rtl');
  for (const l of ['en', 'ru', 'ja', 'xx', '__proto__']) assert.equal(localeDir(l), 'ltr', l);
});

test('IndexNow only builds published-locale paths', () => {
  assert.deepEqual(pathsForModelPublish(), ['/en/products', '/ru/products']);
  const live = { article: { live: true, prefix: 'articles' } };
  const doc = { _type: 'article', slug: { en: { current: 'a-b' }, ru: { current: 'v-g' }, ja: { current: 'x' } } } as never;
  assert.deepEqual(pathsForSanityDoc(doc, live), ['/en/articles/a-b', '/ru/articles/v-g']);
});

test('sitemap: same en/ru URLs with x-default', () => {
  const sm = buildSitemap({ siteUrl: 'https://geiom.com', locales: PUBLISHED_LOCALES, defaultLocale: DEFAULT_PUBLISHED_LOCALE, lastModified: new Date(0) });
  assert.deepEqual(sm.map((e) => e.url), ['https://geiom.com/en', 'https://geiom.com/ru', 'https://geiom.com/en/products', 'https://geiom.com/ru/products', 'https://geiom.com/en/contact', 'https://geiom.com/ru/contact']);
  assert.equal(sm[0].alternates?.languages?.['x-default'], 'https://geiom.com/en');
});

test('call sites read PUBLISHED_LOCALES, not routing.locales or literals', () => {
  const read = (f: string) => readFileSync(f, 'utf8');
  for (const f of ['src/app/sitemap.ts', 'src/i18n/alternates.ts', 'src/app/[locale]/products/[slug]/page.tsx', 'src/components/cms/cmsPages.tsx', 'src/lib/seo/indexnow.ts', 'src/app/[locale]/layout.tsx']) {
    const s = read(f);
    assert.match(s, /PUBLISHED_LOCALES/, f);
    assert.doesNotMatch(s, /routing\.locales\.map|\['en', 'ru'\] as const/, f);
  }
  assert.match(read('src/app/[locale]/layout.tsx'), /return PUBLISHED_LOCALES\.map\(\(locale\) => \(\{ locale \}\)\)/);
  for (const f of ['src/app/[locale]/layout.tsx', 'src/lib/seo/pageMeta.ts', 'src/lib/seo/articleOg.ts']) assert.doesNotMatch(read(f), /'ru_RU'|'en_US'/, f);
});
