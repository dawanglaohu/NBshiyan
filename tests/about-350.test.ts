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
test('#350 编辑器链接框：用例清单 tests/about-link-cases.json（和后端 sanitizeAboutHtml 共用）全部通过', () => {
  const { cases } = JSON.parse(read('./about-link-cases.json')) as { cases: { input: string; expected: 'allow' | 'reject'; note: string }[] };
  assert.ok(cases.length >= 60);
  for (const c of cases) assert.equal(isAllowedAboutHref(c.input), c.expected === 'allow', `${JSON.stringify(c.input)} (${c.note})`);
  // PM / 安全复核点：这些必须在清单里而且是 reject
  for (const must of ['/a/..//evil.com', '/.//evil.com', '/%2e//evil.com', '/a/%2e%2e//evil.com', 'https://user:pw@example.com', 'mailto:hi@example.com?bcc=x@evil.com', 'mailto:hi@example.com?cc=x@evil.com', 'mailto:hi@example.com?body=hello'])
    assert.equal(cases.find((c) => c.input === must)?.expected, 'reject', must);
  assert.equal(cases.find((c) => c.input === 'mailto:hi@example.com?subject=Hello')?.expected, 'allow');
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
  assert.deepEqual(await aboutSettingsApi.setEnabled(true, null), { ok: false, code: 'not_ready' });
  const d = await aboutSettingsApi.load(['en', 'ru']);
  assert.equal(d.enabled, false);
  assert.deepEqual(Object.keys(d.locales), ['en', 'ru']);
  assert.match(settingsErrorText('not_ready'), /接口还没上线/);
  assert.equal(SETTINGS_TEXT.saved(['en']), '✓ 已保存 EN。前台约 1 分钟内生效。');
  assert.equal(SETTINGS_TEXT.linkError, '仅支持 https://、mailto: 或站内路径 /…');
  assert.equal(SETTINGS_TEXT.conflict, '内容已被他人修改，请刷新后重新编辑');
  // 站点设置只给 ADMIN：页面 enforceAdminPage(['ADMIN'])，侧栏 adminOnly
  assert.match(read('../src/app/admin/settings/page.tsx'), /enforceAdminPage\(\['ADMIN'\], '\/admin\/settings'\)/);
  assert.match(read('../src/components/admin/AdminShell.tsx'), /'\/admin\/settings', label: '站点设置', ready: true, adminOnly: true/);
  assert.match(read('../src/components/admin/AdminShell.tsx'), /NAV\.filter\(\(n\) => !n\.adminOnly \|\| role === 'ADMIN'\)/);
});

// ───────── 409 version_conflict（PM 定稿） ─────────
test('#350 409：只认 version_conflict；文案 + 刷新；冲突期间不能保存 / 切开关', async () => {
  const { conflictStep, canSave, writesBlocked, isVersionConflict, SETTINGS_TEXT: T } = await import('../src/lib/admin/site-settings');
  assert.equal(T.conflict, '内容已被他人修改，请刷新后重新编辑');
  assert.equal(T.conflictRefresh, '刷新');
  assert.equal(T.conflictConfirmTitle, '未保存的修改将丢弃');
  assert.equal(T.conflictConfirmOk, '丢弃并刷新');
  assert.equal(T.cancel, '取消');
  assert.equal(isVersionConflict({ ok: false, code: 'version_conflict', currentVersion: 7 }), true);
  assert.equal(isVersionConflict({ ok: false, code: 'conflict' }), false, 'old guessed code is gone');
  const base = { busy: false, dirty: true, anyErrors: false };
  assert.equal(canSave({ ...base, conflict: 'none' }), true);
  for (const c of ['conflict', 'confirm', 'loading'] as const) {
    assert.equal(canSave({ ...base, conflict: c }), false, c);
    assert.equal(writesBlocked(c), true, c);
  }
  assert.deepEqual(conflictStep('none', 'conflict'), { next: 'conflict', reload: false });
  // 在冲突里再点保存 / 确认之外的事件都不会触发读取
  assert.deepEqual(conflictStep('conflict', 'confirm'), { next: 'conflict', reload: false });
  assert.deepEqual(conflictStep('none', 'refresh'), { next: 'none', reload: false });
});

test('#350 409：点刷新 → 确认框；取消 = 仍是冲突、不读取、文字保留；确认 = 读最新内容 + 版本，丢弃本地修改，不重新提交', async () => {
  const { conflictStep, canSave } = await import('../src/lib/admin/site-settings');
  // 取消路径
  let s = conflictStep('none', 'conflict').next;
  s = conflictStep(s, 'refresh').next;
  assert.equal(s, 'confirm');
  const cancel = conflictStep(s, 'cancel');
  assert.deepEqual(cancel, { next: 'conflict', reload: false });
  assert.equal(canSave({ busy: false, dirty: true, anyErrors: false, conflict: cancel.next }), false, 'still blocked after cancel');
  // 确认路径
  s = conflictStep(cancel.next, 'refresh').next;
  const ok = conflictStep(s, 'confirm');
  assert.deepEqual(ok, { next: 'loading', reload: true });
  assert.deepEqual(conflictStep(ok.next, 'reloaded'), { next: 'none', reload: false });
  assert.deepEqual(conflictStep(ok.next, 'reload_failed'), { next: 'conflict', reload: false });
  // 组件接线：409 不清空草稿、不带 currentVersion 重交；刷新确认后才 load，并用服务端内容覆盖草稿
  const ui = read('../src/components/admin/settings/AboutSettings.tsx');
  const onConflict = ui.slice(ui.indexOf('if (isVersionConflict(r)) {'), ui.indexOf("step('conflict');") + 20);
  assert.doesNotMatch(onConflict, /setDraft|aboutSettingsApi\.save|currentVersion/);
  assert.doesNotMatch(ui, /currentVersion/);
  const refresh = ui.slice(ui.indexOf('const confirmRefresh'), ui.indexOf('const onTabKey'));
  assert.match(refresh, /if \(!step\('confirm'\)\.reload\) return;/);
  assert.match(refresh, /aboutSettingsApi\.load\(locales\)/);
  assert.match(refresh, /setDraft\(structuredClone\(fresh\.locales\)\)/);
  assert.doesNotMatch(refresh, /\.save\(|setEnabled\(/);
  assert.match(ui, /title=\{T\.conflictConfirmTitle\} confirmLabel=\{T\.conflictConfirmOk\} danger onCancel=\{\(\) => step\('cancel'\)\} onConfirm=\{confirmRefresh\}/);
  assert.match(ui, /disabled=\{!saveAllowed\}/);
  assert.match(ui, /disabled=\{busy \|\| writesBlocked\(conflict\)\}/);
  assert.match(ui, /if \(!canSave\(\{ busy, dirty, anyErrors, conflict: conflictRef\.current \}\)\) return;/);
  assert.match(ui, /if \(writesBlocked\(conflictRef\.current\)\) return;/);
});
