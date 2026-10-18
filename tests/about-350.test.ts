import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ABOUT_LIMITS, charCount, homeBlockVisible, isAllowedAboutHref, plainText, visibleImages, visibleStats, type AboutContent } from '../src/lib/about/model';
import {
  dirtyFields, dirtySummary, draftCompleteness, draftErrors, emptyDraft, fieldCount, settingsErrorText, SETTINGS_TEXT, aboutSettingsApi,
} from '../src/lib/admin/site-settings';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const content = (over: Partial<AboutContent> = {}): AboutContent => ({
  locale: 'en', title: 'Sample title', summary: '', bodyHtml: '<p>Sample text</p>', stats: [], images: [],
  home: { title: 'Sample heading', intro: 'Sample intro' }, updatedAt: '2026-10-17T00:00:00Z', ...over,
});
const img = (id: string, alt = 'alt') => ({ id, w: 1600, h: 1200, alt, caption: '', src: { sm: `/media/${id}-800.webp`, lg: `/media/${id}-1600.webp` } });

// ───────── 空字段隐藏 ─────────
test('#350 数据条：两项都填才显示；空 / 半填的条目去掉；最多 4 条；空数组 → 整块不渲染', () => {
  assert.deepEqual(visibleStats([]), []);
  assert.deepEqual(visibleStats(null), []);
  assert.deepEqual(visibleStats([{ label: '', value: '' }, { label: 'L', value: ' ' }, { label: ' ', value: '1' }]), []);
  const five = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
  assert.equal(visibleStats(five).length, 4);
  assert.deepEqual(visibleStats([{ label: 'Lbl', value: 'Val' }]), [{ label: 'Lbl', value: 'Val' }]);
});

test('#350 图片：缺 alt、缺地址或宽高为 0 的不显示；最多 6 张；现在 images 恒为 []', () => {
  assert.deepEqual(visibleImages([]), []);
  assert.deepEqual(visibleImages([img('a', ''), { ...img('b'), w: 0 }, { ...img('c'), src: { sm: '', lg: '' } }]), []);
  assert.equal(visibleImages(Array.from({ length: 8 }, (_, i) => img(`i${i}`))).length, 6);
});

test('#350 首页区块：about 显示 + 首页标题 + 简介都有才渲染；任何一项空 → 不渲染', () => {
  assert.equal(homeBlockVisible(content(), true), true);
  assert.equal(homeBlockVisible(content(), false), false, 'about hidden → no dead link to /about');
  assert.equal(homeBlockVisible(null, true), false);
  assert.equal(homeBlockVisible(content({ home: { title: '', intro: 'x' } }), true), false);
  assert.equal(homeBlockVisible(content({ home: { title: 'x', intro: '  ' } }), true), false);
});

test('#350 组件：空数据条 / 空图片整块不渲染；about 不显示时 404、入口隐藏', () => {
  const page = read('../src/app/[locale]/about/page.tsx');
  assert.match(page, /if \(!c\) notFound\(\)/);
  assert.match(page, /stats\.length > 0 &&/);
  assert.match(page, /images\.length > 0 &&/);
  assert.match(page, /export const revalidate = 60/);
  const home = read('../src/components/about/AboutHomeBlock.tsx');
  assert.match(home, /if \(!content \|\| !homeBlockVisible\(content, aboutVisible\)\) return null/);
  assert.match(home, /stats\.length > 0 &&/);
  assert.match(home, /images\.length > 0 &&/);
  const header = read('../src/components/layout/SiteHeader.tsx');
  assert.match(header, /\{aboutVisible && <Link href="\/about"/);
  assert.match(header, /aboutVisible = false/);
  assert.match(read('../src/components/layout/SiteFooter.tsx'), /\{aboutVisible && <Link href="\/about">/);
  // 顺序：Home、3D Products、About、Contact
  const order = ['href="/products"', 'href="/about"', 'href="/contact"'].map((h) => header.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('#350 读取函数桩：getAboutContent 恒 null、getPublishedAboutLocales 恒 []（前台全部隐藏），没有任何示例 HTML', () => {
  const src = read('../src/lib/server/site-settings.ts');
  assert.match(src, /getAboutContent\(locale: PublishedLocale\): Promise<AboutContent \| null>[\s\S]*?return null;/);
  assert.match(src, /getPublishedAboutLocales\(\): Promise<PublishedLocale\[\]>[\s\S]*?return \[\];/);
  assert.doesNotMatch(src, /<p>|<h2|<a /);
  // dangerouslySetInnerHTML 只出现在 about 页，且只吃读取函数返回的 bodyHtml
  assert.match(read('../src/app/[locale]/about/page.tsx'), /dangerouslySetInnerHTML=\{\{ __html: c\.bodyHtml \}\}/);
});

// ───────── 文案键 ─────────
const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p]);
test('#350 About 文案键：en / ru 两边完全一致且非空；没有任何数字（公司数字只来自后台）', () => {
  const en = JSON.parse(read('../messages/en.json')), ru = JSON.parse(read('../messages/ru.json'));
  assert.deepEqual(keys(en.About).sort(), keys(ru.About).sort());
  for (const k of ['eyebrow', 'statsTitle', 'imagesTitle', 'ctaTitle', 'crumbLabel', 'home.eyebrow', 'home.more']) assert.ok(keys(en.About).includes(k), k);
  for (const k of keys(en.About)) {
    const get = (o: Record<string, unknown>) => k.split('.').reduce<unknown>((a, s) => (a as Record<string, unknown>)[s], o) as string;
    assert.ok(get(en.About).trim() && get(ru.About).trim(), k);
    assert.doesNotMatch(get(en.About) + get(ru.About), /\d/, k);
  }
  assert.equal(en.About.imagesTitle, 'Our factory');
  assert.equal(ru.About.imagesTitle, 'Наше производство');
  assert.equal(ru.About.home.eyebrow, 'Наше производство');
  // CTA 按钮用 Nav.quote：RU 必须是 «Запросить расчёт»
  assert.equal(ru.Nav.quote, 'Запросить расчёт');
  assert.equal(ru.Nav.about, 'О компании');
  assert.match(read('../src/app/[locale]/about/page.tsx'), /cta=\{nav\('quote'\)\}/);
});

// ───────── 链接规则 ─────────
test('#350 编辑器链接框：只允许 https:、mailto:、以单个 / 开头的站内路径', () => {
  for (const ok of ['https://example.com', 'HTTPS://example.com/a?b=1', 'mailto:hi@example.com', '/contact', '/en/products#gift-boxes', '/'])
    assert.equal(isAllowedAboutHref(ok), true, ok);
  for (const bad of ['', ' ', 'http://example.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x',
    'https:/evil', 'https://', 'contact', 'ftp://x', 'https://exa mple.com', '/a\nb', 'vbscript:x', 'mailto:'])
    assert.equal(isAllowedAboutHref(bad), false, JSON.stringify(bad));
});

// ───────── 后台 ─────────
test('#350 后台：计数按去 HTML 后的字符数；超上限阻止保存；数据条要两项都填', () => {
  assert.equal(plainText('<p>a<strong>b</strong></p><p>c&amp;d</p>'), 'ab c&d');
  assert.equal(charCount('ёж😀'), 3);
  const d = { ...emptyDraft(), title: 'x'.repeat(81), bodyHtml: `<p>${'я'.repeat(60)}</p>` };
  assert.deepEqual(fieldCount('bodyHtml', d), { n: 60, max: ABOUT_LIMITS.bodyMax, min: ABOUT_LIMITS.bodyMin });
  assert.ok(draftErrors(d).title);
  assert.equal(draftErrors({ ...emptyDraft(), stats: [{ label: 'L', value: '' }] }).stats, SETTINGS_TEXT.statPairError);
  assert.deepEqual(draftErrors({ ...emptyDraft(), stats: [{ label: 'L', value: 'V' }] }), {});
  assert.deepEqual(draftErrors(emptyDraft()), {}, 'empty draft can be saved');
});

test('#350 后台：未保存修改的摘要；完整度只区分空 / 有内容，「完整」以后端结果为准', () => {
  const a = emptyDraft(), b = { ...emptyDraft(), bodyHtml: '<p>x</p>', stats: [{ label: 'l', value: 'v' }] };
  assert.deepEqual(dirtyFields(a, b), ['bodyHtml', 'stats']);
  assert.equal(dirtySummary({ en: a, ru: a }, { en: b, ru: a }), 'EN：正文、数据条');
  assert.equal(draftCompleteness(a).state, 'empty');
  assert.equal(draftCompleteness(b).state, 'partial');
  assert.equal(draftCompleteness(b, { complete: true }).state, 'complete');
});

test('#350 后台接口桩：不假装保存成功；文案与稿件一致', async () => {
  assert.deepEqual(await aboutSettingsApi.save({}), { ok: false, code: 'not_ready' });
  assert.deepEqual(await aboutSettingsApi.setEnabled(true), { ok: false, code: 'not_ready' });
  const d = await aboutSettingsApi.load(['en', 'ru']);
  assert.equal(d.enabled, false);
  assert.deepEqual(Object.keys(d.locales), ['en', 'ru']);
  assert.match(settingsErrorText('not_ready'), /接口还没上线/);
  assert.equal(SETTINGS_TEXT.saved(['en']), '✓ 已保存 EN。前台约 1 分钟内生效。');
  assert.equal(SETTINGS_TEXT.linkError, '仅支持 https://、mailto: 或站内路径 /…');
  assert.match(SETTINGS_TEXT.conflict('王', '5 分钟前'), /^保存失败（409）：内容已被其他管理员修改（王 · 5 分钟前）。你的修改仍保留在页面上，没有覆盖对方的版本。/);
  // 站点设置只给 ADMIN：页面 enforceAdminPage(['ADMIN'])，侧栏 adminOnly
  assert.match(read('../src/app/admin/settings/page.tsx'), /enforceAdminPage\(\['ADMIN'\], '\/admin\/settings'\)/);
  assert.match(read('../src/components/admin/AdminShell.tsx'), /'\/admin\/settings', label: '站点设置', ready: true, adminOnly: true/);
  assert.match(read('../src/components/admin/AdminShell.tsx'), /NAV\.filter\(\(n\) => !n\.adminOnly \|\| role === 'ADMIN'\)/);
});
