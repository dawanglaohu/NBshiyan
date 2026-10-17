import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consentCloseSource, consentFocusTarget } from '../src/lib/a11y/focus';

// #307 P2：首访 横幅 → 设置 → 保存，焦点到 <main> 且不滚动；从页脚打开的面板关闭后仍回到页脚链接

test('banner choice and first-visit "banner → settings → save" both use the banner rule (<main>, no scroll)', () => {
  assert.equal(consentCloseSource('banner-choice', false), 'banner');
  assert.equal(consentCloseSource('dialog-save', true), 'banner');
});

test('closing a banner-opened panel (✕ / Esc / scrim) keeps the dialog rule: banner reappears, focus back on its Settings', () => {
  assert.equal(consentCloseSource('dialog-close', true), 'dialog');
});

test('panel opened from the footer link (or toast): save and close both restore to the opener', () => {
  assert.equal(consentCloseSource('dialog-save', false), 'dialog');
  assert.equal(consentCloseSource('dialog-close', false), 'dialog');
  const footer = { focus: () => {} };
  const r = consentFocusTarget(consentCloseSource('dialog-close', false), { opener: footer, main: () => null, bannerSettings: () => null, footerLink: () => footer });
  assert.equal(r.el, footer);
  assert.equal(r.preventScroll, false);
});

test('banner-opened save resolves to <main> with tabindex=-1 and preventScroll, never the footer link', () => {
  const attrs = new Map<string, string>();
  const main = { focus: () => {}, hasAttribute: (n: string) => attrs.has(n), setAttribute: (n: string, v: string) => void attrs.set(n, v) };
  const footer = { focus: () => {} };
  const r = consentFocusTarget(consentCloseSource('dialog-save', true), { opener: null, main: () => main, bannerSettings: () => null, footerLink: () => footer });
  assert.equal(r.el, main);
  assert.equal(r.preventScroll, true);
  assert.equal(attrs.get('tabindex'), '-1');
});

test('CookieConsent wiring: openSettings records whether the opener sits inside the banner; banner Settings passes itself as opener', () => {
  const src = readFileSync(new URL('../src/components/consent/CookieConsent.tsx', import.meta.url), 'utf8');
  assert.match(src, /openedFromBanner\.current = Boolean\(from\?\.closest\('\.consent'\)\)/);
  assert.match(src, /className="consent-set" onClick=\{\(e\) => openSettings\(e\.currentTarget\)\}/);
});
