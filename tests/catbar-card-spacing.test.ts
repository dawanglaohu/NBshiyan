import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const css = read('../src/app/globals.css');
const bar = read('../src/components/CategoryBar.tsx');

test('--catbar-h: CSS fallback derived from the bar\'s own padding/line-height/border (56.7px), not a hardcoded 57', () => {
  assert.match(css, /:root\{--catbar-h:calc\(10px \* 2 \+ 14px \* 1\.55 \+ 6px \* 2 \+ 1px \* 2 \+ 1px\)\}/);
  // 兜底值依赖的这些样式没被改掉
  assert.match(css, /\.catbar\{[^}]*padding:10px 0[;}]/);
  assert.match(css, /\.catbar a\{[^}]*padding:6px 14px;[^}]*border:1px solid var\(--line\);[^}]*font-size:14px/);
  assert.match(css, /\.catbar-wrap\{[^}]*border-bottom:1px solid var\(--line\)/);
  assert.match(css, /body\{[^}]*line-height:1\.55\}/);
  assert.doesNotMatch(css, /--catbar-h:57px/);
});

test('--catbar-h: CategoryBar measures the real height with ResizeObserver and cleans up on unmount', () => {
  assert.match(bar, /<div ref=\{wrapRef\} className=\{`catbar-wrap/);
  assert.match(bar, /root\.style\.setProperty\('--catbar-h', `\$\{wrap\.getBoundingClientRect\(\)\.height\}px`\)/);
  assert.match(bar, /new ResizeObserver\(upd\);\s*ro\.observe\(wrap\);/);
  assert.match(bar, /ro\.disconnect\(\); root\.style\.removeProperty\('--catbar-h'\);/);
});

test('.card scroll-margin-top: 16px below the category bar (desktop header + bar, mobile bar only)', () => {
  assert.match(css, /\.card\{scroll-margin-top:calc\(var\(--header-h\) \+ var\(--catbar-h\) \+ 16px\)\}/);
  assert.match(css, /@media \(max-width:767px\)\{header\.site\{position:static\}\.catbar-wrap\{top:0\}\.card\{scroll-margin-top:calc\(var\(--catbar-h\) \+ 16px\)\}\}/);
  assert.doesNotMatch(css, /var\(--header-h\) \+ 64px/);
});
