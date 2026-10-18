import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABOUT_DESCRIPTION_MAX,
  aboutDescription,
  aboutOgImageUrl,
  aboutSitemapEntries,
  buildAboutMetadata,
  buildOrganizationJsonLd,
  htmlToPlainText,
  serializeJsonLd,
  truncateCodePoints
} from '../src/lib/seo/about';
import * as aboutModule from '../src/lib/seo/about';
import { articleOgVersion } from '../src/lib/seo/articleOg';
import { ORGANIZATION_DEFAULTS } from '../src/lib/seo/organization-defaults';
import type { AboutContent } from '../src/lib/server/site-settings';

const ORIGIN = 'https://example.test';
const LONG_BODY = `<h2>Who we are</h2><p>${'Sample text about the company. '.repeat(12)}</p><ul><li>Item one</li></ul>`;
const DEFAULT_DESC =
  'PackJoyU is a custom packaging manufacturer with its own factory, making printed corrugated and gift boxes, molded pulp and paper cups, from sample to bulk.';

const content = (locale: 'en' | 'ru', over: Partial<AboutContent> = {}): AboutContent => ({
  locale, title: 'About PackJoyU', summary: '', bodyHtml: LONG_BODY, stats: [], images: [],
  home: { title: '', intro: '' }, updatedAt: '2026-10-17T00:00:00Z', ...over
});
type Img = { url: string; width: number; height: number; alt: string };
const ogImg = (m: ReturnType<typeof buildAboutMetadata>) => (m.openGraph?.images as Img[])[0];

test('own published-locale rules are not duplicated here (backend about-rules.ts owns them)', () => {
  assert.equal('resolvePublishedAboutLocales' in aboutModule, false);
  assert.equal('isAboutComplete' in aboutModule, false);
});

test('description: summary wins; empty summary → body plain text, first 160 code points', () => {
  assert.equal(ABOUT_DESCRIPTION_MAX, 160);
  assert.equal(aboutDescription({ summary: '  Short  summary ', bodyHtml: LONG_BODY }), 'Short summary');
  const d = aboutDescription({ summary: '   ', bodyHtml: LONG_BODY });
  assert.ok(Array.from(d).length <= 160);
  assert.ok(Array.from(d).length >= 150, d);
  assert.ok(d.startsWith('Who we are Sample text about the company.'), d);
  assert.doesNotMatch(d, /[<>]|\s{2,}|\s$/);
  assert.equal(aboutDescription({ summary: '', bodyHtml: '<p>a&amp;b&nbsp;c<br>d</p><p>e</p>' }), 'a&b c d e');
});

test('truncate never splits a surrogate pair', () => {
  const t = truncateCodePoints('😀'.repeat(200), 160);
  assert.equal(Array.from(t).length, 160);
  assert.doesNotMatch(t, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(htmlToPlainText('<p>x</p>\n\n<p>y</p>'), 'x y');
});

test('metadata: single published locale → canonical, self hreflang, no x-default', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['ru'], origin: ORIGIN });
  assert.equal(m.alternates?.canonical, `${ORIGIN}/ru/about`);
  assert.deepEqual(m.alternates?.languages, { ru: `${ORIGIN}/ru/about` });
  assert.equal((m.title as { absolute: string }).absolute, 'About PackJoyU');
  assert.equal(m.robots, undefined);
});

test('metadata: en + ru → both listed, x-default = en', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['en', 'ru'], origin: `${ORIGIN}/` });
  assert.deepEqual(m.alternates?.languages, { en: `${ORIGIN}/en/about`, ru: `${ORIGIN}/ru/about`, 'x-default': `${ORIGIN}/en/about` });
  assert.equal(m.alternates?.canonical, `${ORIGIN}/ru/about`);
});

test('metadata: locale not in publishedLocales (switch off / no content) → noindex, no canonical/hreflang', () => {
  for (const m of [
    buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['en'], origin: ORIGIN }),
    buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: [], origin: ORIGIN }),
    buildAboutMetadata({ locale: 'en', content: null, publishedLocales: ['en'], origin: ORIGIN })
  ]) {
    assert.equal(m.alternates, undefined);
    assert.equal(m.openGraph, undefined);
    assert.deepEqual(m.robots, { index: false, follow: false });
  }
});

test('og image: #354 article template at /<locale>/about/og?v=…, never uploaded photos', () => {
  const m = buildAboutMetadata({
    locale: 'en', origin: ORIGIN, publishedLocales: ['en'],
    content: content('en', { images: [{ id: 'abc', w: 1600, h: 1200, alt: 'x', caption: '', src: { sm: '/media/abc-800.webp', lg: '/media/abc-1600.webp' } }] })
  });
  const img = ogImg(m);
  assert.equal(img.url, `${ORIGIN}/en/about/og?v=${articleOgVersion('en', 'About PackJoyU')}`);
  assert.match(img.url, /\?v=[0-9a-f]{8}$/);
  assert.deepEqual([img.width, img.height, img.alt], [1200, 630, 'About PackJoyU | PackJoyU']);
  assert.doesNotMatch(JSON.stringify(m), /\/media\//);
  assert.deepEqual((m.twitter as { images: Img[] }).images[0], img);
  // 标题变了 v 也变
  assert.notEqual(aboutOgImageUrl(ORIGIN, 'en', 'About us'), img.url);
});

test('og image: title with no renderable glyphs → home OG fallback', () => {
  assert.equal(aboutOgImageUrl(ORIGIN, 'ru', '   '), null);
  const m = buildAboutMetadata({ locale: 'ru', origin: ORIGIN, publishedLocales: ['ru'], content: content('ru', { title: '关于我们' }), fallbackOgAlt: 'alt' });
  const img = ogImg(m);
  assert.match(img.url, /^https:\/\/example\.test\/og\/home-ru\.jpg(\?v=[0-9a-f]{8})?$/);
  assert.equal(img.alt, 'alt');
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

test('ORGANIZATION_DEFAULTS: exact text, no numbers', () => {
  assert.equal(ORGANIZATION_DEFAULTS.description, DEFAULT_DESC);
  assert.equal(ORGANIZATION_DEFAULTS.description.length, 156);
  assert.equal(ORGANIZATION_DEFAULTS.alternateName, '保乐优');
  assert.doesNotMatch(ORGANIZATION_DEFAULTS.description, /\d|supplier/i);
  assert.deepEqual(Object.keys(ORGANIZATION_DEFAULTS).sort(), ['alternateName', 'description']);
});

test('Organization JSON-LD: stub settings → name/url + defaults only', () => {
  const expected = {
    '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`,
    name: 'PackJoyU', url: ORIGIN, alternateName: '保乐优', description: DEFAULT_DESC
  };
  assert.deepEqual(buildOrganizationJsonLd({ name: 'PackJoyU', url: 'http://localhost:3000', sameAs: [] }, ORIGIN), expected);
  assert.deepEqual(buildOrganizationJsonLd(null, `${ORIGIN}/`), expected);
  assert.deepEqual(buildOrganizationJsonLd({ name: ' ', url: '', sameAs: [] }, ORIGIN), expected);
});

test('Organization JSON-LD: already-defaulted settings give the same output (idempotent)', () => {
  const raw = { name: 'PackJoyU', url: ORIGIN, sameAs: [] };
  assert.deepEqual(buildOrganizationJsonLd({ ...ORGANIZATION_DEFAULTS, ...raw }, ORIGIN), buildOrganizationJsonLd(raw, ORIGIN));
});

test('Organization JSON-LD: settings override defaults; empty fields omitted; invalid values dropped', () => {
  const o = buildOrganizationJsonLd({
    name: 'PackJoyU', url: ORIGIN, alternateName: 'ПакДжойЮ', description: 'Own text', legalName: '  ', logo: '/logo.png',
    email: 'not-an-email', telephone: '', address: { addressCountry: 'CN', streetAddress: ' ' },
    sameAs: ['https://x.example/p', 'http://insecure.example', 'javascript:alert(1)', '', 'https://x.example/p'],
    foundingDate: 'soon'
  }, ORIGIN);
  assert.deepEqual(o, {
    '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`,
    name: 'PackJoyU', url: ORIGIN, alternateName: 'ПакДжойЮ', description: 'Own text', logo: `${ORIGIN}/logo.png`,
    address: { '@type': 'PostalAddress', addressCountry: 'CN' }, sameAs: ['https://x.example/p']
  });
  for (const k of ['legalName', 'email', 'telephone', 'foundingDate']) assert.equal(k in o, false, k);
  const json = JSON.stringify(o);
  for (const k of ['numberOfEmployees', 'hasCredential', 'award', 'capacity', 'leadTime']) assert.equal(json.includes(k), false, k);
  assert.equal(buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], logo: '//evil.example/x.png' }, ORIGIN).logo, undefined);
  assert.equal(buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], logo: '/\\evil.example' }, ORIGIN).logo, undefined);
  const full = buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], email: 'sales@example.test', telephone: '+00 0000', address: 'Sample address', foundingDate: '2000', legalName: 'Sample Co.' }, ORIGIN);
  assert.deepEqual([full.email, full.telephone, full.address, full.foundingDate, full.legalName], ['sales@example.test', '+00 0000', 'Sample address', '2000', 'Sample Co.']);
});

test("serializeJsonLd escapes '<' so </script> cannot break out", () => {
  const s = serializeJsonLd(buildOrganizationJsonLd({ name: '</script><script>alert(1)</script>', url: ORIGIN, sameAs: [] }, ORIGIN));
  assert.equal(s.includes('<'), false);
  assert.match(s, /\\u003c\/script>/);
  assert.equal((JSON.parse(s) as { name: string }).name, '</script><script>alert(1)</script>');
});
