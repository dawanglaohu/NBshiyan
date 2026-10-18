import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminTime, fmtDate } from '../src/components/admin/format';

// #291 UX：后台统一时间规则。固定时钟 + 显式时区，结果不受跑测试机器的时区影响

const NOW = Date.parse('2026-10-17T07:46:00Z'); // 2026-10-17 00:46 PT
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000, H = 60 * MIN;

test('<24h: relative, floored (59s → 刚刚, 1m, 59m, 1h, 23h59 → 23 小时前)', () => {
  const o = { now: NOW, timeZone: 'UTC' };
  assert.equal(adminTime(at(59_000), o), '刚刚');
  assert.equal(adminTime(at(MIN), o), '1 分钟前');
  assert.equal(adminTime(at(59 * MIN), o), '59 分钟前');
  assert.equal(adminTime(at(H), o), '1 小时前');
  assert.equal(adminTime(at(16 * H + 30 * MIN), o), '16 小时前');
  assert.equal(adminTime(at(23 * H + 59 * MIN), o), '23 小时前');
});

test('exactly 24h and older in the same year: MM/DD HH:mm (no 昨天 / N 天前)', () => {
  assert.equal(adminTime(at(24 * H), { now: NOW, timeZone: 'UTC' }), '10/16 07:46');
  assert.equal(adminTime(at(24 * H), { now: NOW, timeZone: 'America/Los_Angeles' }), '10/16 00:46');
  assert.equal(adminTime('2026-01-01T00:00:00Z', { now: NOW, timeZone: 'UTC' }), '01/01 00:00');
});

test('different year: full YYYY/MM/DD HH:mm (e.g. 767 days ago)', () => {
  assert.equal(adminTime(at(767 * 24 * H), { now: NOW, timeZone: 'UTC' }), '2024/09/10 07:46');
  assert.equal(adminTime('2025-12-31T23:59:00Z', { now: NOW, timeZone: 'UTC' }), '2025/12/31 23:59');
});

test('year boundary is decided in the display time zone', () => {
  const now = Date.parse('2027-01-02T00:00:00Z');
  const iso = '2026-12-31T23:30:00Z'; // UTC 仍是 2026 年；上海已是 2027-01-01 07:30
  assert.equal(adminTime(iso, { now, timeZone: 'UTC' }), '2026/12/31 23:30');
  assert.equal(adminTime(iso, { now, timeZone: 'Asia/Shanghai' }), '01/01 07:30');
  // 跨年但不到 24 小时：仍是相对时间
  assert.equal(adminTime('2026-12-31T23:30:00Z', { now: Date.parse('2027-01-01T00:30:00Z'), timeZone: 'UTC' }), '1 小时前');
});

test('future beyond 1 min clock skew → full format; small skew → 刚刚; invalid → as-is', () => {
  assert.equal(adminTime(new Date(NOW + 30_000).toISOString(), { now: NOW, timeZone: 'UTC' }), '刚刚');
  assert.equal(adminTime(new Date(NOW + 2 * H).toISOString(), { now: NOW, timeZone: 'UTC' }), '2026/10/17 09:46');
  assert.equal(adminTime('nope', { now: NOW }), 'nope');
});

test('title / anonymized banner keep the full format', () => {
  assert.equal(fmtDate(at(767 * 24 * H), 'UTC'), '2024/09/10 07:46');
});

test('AdminTime renders <time dateTime={iso} title={fmtDate(iso)}>; admin screens use it instead of ad-hoc formats', () => {
  const comp = readFileSync(new URL('../src/components/admin/AdminTime.tsx', import.meta.url), 'utf8');
  assert.match(comp, /<time dateTime=\{iso\} title=\{fmtDate\(iso\)\}[^>]*>\{adminTime\(iso\)\}<\/time>/);
  const files = ['InquiryList.tsx', 'InquiryDetail.tsx', 'users/UsersAdmin.tsx', 'specs/SpecEditor.tsx', 'mail/MailThread.tsx', 'mail/UnassignedInbox.tsx'];
  for (const f of files) {
    const src = readFileSync(new URL(`../src/components/admin/${f}`, import.meta.url), 'utf8');
    assert.match(src, /<AdminTime iso=/, f);
    assert.doesNotMatch(src, /toLocale(Date|Time)?String\('zh-CN'|relTime\(/, f);
  }
  const fmt = readFileSync(new URL('../src/components/admin/format.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(fmt, /昨天|天前/);
});

test('detail empty states and disabled drawer items', () => {
  const d = readFileSync(new URL('../src/components/admin/InquiryDetail.tsx', import.meta.url), 'utf8');
  assert.match(d, /const EMPTY_TEXT = '暂无记录'/);
  // #331：操作历史改成单独组件（接 /history），空列表同样显示灰色「暂无记录」
  assert.match(d, /<InquiryHistory inquiryId=\{inq\.id\} refreshKey=\{historyKey\} \/>/);
  assert.match(readFileSync(new URL('../src/components/admin/InquiryHistory.tsx', import.meta.url), 'utf8'), /<p className="adm-empty-note" data-testid="empty-note">\{HISTORY_TEXT\.empty\}<\/p>/);
  assert.match(d, /\{!inq\.message && \(threadMode \|\| inq\.messages\.length === 0\) && <EmptyNote \/>\}/);
  assert.match(d, /<div className="adm-reply-actions">/);
  assert.match(d, /\{anon && inq\.notes\.length === 0 && <EmptyNote \/>\}/);
  const shell = readFileSync(new URL('../src/components/admin/AdminShell.tsx', import.meta.url), 'utf8');
  // 待开发入口：没有 href（不可聚焦、不在抽屉焦点循环里），aria-disabled
  assert.match(shell, /<a key=\{n\.href\} className="soon" role="link" aria-disabled="true" title="待开发">/);
  const css = readFileSync(new URL('../src/app/admin/admin.css', import.meta.url), 'utf8');
  assert.match(css, /\.adm-side \.soon\{opacity:\.45;pointer-events:none\}/);
  assert.match(css, /\.adm select:disabled\{/);
  assert.match(css, /td:nth-child\(5\)\{grid-row:1;grid-column:2/);
  assert.match(css, /td:nth-child\(6\)\{grid-row:5;grid-column:1\}/);
  assert.match(css, /td:nth-child\(7\)\{grid-row:5;grid-column:2/);
});
