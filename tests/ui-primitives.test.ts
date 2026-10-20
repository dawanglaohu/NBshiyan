import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { Button, Input, Textarea, Select, Dialog, Status } from '../src/components/ui';
import { activateDialog } from '../src/components/ui/dialog-focus';

test('buttons keep native semantics, busy content, reasons and accessible names', () => {
  assert.equal(render(h(Button, null)), '');
  assert.equal(render(h(Button, null, '   ')), '');
  const idle = render(h(Button, { busyLabel: 'Submitting' }, 'Save'));
  const busy = render(h(Button, { busy: true, busyLabel: 'Submitting', type: 'submit' }, 'Save'));
  assert.match(idle, /type="button"/);
  assert.match(busy, /type="submit"/);
  assert.match(busy, /disabled=""/);
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /pj-control-content[^>]*>Save</);
  assert.match(idle, /Submitting/);
  assert.match(busy, /Submitting/);
  const disabled = render(h(Button, { disabled: true, disabledReason: 'Choose a file', 'aria-describedby': 'external' }, 'Upload'));
  assert.match(disabled, /Choose a file/);
  assert.match(disabled, /aria-describedby="external [^"]+"/);
  assert.match(render(h(Button, { 'aria-label': 'Close' }, '×')), /aria-label="Close"/);
});

test('buttons accept composed React labels without guessing their rendered contents', () => {
  const SaveText = () => h('span', null, 'Save changes');
  assert.match(render(h(Button, null, h(SaveText))), /Save changes/);
  assert.equal(render(h(Button, null, h('span', { 'aria-hidden': true }, '×'))), '');
});

test('fields retain labels for empty values and associate error, help and disabled reason', () => {
  const html = render(h(Input, { id: 'email', label: 'Email', defaultValue: '', error: 'Enter an email', description: 'Work address', 'aria-describedby': 'external' }));
  assert.match(html, /<label[^>]*for="email"[^>]*>Email<\/label>/);
  assert.match(html, /<input[^>]*id="email"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="external [^"]+"/);
  assert.match(html, /Enter an email/);
  assert.match(html, /Work address/);
  const locked = render(h(Input, { label: 'Name', disabled: true, disabledReason: 'Unavailable' }));
  assert.match(locked, /disabled=""/);
  assert.match(locked, /Unavailable/);
  assert.match(render(h(Input, { label: 'Reference', readOnly: true })), /readOnly=""/);
  assert.match(render(h(Textarea, { label: 'Message', rows: 1 })), /rows="3"/);
  assert.match(render(h(Select, { label: 'Language', defaultValue: '' }, h('option', { value: '' }, 'Choose'))), /<select/);
});

test('dialog has a named native shell and visible cancellable close control', () => {
  const html = render(h(Dialog, { open: true, title: 'Confirm change', description: 'Review the details', closeLabel: 'Cancel', onClose() {} }, h('p', null, 'Context')));
  assert.match(html, /<dialog/);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /type="button"[^>]*>Cancel<\/button>/);
  assert.match(html, /Context/);
});

test('status text uses polite announcements, explicit prefixes and opt-in error alerts', () => {
  for (const tone of ['neutral', 'loading', 'empty', 'warning', 'error', 'success'] as const) {
    const html = render(h(Status, { tone, prefix: 'Result', children: 'Details' }));
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /Result/);
    assert.match(html, /Details/);
    assert.doesNotMatch(html, /tabindex/i);
  }
  assert.match(render(h(Status, { tone: 'error', prefix: 'Error', urgent: true, children: 'Try again' })), /role="alert"/);
  assert.doesNotMatch(render(h(Status, { tone: 'success', prefix: 'Saved', urgent: true, children: 'Record saved' })), /role="alert"/);
});

// DOM doubles isolate lifecycle ordering; the browser integration belongs to M1-T4.
function dialogFixture() {
  const doc = new EventTarget() as EventTarget & { activeElement: unknown };
  doc.activeElement = null;
  const element = () => ({
    isConnected: true, tabIndex: 0, disabled: false,
    hasAttribute: () => false, closest: () => null, matches: () => false,
    getClientRects: () => [{}],
    focus() { doc.activeElement = this; },
  });
  const opener = element();
  const title = element();
  const first = element();
  const last = element();
  const dialog = Object.assign(new EventTarget(), {
    ownerDocument: doc, open: false, items: [first, last],
    showModal() { this.open = true; first.focus(); },
    close() { this.open = false; dialog.dispatchEvent(new Event('close')); },
    querySelectorAll() { return this.items; },
    contains(el: unknown) { return [title, ...this.items].includes(el as typeof first); },
  });
  opener.focus();
  let requests = 0;
  const activate = () => activateDialog(dialog as unknown as HTMLDialogElement, title as unknown as HTMLElement, () => { requests++; });
  const key = (key: string, shiftKey = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey });
    doc.dispatchEvent(event);
    return event;
  };
  return { doc, opener, title, first, last, dialog, activate, key, requests: () => requests };
}

test('dialog keyboard focus wraps both ways, Escape requests close, cleanup restores opener', () => {
  const f = dialogFixture();
  const release = f.activate();
  assert.equal(f.dialog.open, true);
  assert.equal(f.doc.activeElement, f.title);
  assert.equal(f.key('Tab').defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.first);
  f.first.focus();
  assert.equal(f.key('Tab').defaultPrevented, false);
  f.last.focus();
  f.key('Tab');
  assert.equal(f.doc.activeElement, f.first);
  f.key('Tab', true);
  assert.equal(f.doc.activeElement, f.last);
  assert.equal(f.key('Escape').defaultPrevented, true);
  assert.equal(f.requests(), 1);
  release();
  assert.equal(f.doc.activeElement, f.opener);
  assert.equal(f.dialog.open, false);
  f.key('Escape');
  assert.equal(f.requests(), 1);
  release();
  assert.equal(f.requests(), 1);
});

test('dialog handles no tab stops, native cancel/close, removed opener and repeated openings', () => {
  const f = dialogFixture();
  f.dialog.items = [];
  let release = f.activate();
  assert.equal(f.key('Tab').defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.title);
  const cancel = new Event('cancel', { cancelable: true });
  f.dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(f.requests(), 1);
  f.opener.isConnected = false;
  release();
  assert.notEqual(f.doc.activeElement, f.opener);
  f.opener.isConnected = true;
  f.opener.focus();
  release = f.activate();
  f.dialog.close();
  assert.equal(f.requests(), 2);
  release();
  assert.equal(f.doc.activeElement, f.opener);
});

test('a queued native close from the previous opening does not cancel the reopened dialog', () => {
  const f = dialogFixture();
  f.activate()();
  const release = f.activate();
  f.dialog.dispatchEvent(new Event('close'));
  assert.equal(f.dialog.open, true);
  assert.equal(f.requests(), 0);
  release();
});

test('complete tokens have one declaration and match the owning UI specification', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  const spec = readFileSync('docs/PackJoyU-开发文档/02-设计/11-UI.md', 'utf8');
  const block = spec.split('### Tokens（项目适配）')[1].split('```css')[1].split('```')[0];
  const expected = [...block.matchAll(/(--pj-[\w-]+):\s*([^;]+);/g)];
  assert.ok(expected.length > 60);
  for (const [, name, value] of expected) {
    const declarations = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
    assert.equal(declarations.length, 1, name);
    assert.equal(declarations[0][1].trim(), value.trim(), name);
  }
  for (const name of ['button', 'input', 'dialog', 'status']) assert.match(css, new RegExp(`\\.pj-${name}`));
  assert.match(css, /border-radius:\s*var\(--pj-radius\)/);
  assert.match(css, /outline-offset:\s*var\(--pj-focus-offset\)/);
  assert.match(css, /border:\s*var\(--pj-border-width\) dashed var\(--pj-border\)/);
  assert.match(css, /prefers-reduced-motion/);
  for (const path of ['src/app/globals.css', 'src/app/admin/admin.css']) assert.match(readFileSync(path, 'utf8'), /@import[^;]+styles\/tokens\.css/);
});

test('native disabled, busy, error and focus states consume the shared values', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  assert.match(css, /\.pj-button[^{}]*:disabled[^{}]*\{[^{}]*background:\s*var\(--pj-disabled-bg\);[^{}]*color:\s*var\(--pj-disabled-fg\);[^{}]*opacity:\s*var\(--pj-opacity\)/);
  assert.match(css, /\.pj-input[^{}]*\[aria-invalid="true"\][^{}]*\{[^{}]*border:\s*var\(--pj-border-width\) solid var\(--pj-accent\)/);
  assert.match(css, /\.pj-button[^{}]*:focus-visible[^{}]*\{[^{}]*outline:\s*var\(--pj-focus-width\) solid var\(--pj-accent\)/);
  assert.match(css, /\[data-pj-inverse\][^{}]*:focus-visible[^{}]*\{[^{}]*outline-color:\s*var\(--pj-on-inverse\)/);
  assert.match(css, /\[data-busy="true"\][^{}]*\.pj-busy-label\s*\{visibility:visible\}/);
  assert.match(css, /\.pj-busy-label\s*\{visibility:hidden\}/);
  assert.match(css, /\.pj-status[^{}]*\[data-tone="error"\][^{}]*\{[^{}]*color:\s*var\(--pj-accent\)/);
  assert.match(css, /max-width:\s*var\(--pj-auth-card-width\)/);
});

test('public primitive modules have no request, persistence or business authority imports', () => {
  for (const file of readdirSync('src/components/ui').filter((name) => /\.[jt]sx?$/.test(name))) {
    const source = readFileSync(`src/components/ui/${file}`, 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|@prisma|next-auth|next\/headers|document\.cookie|localStorage|sessionStorage|process\.env/);
  }
});
