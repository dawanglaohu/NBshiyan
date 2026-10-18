import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAboutSettingsApi } from '../src/lib/admin/site-settings-http';
import { bodyTooShortNote, draftChecklist, draftCompleteness, emptyDraft, mapAboutServerIssues, focusField, missingParts, revealAlert, saveFailureView, SETTINGS_TEXT, type AboutDraft } from '../src/lib/admin/site-settings';

// UX #373 视觉验收（issue #350 评论 6247346735）对 /admin/settings 的修正
const d = (o: Partial<AboutDraft>): AboutDraft => ({ ...emptyDraft(), ...o });
const long = `<p>${'a'.repeat(50)}</p>`;
const css = readFileSync('src/components/admin/settings/settings.css', 'utf8');
const about = readFileSync('src/components/admin/settings/AboutSettings.tsx', 'utf8');

test('P2-2 标签写清楚缺什么：缺标题 / 缺正文 / 缺标题、正文；完整、未填写不变', () => {
  assert.equal(draftCompleteness(d({ title: 'About', bodyHtml: '<p>short</p>' })).label, '缺正文');
  assert.equal(draftCompleteness(d({ title: '', bodyHtml: long })).label, '缺标题');
  assert.equal(draftCompleteness(d({ title: 'A', bodyHtml: '<p>x</p>' })).label, '缺标题、正文');
  assert.equal(draftCompleteness(d({ title: 'About', bodyHtml: long })).label, '完整');
  assert.equal(draftCompleteness(d({})).label, '未填写');
  assert.deepEqual(missingParts(d({ title: '😀😀', bodyHtml: `<p>${'😀'.repeat(50)}</p>` })), []); // code point
});

test('P2-2 右栏完整度清单：标题 / 正文（≥ 50 字）/ 数据条（选填）· n 条 / 首页区块标题 + 简介', () => {
  const c = draftChecklist(d({ title: 'About', bodyHtml: '<p>short</p>', stats: [{ value: 'v', label: 'l' }] }));
  assert.deepEqual(c.map((x) => [x.label, x.state]), [['标题', 'ok'], ['正文（≥ 50 字）', 'missing'], ['数据条（选填）· 1 条', 'optional'], ['首页区块标题 + 简介', 'optional']]);
  assert.equal(draftChecklist(d({ homeHeading: 'H', homeIntro: 'I' }))[3].state, 'ok');
  assert.match(about, /T\.checklist\(tab\)/);
});

test('P2-2 正文 1–49 字：字段下方说明前台不会显示（不阻止保存）；0 字和 ≥50 字不提示', () => {
  assert.equal(bodyTooShortNote(d({ bodyHtml: '<p>short</p>' })), SETTINGS_TEXT.bodyShort(50));
  assert.equal(bodyTooShortNote(d({ bodyHtml: '' })), null);
  assert.equal(bodyTooShortNote(d({ bodyHtml: long })), null);
});

test('前台链接（UX 定稿）：「查看前台已发布页 ↗」只在当前语言前台可见时出现（target=_blank rel=noopener，无 title）；否则灰字「尚未发布，前台不可见」', () => {
  assert.equal(SETTINGS_TEXT.preview, '查看前台已发布页 ↗');
  assert.equal(SETTINGS_TEXT.unpublished, '尚未发布，前台不可见');
  assert.match(about, /\{shownLocales\.includes\(tab\)\s*\? <a className="adm-btn st-preview" href=\{`\/\$\{tab\}\/about`\} target="_blank" rel="noopener">\{T\.preview\}<\/a>\s*: <span className="st-unpub">\{T\.unpublished\}<\/span>\}/);
  assert.doesNotMatch(about, /previewNote|在新窗口预览/);
  assert.match(css, /\.st-unpub\{font-size:13px;color:var\(--ink-2\)/);
});

test('P3-1 编辑器链接颜色用 --accent-text', () => {
  assert.match(css, /\.st-rich a\{color:var\(--accent-text\)\}/);
});

test('P3-2 冲突期间保存栏：状态文字两行（冲突文案在第二行），保存灰色禁用，放弃修改也禁用（about 和组织信息都一样）', () => {
  assert.equal(SETTINGS_TEXT.conflictBar, '内容冲突，请在上方提示条中刷新');
  for (const f of ['AboutSettings.tsx', 'OrgSettings.tsx']) {
    const src = readFileSync(`src/components/admin/settings/${f}`, 'utf8');
    assert.match(src, /className="st-bar-msg"/, f);
    assert.match(src, /conflict !== 'none' \? <small>\{T\.conflictBar\}<\/small>/, f);
    assert.doesNotMatch(src, /<small> · \{T\.conflictBar\}/, f);
    assert.match(src, /disabled=\{busy \|\| conflict !== 'none'\} onClick=\{discard\}/, f);
    assert.match(src, /title=\{conflict !== 'none' \? T\.conflictSaveTitle : undefined\}/, f);
  }
  assert.match(css, /\.st-bar \.adm-btn\.primary:disabled\{background:var\(--line\);border-color:var\(--line\);color:var\(--ink-2\);opacity:1/);
  assert.match(css, /\.st-bar-msg\{flex:1;min-width:0/);
  assert.match(css, /-webkit-line-clamp:2/);
  assert.match(css, /\.st-bar \.adm-btn\{white-space:nowrap;flex-shrink:0;min-height:44px\}/);
});

test('P3-3 工具栏：平的按钮（没有 adm-btn 边框方块），四组之间有分隔线，加粗 / 斜体有 aria-pressed', () => {
  assert.doesNotMatch(about, /className="adm-btn sq" aria-label=\{name\}/);
  assert.match(about, /className="st-tb-btn"/);
  assert.match(about, /<span className="sep" aria-hidden="true" \/>/);
  assert.match(css, /\.st-tb-btn\{font:inherit;font-size:13px;min-width:34px;height:32px;border:1px solid transparent;border-radius:6px;background:none/);
  assert.match(css, /\.st-tools\{display:flex;gap:2px;flex-wrap:wrap;padding:4px;border-bottom:1px solid var\(--line\);background:#FCFAF6/);
});

test('P2-3 390 下点击区域 ≥ 44px：按钮、输入框、下拉、标签页、分区链接、工具栏、开关', () => {
  const mobile = css.slice(css.indexOf('@media (max-width:767px)'));
  for (const rule of ['.st-page .adm-btn{min-height:44px}', '.st-page .adm-btn.sq{min-width:44px}', '.st-f input,.st-f select,.st-link input{min-height:44px}', '.st-tb-btn{min-width:44px;height:44px}', '.st-tabs [role=tab]{min-height:44px}', '.st-sections a{min-height:44px']) {
    assert.ok(mobile.includes(rule), rule);
  }
  assert.match(css, /\.st-switch\{width:52px;height:44px;/);
});

test('关于页 400 / 422：能对上字段的进字段下方，对不上的进顶部错误条（复用 saveFailureView）', async () => {
  const bodies = [
    { status: 400, body: { error: 'invalid', issues: [{ path: 'home.title', message: 'max 60 chars' }] } },
    { status: 400, body: { error: 'invalid', issues: [{ path: 'capacity', message: 'Unrecognized key' }] } },
    { status: 422, body: {} },
  ];
  let n = 0;
  const api = createAboutSettingsApi(async () => { const r = bodies[n++]; return new Response(JSON.stringify(r.body), { status: r.status }); });
  const base = { enabled: false, enabledVersion: 0, locales: { en: emptyDraft() } };
  const r1 = await api.save({ en: d({ title: 'About' }) }, base);
  assert.ok(!r1.ok);
  assert.deepEqual(r1.ok ? null : r1.fieldErrors, { homeHeading: '超出上限（最多 60 字）' });
  assert.equal(saveFailureView(r1 as Extract<typeof r1, { ok: false }>).alert, null);
  const r2 = await api.save({ en: d({ title: 'About' }) }, base);
  assert.ok(!r2.ok);
  const v2 = saveFailureView(r2 as Extract<typeof r2, { ok: false }>);
  assert.deepEqual(v2.fieldErrors, {});
  assert.equal(v2.alert, '参数不正确，请检查后重试。（包含不支持的字段）'); // UX #378 P3 ①：不显示后端字段路径
  const r3 = await api.save({ en: d({ title: 'About' }) }, base);
  assert.ok(!r3.ok);
  assert.equal(saveFailureView(r3 as Extract<typeof r3, { ok: false }>).alert, '保存失败：http_422');
  assert.match(about, /saveFailureView\(r\)/);
});

test('mapAboutServerIssues：title / bodyHtml / stats.N / home.* 对到 DraftField，其余进 rest', () => {
  const m = mapAboutServerIssues([
    { path: 'title', message: 'too_short' },
    { path: 'bodyHtml', message: 'too_long' },
    { path: 'stats.0', message: 'empty' },
    { path: 'home.title', message: 'max 60 chars' },
    { path: 'home.intro', message: 'max 200 chars' },
    { path: 'summary', message: 'max 160 chars' },
    { path: 'imageMeta.x.alt', message: 'max 120' },
    { path: 'enabled', message: 'required' },
    { path: '', message: 'boom' },
  ]);
  assert.deepEqual(m.fields, {
    title: '标题至少 2 个字',
    bodyHtml: '超出上限（最多 6000 字）', // UX #378 P3 ③：没传草稿时退回上限；传了草稿见 admin-p3-350.test.ts
    stats: '数值和说明都要填写',
    homeHeading: '超出上限（最多 60 字）',
    homeIntro: '超出上限（最多 200 字）',
    summary: '超出上限（最多 160 字）',
  });
  assert.deepEqual(m.rest, ['imageMeta.x.alt：max 120', 'enabled：required', 'boom']);
});

test('UX #375 P2：revealAlert 滚到 block:start，尊重 prefers-reduced-motion；about 和组织信息都挂了冲突横幅 / 错误条 ref', () => {
  assert.equal(typeof revealAlert, 'function');
  assert.equal(typeof focusField, 'function');
  assert.match(readFileSync('src/lib/admin/site-settings.ts', 'utf8'), /scrollIntoView\(\{ block: 'center'/);
  assert.match(readFileSync('src/lib/admin/site-settings.ts', 'utf8'), /scrollIntoView\(\{ block: 'start'/);
  assert.match(readFileSync('src/lib/admin/site-settings.ts', 'utf8'), /prefers-reduced-motion: reduce/);
  assert.match(readFileSync('src/lib/admin/site-settings.ts', 'utf8'), /focus\(\{ preventScroll: true \}\)/);
  for (const f of ['AboutSettings.tsx', 'OrgSettings.tsx']) {
    const src = readFileSync(`src/components/admin/settings/${f}`, 'utf8');
    assert.match(src, /conflictBannerRef/, f);
    assert.match(src, /errAlertRef/, f);
    assert.match(src, /revealAlert\(conflictBannerRef/, f);
    assert.match(src, /revealAlert\(errAlertRef/, f);
    assert.match(src, /focusField\(/, f); // 400/422 字段聚焦不用裸 focus()，390 下不停在保存栏后面
    assert.doesNotMatch(src, /st-bar[\s\S]*冲突刷新|保存栏[\s\S]*刷新/, f); // 保存栏不加「刷新」
  }
});
