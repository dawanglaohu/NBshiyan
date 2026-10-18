import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextTrapFocus, FOCUSABLE_SELECTOR } from '../src/lib/admin/focus-trap';

// #350 部署后的前端 P3 小 PR（UX #378 / #379 遗留 + spec v1.0.10 + SEO）
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ───────── ① UX #379 P2：ConfirmDialog 焦点锁在框内 ─────────
test('焦点循环：Tab 在最后一个回到第一个，Shift+Tab 在第一个去最后一个；中间位置交给浏览器；焦点在框外时拉回', () => {
  const [a, b, c] = ['取消', '中间', '删除'];
  const items = [a, b, c];
  assert.equal(nextTrapFocus(items, c, false), a);
  assert.equal(nextTrapFocus(items, a, true), c);
  assert.equal(nextTrapFocus(items, a, false), null);
  assert.equal(nextTrapFocus(items, b, false), null);
  assert.equal(nextTrapFocus(items, b, true), null);
  assert.equal(nextTrapFocus(items, null, false), a);
  assert.equal(nextTrapFocus(items, null, true), c);
  assert.equal(nextTrapFocus(['只有一个'], '只有一个', false), '只有一个');
  assert.equal(nextTrapFocus(['只有一个'], '只有一个', true), '只有一个');
  assert.equal(nextTrapFocus([], null, false), null);
  assert.ok(FOCUSABLE_SELECTOR.includes('button:not([disabled])'));
});

test('ConfirmDialog：保留原有行为（alertdialog + 标题 / 正文关联、焦点在「取消」、Esc 关闭、焦点回到触发按钮），新增 Tab 循环和 focusin 拉回', () => {
  const dlg = read('../src/components/admin/settings/ConfirmDialog.tsx');
  assert.match(dlg, /role="alertdialog" aria-modal="true" aria-labelledby="st-dlg-h" aria-describedby="st-dlg-b"/);
  assert.match(dlg, /cancelRef\.current\?\.focus\(\)/);
  assert.match(dlg, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); cancelCb\.current\(\)/);
  assert.match(dlg, /prev\?\.focus\(\)/);
  assert.match(dlg, /nextTrapFocus\(focusablesIn\(dlg\), active, e\.shiftKey\)/);
  assert.match(dlg, /addEventListener\('focusin', fin\)/);
  assert.match(dlg, /removeEventListener\('focusin', fin\)/);
  // effect 只在挂载时跑一次（onCancel 走 ref）：调用方传内联函数时重渲染不会把焦点拉回「取消」
  assert.match(dlg, /prev\?\.focus\(\); \};\n  \}, \[\]\);/);
  // AboutImages 仍然传稳定的 closeConfirm
  assert.match(read('../src/components/admin/settings/AboutImages.tsx'), /const closeConfirm = useCallback\(\(\) => setConfirmId\(null\), \[\]\)/);
});
