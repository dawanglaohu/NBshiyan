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
  assert.equal(aboutPlainText('<p>x</p>\n\n<p>y</p>'), 'x y');
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

test("JsonLd component escapes '<' when rendering builder output", () => {
  const html = renderToStaticMarkup(createElement(JsonLd, { data: buildOrganizationJsonLd({ name: '</script><script>alert(1)</script>', url: ORIGIN, sameAs: [] }, ORIGIN) }));
  assert.match(html, /^<script type="application\/ld\+json">/);
  const inner = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  assert.equal(inner.includes('<'), false);
  assert.match(inner, /\\u003c\/script>/);
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
  assert.match(readFileSync('src/components/seo/OrganizationJsonLd.tsx', 'utf8'), /'@id': `\$\{SITE_URL\}\/#organization`/);
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
