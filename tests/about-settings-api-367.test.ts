import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAboutSettingsApi, putBody, draftFromView } from '../src/lib/admin/site-settings-http';
import { emptyDraft, fieldCount, draftErrors, type AboutDraft } from '../src/lib/admin/site-settings';
import { ABOUT_LIMITS } from '../src/lib/site-settings/about-rules';
import { AboutPutInput, EnabledPutInput } from '../src/lib/server/site-settings-admin';

// #350 × #367：后台「公司介绍」接到真实接口（请求 / 响应形状、409 version_conflict、上限来自 about-rules.ts）
type Call = { url: string; method: string; body: unknown };
const view = (over: Record<string, unknown> = {}) => ({
  version: 3, title: 'About', summary: 's', bodyHtml: '<p>b</p>', stats: [{ label: 'L', value: 'V' }], home: { title: 'H', intro: 'I' },
  imageMeta: { img1: { alt: 'a', caption: 'c' } }, updatedAt: '2026-10-17T20:00:00.000Z', updatedBy: 'u1', updatedByName: 'Ryan', ...over,
});
function fake(responses: ((c: Call) => { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = responses[calls.length - 1](c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { api: createAboutSettingsApi(f), calls };
}

test('load：GET /api/admin/site-settings/about → 草稿（home.title → homeHeading，imageMeta 原样保留，没存过的语言 version 0）', async () => {
  const { api, calls } = fake([() => ({ status: 200, body: { enabled: true, enabledMeta: { version: 5, updatedAt: null, updatedBy: null, updatedByName: null }, locales: { en: view(), ru: null } } })]);
  const d = await api.load(['en', 'ru']);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/admin/site-settings/about']]);
  assert.equal(d.enabled, true);
  assert.equal(d.enabledVersion, 5);
  assert.equal(d.locales.en.homeHeading, 'H');
  assert.equal(d.locales.en.version, 3);
  assert.deepEqual(d.locales.en.imageMeta, { img1: { alt: 'a', caption: 'c' } });
  assert.equal(d.locales.ru.version, 0);
  await assert.rejects(fake([() => ({ status: 403, body: { error: 'forbidden' } })]).api.load(['en']), /forbidden/);
});

test('save：每个语言 PUT /about/<locale>，请求体能通过后端 AboutPutInput（.strict），带 expectedVersion 和原 imageMeta', async () => {
  const base = { enabled: false, enabledVersion: 0, locales: { en: draftFromView(view()), ru: draftFromView(null) } };
  const en: AboutDraft = { ...base.locales.en, title: 'About PackJoyU', stats: [...base.locales.en.stats, { value: '', label: '' }] };
  const ru: AboutDraft = { ...base.locales.ru, title: 'О нас' };
  const { api, calls } = fake([
    (c) => ({ status: 200, body: { locale: 'en', changed: true, content: view({ ...(c.body as object), version: 4, home: { title: 'H', intro: 'I' } }) } }),
    () => ({ status: 200, body: { locale: 'ru', changed: true, content: view({ title: 'О нас', version: 1 }) } }),
  ]);
  const r = await api.save({ en, ru }, base);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['PUT', '/api/admin/site-settings/about/en'], ['PUT', '/api/admin/site-settings/about/ru']]);
  for (const c of calls) assert.equal(AboutPutInput.safeParse(c.body).success, true, JSON.stringify(c.body));
  assert.deepEqual(calls[0].body, { expectedVersion: 3, title: 'About PackJoyU', summary: 's', bodyHtml: '<p>b</p>', stats: [{ label: 'L', value: 'V' }], home: { title: 'H', intro: 'I' }, imageMeta: { img1: { alt: 'a', caption: 'c' } } });
  assert.equal((calls[1].body as { expectedVersion: number }).expectedVersion, 0);
  assert.ok(r.ok && r.data.locales.en.version === 4 && r.data.locales.ru.version === 1);
});

test('409：只认 { error: version_conflict, currentVersion }；停止保存后面的语言，已保存的放进 saved；不自动重交', async () => {
  const base = { enabled: false, enabledVersion: 0, locales: { en: draftFromView(view()), ru: draftFromView(view({ version: 7 })) } };
  const { api, calls } = fake([
    () => ({ status: 200, body: { locale: 'en', changed: true, content: view({ version: 4 }) } }),
    () => ({ status: 409, body: { error: 'version_conflict', currentVersion: 8 } }),
  ]);
  const r = await api.save({ en: { ...base.locales.en, title: 'x2' }, ru: { ...base.locales.ru, title: 'y2' }, de: emptyDraft() }, base);
  assert.equal(calls.length, 2, 'stops at the conflict, no retry, later locales not sent');
  assert.ok(!r.ok);
  assert.equal(r.code, 'version_conflict');
  assert.equal(r.currentVersion, 8);
  assert.equal(r.saved?.locales.en.version, 4);
  // 第一个语言就冲突：没有 saved
  const one = await fake([() => ({ status: 409, body: { error: 'version_conflict', currentVersion: 9 } })]).api.save({ en: base.locales.en }, base);
  assert.deepEqual(one, { ok: false, code: 'version_conflict', currentVersion: 9 });
  // 其他错误码原样交给页面
  assert.deepEqual(await fake([() => ({ status: 400, body: { error: 'invalid', issues: [] } })]).api.save({ en: base.locales.en }, base), { ok: false, code: 'invalid' });
  assert.deepEqual(await fake([() => ({ status: 500, body: {} })]).api.save({ en: base.locales.en }, base), { ok: false, code: 'http_500' });
});

test('开关：PUT /about/enabled 带 expectedVersion（能通过 EnabledPutInput）；409 同样是 version_conflict', async () => {
  const { api, calls } = fake([
    () => ({ status: 200, body: { enabled: true, version: 6, changed: true, updatedAt: 'x' } }),
    () => ({ status: 409, body: { error: 'version_conflict', currentVersion: 1 } }),
  ]);
  const r = await api.setEnabled(true, 5);
  assert.deepEqual(calls[0], { url: '/api/admin/site-settings/about/enabled', method: 'PUT', body: { enabled: true, expectedVersion: 5 } });
  assert.equal(EnabledPutInput.safeParse(calls[0].body).success, true);
  assert.ok(r.ok && r.data.enabled === true && r.data.enabledVersion === 6);
  // 没有版本号（从没存过）时不带 expectedVersion；并发新建时后端也可能 409
  assert.deepEqual(await api.setEnabled(false, null), { ok: false, code: 'version_conflict', currentVersion: 1 });
  assert.deepEqual(calls[1].body, { enabled: false });
});

test('计数 / 上限来自 about-rules.ts（code point）；保存只卡上限，标题非空时至少 2 字', () => {
  const d = { ...emptyDraft(), title: '😀'.repeat(80), bodyHtml: `<p>${'😀'.repeat(ABOUT_LIMITS.bodyTextMax)}</p>` };
  assert.deepEqual(fieldCount('title', d), { n: 80, max: ABOUT_LIMITS.titleMax, min: ABOUT_LIMITS.titleMin });
  assert.equal(fieldCount('bodyHtml', d).n, ABOUT_LIMITS.bodyTextMax);
  assert.equal(fieldCount('homeHeading', emptyDraft()).max, ABOUT_LIMITS.homeTitleMax);
  assert.deepEqual(draftErrors(d), {}, 'exactly at the limit (emoji = 1) is fine');
  assert.ok(draftErrors({ ...d, title: '😀'.repeat(81) }).title);
  assert.ok(draftErrors({ ...emptyDraft(), title: 'A' }).title, 'backend too_short');
  assert.deepEqual(draftErrors({ ...emptyDraft(), bodyHtml: '<p>short</p>' }), {}, 'drafts below the completeness minimum can be saved');
  for (const f of ['src/lib/admin/site-settings.ts', 'src/lib/about/model.ts', 'src/components/admin/settings/AboutSettings.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /from '@\/lib\/site-settings\/about-rules'/, f);
    assert.doesNotMatch(src, /titleMax:\s*\d|bodyMax:|summaryMax:\s*\d/, `${f}: no local limit constants`);
  }
  // 客户端文件不能 import 服务端模块（sanitize-html / prisma / SEO 的 about.ts）
  for (const f of ['src/lib/admin/site-settings.ts', 'src/lib/admin/site-settings-http.ts', 'src/lib/about/model.ts', 'src/components/admin/settings/AboutSettings.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from '[^']*(seo\/about|sanitize-about|sanitize-html|server-only)'/, f);
    for (const line of src.split('\n').filter((l) => /from '@\/lib\/server\//.test(l) && !/published-locales/.test(l))) assert.match(line, /^import type /, `${f}: ${line}`);
  }
});

test('putBody 只含后端认识的字段', () => {
  assert.deepEqual(Object.keys(putBody(emptyDraft())).sort(), ['bodyHtml', 'expectedVersion', 'home', 'imageMeta', 'stats', 'summary', 'title']);
});
