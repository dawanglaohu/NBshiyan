import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSiteSettingsReader, DEFAULT_ORGANIZATION, PUBLIC_SETTING_KEYS } from '../src/lib/server/site-settings';
import { SITE_URL } from '../src/lib/site';

// #350 前台读取：开关 / 完整内容 / 已发布语言过滤 / 读出再净化 / 缓存标签
const body = (n = 60) => `<p>${'x'.repeat(n)}</p>`;
const about = (o: Record<string, unknown> = {}) => ({ version: 1, title: 'About us', summary: 'S', bodyHtml: body(), stats: [{ label: 'L', value: '00' }], home: { title: 'H', intro: 'I' }, imageMeta: { img1: { alt: 'a', caption: 'c' } }, updatedAt: '2026-10-18T05:30:00.000Z', updatedBy: 'u1', ...o });
const reader = (raw: Record<string, unknown>) => createSiteSettingsReader(async () => structuredClone(raw));

test('开关关闭 / 没有开关 / 开关值不认识：getAboutContent 返回 null，已发布语言为空', async () => {
  for (const enabled of [undefined, false, { enabled: false, version: 2 }, 'true', 1, null]) {
    const r = reader({ ...(enabled === undefined ? {} : { 'about.enabled': enabled }), 'about.en': about(), 'about.ru': about() });
    assert.equal(await r.getAboutContent('en'), null, String(enabled));
    assert.deepEqual(await r.getPublishedAboutLocales(), []);
  }
});

test('开关打开：返回 AboutContent（images 固定 []，不带 version / updatedBy / imageMeta）', async () => {
  for (const enabled of [true, { enabled: true, version: 1, updatedAt: 't', updatedBy: 'u' }]) {
    const c = await reader({ 'about.enabled': enabled, 'about.en': about() }).getAboutContent('en');
    assert.deepEqual(c, { locale: 'en', title: 'About us', summary: 'S', bodyHtml: body(), stats: [{ label: 'L', value: '00' }], images: [], home: { title: 'H', intro: 'I' }, updatedAt: '2026-10-18T05:30:00.000Z' });
  }
});

test('内容不完整（标题 <2 字或正文纯文本 <50 字）只在该语言隐藏', async () => {
  const r = reader({ 'about.enabled': true, 'about.en': about(), 'about.ru': about({ bodyHtml: body(49) }) });
  assert.equal(await r.getAboutContent('ru'), null);
  assert.deepEqual(await r.getPublishedAboutLocales(), ['en']);
  assert.equal(await reader({ 'about.enabled': true, 'about.en': about({ title: 'A' }) }).getAboutContent('en'), null);
  assert.equal(await reader({ 'about.enabled': true, 'about.en': 'garbage' }).getAboutContent('en'), null);
  assert.deepEqual(await reader({ 'about.enabled': true, 'about.en': about(), 'about.ru': about() }).getPublishedAboutLocales(), ['en', 'ru']);
});

test('只认已发布语言：预留语言（ja/es…）即使库里有内容也不返回；前台只读已发布语言的键', async () => {
  const r = reader({ 'about.enabled': true, 'about.ja': about(), 'about.es': about(), 'about.ru': about() });
  assert.equal(await r.getAboutContent('ja' as never), null);
  assert.deepEqual(await r.getPublishedAboutLocales(), ['ru']);
  assert.deepEqual(PUBLIC_SETTING_KEYS, ['about.enabled', 'about.en', 'about.ru']);
});

test('读出时再净化：库里被改坏的正文和纯文本字段也不会带出脚本、事件属性或危险链接', async () => {
  const c = await reader({ 'about.enabled': true, 'about.en': about({
    title: '<img src=x onerror=alert(1)>About\u0000 us', bodyHtml: `${body()}<p onclick="x" style="a">t<script>alert(1)</script><a href="javascript:alert(1)">j</a><a href="/\\evil.com">b</a><a href="/en">ok</a></p><iframe src="https://x"></iframe>`,
    stats: [{ label: '<b>L</b>', value: '00' }, { label: '', value: '1' }, 'x'], home: { title: '<i>H</i>', intro: 'a\u0007b' },
  }) }).getAboutContent('en');
  assert.ok(c);
  assert.equal(c.title, 'About us');
  assert.equal(c.bodyHtml, `${body()}<p>tjb<a href="/en" rel="noopener noreferrer">ok</a></p>`);
  assert.deepEqual(c.stats, [{ label: 'L', value: '00' }]);
  assert.deepEqual(c.home, { title: 'H', intro: 'ab' });
});

test('读库失败按关闭处理（null / []），不抛错', async () => {
  const r = createSiteSettingsReader(async () => { throw Object.assign(new Error('connect ECONNREFUSED secret-host'), { code: 'P1001' }); });
  const errs: unknown[] = []; const orig = console.error; console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    assert.equal(await r.getAboutContent('en'), null);
    assert.deepEqual(await r.getPublishedAboutLocales(), []);
  } finally { console.error = orig; }
  assert.ok(!JSON.stringify(errs).includes('secret-host'));
});

test('getOrganizationSettings：后台没有设置时返回现在 JSON-LD 写死的值，不编任何数字', async () => {
  const o = await reader({}).getOrganizationSettings();
  assert.deepEqual(o, { name: 'PackJoyU', url: SITE_URL, description: DEFAULT_ORGANIZATION.description, sameAs: [] });
  const jsonLd = readFileSync('src/components/seo/OrganizationJsonLd.tsx', 'utf8');
  assert.ok(jsonLd.includes(`name: '${o.name}'`) && jsonLd.includes(`description: '${o.description}'`));
  assert.ok(!/\d/.test(o.description ?? ''));
});

test('缓存：三个函数都走 unstable_cache，标签 site-settings，revalidate 60；签名和交接一致', () => {
  const src = readFileSync('src/lib/server/site-settings.ts', 'utf8');
  assert.equal(src.match(/unstable_cache\(/g)?.length, 2);
  assert.equal(src.match(/\{ tags: \[SITE_SETTINGS_TAG\], revalidate: 60 \}/g)?.length, 2);
  assert.match(src, /createSiteSettingsReader\(loadPublicSettingsCached, loadOrganizationCached\)/);
  assert.match(src, /export function getAboutContent\(locale: PublishedLocale\): Promise<AboutContent \| null>/);
  assert.match(src, /export function getPublishedAboutLocales\(\): Promise<PublishedLocale\[\]>/);
  assert.match(src, /export function getOrganizationSettings\(\): Promise<OrganizationSettings>/);
  assert.match(src, /export type OrganizationSettings = \{ name: string; url: string; logo\?: string; description\?: string; sameAs: string\[\] \}/);
  assert.match(readFileSync('src/lib/server/site-settings-model.ts', 'utf8'), /SITE_SETTINGS_TAG = 'site-settings'/);
});
