// 全站 Organization + WebSite JSON-LD（src/components/seo/OrganizationJsonLd.tsx）接后台组织信息；JsonLd.tsx 的转义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换（同 about-seo.test.ts）
import JsonLd, { serializeJsonLd } from '../src/components/seo/JsonLd';
import OrganizationJsonLd, { buildSiteJsonLd, readOrganizationSettingsSafe } from '../src/components/seo/OrganizationJsonLd';
import { ORGANIZATION_DEFAULTS } from '../src/lib/seo/organization-defaults';
import { buildOrganizationJsonLd } from '../src/lib/seo/about';
import { breadcrumbJsonLd } from '../src/lib/seo/breadcrumbs';
import { buildProductJsonLd } from '../src/lib/seo/jsonld/product';
import { buildFaqJsonLd } from '../src/lib/seo/jsonld/faq';
import { SITE_URL } from '../src/lib/site';
import type { OrganizationSettings } from '../src/lib/server/site-settings';

type Graph = { '@context': string; '@graph': Record<string, unknown>[] };

/** 渲染组件，取出唯一的 ld+json script 正文并 JSON.parse */
async function render(locale: string, read: () => Promise<OrganizationSettings>) {
  const html = renderToStaticMarkup(await OrganizationJsonLd({ locale, read }));
  const m = html.match(/^<script type="application\/ld\+json">([\s\S]*)<\/script>$/);
  assert.ok(m, `只应有一个 ld+json script：${html}`);
  assert.equal(html.match(/<script/g)!.length, 1);
  return { html, inner: m![1], data: JSON.parse(m![1]) as Graph };
}

const EMPTY: OrganizationSettings = { name: 'PackJoyU', url: SITE_URL, sameAs: [] }; // getOrganizationSettings 没存过时的返回
const WEBSITE = (locale: string) => ({
  '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: SITE_URL, name: 'PackJoyU', inLanguage: locale,
  publisher: { '@id': `${SITE_URL}/#organization` },
});
// 最小默认值：只允许这些键（不编任何事实：没有 foundingDate / 人数 / 地址 / 电话 / 邮箱 / logo / sameAs）
const MINIMAL_ORG = {
  '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: 'PackJoyU', url: SITE_URL,
  alternateName: ORGANIZATION_DEFAULTS.alternateName, description: ORGANIZATION_DEFAULTS.description,
};

function assertMinimal(d: Graph, locale: string) {
  assert.deepEqual(Object.keys(d).sort(), ['@context', '@graph']);
  assert.equal(d['@context'], 'https://schema.org');
  assert.equal(d['@graph'].length, 2);
  const [org, site] = d['@graph'];
  assert.deepEqual(Object.keys(org).sort(), ['@id', '@type', 'alternateName', 'description', 'name', 'url']);
  assert.deepEqual(org, MINIMAL_ORG);
  assert.equal(org.alternateName, '保乐优');
  assert.deepEqual(site, WEBSITE(locale));
  for (const k of ['name', 'alternateName', 'description']) assert.doesNotMatch(String((org as Record<string, unknown>)[k]), /\d/, `fallback 的 ${k} 里不应有任何数字`);
}

test('后台保存的组织信息出现在全站 JSON-LD 里（sameAs、foundingDate 2012、description），@type 仍是 Organization', async () => {
  const saved: OrganizationSettings = {
    name: 'PackJoyU', url: SITE_URL, description: 'Saved description from admin.',
    sameAs: ['https://www.linkedin.com/company/example-test', 'https://x.example.test/packjoyu'], foundingDate: '2012',
  };
  const { data } = await render('en', async () => saved);
  const [org, site] = data['@graph'];
  assert.equal(org['@type'], 'Organization');
  assert.equal(org.description, 'Saved description from admin.');
  assert.deepEqual(org.sameAs, saved.sameAs);
  assert.equal(org.foundingDate, '2012');
  assert.equal(org.alternateName, '保乐优'); // 没填 → 默认
  // 没填的字段不出现
  for (const k of ['email', 'telephone', 'address', 'logo', 'legalName', 'numberOfEmployees']) assert.equal(k in org, false, k);
  // 与 about 页同一个 builder（去掉外层 @context）
  const { '@context': _c, ...expected } = buildOrganizationJsonLd(saved);
  assert.equal(_c, 'https://schema.org');
  assert.deepEqual(org, expected);
  assert.deepEqual(site, WEBSITE('en'));
});

test('空设置 → 最小默认值（只有 @context/@type/@id/name/url/alternateName/description + WebSite）', async () => {
  assertMinimal((await render('en', async () => EMPTY)).data, 'en');
  assertMinimal((await render('ru', async () => ({ name: '', url: '', sameAs: [] }))).data, 'ru');
  assertMinimal(buildSiteJsonLd(null, 'en') as Graph, 'en');
});

test('读取抛错 / 返回 rejected / 超时 → 最小默认值，组件不抛错', async () => {
  assertMinimal((await render('en', () => { throw new Error('db down'); })).data, 'en');
  assertMinimal((await render('ru', () => Promise.reject(new Error('timeout')))).data, 'ru');
  const t0 = Date.now();
  assert.equal(await readOrganizationSettingsSafe(() => new Promise(() => {}), 30), null);
  assert.ok(Date.now() - t0 < 1000);
  // 返回了垃圾值 → builder 也不抛
  assertMinimal((await render('en', async () => null as unknown as OrganizationSettings)).data, 'en');
});

test('真实 getOrganizationSettings：没有 DATABASE_URL 时（构建环境）回落到最小默认值且不抛错', { skip: !!process.env.DATABASE_URL }, async () => {
  const err = console.error; console.error = () => {}; // site-settings 读失败会打一条不带内容的日志
  try {
    const html = renderToStaticMarkup(await OrganizationJsonLd({ locale: 'en' }));
    assertMinimal(JSON.parse(html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Graph, 'en');
  } finally { console.error = err; }
});

test('WebSite 部分与改动前完全一致', () => {
  for (const l of ['en', 'ru']) assert.deepEqual((buildSiteJsonLd(EMPTY, l) as Graph)['@graph'][1], WEBSITE(l));
});

test('XSS：description = </script><script>alert(1)</script> → 输出里没有 </script（不分大小写），JSON.parse 还原原文', async () => {
  const evil = '</script><script>alert(1)</script>';
  for (const v of [evil, evil.toUpperCase(), '</ScRiPt >x']) {
    const { inner, data } = await render('en', async () => ({ ...EMPTY, description: v }));
    assert.doesNotMatch(inner, /<\/script/i);
    assert.doesNotMatch(inner, /[<>&\u2028\u2029]/);
    assert.equal(data['@graph'][0].description, v);
  }
});

test('JsonLd 转义 < > & U+2028 U+2029 为 \\u003c \\u003e \\u0026 \\u2028 \\u2029，并能原样还原', () => {
  const s = 'a<b>c&d\u2028e\u2029f <!-- --> &amp;';
  const out = serializeJsonLd({ s });
  assert.equal(out, '{"s":"a\\u003cb\\u003ec\\u0026d\\u2028e\\u2029f \\u003c!-- --\\u003e \\u0026amp;"}');
  assert.doesNotMatch(out, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(out), { s });
  const html = renderToStaticMarkup(React.createElement(JsonLd, { data: { s } }));
  const inner = html.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '');
  assert.equal(inner, out); // dangerouslySetInnerHTML 不再二次转义
  assert.deepEqual(JSON.parse(inner), { s });
});

test('现有 JSON-LD 输出（Organization / 面包屑 / Product / FAQ）换了转义后解析结果不变', () => {
  const old = (d: unknown) => JSON.stringify(d).replace(/</g, '\\u003c'); // 改动前 JsonLd.tsx 的写法
  const faq = buildFaqJsonLd([{ question: 'MOQ & lead time <30 days>?', answer: 'Ask us.' }], { enabled: true });
  const samples: unknown[] = [
    buildOrganizationJsonLd({ name: 'A & B <Co>', url: SITE_URL, sameAs: ['https://example.test/a?x=1&y=2'] }),
    breadcrumbJsonLd(SITE_URL, 'en', [{ name: 'Home', path: '/' }, { name: 'Boxes & <Cups>', path: '/products' }]),
    buildProductJsonLd('gift-boxes', 'en'), buildProductJsonLd('wine-boxes', 'ru'),
    faq, buildSiteJsonLd(EMPTY, 'ru'),
  ];
  for (const d of samples) {
    if (d == null) continue;
    assert.deepEqual(JSON.parse(serializeJsonLd(d)), JSON.parse(old(d)));
    assert.deepEqual(JSON.parse(serializeJsonLd(d)), JSON.parse(JSON.stringify(d)));
  }
});
