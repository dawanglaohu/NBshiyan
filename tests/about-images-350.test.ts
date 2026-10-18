import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换
import { renderToStaticMarkup } from 'react-dom/server';
import {
  IMAGES_MAX, IMAGES_TEXT, addImage, anyImageErrors, createAboutImagesApi, imageAltChecklistItem, imageErrorText, imageIssueText, imagesStateFrom, isSmallImage, localeImageErrors, metaChanged, moveImage,
  precheckFile, pruneImageMeta, retryAfterMs, saveAboutWithImages, slotsLeft, uploadAboutImage, uploadOutcome, withImageAltCompleteness, withImagesDirty,
  type AboutImageItem, type AboutImagesState, type XhrLike,
} from '../src/lib/admin/about-images';
import { createAboutSettingsApi, draftFromView } from '../src/lib/admin/site-settings-http';
import { dirtySummary, draftCompleteness, emptyDraft, issuesAlertText, settingsErrorText, type AboutDraft, type AboutSettingsData } from '../src/lib/admin/site-settings';
import { aboutImageAttrs, visibleImages } from '../src/lib/about/model';
import { AboutFigure, ABOUT_IMAGE_SIZES } from '../src/components/about/AboutParts';
import { AboutImagesPutInput, AboutPutInput } from '../src/lib/server/site-settings-admin';

// #350 后台图片列表（PublicAsset #374）：错误文案、6 张上限、imageMeta 剪枝、保存顺序和 409、前台 srcset 用 sm / lg 实际宽高
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ID = (n: number) => `asset${String(n).padStart(19, '0')}`; // 24 位字母数字，和后端 randomId(24) 同格式
const item = (n: number, lg = { w: 1600, h: 1200 }, sm = { w: 800, h: 600 }): AboutImageItem => ({ id: ID(n), sm, lg, src: { sm: `/media/${ID(n)}-800.webp`, lg: `/media/${ID(n)}-1600.webp` } });
const draft = (over: Partial<AboutDraft> = {}): AboutDraft => ({ ...emptyDraft(), title: 'About us', bodyHtml: '<p>' + 'x'.repeat(60) + '</p>', version: 1, imageMeta: {}, ...over });

// ───────── 错误码 → 文案（v1.0.7 / v1.0.8 逐字） ─────────
test('上传错误：状态码和错误码都映射到定稿文案；nginx 返回的非 JSON 413 / 429 按状态码判断', () => {
  const cases: [number, string, string][] = [
    [413, JSON.stringify({ error: 'file_too_large' }), '图片不能超过 10MB'],
    [413, '<html>413 Request Entity Too Large</html>', '图片不能超过 10MB'],
    [415, JSON.stringify({ error: 'unsupported_type' }), '仅支持 JPG、PNG、WebP 静态图片'],
    [422, JSON.stringify({ error: 'image_too_small' }), '图片太小，长边至少 800 像素'],
    [422, JSON.stringify({ error: 'processing_failed' }), '图片处理失败，请换一张重试'],
    [422, JSON.stringify({ error: 'image_too_large_dimensions' }), '图片像素过大（超过 6000 万），请缩小后再上传'],
    [429, JSON.stringify({ error: 'rate_limited' }), '上传太频繁，请稍后再试'],
    [429, 'Too Many Requests', '上传太频繁，请稍后再试'],
  ];
  for (const [status, body, text] of cases) {
    const r = uploadOutcome(status, body, null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.message, text, `${status} ${body}`);
  }
  assert.equal(imageErrorText('asset_in_use'), '这张图正在关于页使用，请先从关于页移除');
  const u = uploadOutcome(401, '{}', null);
  assert.ok(!u.ok && u.code === 'unauthorized');
  const n = uploadOutcome(0, '', null);
  assert.ok(!n.ok && n.code === 'network');
});

test('429：带 retryAfterMs（Retry-After 秒数 / HTTP 日期 / 缺省 60 秒），其他错误不带', () => {
  const r = uploadOutcome(429, JSON.stringify({ error: 'rate_limited' }), '60');
  assert.ok(!r.ok && r.retryAfterMs === 60_000);
  assert.equal(retryAfterMs('5'), 5000);
  assert.equal(retryAfterMs(null), 60_000);
  assert.equal(retryAfterMs('garbage'), 60_000);
  const now = Date.parse('2026-10-18T08:00:00Z');
  assert.equal(retryAfterMs('Sun, 18 Oct 2026 08:00:30 GMT', now), 30_000);
  const t = uploadOutcome(415, JSON.stringify({ error: 'unsupported_type' }), '60');
  assert.ok(!t.ok && t.retryAfterMs === undefined);
});

const assetBody = (over: Record<string, unknown> = {}) => ({
  id: ID(1), kind: 'about', width: 1600, height: 1200,
  sm: { url: `/media/${ID(1)}-800.webp`, width: 800, height: 600, bytes: 50_000 },
  lg: { url: `/media/${ID(1)}-1600.webp`, width: 1600, height: 1200, bytes: 180_000 },
  bytes: 2_000_000, createdAt: '2026-10-18T08:00:00.000Z', warnings: [], ...over,
});
test('上传成功：201 新图；200 + deduplicated:true 复用已有记录；warnings 原样带出（image_small）', () => {
  const a = uploadOutcome(201, JSON.stringify({ ...assetBody(), deduplicated: false }), null);
  assert.ok(a.ok && !a.deduplicated && a.asset.sm.width === 800 && a.asset.lg.height === 1200);
  const b = uploadOutcome(200, JSON.stringify({ ...assetBody(), deduplicated: true }), null);
  assert.ok(b.ok && b.deduplicated);
  const c = uploadOutcome(201, JSON.stringify({ ...assetBody({ warnings: ['image_small'] }), deduplicated: false }), null);
  assert.ok(c.ok && c.warnings.includes('image_small'));
  const bad = uploadOutcome(201, '{"id":"x"}', null);
  assert.ok(!bad.ok, '字段不全的成功响应当失败处理，不往列表里塞坏数据');
});

test('选文件后先查：>10 MB、浏览器明确报出的非 JPG/PNG/WebP 不上传；类型为空交给服务端', () => {
  assert.equal(precheckFile({ size: 10 * 1024 * 1024 + 1, type: 'image/jpeg' }), 'file_too_large');
  assert.equal(precheckFile({ size: 10 * 1024 * 1024, type: 'image/jpeg' }), null);
  assert.equal(precheckFile({ size: 100, type: 'image/heic' }), 'unsupported_type');
  assert.equal(precheckFile({ size: 100, type: 'image/svg+xml' }), 'unsupported_type');
  assert.equal(precheckFile({ size: 100, type: 'image/gif' }), 'unsupported_type');
  assert.equal(precheckFile({ size: 100, type: '' }), null);
  assert.equal(precheckFile({ size: 100, type: 'image/WEBP' }), null);
});

test('小图提示：长边 < 1600 才提示（和后端 image_small 同一规则）', () => {
  assert.equal(isSmallImage({ w: 1600, h: 1200 }), false);
  assert.equal(isSmallImage({ w: 1200, h: 1600 }), false);
  assert.equal(isSmallImage({ w: 1200, h: 900 }), true);
});

// ───────── 6 张上限、排序 ─────────
test('最多 6 张：正在上传的也占名额；满了 addImage 不再加；重复 id 不加；保存校验 >6 拦住', () => {
  const five = [1, 2, 3, 4, 5].map((n) => item(n));
  assert.equal(IMAGES_MAX, 6);
  assert.equal(slotsLeft(five), 1);
  assert.equal(slotsLeft(five, 1), 0);
  assert.equal(slotsLeft(five, 3), 0);
  const six = addImage(five, item(6));
  assert.equal(six.length, 6);
  assert.equal(addImage(six, item(7)).length, 6);
  assert.equal(addImage(five, item(1)).length, 5);
  assert.equal(anyImageErrors({}, ['en'], [...six.map((i) => i.id), ID(7)]), true);
  assert.equal(AboutImagesPutInput.safeParse({ expectedVersion: 0, ids: [1, 2, 3, 4, 5, 6, 7].map(ID) }).success, false, '后端同样拒绝 7 张');
});

test('左移 / 右移：交换相邻两张；越界不动', () => {
  const l = [item(1), item(2), item(3)];
  assert.deepEqual(moveImage(l, 1, -1).map((i) => i.id), [ID(2), ID(1), ID(3)]);
  assert.deepEqual(moveImage(l, 1, 1).map((i) => i.id), [ID(1), ID(3), ID(2)]);
  assert.deepEqual(moveImage(l, 0, -1).map((i) => i.id), l.map((i) => i.id));
  assert.deepEqual(moveImage(l, 2, 1).map((i) => i.id), l.map((i) => i.id));
});

// ───────── imageMeta ─────────
test('imageMeta 剪枝：只留当前列表里的 id、按列表顺序；alt 和说明都空的不发', () => {
  const meta = { [ID(1)]: { alt: 'one', caption: '' }, [ID(2)]: { alt: '', caption: '' }, [ID(9)]: { alt: 'removed', caption: 'x' }, [ID(3)]: { alt: '', caption: 'cap only' } };
  const out = pruneImageMeta(meta, [ID(3), ID(1), ID(2)]);
  assert.deepEqual(Object.keys(out), [ID(3), ID(1)]);
  assert.deepEqual(out[ID(1)], { alt: 'one', caption: '' });
  assert.equal(out[ID(9)], undefined, '已移除的图的旧文字不带回去');
  assert.deepEqual(pruneImageMeta(undefined, [ID(1)]), {});
});

test('替代文字必填（有内容的语言）、≤125；说明 ≤80；完全没填过的语言不强制', () => {
  const ids = [ID(1), ID(2)];
  const e = localeImageErrors(draft({ imageMeta: { [ID(1)]: { alt: 'ok', caption: 'c'.repeat(81) } } }), ids);
  assert.deepEqual(e.missing, [ID(2)]);
  assert.equal(e.alt[ID(2)], '请填写替代文字');
  assert.equal(e.caption[ID(1)], '超出上限：81 / 80');
  const long = localeImageErrors(draft({ imageMeta: { [ID(1)]: { alt: 'a'.repeat(126), caption: '' }, [ID(2)]: { alt: '  ', caption: '' } } }), ids);
  assert.equal(long.alt[ID(1)], '超出上限：126 / 125');
  assert.deepEqual(long.missing, [ID(2)], '只有空白也算没填');
  assert.deepEqual(localeImageErrors(emptyDraft(), ids).missing, [], '空语言前台本来就不显示');
  assert.equal(anyImageErrors({ en: draft(), ru: emptyDraft() }, ['en', 'ru'], ids), true);
  assert.equal(anyImageErrors({ en: draft({ imageMeta: { [ID(1)]: { alt: 'a', caption: '' }, [ID(2)]: { alt: 'b', caption: '' } } }), ru: emptyDraft() }, ['en', 'ru'], ids), false);
});

test('保存条摘要：图片文字按语言补在后面，列表变化单独一段', () => {
  const saved = { en: draft(), ru: draft() };
  const d = { en: draft({ title: 'Changed title', imageMeta: { [ID(1)]: { alt: 'new', caption: '' } } }), ru: draft({ imageMeta: { [ID(1)]: { alt: 'ru', caption: '' } } }) };
  const s = withImagesDirty(dirtySummary(saved, d), saved, d, [], [item(1)]);
  assert.equal(s, 'EN：标题、图片文字；RU：图片文字；图片列表');
  assert.equal(withImagesDirty('', saved, saved, [item(1)], [item(1)]), '');
  assert.equal(metaChanged(draft({ imageMeta: { [ID(9)]: { alt: 'x', caption: '' } } }), draft(), [ID(1)]), false, '不在列表里的图的文字不算改动');
});

// ───────── 保存顺序、409 ─────────
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function fakeFetch(handler: (c: Call, i: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const c: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c, calls.length - 1);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { f, calls };
}
const okLocale = (c: Call) => ({ status: 200, body: { locale: c.url.split('/').pop(), changed: true, content: { version: Number(c.body?.expectedVersion) + 1, title: c.body?.title, summary: '', bodyHtml: c.body?.bodyHtml, stats: [], home: { title: '', intro: '' }, imageMeta: c.body?.imageMeta, updatedAt: '2026-10-18T08:00:00Z', updatedByName: 'Ryan' } } });
const okImages = (c: Call) => ({ status: 200, body: { changed: true, images: { version: Number(c.body?.expectedVersion) + 1, updatedAt: null, updatedBy: null, items: (c.body?.ids as string[]).map((id) => ({ id, sm: { w: 800, h: 600 }, lg: { w: 1600, h: 1200 }, src: { sm: `/media/${id}-800.webp`, lg: `/media/${id}-1600.webp` } })) } } });
const route = (c: Call) => (c.url.endsWith('/about/images') ? okImages(c) : okLocale(c));

function setup(handler: (c: Call, i: number) => { status: number; body: unknown } = route) {
  const { f, calls } = fakeFetch(handler);
  return { calls, api: createAboutSettingsApi(f), images: createAboutImagesApi(f) };
}
const meta = (...ns: number[]) => Object.fromEntries(ns.map((n) => [ID(n), { alt: `alt ${n}`, caption: '' }]));

test('列表没变：只 PUT 改过的语言，imageMeta 剪到当前列表（库里残留的已删除图片 id 不再发，避免 400 unknown_asset）', async () => {
  const { calls, api, images } = setup();
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft({ imageMeta: { ...meta(1), [ID(8)]: { alt: 'stale', caption: '' } } }), ru: draft() } };
  const d = { en: { ...saved.locales.en, title: 'New title' }, ru: saved.locales.ru };
  const savedImages: AboutImagesState = { version: 4, items: [item(1)] };
  const r = await saveAboutWithImages({ locales: ['en', 'ru'], draft: d, saved, savedImages, draftImages: [item(1)], api, putImages: images.putImages });
  assert.ok(r.ok);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['PUT', '/api/admin/site-settings/about/en']]);
  assert.deepEqual(Object.keys(calls[0].body!.imageMeta as object), [ID(1)]);
  assert.ok(AboutPutInput.safeParse(calls[0].body).success);
});

test('列表变了：① 语言带「旧 ∪ 新」文字 → ② PUT /about/images（expectedVersion）→ ③ 剪到新列表再 PUT 一次', async () => {
  const { calls, api, images } = setup();
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft({ version: 2, imageMeta: meta(1, 2) }), ru: emptyDraft() } };
  // 去掉 2、加上 3（en 补了 3 的 alt）
  const d = { en: { ...saved.locales.en, imageMeta: meta(1, 2, 3) }, ru: saved.locales.ru };
  const r = await saveAboutWithImages({ locales: ['en', 'ru'], draft: d, saved, savedImages: { version: 4, items: [item(1), item(2)] }, draftImages: [item(1), item(3)], api, putImages: images.putImages });
  assert.ok(r.ok);
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace('/api/admin/site-settings', '')]), [['PUT', '/about/en'], ['PUT', '/about/images'], ['PUT', '/about/en']]);
  assert.deepEqual(Object.keys(calls[0].body!.imageMeta as object).sort(), [ID(1), ID(2), ID(3)].sort(), '第一步：新旧状态下列表里的图都有 alt');
  assert.deepEqual(calls[1].body, { expectedVersion: 4, ids: [ID(1), ID(3)] });
  assert.ok(AboutImagesPutInput.safeParse(calls[1].body).success);
  assert.deepEqual(Object.keys(calls[2].body!.imageMeta as object), [ID(1), ID(3)], '第三步：剪掉已移除的 2');
  assert.equal(calls[2].body!.expectedVersion, 3, '第三步带第一步保存后的新版本号');
  for (const c of [calls[0], calls[2]]) assert.ok(AboutPutInput.safeParse(c.body).success);
  if (r.ok) { assert.equal(r.images.version, 5); assert.deepEqual(r.images.items.map((i) => i.id), [ID(1), ID(3)]); assert.equal(r.data.locales.en.version, 4); }
});

test('只改顺序 / 只移除：不用 PUT 语言（文字没变），直接 PUT 列表', async () => {
  const { calls, api, images } = setup();
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft({ imageMeta: meta(1, 2) }) } };
  const r = await saveAboutWithImages({ locales: ['en'], draft: saved.locales, saved, savedImages: { version: 1, items: [item(1), item(2)] }, draftImages: [item(2), item(1)], api, putImages: images.putImages });
  assert.ok(r.ok);
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['images']);
});

test('「旧 ∪ 新」超过 6 张：第一步只带新列表（不能超过后端 imageMeta 6 个键的上限）', async () => {
  const { calls, api, images } = setup();
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft({ imageMeta: meta(1, 2, 3, 4, 5, 6) }) } };
  const d = { en: { ...saved.locales.en, imageMeta: meta(1, 2, 3, 4, 5, 6, 7) } };
  const r = await saveAboutWithImages({ locales: ['en'], draft: d, saved, savedImages: { version: 1, items: [1, 2, 3, 4, 5, 6].map((n) => item(n)) }, draftImages: [1, 2, 3, 4, 5, 7].map((n) => item(n)), api, putImages: images.putImages });
  assert.ok(r.ok);
  assert.equal(Object.keys(calls[0].body!.imageMeta as object).length, 6);
  assert.ok(AboutPutInput.safeParse(calls[0].body).success);
  assert.equal(calls.length, 2, '已经是新列表，不需要第三步');
});

test('409（图片列表）：返回 version_conflict + currentVersion，不自动重发；之前成功的语言放在 saved 里', async () => {
  const { calls, api, images } = setup((c) => (c.url.endsWith('/about/images') ? { status: 409, body: { error: 'version_conflict', currentVersion: 9 } } : okLocale(c)));
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft({ imageMeta: meta(1) }) } };
  const d = { en: { ...saved.locales.en, imageMeta: meta(1, 2) } };
  const r = await saveAboutWithImages({ locales: ['en'], draft: d, saved, savedImages: { version: 4, items: [item(1)] }, draftImages: [item(1), item(2)], api, putImages: images.putImages });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'version_conflict');
    assert.equal(r.currentVersion, 9);
    assert.equal(r.saved?.locales.en.version, 2, '语言那一步已经保存了，页面要更新基线');
    assert.equal(r.images, undefined, '列表没保存');
  }
  assert.equal(calls.filter((c) => c.url.endsWith('/about/images')).length, 1, '只发一次，不拿 currentVersion 重交');
});

test('409（语言）：在 PUT 列表之前就停下，列表不动', async () => {
  const { calls, api, images } = setup((c) => (c.url.endsWith('/about/en') ? { status: 409, body: { error: 'version_conflict', currentVersion: 7 } } : route(c)));
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft() } };
  const d = { en: { ...saved.locales.en, imageMeta: meta(1) } };
  const r = await saveAboutWithImages({ locales: ['en'], draft: d, saved, savedImages: { version: 0, items: [] }, draftImages: [item(1)], api, putImages: images.putImages });
  assert.ok(!r.ok && r.code === 'version_conflict');
  assert.equal(calls.length, 1);
});

test('第三步失败：列表已保存（images 带回去，页面更新列表基线），错误照常报', async () => {
  let n = 0;
  const { api, images } = setup((c) => (c.url.endsWith('/about/en') && ++n === 2 ? { status: 409, body: { error: 'version_conflict', currentVersion: 11 } } : route(c)));
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: draft({ imageMeta: meta(1, 2) }) } };
  const d = { en: { ...saved.locales.en, title: 'T2', imageMeta: meta(1, 2) } };
  const r = await saveAboutWithImages({ locales: ['en'], draft: d, saved, savedImages: { version: 1, items: [item(1), item(2)] }, draftImages: [item(1)], api, putImages: images.putImages });
  assert.ok(!r.ok && r.code === 'version_conflict');
  if (!r.ok) { assert.deepEqual(r.images?.items.map((i) => i.id), [ID(1)]); assert.equal(r.saved?.locales.en.title, 'T2'); }
});

test('接口层：一次 GET /about 同时拿到文字和图片列表；列表、删除 409 asset_in_use、PUT images 400 unknown_asset', async () => {
  const { f, calls } = fakeFetch((c) => {
    if (c.url === '/api/admin/site-settings/about') return { status: 200, body: { enabled: true, enabledMeta: { version: 2 }, locales: { en: null }, images: { version: 3, items: [{ id: ID(1), sm: { w: 600, h: 800 }, lg: { w: 1200, h: 1600 }, src: { sm: `/media/${ID(1)}-800.webp`, lg: `/media/${ID(1)}-1600.webp` } }, { id: 'bad' }] } } };
    if (c.url === '/api/admin/site-settings/assets') return { status: 200, body: { assets: [{ ...assetBody(), inUse: true }, { nope: 1 }] } };
    if (c.method === 'DELETE') return { status: 409, body: { error: 'asset_in_use', usedBy: ['about.images'] } };
    return { status: 400, body: { error: 'unknown_asset', ids: [ID(5)] } };
  });
  const api = createAboutImagesApi(f);
  const { data, images } = await api.loadWithImages(['en']);
  assert.equal(data.enabledVersion, 2);
  assert.deepEqual(data.locales.en, draftFromView(null));
  assert.deepEqual(images, { version: 3, items: [{ id: ID(1), sm: { w: 600, h: 800 }, lg: { w: 1200, h: 1600 }, src: { sm: `/media/${ID(1)}-800.webp`, lg: `/media/${ID(1)}-1600.webp` } }] });
  assert.deepEqual(await api.loadImages(), images, '409 刷新用的只读图片列表');
  const lib = await api.listAssets();
  assert.equal(lib.length, 1); assert.equal(lib[0].inUse, true);
  assert.deepEqual(await api.deleteAsset(ID(1)), { ok: false, code: 'asset_in_use' });
  assert.equal(calls.at(-1)!.url, `/api/admin/site-settings/assets/${ID(1)}`);
  assert.deepEqual(await api.putImages(1, [ID(5)]), { ok: false, code: 'unknown_asset' });
  assert.deepEqual(imagesStateFrom(null), { version: 0, items: [] });
});

// ───────── 上传（XHR：进度、取消、429 头） ─────────
function fakeXhr(status: number, body: string, headers: Record<string, string> = {}) {
  const x: XhrLike & { sent: FormData | null; url: string; aborted: boolean } = {
    sent: null, url: '', aborted: false, status: 0, responseText: '', withCredentials: false,
    upload: { onprogress: null }, onload: null, onerror: null, onabort: null,
    open(_m, u) { this.url = u; },
    send(fd) { this.sent = fd; queueMicrotask(() => { if (this.aborted) return; this.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true }); this.status = status; this.responseText = body; this.onload?.(); }); },
    abort() { this.aborted = true; this.onabort?.(); },
    getResponseHeader(n) { return headers[n] ?? null; },
  };
  return x;
}
test('uploadAboutImage：POST multipart file，报进度；429 带 Retry-After；取消 → aborted', async () => {
  const x = fakeXhr(429, JSON.stringify({ error: 'rate_limited' }), { 'Retry-After': '60' });
  const prog: number[] = [];
  const r = await uploadAboutImage(new Blob(['x'], { type: 'image/png' }), { xhr: () => x, onProgress: (p) => prog.push(p) });
  assert.equal(x.url, '/api/admin/site-settings/assets');
  assert.ok(x.sent?.get('file'));
  assert.deepEqual(prog, [50]);
  assert.ok(!r.ok && r.code === 'rate_limited' && r.retryAfterMs === 60_000 && r.message === '上传太频繁，请稍后再试');
  const ctrl = new AbortController();
  const y = fakeXhr(201, '{}');
  const p = uploadAboutImage(new Blob(['x']), { xhr: () => y, signal: ctrl.signal });
  ctrl.abort();
  const a = await p;
  assert.ok(!a.ok && a.code === 'aborted');
});

// ───────── 前台 srcset / width / height 用 sm / lg ─────────
const pub = (sm: { w: number; h: number }, lg: { w: number; h: number }, same = false) => ({
  id: ID(1), w: lg.w, h: lg.h, alt: 'Factory floor', caption: '', sm, lg,
  src: { sm: same ? `/media/${ID(1)}-1600.webp` : `/media/${ID(1)}-800.webp`, lg: `/media/${ID(1)}-1600.webp` },
});
test('前台 srcset：w 描述符取 sm.w / lg.w 实际宽度（竖图不是 800w / 1600w）；width / height 用 lg；同一文件只写一档', () => {
  assert.deepEqual(aboutImageAttrs(pub({ w: 800, h: 600 }, { w: 1600, h: 1200 })), { src: `/media/${ID(1)}-800.webp`, srcSet: `/media/${ID(1)}-800.webp 800w, /media/${ID(1)}-1600.webp 1600w`, width: 1600, height: 1200 });
  assert.deepEqual(aboutImageAttrs(pub({ w: 600, h: 800 }, { w: 1200, h: 1600 })).srcSet, `/media/${ID(1)}-800.webp 600w, /media/${ID(1)}-1600.webp 1200w`);
  const small = aboutImageAttrs(pub({ w: 800, h: 533 }, { w: 1200, h: 800 }));
  assert.equal(small.srcSet, `/media/${ID(1)}-800.webp 800w, /media/${ID(1)}-1600.webp 1200w`, '长边 1200 的图 lg 实际只有 1200 宽');
  assert.deepEqual(aboutImageAttrs(pub({ w: 800, h: 600 }, { w: 800, h: 600 }, true)), { src: `/media/${ID(1)}-1600.webp`, srcSet: `/media/${ID(1)}-1600.webp 800w`, width: 800, height: 600 });
});

test('前台 <img>：srcset、sizes、width、height、alt 都在；缺 sm / lg 宽高的不渲染', () => {
  const html = renderToStaticMarkup(React.createElement(AboutFigure, { img: pub({ w: 600, h: 800 }, { w: 1200, h: 1600 }), sizes: ABOUT_IMAGE_SIZES }));
  assert.match(html, /srcSet="\/media\/asset0+1-800\.webp 600w, \/media\/asset0+1-1600\.webp 1200w"/);
  assert.match(html, /width="1200"/); assert.match(html, /height="1600"/);
  assert.match(html, /alt="Factory floor"/);
  assert.match(html, /sizes="\(min-width: 1024px\) 50vw, 100vw"/);
  assert.equal(visibleImages([{ ...pub({ w: 0, h: 0 }, { w: 1600, h: 1200 }) }]).length, 0);
  assert.doesNotMatch(read('../src/components/about/AboutParts.tsx'), /800w, \$\{img\.src\.lg\} 1600w/, '不再写死 800w / 1600w');
});

// ───────── 组件接线（源码检查：不改后端文件，只用现有接口） ─────────
test('后台组件：替代文字必填、按语言；上传区常驻规则文案；删除确认文案和红色按钮；在用时不发 DELETE', () => {
  const src = read('../src/components/admin/settings/AboutImages.tsx');
  const lib = read('../src/lib/admin/about-images.ts');
  for (const s of ['JPG / PNG / WebP，单张 ≤ 10 MB', '删除后，旧的图片链接可能仍能访问一段时间', '图片较小，大屏上可能不够清晰', '描述图片内容，≤125 字', '≤80 字，显示在图片下方']) assert.ok(lib.includes(s), s);
  // 删除确认用 #375 共用的 ConfirmDialog（role=alertdialog、焦点在「取消」、danger = 红色按钮）
  assert.match(src, /<ConfirmDialog title=\{T\.deleteTitle\} confirmLabel=\{T\.delete\} danger onCancel=\{closeConfirm\} onConfirm=\{doDelete\}>/);
  assert.doesNotMatch(src, /function DeleteDialog/);
  const dlg = read('../src/components/admin/settings/ConfirmDialog.tsx');
  assert.match(dlg, /role="alertdialog"/); assert.match(dlg, /primary\$\{danger \? ' danger' : ''\}/);
  assert.match(src, /savedIds\.includes\(id\)\) \{ setAssetErr/);
  assert.match(src, /accept=\{ACCEPT\}/);
  assert.match(read('../src/components/admin/settings/AboutSettings.tsx'), /<AboutImages /);
});

test('完整度：右栏「图片替代文字」一项（无图 – / N 张缺失 ! / 都填 ✓），语言标签「缺…」也算上图片替代文字', () => {
  const ids = [ID(1), ID(2), ID(3)];
  const body = 'x'.repeat(60);
  const full: AboutDraft = { ...emptyDraft(), title: 'About us', bodyHtml: `<p>${body}</p>`, imageMeta: { [ID(1)]: { alt: 'a', caption: '' }, [ID(2)]: { alt: '  ', caption: 'c' } } };
  assert.deepEqual(imageAltChecklistItem(full, []), { key: 'imageAlt', label: '图片替代文字（暂无图片）', state: 'optional' });
  assert.deepEqual(imageAltChecklistItem(full, ids), { key: 'imageAlt', label: '图片替代文字 · 2 张缺失', state: 'missing' });
  assert.deepEqual(imageAltChecklistItem(full, [ID(1)]), { key: 'imageAlt', label: '图片替代文字', state: 'ok' });
  // 空语言在清单里也显示缺（清单是完整度，不是保存校验）
  assert.equal(imageAltChecklistItem(emptyDraft(), [ID(1)]).state, 'missing');
  // 标签
  assert.equal(draftCompleteness(full).state, 'complete');
  assert.deepEqual(withImageAltCompleteness(draftCompleteness(full), full, ids), { state: 'partial', label: '缺图片替代文字' });
  assert.deepEqual(withImageAltCompleteness(draftCompleteness(full), full, [ID(1)]), { state: 'complete', label: '完整' });
  const noBody = { ...full, bodyHtml: '' };
  assert.equal(withImageAltCompleteness(draftCompleteness(noBody), noBody, ids).label, `${draftCompleteness(noBody).label}、图片替代文字`);
  assert.deepEqual(withImageAltCompleteness(draftCompleteness(emptyDraft()), emptyDraft(), ids), { state: 'empty', label: '未填写' });
  // 接线：清单最后一项、标签 / 前台状态都走 withImageAltCompleteness（按已保存的列表）
  const ui = read('../src/components/admin/settings/AboutSettings.tsx');
  assert.match(ui, /\[\.\.\.draftChecklist\(d\), imageAltChecklistItem\(d, imgDraft\.map\(\(i\) => i\.id\)\)\]/);
  assert.match(ui, /const comp = \(l: string\) => withImageAltCompleteness\(draftCompleteness\(savedLocales\[l\] \?\? emptyDraft\(\)\), savedLocales\[l\], imgSaved\.items\.map/);
});

test('错误文案：图片带来的新错误码都是中文（经 settingsErrorText / issuesAlertText），imageMeta issue 换成「第 N 张图片…」', async () => {
  assert.equal(settingsErrorText('unknown_asset'), '列表里有图片已经被删除，请移除后再保存');
  assert.equal(issuesAlertText('unknown_asset'), '列表里有图片已经被删除，请移除后再保存');
  assert.equal(settingsErrorText('network'), '网络错误，请检查网络后重试');
  assert.equal(settingsErrorText('invalid_locale'), '这个语言还不支持，请刷新页面后重试');
  assert.equal(settingsErrorText('invalid'), '参数不正确，请检查后重试。');
  assert.equal(settingsErrorText('http_422'), '保存失败：http_422', '#373 / #375 的既有约定不变');
  for (const c of ['unknown_asset', 'network', 'missing_file', 'asset_in_use', 'not_found', 'file_too_large', 'rate_limited', 'http_502', 'http_404']) {
    assert.doesNotMatch(imageErrorText(c), /[a-z]+_[a-z0-9]+/, c);
  }
  assert.equal(imageErrorText('http_502'), '上传失败：服务器出错（HTTP 502），请稍后重试');
  const ids = [ID(1), ID(2)];
  assert.equal(imageIssueText(`imageMeta.${ID(2)}.alt：max 125 chars`, ids), '第 2 张图片的替代文字超出上限（最多 125 字）');
  assert.equal(imageIssueText(`imageMeta.${ID(9)}.caption：bad`, ids), '图片的说明不符合要求，请检查');
  assert.equal(imageIssueText('imageMeta：too many', ids), '图片的文字不符合要求，请检查');
  assert.equal(imageIssueText('summary：max 300 chars', ids), 'summary：max 300 chars');
  // saveAboutWithImages 失败时把 issues / rest 都换掉
  const saved: AboutSettingsData = { enabled: true, enabledVersion: 1, locales: { en: { ...emptyDraft(), version: 1 } as AboutDraft } };
  const draft = { en: { ...saved.locales.en, title: 'New title' } };
  for (const key of ['issues', 'rest']) {
    const r = await saveAboutWithImages({
      locales: ['en'], draft, saved, savedImages: { version: 1, items: [] }, draftImages: [],
      api: { save: async () => ({ ok: false, code: 'invalid', [key]: [`imageMeta.${ID(1)}.alt：max 125 chars`, 'title：x'] }) as never },
      putImages: async () => { throw new Error('not called'); },
    });
    assert.equal(r.ok, false);
    assert.deepEqual((r as unknown as Record<string, string[]>)[key], ['图片的替代文字超出上限（最多 125 字）', 'title：x'], key);
  }
});

test('UX 复审：上移 / 下移 / 删除第 N 张图片；删除用后台通用的 ✕（不用 🗑）；<640px 单列；「N 张」数字和量词之间有空格', () => {
  const src = read('../src/components/admin/settings/AboutImages.tsx');
  const css = read('../src/components/admin/settings/about-images.css');
  const lib = read('../src/lib/admin/about-images.ts');
  assert.match(src, /aria-label=\{T\.moveUpAria\(n\)\}/);
  assert.match(src, /aria-label=\{T\.moveDownAria\(n\)\}/);
  assert.match(src, /aria-label=\{T\.removeAria\(n\)\}[^\n]*<span aria-hidden="true">✕<\/span><\/button>/);
  assert.doesNotMatch(src + lib, /🗑/u);
  assert.equal(IMAGES_TEXT.moveUpAria(3), '上移第 3 张图片');
  assert.equal(IMAGES_TEXT.moveDownAria(3), '下移第 3 张图片');
  assert.equal(IMAGES_TEXT.removeAria(3), '删除第 3 张图片');
  assert.equal(IMAGES_TEXT.checkAltMissing(2), '图片替代文字 · 2 张缺失');
  assert.match(read('../src/components/admin/settings/AboutSettings.tsx'), /aria-label=\{`删除第 \$\{i \+ 1\} 条`\}[^\n]*>✕<\/button>/, '沿用数据条删除按钮的 ✕');
  assert.match(css, /@media \(max-width:639px\)\{\s*\.st-im-grid\{grid-template-columns:minmax\(0,1fr\)/);
  // 所有「N 张」：数字前后都有空格
  for (const m of lib.matchAll(/`[^`]*\$\{[^}]+\}[^`]*张[^`]*`/g)) assert.match(m[0], /\} 张/, m[0]);
});
