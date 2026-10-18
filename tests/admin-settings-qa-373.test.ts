import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodyTooShortNote, draftChecklist, draftCompleteness, emptyDraft, missingParts, SETTINGS_TEXT, type AboutDraft } from '../src/lib/admin/site-settings';

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

test('P2-2「在新窗口预览 EN ↗」：target=_blank + rel=noopener，指向当前语言', () => {
  assert.match(about, /href=\{`\/\$\{tab\}\/about`\} target="_blank" rel="noopener"/);
  assert.equal(SETTINGS_TEXT.preview('en'), '在新窗口预览 EN ↗');
});

test('P3-1 编辑器链接颜色用 --accent-text', () => {
  assert.match(css, /\.st-rich a\{color:var\(--accent-text\)\}/);
});

test('P3-2 冲突期间保存栏：「有未保存的修改 · 内容冲突，刷新后才能保存」，保存灰色禁用，放弃修改也禁用（about 和组织信息都一样）', () => {
  assert.equal(SETTINGS_TEXT.conflictBar, '内容冲突，刷新后才能保存');
  for (const f of ['AboutSettings.tsx', 'OrgSettings.tsx']) {
    const src = readFileSync(`src/components/admin/settings/${f}`, 'utf8');
    assert.match(src, /conflict !== 'none' \? <small> · \{T\.conflictBar\}<\/small>/, f);
    assert.match(src, /disabled=\{busy \|\| conflict !== 'none'\} onClick=\{discard\}/, f);
    assert.match(src, /title=\{conflict !== 'none' \? T\.conflictSaveTitle : undefined\}/, f);
  }
  assert.match(css, /\.st-bar \.adm-btn\.primary:disabled\{background:var\(--line\);border-color:var\(--line\);color:var\(--ink-2\);opacity:1/);
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
