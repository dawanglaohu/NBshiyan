import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consentFocusTarget, prefersReducedMotion, revealAndFocus, scrollBehaviorFor } from '../src/lib/a11y/focus';

// #307：cookie 横幅关闭后焦点不跳页脚；询盘成功卡片滚进可视区并获得焦点

const el = (name: string) => ({ name, focus: () => {} });
const mainEl = (tabindex?: string) => {
  const attrs = new Map<string, string>(tabindex === undefined ? [] : [['tabindex', tabindex]]);
  return { name: 'main', attrs, focus: () => {}, hasAttribute: (n: string) => attrs.has(n), setAttribute: (n: string, v: string) => void attrs.set(n, v) };
};

test('banner accept/reject: focus goes to <main> with preventScroll, never the footer link', () => {
  const main = mainEl();
  const footer = el('footer');
  const r = consentFocusTarget('banner', { opener: el('opener'), main: () => main, bannerSettings: () => el('banner-set'), footerLink: () => footer });
  assert.equal(r.el, main);
  assert.equal(r.preventScroll, true);
  assert.equal(main.attrs.get('tabindex'), '-1');
});

test('banner: keeps an existing tabindex on <main>; no <main> → focus does not move', () => {
  const main = mainEl('0');
  consentFocusTarget('banner', { opener: null, main: () => main, bannerSettings: () => null, footerLink: () => el('footer') });
  assert.equal(main.attrs.get('tabindex'), '0');
  const r = consentFocusTarget('banner', { opener: null, main: () => null, bannerSettings: () => null, footerLink: () => el('footer') });
  assert.equal(r.el, null);
  assert.equal(r.preventScroll, true);
});

test('settings dialog: original restore order is kept (opener → banner “settings” → footer link)', () => {
  const opener = el('opener'), set = el('banner-set'), footer = el('footer');
  const q = (o: typeof opener | null, s: typeof set | null) => ({ opener: o, main: () => mainEl(), bannerSettings: () => s, footerLink: () => footer });
  assert.equal(consentFocusTarget('dialog', q(opener, set)).el, opener);
  assert.equal(consentFocusTarget('dialog', q(null, set)).el, set);
  assert.equal(consentFocusTarget('dialog', q(null, null)).el, footer);
  assert.equal(consentFocusTarget('dialog', q(opener, set)).preventScroll, false);
});

test('revealAndFocus: focuses with preventScroll then scrolls to block start; reduced motion → auto', () => {
  const calls: unknown[] = [];
  const card = { focus: (o?: FocusOptions) => calls.push(['focus', o]), scrollIntoView: (o?: ScrollIntoViewOptions) => calls.push(['scroll', o]) };
  revealAndFocus(card, false);
  assert.deepEqual(calls, [['focus', { preventScroll: true }], ['scroll', { block: 'start', behavior: 'smooth' }]]);
  calls.length = 0;
  revealAndFocus(card, true);
  assert.deepEqual(calls[1], ['scroll', { block: 'start', behavior: 'auto' }]);
  assert.doesNotThrow(() => revealAndFocus(null, false));
  assert.equal(scrollBehaviorFor(true), 'auto');
  assert.equal(scrollBehaviorFor(false), 'smooth');
});

test('prefersReducedMotion reads the media query and tolerates missing/throwing matchMedia', () => {
  assert.equal(prefersReducedMotion({ matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({}), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error('x'); } }), false);
});

test('CookieConsent wiring: banner buttons restore as "banner", dialog paths as "dialog", focus honours preventScroll', () => {
  const src = readFileSync(new URL('../src/components/consent/CookieConsent.tsx', import.meta.url), 'utf8');
  assert.match(src, /restoreFocus\(fromDialog \? 'dialog' : 'banner'\)/);
  assert.match(src, /const close = \(\) => \{ setOpen\(false\); restoreFocus\('dialog'\); \}/);
  assert.match(src, /el\?\.focus\(preventScroll \? \{ preventScroll: true \} : undefined\)/);
  // 横幅按钮走 save(..., false)，设置面板走 save(c, true)
  assert.match(src, /onClick=\{\(\) => save\(\{ analytics: false, chat: false \}, false\)\}/);
  assert.match(src, /onClick=\{\(\) => save\(\{ analytics: true, chat: true \}, false\)\}/);
  assert.match(src, /onSave=\{\(c\) => save\(c, true\)\}/);
});

test('InquiryWizard success card: tabIndex=-1, labelled by its heading, revealed + focused after success', () => {
  const src = readFileSync(new URL('../src/components/inquiry/InquiryWizard.tsx', import.meta.url), 'utf8');
  assert.match(src, /<div ref=\{doneRef\} className="wizard wizard-done" role="status" tabIndex=\{-1\} aria-labelledby="iq-done-title">/);
  assert.match(src, /<h2 id="iq-done-title"/);
  assert.match(src, /if \(succeeded\) revealAndFocus\(doneRef\.current, prefersReducedMotion\(window\)\)/);
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.wizard-done\{scroll-margin-top:calc\(var\(--header-h\) \+ 16px\)\}/);
  assert.match(css, /main\[tabindex="-1"\]:focus\{outline:none\}/);
});
