import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABOUT_DESCRIPTION_MAX,
  aboutDescription,
  aboutSitemapEntries,
  buildAboutMetadata,
  buildOrganizationJsonLd,
  htmlToPlainText,
  resolvePublishedAboutLocales,
  serializeJsonLd,
  truncateCodePoints
} from '../src/lib/seo/about';
import type { AboutContent, AboutLocaleSetting } from '../src/lib/server/site-settings';

const ORIGIN = 'https://example.test';
const LONG_BODY = `<h2>Who we are</h2><p>${'Sample text about the company. '.repeat(12)}</p><ul><li>Item one</li></ul>`;

const setting = (over: Partial<AboutLocaleSetting> = {}): AboutLocaleSetting => ({
  version: 1, title: 'About PackJoyU', bodyHtml: LONG_BODY, ...over
});
const content = (locale: string, over: Partial<AboutContent> = {}): AboutContent => ({
  version: 1, locale, title: 'About PackJoyU', bodyHtml: LONG_BODY, images: [], ...over
});

test('description: summary wins; empty summary → body plain text, first 160 code points', () => {
  assert.equal(ABOUT_DESCRIPTION_MAX, 160);
  assert.equal(aboutDescription({ summary: '  Short  summary ', bodyHtml: LONG_BODY }), 'Short summary');
  const d = aboutDescription({ summary: '   ', bodyHtml: LONG_BODY });
  assert.ok(Array.from(d).length <= 160);
  assert.ok(d.startsWith('Who we are Sample text about the company.'), d);
  assert.doesNotMatch(d, /[<>]/);
  assert.doesNotMatch(d, /\s{2,}|\s$/);
  assert.equal(aboutDescription({ bodyHtml: '<p>a&amp;b&nbsp;c<br>d</p><p>e</p>' }), 'a&b c d e');
});

test('truncate never splits a surrogate pair', () => {
  const s = '😀'.repeat(200);
  const t = truncateCodePoints(s, 160);
  assert.equal(Array.from(t).length, 160);
  assert.doesNotMatch(t, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(htmlToPlainText('<p>x</p>\n\n<p>y</p>'), 'x y');
});

test('metadata: single published locale → canonical, self hreflang, no x-default', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['ru'], origin: ORIGIN });
  assert.equal(m.alternates?.canonical, `${ORIGIN}/ru/about`);
  assert.deepEqual(m.alternates?.languages, { ru: `${ORIGIN}/ru/about` });
  assert.deepEqual((m.title as { absolute: string }).absolute, 'About PackJoyU');
});

test('metadata: en + ru → both listed, x-default = en', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['en', 'ru'], origin: `${ORIGIN}/` });
  assert.deepEqual(m.alternates?.languages, {
    en: `${ORIGIN}/en/about`, ru: `${ORIGIN}/ru/about`, 'x-default': `${ORIGIN}/en/about`
  });
  assert.equal(m.alternates?.canonical, `${ORIGIN}/ru/about`);
});

test('metadata: >1 locale but no en → no x-default (withXDefault rule)', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['ru', 'ja'], origin: ORIGIN });
  assert.equal((m.alternates?.languages as Record<string, string>)['x-default'], undefined);
});

test('metadata: locale not displayed → noindex, no canonical/hreflang', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['en'], origin: ORIGIN });
  assert.equal(m.alternates, undefined);
  assert.deepEqual(m.robots, { index: false, follow: false });
  const n = buildAboutMetadata({ locale: 'en', content: null, publishedLocales: ['en'], origin: ORIGIN });
  assert.equal(n.alternates, undefined);
});

test('metadata: og image = first about image, else home OG fallback', () => {
  const withImg = buildAboutMetadata({
    locale: 'en', origin: ORIGIN, publishedLocales: ['en'],
    content: content('en', { images: [{ id: 'abc', width: 1600, height: 1200, alt: 'Our production line' }] })
  });
  const img = (withImg.openGraph?.images as { url: string; alt: string }[])[0];
  assert.equal(img.url, `${ORIGIN}/media/abc-1600.webp`);
  assert.equal(img.alt, 'Our production line');
  const noImg = buildAboutMetadata({ locale: 'ru', origin: ORIGIN, publishedLocales: ['ru'], content: content('ru'), fallbackOgAlt: 'alt' });
  const f = (noImg.openGraph?.images as { url: string }[])[0];
  assert.match(f.url, /^https:\/\/example\.test\/og\/home-ru\.jpg(\?v=[0-9a-f]{8})?$/);
  const ja = buildAboutMetadata({ locale: 'ja', origin: ORIGIN, publishedLocales: ['ja'], content: content('ja') });
  assert.match((ja.openGraph?.images as { url: string }[])[0].url, /\/og\/home-en\.jpg/);
});

test('published locales: disabled switch excludes all; missing/incomplete content excluded; order follows site locales', () => {
  const settings = { en: setting(), ru: setting() };
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: false, siteLocales: ['en', 'ru'], settings }), []);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, siteLocales: ['ru', 'en'], settings }), ['ru', 'en']);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, siteLocales: ['en', 'ru'], settings: { en: setting() } }), ['en']);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, siteLocales: ['en', 'ru'], settings: { en: setting(), ru: null } }), ['en']);
  // 标题为空 / 正文太短 / 图片缺 alt 都算未完成
  for (const bad of [setting({ title: ' ' }), setting({ bodyHtml: '<p>too short</p>' }), setting({ images: [{ id: 'x', alt: ' ' }] })])
    assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, siteLocales: ['en', 'ru'], settings: { en: setting(), ru: bad } }), ['en']);
  // 设置里有内容但语言未上线：不出现
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, siteLocales: ['en'], settings: { en: setting(), ja: setting() } }), ['en']);
});

test('sitemap: [] when none; entries share the same hreflang rule', () => {
  assert.deepEqual(aboutSitemapEntries({ publishedLocales: [], origin: ORIGIN }), []);
  const one = aboutSitemapEntries({ publishedLocales: ['en'], origin: ORIGIN });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].alternates?.languages, { en: `${ORIGIN}/en/about` });
  assert.equal('lastModified' in one[0], false);
  const lm = new Date('2026-10-17T00:00:00Z');
  const two = aboutSitemapEntries({ publishedLocales: ['en', 'ru'], origin: ORIGIN, lastModified: { en: lm, ru: 'bad-date' } });
  assert.deepEqual(two.map((e) => e.url), [`${ORIGIN}/en/about`, `${ORIGIN}/ru/about`]);
  assert.equal(two[0].lastModified, lm);
  assert.equal('lastModified' in two[1], false);
  for (const e of two) assert.deepEqual(e.alternates?.languages, { en: `${ORIGIN}/en/about`, ru: `${ORIGIN}/ru/about`, 'x-default': `${ORIGIN}/en/about` });
});

test('Organization JSON-LD: empty settings → minimal fallback', () => {
  const expected = { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'PackJoyU', url: ORIGIN };
  assert.deepEqual(buildOrganizationJsonLd({}, ORIGIN), expected);
  assert.deepEqual(buildOrganizationJsonLd(null, `${ORIGIN}/`), expected);
});

test('Organization JSON-LD: only filled fields; invalid values dropped; no invented facts', () => {
  const o = buildOrganizationJsonLd({
    name: 'PackJoyU', legalName: '  ', description: 'Custom packaging manufacturer', logo: '/logo.png',
    email: 'not-an-email', telephone: '', address: { addressCountry: 'CN', streetAddress: ' ' },
    sameAs: ['https://x.example/p', 'http://insecure.example', 'javascript:alert(1)', '', 'https://x.example/p'],
    foundingDate: 'soon'
  }, ORIGIN);
  assert.deepEqual(o, {
    '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`,
    name: 'PackJoyU', url: ORIGIN, description: 'Custom packaging manufacturer', logo: `${ORIGIN}/logo.png`,
    address: { '@type': 'PostalAddress', addressCountry: 'CN' }, sameAs: ['https://x.example/p']
  });
  const json = JSON.stringify(o);
  for (const k of ['numberOfEmployees', 'hasCredential', 'award', 'areaServed', 'capacity', 'leadTime'])
    assert.equal(json.includes(k), false, k);
  assert.equal(buildOrganizationJsonLd({ logo: '//evil.example/x.png' }, ORIGIN).logo, undefined);
});

test("serializeJsonLd escapes '<' so </script> cannot break out", () => {
  const s = serializeJsonLd(buildOrganizationJsonLd({ name: '</script><script>alert(1)</script>' }, ORIGIN));
  assert.equal(s.includes('<'), false);
  assert.match(s, /\\u003c\/script>/);
  assert.equal((JSON.parse(s) as { name: string }).name, '</script><script>alert(1)</script>');
});
