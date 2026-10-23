// #331：询盘详情「操作历史」接 GET /api/admin/inquiries/:id/history —— 参数、响应整理、状态机、文案、渲染、mock 分页、详情页接线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import * as H from '../src/lib/admin/history';
import { httpAdminApi } from '../src/lib/admin/http';
import { mockAdminApi } from '../src/lib/admin/mock';
import { HistoryView, HistoryRow } from '../src/components/admin/InquiryHistory';
import { fmtDate } from '../src/components/admin/format';

const lf = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const src = (p: string) => lf(readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));
const item = (n: number, o: Partial<H.HistoryItem> = {}): H.HistoryItem => ({ type: 'status', at: new Date(Date.UTC(2026, 9, 1, 0, 0) - n * 60_000).toISOString(), actor: { name: '王五', role: 'ADMIN' }, summary: `状态：新询盘 → 跟进中 #${n}`, cursor: `c${n}`, ...o });
const page = (from: number, n: number, total: number): H.HistoryPage => ({ items: Array.from({ length: n }, (_, i) => item(from + i)), total });

test('查询参数：默认 limit=10；limit 夹在 1..50；before 原样编码，空不带', () => {
  assert.equal(H.historyQuery(), 'limit=10');
  assert.equal(H.historyQuery({ limit: 999 }), 'limit=50');
  assert.equal(H.historyQuery({ limit: 0 }), 'limit=1');
  assert.equal(H.historyQuery({ before: 'MjAy+/=' }), 'limit=10&before=MjAy%2B%2F%3D');
  assert.equal(H.historyQuery({ before: '' }), 'limit=10');
});

test('响应整理：丢掉未知类型 / 缺字段的条目；actor 只留 name、role；total 不小于本页条数', () => {
  const p = H.historyPageFrom({ total: 1, items: [
    item(1), { ...item(2), type: 'note' }, { ...item(3), cursor: '' }, { ...item(4), summary: 5 }, null,
    { ...item(5), actor: { name: '赵六', role: 'SALES', id: 'u1', email: 'x@y' } }, { ...item(6), actor: undefined },
  ] });
  assert.deepEqual(p.items.map((i) => i.cursor), ['c1', 'c5', 'c6']);
  assert.deepEqual(p.items[1].actor, { name: '赵六', role: 'SALES' });
  assert.equal(p.items[2].actor, null);
  assert.equal(p.total, 3);
  assert.deepEqual(H.historyPageFrom(null), { items: [], total: 0 });
  assert.deepEqual(H.historyPageFrom({ items: 'x', total: 'y' }), { items: [], total: 0 });
});

test('操作人：「姓名 · 角色」；actor 为 null → 系统；来信 → 客户', () => {
  assert.equal(H.actorText({ type: 'status', actor: { name: '王五', role: 'ADMIN' } }), '王五 · 管理员');
  assert.equal(H.actorText({ type: 'reply', actor: { name: '李四', role: 'SALES' } }), '李四 · 业务员');
  assert.equal(H.actorText({ type: 'assignment', actor: { name: 'X', role: 'OWNER' } }), 'X · OWNER');
  assert.equal(H.actorText({ type: 'assignment', actor: { name: 'X', role: 'constructor' } }), 'X · constructor', '原型键不当成角色');
  assert.equal(H.actorText({ type: 'created', actor: null }), '系统');
  assert.equal(H.actorText({ type: 'inbound', actor: null }), '客户');
  assert.equal(H.actorText({ type: 'inbound', actor: { name: 'a', role: 'ADMIN' } }), '客户');
});

test('文案', () => {
  assert.equal(H.loadMoreText(8), '加载更早记录（剩 8 条）');
  assert.equal(H.HISTORY_TEXT.empty, '暂无记录');
  assert.equal(H.historyErrorText('http_500'), '加载失败');
  assert.equal(H.historyErrorText('not_found'), '加载失败');
  assert.equal(H.historyErrorText('rate_limited'), '加载失败：操作太频繁，请稍等一分钟再试。');
  assert.equal(H.historyErrorText('unauthorized'), '加载失败：登录已过期，请重新登录。');
  assert.deepEqual(Object.keys(H.HISTORY_ICON).sort(), ['assignment', 'created', 'inbound', 'reply', 'status']);
});

test('状态机：第一页 → 翻页（按 cursor 去重）→ 剩余条数；不足一页即到底', () => {
  let s = H.historyReducer(H.initialHistory, { t: 'load' });
  assert.equal(s.phase, 'loading');
  s = H.historyReducer(s, { t: 'loaded', page: page(0, 10, 23) });
  assert.equal(s.phase, 'ready'); assert.equal(H.remaining(s), 13); assert.equal(H.nextCursor(s), 'c9');
  s = H.historyReducer(s, { t: 'moreLoad' }); assert.equal(s.more, 'loading');
  s = H.historyReducer(s, { t: 'moreLoaded', page: { items: [item(9), ...page(10, 9, 23).items], total: 23 } });
  assert.equal(s.items.length, 19, 'c9 重复，去掉'); assert.equal(H.remaining(s), 4); assert.equal(s.more, 'idle');
  s = H.historyReducer(s, { t: 'moreLoaded', page: page(19, 3, 23) });
  assert.equal(s.end, true); assert.equal(H.remaining(s), 0, '返回不足一页：没有更早的了，即使 total 还多');
  // 刷新第一页（回复 / 改状态 / 改分配之后）：保留旧列表不闪骨架，回来后只剩第一页
  s = H.historyReducer(s, { t: 'load' }); assert.equal(s.phase, 'ready'); assert.equal(s.items.length, 22);
  s = H.historyReducer(s, { t: 'loaded', page: page(0, 10, 24) }); assert.equal(s.items.length, 10); assert.equal(H.remaining(s), 14); assert.equal(s.end, false);
  // 空
  assert.equal(H.remaining(H.historyReducer(H.initialHistory, { t: 'loaded', page: { items: [], total: 0 } })), 0);
});

test('状态机：失败 / 429 禁用一分钟 / 翻页失败保留已加载的记录', () => {
  const now = 1_000_000;
  let s = H.historyReducer(H.initialHistory, { t: 'failed', code: 'http_500', now });
  assert.equal(s.phase, 'error'); assert.equal(s.rateUntil, undefined); assert.equal(H.rateLimited(s, now), false);
  s = H.historyReducer(H.initialHistory, { t: 'failed', code: 'rate_limited', now });
  assert.equal(s.rateUntil, now + 60_000); assert.equal(H.rateLimited(s, now + 59_999), true); assert.equal(H.rateLimited(s, now + 60_000), false);
  s = H.historyReducer(s, { t: 'rateOver' }); assert.equal(H.rateLimited(s, now), false);
  s = H.historyReducer(H.historyReducer(H.initialHistory, { t: 'loaded', page: page(0, 10, 15) }), { t: 'moreFailed', code: 'rate_limited', now });
  assert.equal(s.phase, 'ready'); assert.equal(s.items.length, 10); assert.equal(s.more, 'error'); assert.equal(s.moreError, 'rate_limited'); assert.equal(H.rateLimited(s, now), true);
  s = H.historyReducer(s, { t: 'moreLoad' }); assert.equal(s.more, 'loading'); assert.equal(s.moreError, undefined);
});

test('http：GET /api/admin/inquiries/:id/history?limit=10&before=…（同源、no-store）；404 / 429 / bad_cursor 抛对应的码', async () => {
  const orig = globalThis.fetch;
  const calls: [string, RequestInit | undefined][] = [];
  let next: [number, unknown] = [200, { items: [item(1)], total: 1 }];
  globalThis.fetch = (async (u: string, i?: RequestInit) => { calls.push([u, i]); return new Response(JSON.stringify(next[1]), { status: next[0], headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
  try {
    const p = await httpAdminApi.getHistory('ck/x y', { before: 'abc=' });
    assert.deepEqual(p, { items: [item(1)], total: 1 });
    assert.equal(calls[0][0], '/api/admin/inquiries/ck%2Fx%20y/history?limit=10&before=abc%3D');
    assert.equal(calls[0][1]?.credentials, 'same-origin'); assert.equal(calls[0][1]?.cache, 'no-store'); assert.equal(calls[0][1]?.method, undefined);
    for (const [status, body, code] of [[404, { error: 'not_found' }, 'not_found'], [429, { error: 'rate_limited' }, 'rate_limited'], [400, { error: 'bad_cursor' }, 'bad_cursor'], [401, { error: 'unauthorized' }, 'unauthorized'], [500, {}, 'http_500']] as const) {
      next = [status, body];
      await assert.rejects(httpAdminApi.getHistory('ck1'), (e: Error) => e.message === code, String(status));
    }
  } finally { globalThis.fetch = orig; }
});

test('mock：与接口同形；新的在前，10 条一页，before 翻页，坏游标 bad_cursor，不存在 not_found；改状态后第一页出现新记录', async () => {
  const p1 = await mockAdminApi.getHistory('inq_2');
  assert.equal(p1.items.length, 10); assert.ok(p1.total > 10);
  assert.ok(p1.items.every((x, i, a) => i === 0 || a[i - 1].at >= x.at), '新的在前');
  const p2 = await mockAdminApi.getHistory('inq_2', { before: p1.items.at(-1)!.cursor });
  assert.equal(p2.items.length, p1.total - 10);
  assert.equal(new Set([...p1.items, ...p2.items].map((x) => x.cursor)).size, p1.total);
  assert.equal(p2.items.at(-1)!.type, 'created');
  await assert.rejects(mockAdminApi.getHistory('inq_2', { before: 'nope' }), /bad_cursor/);
  await assert.rejects(mockAdminApi.getHistory('missing'), /not_found/);
  const d = await mockAdminApi.getInquiry('inq_2');
  assert.equal(d && 'history' in d, false, '详情不再带 history（真实接口也没有）');
  await mockAdminApi.updateInquiry('inq_2', { status: 'QUOTED' });
  const p3 = await mockAdminApi.getHistory('inq_2');
  assert.equal(p3.total, p1.total + 1); assert.equal(p3.items[0].type, 'status'); assert.equal(p3.items[0].summary, '状态：跟进中 → 已报价');
});

const view = (s: H.HistoryState, limited = false) => renderToStaticMarkup(React.createElement(HistoryView, { s, limited, onRetry: () => {}, onMore: () => {} }));
test('渲染：加载中 3 行骨架；空 → 灰色「暂无记录」；失败 → 「加载失败」+ 重试；429 → 重试禁用', () => {
  const sk = view(H.initialHistory);
  assert.equal((sk.match(/adm-tl-skel/g) ?? []).length, 3);
  assert.match(sk, /aria-busy="true"/); assert.match(sk, /<ol class="adm-hist adm-tl" aria-hidden="true"/); assert.match(sk, /role="status">正在加载操作历史</);
  assert.match(view({ ...H.initialHistory, phase: 'ready' }), /<p class="adm-empty-note" data-testid="empty-note">暂无记录<\/p>/);
  const err = view({ ...H.initialHistory, phase: 'error', error: 'http_500' });
  assert.match(err, /role="alert"[^>]*>加载失败 <button type="button" class="adm-btn sq">重试<\/button>/);
  const rl = view({ ...H.initialHistory, phase: 'error', error: 'rate_limited' }, true);
  assert.match(rl, /加载失败：操作太频繁，请稍等一分钟再试。 <button type="button" class="adm-btn sq" disabled="">重试<\/button>/);
  assert.match(view({ ...H.initialHistory, phase: 'error', error: 'unauthorized' }), /登录已过期，请重新登录。 <a href="[^"]*">去登录<\/a>/);
});

test('渲染：竖向 <ol>，图标 aria-hidden，summary 原样，「姓名 · 角色 · <time datetime title>」，「加载更早记录（剩 N 条）」', () => {
  const s = H.historyReducer(H.initialHistory, { t: 'loaded', page: page(0, 10, 18) });
  const html = view(s);
  assert.equal((html.match(/<li class="adm-tl-row status">/g) ?? []).length, 10);
  assert.match(html, /<ol class="adm-hist adm-tl">/);
  assert.match(html, /<button type="button" class="adm-btn sq adm-tl-more">加载更早记录（剩 8 条）<\/button>/);
  assert.match(view({ ...s, more: 'loading' }), /disabled="">加载中…<\/button>/);
  assert.match(view(s, true), /adm-tl-more" disabled="">加载更早记录/, '429 期间也不能翻页');
  const moreErr = view({ ...s, more: 'error', moreError: 'http_502' });
  assert.match(moreErr, /加载失败 <button type="button" class="adm-btn sq">重试<\/button>/); assert.doesNotMatch(moreErr, /adm-tl-more/);
  assert.doesNotMatch(view({ ...s, end: true }), /加载更早记录/);
  const at = '2025-03-04T05:06:00.000Z';
  const row = renderToStaticMarkup(React.createElement(HistoryRow, { item: { type: 'inbound', at, actor: null, summary: '收到客户来信：<b>Re: ***</b> & co', cursor: 'x' } }));
  assert.match(row, /<span class="adm-tl-ic" aria-hidden="true">📥<\/span>/);
  assert.match(row, /<div class="adm-tl-sum">收到客户来信：&lt;b&gt;Re: \*\*\*&lt;\/b&gt; &amp; co<\/div>/, 'summary 原样当文本显示，不解析 HTML');
  assert.match(row, new RegExp(`客户 · <time dateTime="${at}" title="${fmtDate(at)}">`));
  const sys = renderToStaticMarkup(React.createElement(HistoryRow, { item: item(1, { type: 'created', actor: null, summary: '客户提交询盘（FORM）' }) }));
  assert.match(sys, /系统 · <time/);
});

test('接线：详情页用 <InquiryHistory>，回复 / 改状态 / 改分配后刷新第一页；加备注不刷新；不轮询、不无限滚动', () => {
  const d = src('components/admin/InquiryDetail.tsx');
  assert.match(d, /<InquiryHistory inquiryId=\{inq\.id\} refreshKey=\{historyKey\} \/>/);
  assert.doesNotMatch(d, /inq\.history/);
  assert.match(d, /setBusy\(false\); refreshHistory\(\); \}\n  \};/, 'changeStatus 之后');
  const refresh = /setBusy\(false\); refreshHistory\(\); \}\n  \};/;
  const crlfDetail = lf(readFileSync(new URL('../src/components/admin/InquiryDetail.tsx', import.meta.url), 'utf8')).replace(/\n/g, '\r\n');
  assert.equal(refresh.test(crlfDetail), false);
  assert.equal(refresh.test(lf(crlfDetail)), true);
  assert.equal(refresh.test(lf(crlfDetail).replace('refreshHistory()', 'keepHistory()')), false);
  assert.match(d, /finally \{ setBusy\(false\); if \(history\) refreshHistory\(\); \}/, 'run（分配、标记无效、回复）之后');
  assert.match(d, /adminApi\.addNote\(inq\.id, note\.trim\(\)\); setNote\(''\); \}, false\)/);
  assert.match(d, /: refreshHistory\}/, '新邮件回复被接受后（非新询盘）也刷新');
  const c = src('components/admin/InquiryHistory.tsx');
  assert.doesNotMatch(c, /setInterval|IntersectionObserver|onScroll/);
  assert.match(c, /useEffect\(\(\) => \{ void loadFirst\(\); \}, \[loadFirst, refreshKey\]\);/);
  assert.match(c, /if \(code === 'bad_cursor'\) void loadFirst\(\);/);
  assert.doesNotMatch(c, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(src('lib/admin/http.ts'), /history: arr\(r\.history\)/);
});
