import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../src/app/globals.css');
const fab = read('../src/components/quote/FloatingActions.tsx');

const narrowPad = 'padding-bottom:calc(var(--fab-h, 0px) + 16px + env(safe-area-inset-bottom))';

test('footer clearance at ≤480px follows the measured FAB height and does not apply above that', () => {
  assert.match(css, /@media \(max-width:480px\)\{\.site-footer\{padding-bottom:calc\(var\(--fab-h, 0px\) \+ 16px \+ env\(safe-area-inset-bottom\)\)\}/);
  const wide = css.indexOf('.site-footer{margin-top:64px;padding:48px 0 24px;');
  const phone96 = css.indexOf('.site-footer{padding-bottom:96px}');
  const narrow = css.indexOf(narrowPad);
  assert.ok(wide > -1 && phone96 > wide && narrow > phone96, '窄屏底边距写在原 24px / 96px 规则之后，≤480 才能盖过 96px');
  assert.match(css, /@media \(max-width:480px\)\{[\s\S]*\.site-footer ul\.cats a\{display:block\}/);
  assert.doesNotMatch(css.slice(0, css.indexOf('@media (max-width:480px)')), /\.site-footer ul\.cats a\{display:block\}/);
});

test('collapsed FAB items keep their layout instead of display:none', () => {
  assert.match(css, /@media \(max-width:767px\)\{\.fab \.toggle\{display:flex;background:var\(--accent\);color:var\(--on-accent\)\}\.fab:not\(\.open\) \.item\{visibility:hidden;opacity:0;pointer-events:none\}/);
  assert.doesNotMatch(css, /\.fab:not\(\.open\) \.item\{[^}]*display:\s*none/);
});

test('FloatingActions writes the expanded height and clears it on unmount', () => {
  assert.match(fab, /new ResizeObserver\(write\)/);
  assert.match(fab, /setProperty\('--fab-h', `\$\{h\}px`\)/);
  assert.match(fab, /if \(h > 0\)/);
  assert.match(fab, /ro\.disconnect\(\); root\.style\.removeProperty\('--fab-h'\)/);
  assert.match(fab, /const menuHidden = narrow && !expanded/);
  assert.match(fab, /aria-hidden=\{menuHidden \|\| undefined\}/);
  assert.match(fab, /inert=\{menuHidden \|\| undefined\}/);
  assert.doesNotMatch(fab, /\{expanded &&/);
});
