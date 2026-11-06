import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyForm, newCertRow } from '../src/lib/admin/spec-form';
import { SpecEditorView } from '../src/components/admin/specs/SpecEditorView';

const css = readFileSync('src/components/admin/specs/specs.css', 'utf8');
const view = readFileSync('src/components/admin/specs/SpecEditorView.tsx', 'utf8');
const editor = readFileSync('src/components/admin/specs/SpecEditor.tsx', 'utf8');
const page = readFileSync('src/app/admin/specs/page.tsx', 'utf8');

test('specs.css 全部选择器限定 .spec / .spec-list 命名域，无全局 .adm-* 覆盖', () => {
  // 逐条规则抽取选择器（去掉注释、@media 行内的选择器单独由后面 media 测试覆盖）
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = noComments.match(/([^{}]+)\{[^{}]*\}/g) || [];
  for (const block of blocks) {
    const selector = block.slice(0, block.indexOf('{')).trim();
    if (!selector || selector.startsWith('@')) continue;
    for (const part of selector.split(',')) {
      const s = part.trim();
      assert.ok(
        /^\.spec\b|^\.spec-list\b|^ul\.spec-list\b|^\.spec\s/.test(s) || /^\.spec/.test(s),
        `越界选择器（未限定 .spec/.spec-list 域）：${s}`,
      );
    }
  }
  // 明确不写全局 adm-card / adm-btn / td 覆盖
  assert.doesNotMatch(css, /^\.adm-(card|btn)\s*\{/m);
  assert.doesNotMatch(css, /^td\s*\{/m);
  assert.doesNotMatch(css, /(^|,)\s*td\s*\{/m);
});

test('specs.css 消费唯一 --pj-* token：2px 黑边 / 0 圆角 / 无阴影 / #b45700 焦点', () => {
  assert.match(css, /border:var\(--pj-border-width\) solid var\(--pj-border\)/);
  assert.match(css, /border-radius:var\(--pj-radius\)/);
  assert.match(css, /box-shadow:var\(--pj-shadow\)/);
  assert.match(css, /outline:var\(--pj-focus-width\) solid var\(--pj-accent\)/);
  assert.match(css, /outline-offset:var\(--pj-focus-offset\)/);
  // 旧色板 / 旧圆角变量不得作为生效规则出现（不留测试诱导的死 CSS）
  assert.doesNotMatch(css, /var\(--r-sm\)|var\(--r-md\)|var\(--r-pill\)/);
  assert.doesNotMatch(css, /var\(--line\)|var\(--surface\)|var\(--ink\)/);
  assert.doesNotMatch(css, /background:var\(--okb|background:var\(--errb/);
  assert.doesNotMatch(css, /var\(--err,#B42318\)/);
});

test('桌面 36px / 正文 16px / 表格 14px，触控条件才 44px（不把屏宽当唯一触控）', () => {
  assert.match(css, /min-height:var\(--pj-admin-control-height\)/); // 36px
  assert.match(css, /font-size:var\(--pj-body-size\)/);               // 16px
  assert.match(css, /font-size:var\(--pj-ui-size\)/);                 // 14px
  assert.match(css, /line-height:var\(--pj-ui-line\)/);               // 20px
  assert.match(css, /@media \(pointer:coarse\),\(max-width:767px\)/);
  // 44px 只在 media 块内出现
  const mediaIdx = css.indexOf('@media (pointer:coarse)');
  const before = css.slice(0, mediaIdx);
  const after = css.slice(mediaIdx);
  assert.doesNotMatch(before, /min-height:var\(--pj-touch-target\)/);
  assert.match(after, /min-height:var\(--pj-touch-target\)/);
  // textarea 不套单行 36px，单独 3 行 min-height
  assert.match(css, /\.spec \.spec-sec textarea\{[\s\S]*?min-height:calc\(var\(--pj-body-line\) \* 3/);
});

test('View 保留 8 字段 / DOM 数量 / 回调与可访问名，不删字段或动作', () => {
  // 静态字面量可访问名
  for (const l of ['material en', 'material ru', 'notes en', 'notes ru', 'moq value', 'lead time min', 'lead time max']) {
    assert.ok(view.includes(`aria-label="${l}"`), `缺可访问名 ${l}`);
  }
  // 单位 select 的可访问名由 UnitSelect 的 label prop 传入（aria-label={label}）
  assert.match(view, /<select aria-label=\{label\}/);
  for (const l of ['size unit', 'moq unit', 'lead time unit']) {
    assert.ok(view.includes(`label="${l}"`), `缺单位 select ${l}`);
  }
  // 六尺寸 input 由模板字符串生成
  assert.match(view, /aria-label=\{`size \$\{key\} \$\{d\}`\}/);
  assert.match(view, /role="radiogroup" aria-label="sample fee"/);
  assert.match(view, /className="adm-card spec-sec"/);
  assert.match(view, /type="submit" className="adm-btn primary"/);
  assert.match(view, /\+ 添加认证/);
  assert.match(view, /role=\{msg\.kind === 'err' \? 'alert' : 'status'\}/);
  assert.match(view, /onSubmit=\{onSave\}/);
  assert.match(view, /onChange=\{\(e\) => onChange\(/);
  assert.match(editor, /<SpecEditorView/);
  assert.match(editor, /onSave=\{save\} onChange=\{set\} onDim=\{setDim\} onCert=\{setCert\}/);
  // PUT / GET 业务链不动
  assert.match(editor, /method: 'PUT'/);
  assert.match(editor, /cache: 'no-store'/);
  assert.match(editor, /toBody\(f\)/);
});

test('列表页 SSR categoryMeta 每 key 恰一个链接，不改业务', () => {
  assert.match(page, /categoryMeta\.map/);
  assert.match(page, /href=\{`\/admin\/specs\/\$\{c\.key\}`\}/);
  assert.match(page, /enforceAdminPage\(SPEC_PAGE_ROLES/);
  assert.match(page, /specs\.css/);
});

test('渲染快照：表单字段数量与 M3-T24 迁移前一致（DOM 数量不删减）', () => {
  const html = renderToStaticMarkup(React.createElement(SpecEditorView, {
    category: 'corrugated-boxes', title: 'Corrugated Boxes', form: emptyForm(), errors: {}, saving: false, updatedAt: null,
    errRef: { current: null }, onSave: () => {}, onChange: () => {}, onDim: () => {}, onCert: () => {},
  }));
  const inputs = html.match(/<input\b/g) || [];
  const textareas = html.match(/<textarea\b/g) || [];
  const selects = html.match(/<select\b/g) || [];
  const buttons = html.match(/<button\b/g) || [];
  // 迁移前基线（emptyForm，feeMode='none'、certifications=[]）的 25 个 input 构成：
  // 2 material + 6 六尺寸 + 1 MOQ + 2 交期 + 3 样品费 radio + 11 Incoterms checkbox = 25。
  // notes en/ru 是两个 textarea（不计入 input）；paid 分支的 sample fee amount / currency
  // 在 none 态不渲染（不是「4 双语减 2 条件」）。
  assert.equal(inputs.length, 25, '迁移前后 input DOM 数量必须相等');
  assert.equal(textareas.length, 2, 'notes en/ru 两个 textarea');
  assert.equal(selects.length, 3, 'size/moq/lead 三个单位 select（无 paid currency）');
  assert.equal(buttons.length, 2, '添加认证 + 保存（无删除按钮，因认证为空）');
  // 必要字段与动作的可访问名都在渲染结果里（不删字段）
  for (const l of ['material en', 'material ru', 'notes en', 'notes ru', 'moq value', 'lead time min', 'lead time max', 'size min l', 'size max h', 'size unit', 'moq unit', 'lead time unit']) {
    assert.ok(html.includes(l), `渲染结果缺 ${l}`);
  }
  assert.match(html, /class="spec"/);
  assert.match(html, /class="adm-card spec-sec"/);
  assert.match(html, /class="adm-btn primary"/);
});

test('渲染快照：paid 费用 + 认证非空分支的同数据 DOM 数量（不只 emptyForm）', () => {
  // 与迁移前基线相同 fixture 类型，但覆盖 feeMode='paid' 与 certifications 非空的条件分支：
  // paid 渲染 sample fee amount input + currency select，认证行渲染 3 input + 1 删除 button。
  const paid = { ...emptyForm(), feeMode: 'paid' as const, feeAmount: '12.50', feeCurrency: 'USD',
    certifications: [newCertRow({ name: 'FSC', certNo: 'FSC-123', url: 'https://example.test/fsc' })] };
  const html = renderToStaticMarkup(React.createElement(SpecEditorView, {
    category: 'gift-boxes', title: 'Gift Boxes', form: paid, errors: {}, saving: false, updatedAt: null,
    errRef: { current: null }, onSave: () => {}, onChange: () => {}, onDim: () => {}, onCert: () => {},
  }));
  const inputs = html.match(/<input\b/g) || [];
  const selects = html.match(/<select\b/g) || [];
  const buttons = html.match(/<button\b/g) || [];
  // 25 基线 + paid 的 sample fee amount(1) + 认证行 3 input(name/certNo/url) = 29
  assert.equal(inputs.length, 29, 'paid + 1 认证行 input 数 = 25 + 1 + 3');
  // 3 单位 select + paid 的 sample fee currency(1) = 4
  assert.equal(selects.length, 4, 'paid 分支多一个币种 select');
  // 添加认证 + 保存 + 认证行删除 = 3
  assert.equal(buttons.length, 3, '认证非空分支多一个删除按钮');
  for (const l of ['sample fee amount', 'sample fee currency', 'certification 1 name', 'certification 1 number', 'certification 1 url']) {
    assert.ok(html.includes(l), `paid / 认证非空分支缺 ${l}`);
  }
});
