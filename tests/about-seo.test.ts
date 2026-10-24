import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JsonLd from '../src/components/seo/JsonLd';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换（同 admin-mail-ui.test.ts）
import {
  ABOUT_DESCRIPTION_MAX,
  aboutDescription,
  ABOUT_OG_TEMPLATE_VERSION,
  aboutOgImageUrl,
  aboutOgVersion,
  aboutSitemapEntries,
  aboutSitemapFromLoader,
  buildAboutMetadata,
  buildOrganizationJsonLd,
  aboutPlainText,
  truncateCodePoints
} from '../src/lib/seo/about';
import * as aboutModule from '../src/lib/seo/about';
import crypto from 'node:crypto';
import { articleOgImageUrl, articleOgVersion } from '../src/lib/seo/articleOg';
import { ORGANIZATION_DEFAULTS } from '../src/lib/seo/organization-defaults';
import { SITE_URL } from '../src/lib/site';
import { isValidFoundingDate, parseStoredOrganization } from '../src/lib/server/site-settings-model';
import { createSiteSettingsReader, type AboutContent, type AboutImage } from '../src/lib/server/site-settings';
import { ABOUT_LIMITS, visibleImages } from '../src/lib/about/model';
import { isAboutVisible, loadAboutPage } from '../src/lib/about/visibility';
import { buildSitemap } from '../src/lib/seo/sitemapEntries';

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
  assert.equal(aboutPlainText('<p>x</p>\n\n<p>y</p>'), 'x y');
});

test('metadata: single published locale → canonical, self hreflang, no x-default', () => {
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['ru'], origin: ORIGIN });
  assert.equal(m.alternates?.canonical, `${ORIGIN}/ru/about`);
  assert.deepEqual(m.alternates?.languages, { ru: `${ORIGIN}/ru/about` });
  assert.equal((m.title as { absolute: string }).absolute, 'About PackJoyU');
  assert.equal(m.robots, undefined);
  const sm = aboutSitemapEntries({ publishedLocales: ['ru'], origin: ORIGIN });
  assert.deepEqual(sm[0].alternates?.languages, { ru: `${ORIGIN}/ru/about` });
});

test('metadata and sitemap: only en → neither has x-default', () => {
  const languages = { en: `${ORIGIN}/en/about` };
  const m = buildAboutMetadata({ locale: 'en', content: content('en'), publishedLocales: ['en'], origin: ORIGIN });
  const sm = aboutSitemapEntries({ publishedLocales: ['en'], origin: ORIGIN });
  assert.equal(m.alternates?.canonical, `${ORIGIN}/en/about`);
  assert.deepEqual(m.alternates?.languages, languages);
  assert.deepEqual(sm[0].alternates?.languages, languages);
  assert.equal(Object.hasOwn(m.alternates?.languages ?? {}, 'x-default'), false);
  assert.equal(Object.hasOwn(sm[0].alternates?.languages ?? {}, 'x-default'), false);
});

test('metadata and sitemap: en + ru → both have x-default pointing at en', () => {
  const languages = { en: `${ORIGIN}/en/about`, ru: `${ORIGIN}/ru/about`, 'x-default': `${ORIGIN}/en/about` };
  const m = buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['en', 'ru'], origin: `${ORIGIN}/` });
  const sm = aboutSitemapEntries({ publishedLocales: ['en', 'ru'], origin: `${ORIGIN}/` });
  assert.deepEqual(m.alternates?.languages, languages);
  assert.equal(m.alternates?.canonical, `${ORIGIN}/ru/about`);
  for (const e of sm) assert.deepEqual(e.alternates?.languages, languages);
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
    content: content('en', { images: [{ id: 'abc', w: 1600, h: 1200, alt: 'x', caption: '', sm: { w: 800, h: 600 }, lg: { w: 1600, h: 1200 }, src: { sm: '/media/abc-800.webp', lg: '/media/abc-1600.webp' } }] })
  });
  const img = ogImg(m);
  assert.equal(img.url, `${ORIGIN}/en/about/og?v=${aboutOgVersion('en', 'About PackJoyU')}`);
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

const aboutImg = (id: string, sameFile = false): AboutImage => ({
  id, w: sameFile ? 640 : 1600, h: sameFile ? 480 : 1000, alt: `alt ${id}`, caption: '',
  sm: sameFile ? { w: 640, h: 480 } : { w: 800, h: 500 },
  lg: sameFile ? { w: 640, h: 480 } : { w: 1600, h: 1000 },
  src: { sm: `/media/${id}-${sameFile ? '1600' : '800'}.webp`, lg: `/media/${id}-1600.webp` }
});

test('sitemap: [] when none; one locale has no x-default; en+ru matches the page', () => {
  assert.deepEqual(aboutSitemapEntries({ publishedLocales: [], origin: ORIGIN }), []);
  const one = aboutSitemapEntries({ publishedLocales: ['en'], origin: ORIGIN });
  assert.equal(one.length, 1);
  assert.equal('x-default' in (one[0].alternates?.languages ?? {}), false);
  assert.deepEqual(one[0].alternates?.languages, { en: `${ORIGIN}/en/about` });
  assert.deepEqual(one[0].alternates?.languages, buildAboutMetadata({ locale: 'en', content: content('en'), publishedLocales: ['en'], origin: ORIGIN }).alternates?.languages);
  assert.equal('lastModified' in one[0], false);
  assert.equal('images' in one[0], false);
  const ruOnly = aboutSitemapEntries({ publishedLocales: ['ru'], origin: ORIGIN });
  assert.equal('x-default' in (ruOnly[0].alternates?.languages ?? {}), false);
  assert.deepEqual(ruOnly[0].alternates?.languages, { ru: `${ORIGIN}/ru/about` });
  assert.deepEqual(ruOnly[0].alternates?.languages, buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['ru'], origin: ORIGIN }).alternates?.languages);
  const lm = new Date('2026-10-17T00:00:00Z');
  const two = aboutSitemapEntries({ publishedLocales: ['en', 'ru'], origin: ORIGIN, lastModified: { en: lm, ru: 'bad-date' } });
  assert.deepEqual(two.map((e) => e.url), [`${ORIGIN}/en/about`, `${ORIGIN}/ru/about`]);
  assert.equal(two[0].lastModified, lm);
  assert.equal('lastModified' in two[1], false);
  const both = { en: `${ORIGIN}/en/about`, ru: `${ORIGIN}/ru/about`, 'x-default': `${ORIGIN}/en/about` };
  for (const e of two) assert.deepEqual(e.alternates?.languages, both);
  assert.deepEqual(buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['en', 'ru'], origin: ORIGIN }).alternates?.languages, both);
});

const storedAbout = () => ({
  version: 1, title: 'About us', summary: 'S', bodyHtml: `<p>${'x'.repeat(60)}</p>`,
  stats: [{ label: 'L', value: '00' }], home: { title: 'H', intro: 'I' }, imageMeta: {},
  updatedAt: '2026-10-18T05:30:00.000Z', updatedBy: 'u1',
});

test('sitemap: switch off → isAboutVisible is false and /about is omitted even when content exists', async () => {
  const raw = () => ({ 'about.enabled': { enabled: false, version: 1 }, 'about.en': storedAbout(), 'about.ru': storedAbout() });
  const published = await createSiteSettingsReader(async () => raw()).getPublishedAboutLocales();
  assert.deepEqual(published, []);
  assert.equal(await isAboutVisible('en', published), false);
  assert.equal(await isAboutVisible('ru', published), false);
  const on = await createSiteSettingsReader(async () => ({ ...raw(), 'about.enabled': { enabled: true, version: 1 } })).getPublishedAboutLocales();
  assert.deepEqual(on, ['en', 'ru']);
  assert.equal(await isAboutVisible('en', on), true);

  const read = {
    isAboutVisible: (locale: string) => isAboutVisible(locale, published),
    getAboutContent: async (locale: 'en' | 'ru') => content(locale),
  };
  assert.ok(await read.getAboutContent('en'));
  assert.equal(await loadAboutPage('en', read), null);
  assert.equal(await loadAboutPage('ru', read), null);
  const entries = await aboutSitemapFromLoader({
    locales: ['en', 'ru'] as const,
    origin: ORIGIN,
    load: (locale) => loadAboutPage(locale, read),
  });
  assert.deepEqual(entries, []);
});

test('sitemap loader: one hidden image is dropped; the two that remain end in -1600.webp', async () => {
  const images = [aboutImg('aaa'), { ...aboutImg('hid'), w: 0, h: 0 }, aboutImg('ccc')];
  assert.equal(visibleImages(images).length, 2);
  const entries = await aboutSitemapFromLoader({
    locales: ['en', 'ru'] as const,
    origin: `${ORIGIN}/`,
    load: async (locale) => (locale === 'en' ? content('en', { images, updatedAt: '2026-10-18T05:30:00.000Z' }) : null)
  });
  assert.deepEqual(entries.map((e) => e.url), [`${ORIGIN}/en/about`]);
  assert.deepEqual(entries[0].alternates?.languages, buildAboutMetadata({ locale: 'en', content: content('en'), publishedLocales: ['en'], origin: ORIGIN }).alternates?.languages);
  assert.equal((entries[0].lastModified as Date).toISOString(), '2026-10-18T05:30:00.000Z');
  assert.equal(entries[0].images?.length, 2);
  assert.deepEqual(entries[0].images, [
    `${ORIGIN}/media/aaa-1600.webp`,
    `${ORIGIN}/media/ccc-1600.webp`,
  ]);
  for (const u of entries[0].images ?? []) assert.match(u, /-1600\.webp$/);
  assert.ok(!(entries[0].images ?? []).some((u) => u.includes('hid')));
});

test('sitemap loader: an image with no alt stays out of the sitemap', async () => {
  const images = [aboutImg('keep'), { ...aboutImg('noalt'), alt: '' }];
  const entries = await aboutSitemapFromLoader({
    locales: ['en'] as const,
    origin: ORIGIN,
    load: async () => content('en', { images }),
  });
  assert.deepEqual(entries[0].images, [`${ORIGIN}/media/keep-1600.webp`]);
  assert.ok(!(entries[0].images ?? []).some((u) => u.includes('noalt')));
});

test('sitemap loader: images beyond imagesMax stay out of the sitemap', async () => {
  const images = [...Array.from({ length: ABOUT_LIMITS.imagesMax }, (_, i) => aboutImg(`n${i}`)), aboutImg('past')];
  assert.equal(visibleImages(images).length, ABOUT_LIMITS.imagesMax);
  const entries = await aboutSitemapFromLoader({
    locales: ['en'] as const,
    origin: ORIGIN,
    load: async () => content('en', { images }),
  });
  assert.equal(entries[0].images?.length, ABOUT_LIMITS.imagesMax);
  assert.ok(!(entries[0].images ?? []).some((u) => u.includes('/media/past-')));
  for (const u of entries[0].images ?? []) assert.match(u, /-1600\.webp$/);
});

test('sitemap route keeps hourly revalidate and loads about through loadAboutPage', () => {
  const src = readFileSync('src/app/sitemap.ts', 'utf8');
  assert.match(src, /export const revalidate = 3600/);
  assert.match(src, /revalidate: 3600/);
  assert.match(src, /tags: \[SITE_SETTINGS_TAG\]/);
  assert.match(src, /loadAboutPage\(locale\)/);
  assert.match(src, /aboutSitemapFromLoader/);
  assert.doesNotMatch(src, /export const dynamic/);
  const page = readFileSync('src/app/[locale]/about/page.tsx', 'utf8');
  assert.match(page, /loadAboutPage\(locale\)/);
  assert.doesNotMatch(page, /async function load\(/);
  const vis = readFileSync('src/lib/about/visibility.ts', 'utf8');
  assert.match(vis, /isPublishedLocale\(locale\)/);
  assert.match(vis, /await visible\(locale\)/);
  assert.match(vis, /contentOf\(locale\)/);
});

test('sitemap loader: getAboutContent throw leaves the other entries unchanged', async () => {
  const base = buildSitemap({ siteUrl: ORIGIN, locales: ['en', 'ru'] as const, defaultLocale: 'en', lastModified: new Date('2026-01-01T00:00:00Z') });
  const logs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const about = await aboutSitemapFromLoader({
      locales: ['en', 'ru'] as const,
      origin: ORIGIN,
      load: async () => { throw new Error('database unavailable secret-host'); }
    });
    assert.deepEqual(about, []);
    assert.deepEqual([...base, ...about], base);
    assert.ok(base.length > 0);
    assert.ok(![...base, ...about].some((e) => e.url.includes('/about')));
    const cacheMiss = Object.assign(new Error('Invariant: incrementalCache missing in unstable_cache () => 1'), { __NEXT_ERROR_CODE: 'E469' });
    assert.deepEqual(await aboutSitemapFromLoader({
      locales: ['en'] as const, origin: ORIGIN, load: async () => { throw cacheMiss; }
    }), []);
    assert.deepEqual(await aboutSitemapFromLoader({
      locales: ['en'] as const, origin: ORIGIN, load: async () => { throw new Error('incrementalCache missing'); }
    }), []);
  } finally { console.error = orig; }
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], ['[sitemap] about entries skipped', 'Error']);
  assert.equal(JSON.stringify(logs).includes('secret-host'), false);
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
    email: 'not-an-email', telephone: '', address: '   ',
    sameAs: ['https://x.example/p', 'http://insecure.example', 'javascript:alert(1)', '', 'https://x.example/p'],
    foundingDate: 'soon'
  }, ORIGIN);
  assert.deepEqual(o, {
    '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`,
    name: 'PackJoyU', url: ORIGIN, alternateName: 'ПакДжойЮ', description: 'Own text', logo: `${ORIGIN}/logo.png`,
    sameAs: ['https://x.example/p']
  });
  for (const k of ['legalName', 'email', 'telephone', 'address', 'foundingDate']) assert.equal(k in o, false, k);
  const json = JSON.stringify(o);
  for (const k of ['numberOfEmployees', 'hasCredential', 'award', 'capacity', 'leadTime']) assert.equal(json.includes(k), false, k);
  assert.equal(buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], logo: '//evil.example/x.png' }, ORIGIN).logo, undefined);
  assert.equal(buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], logo: '/\\evil.example' }, ORIGIN).logo, undefined);
  const full = buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], email: 'sales@example.test', telephone: '+00 0000', address: '  Sample address, Line 1  ', foundingDate: '2000', legalName: 'Sample Co.' }, ORIGIN);
  assert.deepEqual([full.email, full.telephone, full.address, full.foundingDate, full.legalName], ['sales@example.test', '+00 0000', 'Sample address, Line 1', '2000', 'Sample Co.']);
});

test('Organization builder returns a plain object; no script/serialization in the SEO helper', () => {
  assert.equal('serializeJsonLd' in aboutModule, false);
  const o = buildOrganizationJsonLd({ name: '</script><script>alert(1)</script>', url: ORIGIN, sameAs: [] }, ORIGIN);
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.equal(o.name, '</script><script>alert(1)</script>'); // 原样保留，由组件转义
  const src = readFileSync('src/lib/seo/about.ts', 'utf8');
  assert.doesNotMatch(src, /<script|dangerouslySetInnerHTML|JSON\.stringify|u003c/);
});

test("JsonLd component escapes '<' (and '>') when rendering builder output", () => {
  const html = renderToStaticMarkup(createElement(JsonLd, { data: buildOrganizationJsonLd({ name: '</script><script>alert(1)</script>', url: ORIGIN, sameAs: [] }, ORIGIN) }));
  assert.match(html, /^<script type="application\/ld\+json">/);
  const inner = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  assert.equal(inner.includes('<'), false);
  assert.match(inner, /\\u003c\/script\\u003e/); // JsonLd.tsx 也转义 > & U+2028 U+2029（见 organization-jsonld.test.ts）
  assert.equal((JSON.parse(inner) as { name: string }).name, '</script><script>alert(1)</script>');
});

test('about OG v uses its own template version; article OG URLs unchanged', () => {
  assert.equal(ABOUT_OG_TEMPLATE_VERSION, 'about-1');
  const sha8 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  assert.equal(aboutOgVersion('en', ' About PackJoyU '), sha8('about-1\nen\nAbout PackJoyU\n'));
  assert.equal(aboutOgVersion('ru', 'О нас', ' О компании '), sha8('about-1\nru\nО нас\nО компании'));
  // 文章 OG：改动前在 cb439c0/d4e2f93 上记录的值
  assert.equal(articleOgVersion('en', 'Custom Gift Boxes Guide'), '1cafb4ae');
  assert.equal(articleOgVersion('ru', 'Гофрокороб'), '789cc75f');
  const u = new URL(articleOgImageUrl('en', { slug: 'custom-gift-boxes-guide', title: 'Custom Gift Boxes Guide' })!);
  assert.equal(u.pathname + u.search, '/en/articles/custom-gift-boxes-guide/og?v=1cafb4ae');
  // about 的 v 和文章的不同；标题、语言变了 v 都变
  assert.notEqual(aboutOgVersion('en', 'Custom Gift Boxes Guide'), articleOgVersion('en', 'Custom Gift Boxes Guide'));
  assert.notEqual(aboutOgVersion('en', 'About PackJoyU'), aboutOgVersion('en', 'About us'));
  assert.notEqual(aboutOgVersion('en', 'About PackJoyU'), aboutOgVersion('ru', 'About PackJoyU'));
  assert.notEqual(aboutOgImageUrl(ORIGIN, 'en', 'About PackJoyU'), aboutOgImageUrl(ORIGIN, 'en', 'About us'));
  // 角标（导航 About 文案）变了 v 也变
  assert.notEqual(aboutOgVersion('en', 'About PackJoyU', 'About'), aboutOgVersion('en', 'About PackJoyU', 'About us'));
  assert.notEqual(aboutOgVersion('ru', 'О нас', 'О компании'), aboutOgVersion('ru', 'О нас'));
  const m = (badge: string) => ogImg(buildAboutMetadata({ locale: 'ru', content: content('ru'), publishedLocales: ['ru'], origin: ORIGIN, ogBadge: badge })).url;
  assert.equal(m('О компании'), `${ORIGIN}/ru/about/og?v=${aboutOgVersion('ru', 'About PackJoyU', 'О компании')}`);
  assert.notEqual(m('О компании'), m('О нас'));
});

test('Organization JSON-LD: origin defaults to SITE_URL, @id matches OrganizationJsonLd.tsx', () => {
  const o = buildOrganizationJsonLd({ name: 'PackJoyU', url: SITE_URL, sameAs: [] });
  assert.equal(o['@id'], `${SITE_URL}/#organization`);
  assert.equal(o.url, SITE_URL);
  // OrganizationJsonLd.tsx 现在直接用 buildOrganizationJsonLd 生成 Organization 节点（见 tests/organization-jsonld.test.ts）
  assert.match(readFileSync('src/components/seo/OrganizationJsonLd.tsx', 'utf8'), /buildOrganizationJsonLd\(settings, origin\)/);
  assert.match(readFileSync('src/components/seo/OrganizationJsonLd.tsx', 'utf8'), /publisher: \{ '@id': `\$\{origin\}\/#organization` \}/);
});

test('Organization JSON-LD (#367): values the backend stores are never dropped (ORG_EMAIL_RE / safeOrgUrl reused)', () => {
  const stored = parseStoredOrganization({
    version: 1, name: 'PackJoyU', email: "o'brien+sales@sub.example.test", telephone: '+00 (000) 000-00',
    logo: '/brand/logo.png', address: 'Sample address, Line 1', foundingDate: '2000-01-31',
    sameAs: ['https://vk.com/sample', 'https://t.me/sample', 'https://vk.com/sample']
  });
  assert.ok(stored);
  const { version: _v, updatedAt: _u, updatedBy: _b, ...fields } = stored!;
  void _v; void _u; void _b;
  const o = buildOrganizationJsonLd({ ...fields, name: fields.name ?? 'PackJoyU', url: ORIGIN }, ORIGIN);
  for (const k of ['email', 'telephone', 'address', 'foundingDate'] as const) {
    assert.ok(fields[k], `backend kept ${k}`);
    assert.equal(o[k], fields[k], k);
  }
  assert.equal(fields.sameAs.length, 2);
  assert.equal(o.logo, `${ORIGIN}/brand/logo.png`);
  assert.deepEqual(o.sameAs, fields.sameAs);
  // 后端也会拒的值，这里同样丢掉
  const bad = buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: ['https://user:pw@x.example/'], logo: '/%2fevil', email: 'a@b' }, ORIGIN);
  for (const k of ['sameAs', 'logo', 'email']) assert.equal(k in bad, false, k);
});

test('Organization JSON-LD (#367): foundingDate uses backend isValidFoundingDate (one rule)', () => {
  const fd = (v: string) => buildOrganizationJsonLd({ name: 'P', url: ORIGIN, sameAs: [], foundingDate: v }, ORIGIN).foundingDate;
  for (const ok of ['2000', '2000-01-31', ' 1999-12-31 ']) {
    assert.equal(isValidFoundingDate(ok.trim()), true, ok);
    assert.equal(fd(ok), ok.trim(), ok);
  }
  // 后端拒绝的：YYYY-MM、不存在的日期、1800 年以前、未来年份、乱写
  const future = String(new Date().getUTCFullYear() + 1);
  for (const bad of ['2000-01', '2001-02-29', '1799', future, 'soon']) {
    assert.equal(isValidFoundingDate(bad), false, bad);
    assert.equal(fd(bad), undefined, bad);
  }
});
