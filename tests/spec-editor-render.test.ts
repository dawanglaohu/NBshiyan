import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyForm, specSaveErrors, type SpecForm } from '../src/lib/admin/spec-form';
import { FORM_INVALID } from '../src/lib/admin/outage-copy';
import { SpecEditorView } from '../src/components/admin/specs/SpecEditorView';

const LEAK = 'postgres://spec-secret-should-not-render';

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

test('spec editor marks field errors in red and keeps the typed value', () => {
  const form = { ...emptyForm(), materialEn: 'Kraft paper' };
  const html = render(400, {
    error: 'invalid',
    message: LEAK,
    issues: [{ path: 'material.en', message: LEAK }],
  }, form);
  assert.match(html, /<span class="spec-err" role="alert">最多 300 个字符<\/span>/);
  assert.equal(html.includes('spec-msg err'), false);
  assert.equal(html.includes(FORM_INVALID.zh), false);
  assert.equal(html.includes(LEAK), false);
  assert.match(html, /value="Kraft paper"/);
  const css = readFileSync('src/components/admin/specs/specs.css', 'utf8');
  assert.match(css, /\.spec-err\{display:block;color:var\(--err,#B42318\)/);
  assert.match(css, /\.spec-msg\.err\{[^}]*color:var\(--err,#B42318\)/);
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
  assert.match(editor, /if \(s\.top\) commitAndReveal\(errRef,/);
});
