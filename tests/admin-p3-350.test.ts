import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextTrapFocus, FOCUSABLE_SELECTOR } from '../src/lib/admin/focus-trap';
import { draftErrors, emptyDraft, humanIssueLine, mapAboutServerIssues, issuePathLabel, issuesAlertText, saveFailureView } from '../src/lib/admin/site-settings';
import { createAboutSettingsApi } from '../src/lib/admin/site-settings-http';
import { IMAGES_TEXT, inFlightCount, missingAltImages, slotsLeft, takeReady } from '../src/lib/admin/about-images';
import { ABOUT_LIMITS } from '../src/lib/site-settings/about-rules';

// #350 部署后的前端 P3 小 PR（UX #378 / #379 遗留 + spec v1.0.10 + SEO）
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ───────── ① UX #379 P2：ConfirmDialog 焦点锁在框内 ─────────
test('焦点循环：Tab 在最后一个回到第一个，Shift+Tab 在第一个去最后一个；中间位置交给浏览器；焦点在框外时拉回', () => {
  const [a, b, c] = ['取消', '中间', '删除'];
  const items = [a, b, c];
  assert.equal(nextTrapFocus(items, c, false), a);
  assert.equal(nextTrapFocus(items, a, true), c);
  assert.equal(nextTrapFocus(items, a, false), null);
  assert.equal(nextTrapFocus(items, b, false), null);
  assert.equal(nextTrapFocus(items, b, true), null);
  assert.equal(nextTrapFocus(items, null, false), a);
  assert.equal(nextTrapFocus(items, null, true), c);
  assert.equal(nextTrapFocus(['只有一个'], '只有一个', false), '只有一个');
  assert.equal(nextTrapFocus(['只有一个'], '只有一个', true), '只有一个');
  assert.equal(nextTrapFocus([], null, false), null);
  assert.ok(FOCUSABLE_SELECTOR.includes('button:not([disabled])'));
});

test('ConfirmDialog：保留原有行为（alertdialog + 标题 / 正文关联、焦点在「取消」、Esc 关闭、焦点回到触发按钮），新增 Tab 循环和 focusin 拉回', () => {
  const dlg = read('../src/components/admin/settings/ConfirmDialog.tsx');
  assert.match(dlg, /role="alertdialog" aria-modal="true" aria-labelledby="st-dlg-h" aria-describedby="st-dlg-b"/);
  assert.match(dlg, /cancelRef\.current\?\.focus\(\)/);
  assert.match(dlg, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); cancelCb\.current\(\)/);
  assert.match(dlg, /prev\?\.focus\(\)/);
  assert.match(dlg, /nextTrapFocus\(focusablesIn\(dlg\), active, e\.shiftKey\)/);
  assert.match(dlg, /addEventListener\('focusin', fin\)/);
  assert.match(dlg, /removeEventListener\('focusin', fin\)/);
  // effect 只在挂载时跑一次（onCancel 走 ref）：调用方传内联函数时重渲染不会把焦点拉回「取消」
  assert.match(dlg, /prev\?\.focus\(\); \};\n  \}, \[\]\);/);
  // AboutImages 仍然传稳定的 closeConfirm
  assert.match(read('../src/components/admin/settings/AboutImages.tsx'), /const closeConfirm = useCallback\(\(\) => setConfirmId\(null\), \[\]\)/);
});

// ───────── ② UX #378 P3 ①：顶部错误条不显示后端字段路径 ─────────
test('顶部错误条：认识的路径换成中文字段名，认不出的去掉前缀；message 换成中文；中文行原样、重复的合并', () => {
  assert.equal(humanIssueLine('bodyHtml：too_long'), '正文：超出上限');
  assert.equal(humanIssueLine('home.title：max 60 chars'), '区块标题：超出上限（最多 60 字）');
  assert.equal(humanIssueLine('stats.2.label：max 40 chars'), '数据条：超出上限（最多 40 字）');
  assert.equal(humanIssueLine('imageMeta.x：max 125 chars'), '图片文字：超出上限（最多 125 字）');
  assert.equal(humanIssueLine('imageMeta.abc.alt：max 125 chars'), '图片的替代文字：超出上限（最多 125 字）');
  assert.equal(humanIssueLine('imageMeta：max 6 images'), '图片文字：最多 6 张');
  assert.equal(humanIssueLine('bodyHtml：max 30720 bytes'), '正文：内容太长（最多 30 KB）');
  assert.equal(humanIssueLine('expectedVersion：Required'), '版本号：必填');
  assert.equal(humanIssueLine('capacity：Unrecognized key'), '包含不支持的字段');
  assert.equal(humanIssueLine('foo.bar：Expected string, received number'), '不符合要求');
  assert.equal(humanIssueLine('Unrecognized key(s) in object: capacity'), '包含不支持的字段');
  assert.equal(humanIssueLine('第 2 张图片的替代文字超出上限（最多 125 字）'), '第 2 张图片的替代文字超出上限（最多 125 字）');
  assert.equal(humanIssueLine('（未说明）'), '（未说明）');
  assert.equal(issuePathLabel('nope'), null);
  const alert = issuesAlertText('invalid', ['imageMeta.x：too_long', 'bodyHtml：too_long', 'a：bad', 'b：bad']);
  assert.equal(alert, '参数不正确，请检查后重试。（图片文字：超出上限；正文：超出上限；不符合要求）');
  for (const raw of ['imageMeta.', 'bodyHtml：', 'a：', 'too_long', 'bad']) assert.ok(!alert.includes(raw), raw);
});

test('顶部错误条（端到端）：about 保存 400 带对不上字段的 issue → saveFailureView 里没有原始路径', async () => {
  const f = (async () => new Response(JSON.stringify({ error: 'invalid', issues: [{ path: 'imageMeta', message: 'max 6 images' }, { path: 'weird.path', message: 'Invalid input' }] }), { status: 400 })) as unknown as typeof fetch;
  const api = createAboutSettingsApi(f);
  const r = await api.save({ en: { ...emptyDraft(), title: 'About' } }, { enabled: false, enabledVersion: 0, locales: { en: emptyDraft() } });
  assert.ok(!r.ok);
  const v = saveFailureView(r as Extract<typeof r, { ok: false }>);
  assert.equal(v.alert, '参数不正确，请检查后重试。（图片文字：最多 6 张；不符合要求）');
});

// ───────── ③ UX #378 P3 ②：390 下编辑器工具栏一行 ─────────
test('工具栏 390：不换行（nowrap + 横向滚动、隐藏滚动条），按钮高度仍 44px；桌面规则不变', () => {
  const css = read('../src/components/admin/settings/settings.css');
  const mobile = css.slice(css.indexOf('@media (max-width:767px)'));
  for (const rule of ['.st-tools{flex-wrap:nowrap;gap:0;overflow-x:auto;', 'scrollbar-width:none}', '.st-tools::-webkit-scrollbar{display:none}', '.st-tb-btn{min-width:36px;height:44px;padding:0 4px;flex:none}']) assert.ok(mobile.includes(rule), rule);
  assert.match(css, /\.st-tools\{display:flex;gap:2px;flex-wrap:wrap;padding:4px;/); // ≥768 不变
  // 8 个按钮 + 3 条分隔线放进 390 的编辑器（390 − 页面 16×2 − 卡片 20×2 − 边框 2 − 工具栏 4×2 = 308px）
  assert.ok(8 * 36 + 3 * (1 + 4) <= 308);
});

// ───────── ④ UX #378 P3 ③：后端 too_long →「超出上限：n / max」 ─────────
test('后端 too_long：用本地 ABOUT_LIMITS 和当前内容算「超出上限：n / max」，和前端校验同一句', () => {
  const over = { ...emptyDraft(), bodyHtml: `<p>${'字'.repeat(ABOUT_LIMITS.bodyTextMax + 1)}</p>`, homeIntro: 'x'.repeat(ABOUT_LIMITS.homeIntroMax + 5), title: '标'.repeat(81) };
  const m = mapAboutServerIssues([
    { path: 'bodyHtml', message: 'too_long' },
    { path: 'home.intro', message: `max ${ABOUT_LIMITS.homeIntroMax} chars` },
    { path: 'title', message: 'too_long' },
  ], over);
  assert.deepEqual(m.fields, { bodyHtml: '超出上限：6001 / 6000', homeIntro: '超出上限：305 / 300', title: '超出上限：81 / 80' });
  // 和前端校验同一句
  const client = draftErrors(over);
  assert.equal(client.bodyHtml, m.fields.bodyHtml);
  assert.equal(client.homeIntro, m.fields.homeIntro);
  assert.equal(client.title, m.fields.title);
  assert.deepEqual(m.rest, []);
});

test('后端 too_long 但前端计数没超（前后端计数不一致）：不显示自相矛盾的数字，退回「超出上限（最多 max 字）」；HTML 超 30 KB 用前端同一句', () => {
  const ok = { ...emptyDraft(), bodyHtml: '<p>short body</p>' };
  assert.deepEqual(mapAboutServerIssues([{ path: 'bodyHtml', message: 'too_long' }], ok).fields, { bodyHtml: '超出上限（最多 6000 字）' });
  assert.deepEqual(mapAboutServerIssues([{ path: 'summary', message: 'too_long' }]).fields, { summary: '超出上限（最多 160 字）' });
  assert.deepEqual(mapAboutServerIssues([{ path: 'bodyHtml', message: 'max 30720 bytes' }], ok).fields, { bodyHtml: '正文格式太复杂（HTML 超过 30 KB），请删减后再保存' });
  // 都不是「内容不符合要求，请检查」
  for (const v of Object.values(mapAboutServerIssues([{ path: 'homeHeading', message: 'too_long' }, { path: 'home.title', message: 'too_long' }], ok).fields)) assert.notEqual(v, '内容不符合要求，请检查');
});

test('后端 too_long（接口层）：save 把这次提交的那个语言的草稿传给映射，字段下方显示「超出上限：n / max」', async () => {
  const over = { ...emptyDraft(), title: 'About', bodyHtml: `<p>${'a'.repeat(6010)}</p>` };
  const f = (async () => new Response(JSON.stringify({ error: 'invalid', issues: [{ path: 'bodyHtml', message: 'too_long' }] }), { status: 400 })) as unknown as typeof fetch;
  const r = await createAboutSettingsApi(f).save({ en: over }, { enabled: false, enabledVersion: 0, locales: { en: emptyDraft() } });
  assert.ok(!r.ok);
  const v = saveFailureView(r as Extract<typeof r, { ok: false }>);
  assert.deepEqual(v, { fieldErrors: { bodyHtml: '超出上限：6010 / 6000' }, alert: null });
  assert.match(read('../src/lib/admin/site-settings-http.ts'), /JSON\.stringify\(putBody\(d\)\) \}, d\);/);
});

// ───────── ⑤ UX #379 P3 ①：多选时按选择顺序入列 ─────────
test('takeReady：按选择顺序，前面的还在上传就等；失败的不挡后面的', () => {
  const t = (key: number, state: 'uploading' | 'done' | 'error') => ({ key, state });
  const keys = (xs: { key: number }[]) => xs.map((x) => x.key);
  // 2、3 先传完，1 还在传：都不入列
  let r = takeReady([t(1, 'uploading'), t(2, 'done'), t(3, 'done')]);
  assert.deepEqual([keys(r.ready), keys(r.rest)], [[], [1, 2, 3]]);
  // 1 传完：1、2、3 按顺序一起入列
  r = takeReady([t(1, 'done'), t(2, 'done'), t(3, 'done')]);
  assert.deepEqual([keys(r.ready), keys(r.rest)], [[1, 2, 3], []]);
  // 1 完成、2 在传、3 完成：只取 1
  r = takeReady([t(1, 'done'), t(2, 'uploading'), t(3, 'done')]);
  assert.deepEqual([keys(r.ready), keys(r.rest)], [[1], [2, 3]]);
  // 1 失败（被拒 / 等 429 重试）：不挡 2、3
  r = takeReady([t(1, 'error'), t(2, 'done'), t(3, 'done')]);
  assert.deepEqual([keys(r.ready), keys(r.rest)], [[2, 3], [1]]);
  assert.deepEqual(takeReady([]), { ready: [], rest: [] });
});

test('AboutImages 接线：上传成功先标 done，由 effect 按 takeReady 的顺序入列（不在完成回调里直接 addImage）', () => {
  const src = read('../src/components/admin/settings/AboutImages.tsx');
  assert.match(src, /patch\(key, \{ state: 'done', progress: 100, ctrl: undefined, asset: r\.asset, deduplicated: r\.deduplicated \}\)/);
  assert.match(src, /const \{ ready \} = takeReady\(tiles\);/);
  // 函数式更新，只去掉已入列的（不能用快照整份覆盖：会吞掉同时到达的 patch）
  assert.match(src, /setTiles\(\(ts\) => ts\.filter\(\(t\) => !done\.has\(t\.key\)\)\);/);
  assert.doesNotMatch(src, /setTiles\(rest\)/);
  assert.match(src, /ready\.reduce\(\(acc, t\) => addImage\(acc, itemFromAsset\(t\.asset!\)\), prev\)/);
  assert.equal((src.match(/addImage\(prev, itemFromAsset\(r\.asset\)\)/g) ?? []).length, 0);
});

// ───────── ⑥ UX #379 P3 ②：等 429 重试的不占 6 张名额 ─────────
test('inFlightCount：正在传 + 传完等入列的占名额；失败的（含等 429 重试）不占', () => {
  const five = [1, 2, 3, 4, 5];
  const tiles = [{ state: 'error' }]; // 等 429 重试（保留了文件）
  assert.equal(inFlightCount(tiles), 0);
  assert.equal(slotsLeft(five, inFlightCount(tiles)), 1); // 5 张 + 1 个等重试：还能加 1 张，不是「已达上限」
  assert.equal(inFlightCount([{ state: 'uploading' }, { state: 'done' }, { state: 'error' }]), 2);
  assert.equal(slotsLeft(five, inFlightCount([{ state: 'uploading' }])), 0);
  assert.equal(IMAGES_TEXT.retryFull, '已有 6 张，移除一张后才能重试');
});

test('AboutImages 接线：「已达上限」只看列表张数；上传区按占名额的上传隐藏；没名额时禁用重试', () => {
  const src = read('../src/components/admin/settings/AboutImages.tsx');
  assert.match(src, /const left = slotsLeft\(items, inFlightCount\(tiles\)\);/);
  assert.match(src, /const full = items\.length >= IMAGES_MAX;/);
  assert.match(src, /\{full && <p className="st-hint st-im-full">\{T\.full\}<\/p>\}/);
  assert.match(src, /<span className="st-count">\{items\.length\} \/ \{IMAGES_MAX\}<\/span>/);
  assert.match(src, /disabled=\{\(!!t\.retryAt && t\.retryAt > now\) \|\| left === 0\}/);
  assert.doesNotMatch(src, /t\.state === 'uploading' \|\| t\.file/);
});

// ───────── ⑦ UX #379 P3 ③：保存栏第二行「n 张图片缺少替代文字」 ─────────
test('missingAltImages：按图去重、只算有内容（必填）的语言；文案', () => {
  const ID = (n: number) => `asset${String(n).padStart(19, '0')}`;
  const ids = [ID(1), ID(2), ID(3)];
  const full = { ...emptyDraft(), title: 'About us', bodyHtml: `<p>${'x'.repeat(60)}</p>` };
  const drafts = {
    en: { ...full, imageMeta: { [ID(1)]: { alt: 'a', caption: '' } } }, // 缺 2、3
    ru: { ...full, imageMeta: { [ID(1)]: { alt: 'a', caption: '' }, [ID(2)]: { alt: 'b', caption: '' } } }, // 缺 3
    de: emptyDraft(), // 没内容：不要求
  };
  assert.equal(missingAltImages(drafts, ['en', 'ru', 'de'], ids), 2);
  assert.equal(missingAltImages(drafts, ['ru'], ids), 1);
  assert.equal(missingAltImages(drafts, ['de'], ids), 0);
  assert.equal(missingAltImages(drafts, ['en'], []), 0);
  assert.equal(IMAGES_TEXT.barMissing(2), '2 张图片缺少替代文字');
});

test('保存栏接线：缺替代文字时第二行先写原因，「保存」按钮 aria-describedby 指向它；冲突时仍显示冲突说明', () => {
  const ui = read('../src/components/admin/settings/AboutSettings.tsx');
  assert.match(ui, /const missingAlt = missingAltImages\(draft, locales, imgDraft\.map\(\(i\) => i\.id\)\);/);
  assert.match(ui, /<small>\{missingAlt > 0 && <span id="st-bar-why" className="st-bar-why">\{IMAGES_TEXT\.barMissing\(missingAlt\)\}<\/span>\}（\{summary\}）<\/small>/);
  assert.match(ui, /conflict !== 'none' \? <small>\{T\.conflictBar\}<\/small>/);
  assert.match(ui, /aria-describedby=\{conflict === 'none' && missingAlt > 0 \? 'st-bar-why' : undefined\}/);
});
