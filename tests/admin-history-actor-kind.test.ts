// #331 / #74 跟进：操作历史按 actorKind 显示操作人（对接 #362 的 { type, at, actorKind, actor, summary, cursor }）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import * as H from '../src/lib/admin/history';
import { HistoryRow } from '../src/components/admin/InquiryHistory';
import { mockAdminApi } from '../src/lib/admin/mock';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const AT = '2026-10-01T00:00:00.000Z';
const it = (o: Partial<H.HistoryItem>): H.HistoryItem => ({ type: 'status', at: AT, actor: null, summary: '状态：新询盘 → 跟进中', cursor: 'c1', ...o });
const meta = (html: string) => /class="muted adm-tl-meta">(.*?) · <time/.exec(html)?.[1];

test('customer →「客户 · 客户名」（名字用后端给的）', () => {
  assert.equal(H.actorText(it({ type: 'created', actorKind: 'customer', actor: { name: 'Anna Weber', role: null } })), '客户 · Anna Weber');
  assert.equal(H.actorText(it({ type: 'inbound', actorKind: 'customer', actor: { name: '[deleted]', role: null } })), '客户 · [deleted]');
  assert.equal(H.actorText(it({ type: 'inbound', actorKind: 'customer', actor: null })), '客户', '缺名字也不崩');
});

test('user →「姓名 · 角色」；三种角色中文；role 为 null 只显示姓名；未知角色原样', () => {
  assert.equal(H.actorText(it({ actorKind: 'user', actor: { name: '王五', role: 'ADMIN' } })), '王五 · 管理员');
  assert.equal(H.actorText(it({ actorKind: 'user', actor: { name: '李四', role: 'SALES' } })), '李四 · 业务员');
  assert.equal(H.actorText(it({ actorKind: 'user', actor: { name: '赵六', role: 'EDITOR' } })), '赵六 · 编辑');
  assert.equal(H.actorText(it({ actorKind: 'user', actor: { name: '赵六', role: null } })), '赵六');
  assert.equal(H.actorText(it({ actorKind: 'user', actor: { name: 'X', role: 'constructor' } })), 'X · constructor', '原型键不当成角色');
});

test('deleted_user →「已删除的账号」（灰色）；system →「系统」；不看 type', () => {
  assert.deepEqual(H.actorView(it({ actorKind: 'deleted_user', actor: null })), { text: '已删除的账号', gone: true });
  assert.deepEqual(H.actorView(it({ type: 'reply', actorKind: 'system', actor: null })), { text: '系统' });
  assert.deepEqual(H.actorView(it({ type: 'inbound', actorKind: 'system', actor: null })), { text: '系统' }, 'actorKind 优先于 type');
  const html = renderToStaticMarkup(React.createElement(HistoryRow, { item: it({ actorKind: 'deleted_user', actor: null }) }));
  assert.match(html, /<span class="adm-tl-gone" data-testid="actor-gone">已删除的账号<\/span>/);
  assert.match(src('app/admin/admin.css'), /\.adm-tl-gone\{color:var\(--ink-2\)/);
});

test('没有 actorKind（#362 部署前的旧响应）→ 旧规则，不崩', () => {
  assert.equal(H.actorText(it({ type: 'inbound', actor: null })), '客户');
  assert.equal(H.actorText(it({ type: 'created', actor: null })), '系统');
  assert.equal(H.actorText(it({ actor: { name: '王五', role: 'ADMIN' } })), '王五 · 管理员');
  assert.equal(H.actorText(it({ type: 'created', actor: { name: 'Anna', role: null } })), 'Anna');
  const p = H.historyPageFrom({ total: 4, items: [
    { type: 'status', at: AT, actor: { name: '王五', role: 'ADMIN' }, summary: 's', cursor: 'a' },
    { type: 'created', at: AT, actorKind: 'robot', actor: null, summary: 's', cursor: 'b' },
    { type: 'created', at: AT, actorKind: 'customer', actor: { name: 'Anna', role: null }, summary: 's', cursor: 'c' },
    { type: 'status', at: AT, actorKind: 'user', actor: { name: '李四', role: null, id: 'u1', email: 'x@y' }, summary: 's', cursor: 'd', extra: 1 },
  ] });
  assert.equal(p.items[0].actorKind, undefined);
  assert.equal(p.items[1].actorKind, undefined, '不认识的 actorKind 当没有');
  assert.equal(H.actorText(p.items[1]), '系统');
  assert.deepEqual(p.items[2], { type: 'created', at: AT, actorKind: 'customer', actor: { name: 'Anna', role: null }, summary: 's', cursor: 'c' });
  assert.deepEqual(p.items[3].actor, { name: '李四', role: null }, '只留 name、role');
  assert.equal('extra' in p.items[3], false);
  // user 但 actor 缺失：不崩，按旧规则显示「系统」
  assert.equal(H.actorText(it({ actorKind: 'user', actor: null })), '系统');
});

test('名字、summary 只当文本：<script>、<img onerror>、&lt;b&gt; 原样显示，不再解码', () => {
  const evil = '<script>alert(1)</script>';
  const html = renderToStaticMarkup(React.createElement(HistoryRow, { item: it({ type: 'inbound', actorKind: 'customer', actor: { name: evil, role: null }, summary: '收到客户来信：<img src=x onerror=alert(1)> &lt;b&gt;' }) }));
  assert.doesNotMatch(html, /<script|<img/);
  assert.equal(meta(html), '客户 · &lt;script&gt;alert(1)&lt;/script&gt;');
  assert.match(html, /收到客户来信：&lt;img src=x onerror=alert\(1\)&gt; &amp;lt;b&amp;gt;/, '&lt; 原样作为文本，不被解码成标签');
  const user = renderToStaticMarkup(React.createElement(HistoryRow, { item: it({ actorKind: 'user', actor: { name: '<b>王</b>', role: 'ADMIN' } }) }));
  assert.equal(meta(user), '&lt;b&gt;王&lt;/b&gt; · 管理员');
  for (const f of ['components/admin/InquiryHistory.tsx', 'lib/admin/history.ts']) assert.doesNotMatch(src(f), /dangerouslySetInnerHTML|\.innerHTML|decodeURI|DOMParser|textarea/, f);
});

test('图标只按 type：📝 🔄 👤 📤 📥；新邮件沿用 reply / inbound；图标格固定宽度、居中', () => {
  assert.deepEqual(H.HISTORY_ICON, { created: '📝', status: '🔄', assignment: '👤', reply: '📤', inbound: '📥' });
  const a = renderToStaticMarkup(React.createElement(HistoryRow, { item: it({ type: 'reply', actorKind: 'system', actor: null }) }));
  const b = renderToStaticMarkup(React.createElement(HistoryRow, { item: it({ type: 'reply', actorKind: 'user', actor: { name: 'A', role: 'SALES' } }) }));
  assert.match(a, /<span class="adm-tl-ic" aria-hidden="true">📤<\/span>/);
  assert.match(b, /<span class="adm-tl-ic" aria-hidden="true">📤<\/span>/);
  assert.match(src('app/admin/admin.css'), /\.adm-tl-ic\{flex:0 0 22px;width:22px;[^}]*justify-content:center;text-align:center/);
});

test('mock 也带 actorKind：客户条目是 customer + 客户名，账号是 user，已删除示例是 deleted_user', async () => {
  const p = await mockAdminApi.getHistory('inq_3', { limit: 50 });
  const kinds = new Set(p.items.map((i) => i.actorKind));
  assert.ok(kinds.has('customer') && kinds.has('deleted_user'));
  const created = p.items.find((i) => i.type === 'created')!;
  assert.equal(created.actorKind, 'customer');
  assert.equal(H.actorText(created), '客户 · J. Smith');
  assert.ok(p.items.every((i) => i.actorKind), '每条都有 actorKind');
});
