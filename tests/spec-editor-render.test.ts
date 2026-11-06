import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyForm, specSaveErrors, type SpecForm } from '../src/lib/admin/spec-form';
import { FORM_INVALID } from '../src/lib/admin/outage-copy';
import { SpecEditorView } from '../src/components/admin/specs/SpecEditorView';
import { revealFirstSpecError } from '../src/components/admin/specs/reveal-spec-error';

const LEAK = 'postgres://spec-secret-should-not-render';

const TOKENS = readFileSync('src/styles/tokens.css', 'utf8');

/** 精确取 tokens.css 中 --pj-* 的真实声明值（--name: value;），不靠全文件任意命中。 */
function pjToken(name: string): string {
  const m = new RegExp('--' + name + '\\s*:\\s*([^;]+);').exec(TOKENS);
  if (!m) throw new Error('tokens.css 缺 --' + name);
  return m[1].trim();
}

/** 精确取某条 CSS 规则的声明块：按规则的选择器列表逐项精确匹配（支持逗号分组规则），
 *  只返回该规则自己的声明，不做全文件任意命中。 */
function cssRule(css: string, selector: string): string {
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/([^{}]+)\{([^{}]*)\}/g) || [];
  for (const block of blocks) {
    const i = block.indexOf('{');
    const sels = block.slice(0, i).split(',').map((s) => s.trim());
    if (sels.includes(selector)) return block.slice(i + 1, block.lastIndexOf('}')).trim();
  }
  throw new Error('specs.css 缺精确规则 ' + selector);
}

function render(status: number, json: unknown, form: SpecForm) {
  const s = specSaveErrors(status, json);
  const html = renderToStaticMarkup(React.createElement(SpecEditorView, {
    category: 'gift-boxes',
    title: 'Gift Boxes',
    form,
    errors: s.fields,
    msg: s.top ? { kind: 'err', text: s.top } : undefined,
    saving: false,
    updatedAt: null,
    errRef: { current: null },
    onSave: () => {},
    onChange: () => {},
    onDim: () => {},
    onCert: () => {},
  }));
  return html;
}

test('spec editor marks field errors with the flat accent and keeps the typed value', () => {
  const form = { ...emptyForm(), materialEn: 'Kraft paper' };
  const html = render(400, {
    error: 'invalid',
    message: LEAK,
    issues: [{ path: 'material.en', message: LEAK }],
  }, form);
  assert.match(html, /<span class="spec-err" role="alert" tabindex="-1">最多 300 个字符<\/span>/);
  assert.equal(html.includes('spec-msg err'), false);
  assert.equal(html.includes(FORM_INVALID.zh), false);
  assert.equal(html.includes(LEAK), false);
  assert.match(html, /value="Kraft paper"/);
  // 精确锚定 specs.css 的 .spec-err / .spec-msg.err 声明块与 tokens.css 真实 --pj-* 值，
  // 不再用被覆盖的旧色板字面量锁死 CSS，也不为旧断言补死 CSS。
  const css = readFileSync('src/components/admin/specs/specs.css', 'utf8');
  const accent = pjToken('pj-accent');            // #b45700
  const bodySize = pjToken('pj-ui-size');         // 14px
  const bodyLine = pjToken('pj-ui-line');         // 20px
  const errBlock = cssRule(css, '.spec .spec-err');
  assert.match(errBlock, new RegExp('display:block'));
  assert.match(errBlock, new RegExp('color:var\\(--pj-accent\\)'));
  assert.match(errBlock, new RegExp('font-size:var\\(--pj-ui-size\\)'));
  assert.match(errBlock, new RegExp('line-height:var\\(--pj-ui-line\\)'));
  assert.equal(accent, '#b45700');
  assert.equal(bodySize, '14px');
  assert.equal(bodyLine, '20px');
  // 精确取该规则（文件里选择器是 .spec .spec-msg.ok,.spec .spec-msg.err，逐项精确匹配 .err 那一条）
  const msgBlock = cssRule(css, '.spec .spec-msg.err');
  assert.match(msgBlock, new RegExp('color:var\\(--pj-fg\\)'));
  assert.match(msgBlock, new RegExp('border-color:var\\(--pj-accent\\)'));
});

test('spec editor top fallback is one alert and hides the server message', () => {
  const form = { ...emptyForm(), materialEn: 'Kraft paper' };
  const html = render(400, {
    error: 'invalid',
    message: LEAK,
    issues: [{ path: 'capacity', message: LEAK }],
  }, form);
  assert.match(html, /<div tabindex="-1" class="spec-msg err" role="alert">部分内容没有通过检查，请核对后再提交。<\/div>/);
  assert.equal(html.includes('spec-err'), false);
  assert.equal(html.includes(LEAK), false);
  assert.equal(html.includes('capacity'), false);
  assert.match(html, /value="Kraft paper"/);
  const editor = readFileSync('src/components/admin/specs/SpecEditor.tsx', 'utf8');
  assert.match(editor, /specSaveErrors\(r\.status, j\)/);
  assert.match(editor, /if \(s\.top\)/);
  assert.match(editor, /commitAndReveal\(errRef,/);
  assert.match(editor, /revealFirstSpecError\(formRef\.current\)/);
});

type MockEl = {
  kind: string;
  className: string;
  children: MockEl[];
  parentElement: MockEl | null;
  previousElementSibling: MockEl | null;
  matches: (sel: string) => boolean;
  querySelector: (sel: string) => MockEl | null;
  scrollIntoView: (opts?: { block?: string }) => void;
  focus: (opts?: { preventScroll?: boolean }) => void;
};

function mockEl(kind: string, children: MockEl[] = [], className = ''): MockEl {
  const el: MockEl = {
    kind,
    className,
    children,
    parentElement: null,
    previousElementSibling: null,
    matches(sel: string) {
      if (sel === '.spec-err') return className.split(/\s+/).includes('spec-err');
      if (sel === 'input, textarea, select') return kind === 'input' || kind === 'textarea' || kind === 'select';
      if (sel === 'form') return kind === 'form';
      return false;
    },
    querySelector(sel: string) {
      for (const child of children) {
        if (child.matches(sel)) return child;
        const nested = child.querySelector(sel);
        if (nested) return nested;
      }
      return null;
    },
    scrollIntoView(opts) { calls.push(['scroll', el, opts]); },
    focus(opts) { calls.push(['focus', el, opts]); },
  };
  children.forEach((child, i) => {
    child.parentElement = el;
    child.previousElementSibling = i > 0 ? children[i - 1] : null;
  });
  return el;
}

let calls: unknown[] = [];

test('mapped field errors scroll the first field into view and focus it', () => {
  const form = { ...emptyForm(), materialEn: 'Kraft paper' };
  const html = render(400, {
    error: 'invalid',
    message: LEAK,
    issues: [{ path: 'material.en', message: LEAK }],
  }, form);
  assert.match(html, /<span class="spec-err" role="alert" tabindex="-1">最多 300 个字符<\/span>/);
  assert.equal(html.includes('spec-msg err'), false);
  assert.equal(html.includes(FORM_INVALID.zh), false);
  calls = [];
  const input = mockEl('input');
  const table = mockEl('table', [input]);
  const err = mockEl('span', [], 'spec-err');
  const root = mockEl('form', [table, err], 'spec');
  revealFirstSpecError(root as unknown as ParentNode);
  assert.deepEqual(calls, [
    ['scroll', input, { block: 'center' }],
    ['focus', input, { preventScroll: true }],
  ]);
  calls = [];
  const alone = mockEl('span', [], 'spec-err');
  revealFirstSpecError(mockEl('form', [alone]) as unknown as ParentNode);
  assert.deepEqual(calls, [
    ['scroll', alone, { block: 'center' }],
    ['focus', alone, { preventScroll: true }],
  ]);
});
