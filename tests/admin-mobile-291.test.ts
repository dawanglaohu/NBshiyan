import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fmtDate } from '../src/components/admin/format';
import { anonymizedNotice } from '../src/components/admin/anonymized';
import { DRAWER_FOCUSABLE, DRAWER_MQ, drawerKeyAction } from '../src/lib/admin/drawer';

// #291：后台手机版（抽屉侧栏、列表卡片、详情单栏）+ 统一时间格式 YYYY/MM/DD HH:mm

test('fmtDate: YYYY/MM/DD HH:mm, zero-padded month/day, 24h, no seconds', () => {
  assert.equal(fmtDate('2026-09-14T16:44:40Z', 'Asia/Shanghai'), '2026/09/15 00:44');
  assert.equal(fmtDate('2026-01-05T03:07:59Z', 'UTC'), '2026/01/05 03:07');
  assert.equal(fmtDate('2026-12-31T23:59:00Z', 'UTC'), '2026/12/31 23:59');
  assert.equal(fmtDate('2026-10-17T07:00:00Z', 'America/Los_Angeles'), '2026/10/17 00:00'); // 午夜是 00 不是 24
  assert.match(fmtDate('2026-10-17T07:00:00Z'), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/); // 本地时区也同一格式
});

test('fmtDate: invalid input is returned as-is (never "Invalid Date")', () => {
  assert.equal(fmtDate('not-a-date'), 'not-a-date');
  assert.equal(fmtDate(''), '');
});

test('anonymized banner uses the unified format (issue example: 2026/09/15 00:44)', () => {
  assert.equal(anonymizedNotice('2026-09-14T16:44:40Z', (iso) => fmtDate(iso, 'Asia/Shanghai')), '此询盘已于 2026/09/15 00:44 按数据保留政策匿名化');
});

test('admin pages no longer format dates with toLocaleString(zh-CN, hour12:false) (2026/9/15 00:44:40)', () => {
  for (const f of ['../src/components/admin/format.ts', '../src/components/admin/specs/SpecEditor.tsx', '../src/components/admin/InquiryDetail.tsx', '../src/components/admin/users/UsersAdmin.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /toLocaleString\('zh-CN', \{ hour12: false \}\)/, f);
  }
});

test('drawer keys: Esc closes; Tab wraps last→first, Shift+Tab wraps first→last; focus outside → first', () => {
  assert.equal(drawerKeyAction({ key: 'Escape' }, 2, 5), 'close');
  assert.equal(drawerKeyAction({ key: 'Tab' }, 4, 5), 'wrap-first');
  assert.equal(drawerKeyAction({ key: 'Tab', shiftKey: true }, 0, 5), 'wrap-last');
  assert.equal(drawerKeyAction({ key: 'Tab' }, -1, 5), 'wrap-first');
  assert.equal(drawerKeyAction({ key: 'Tab' }, 1, 5), null);
  assert.equal(drawerKeyAction({ key: 'Tab', shiftKey: true }, 3, 5), null);
  assert.equal(drawerKeyAction({ key: 'Tab' }, -1, 0), null);
  assert.equal(drawerKeyAction({ key: 'a' }, 0, 5), null);
  assert.equal(DRAWER_MQ, '(max-width: 767px)');
  assert.match(DRAWER_FOCUSABLE, /:not\(\[aria-disabled="true"\]\)/);
});

test('AdminShell wiring: toggle has aria-expanded/aria-controls, nav id matches, inert when closed on mobile, Esc/scrim close and restore focus', () => {
  const src = readFileSync(new URL('../src/components/admin/AdminShell.tsx', import.meta.url), 'utf8');
  assert.match(src, /className="adm-menu" aria-expanded=\{open\} aria-controls="adm-nav"/);
  assert.match(src, /<nav ref=\{navRef\} id="adm-nav"[^>]*onKeyDown=\{onKey\} inert=\{hidden \|\| undefined\}>/);
  assert.match(src, /const hidden = mobile && !open/);
  assert.match(src, /toggleRef\.current\?\.focus\(\)/);
  assert.match(src, /className="adm-scrim" aria-hidden="true" onClick=\{\(\) => close\(\)\}/);
  assert.match(src, /querySelector<HTMLElement>\(DRAWER_FOCUSABLE\)\?\.focus\(\)/);
});

test('admin.css: 44px targets, drawer + stacked detail + card rows under 768px', () => {
  const css = readFileSync(new URL('../src/app/admin/admin.css', import.meta.url), 'utf8');
  const m = css.slice(css.indexOf('@media (max-width:767px){'));
  assert.match(m, /\.adm-menu,\.adm-nav-close\{[^}]*min-width:44px;min-height:44px/);
  assert.match(m, /\.adm-side a\{min-height:44px\}/);
  assert.match(m, /\.adm-g2,\.adm-detail\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(m, /\.adm-inq-table tr\.row\{display:grid/);
  assert.match(m, /\.adm\[data-nav=open\] \.adm-side\{transform:none;visibility:visible/);
});
