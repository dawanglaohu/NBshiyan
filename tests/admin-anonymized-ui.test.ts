import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换
import { renderToStaticMarkup } from 'react-dom/server';
import { DeletedBody, needsReview, AnonConflictNotice, ANON_CONFLICT_MSG, isAnonConflict, StatusText, AnonTag, anonymizedNotice, detailControls, filterAnonymized, isAnonymized, parseIncludeAnon, piiField } from '../src/components/admin/anonymized';
import { mockAdminApi } from '../src/lib/admin/mock';
import { errorText } from '../src/components/admin/format';

const anon = { anonymizedAt: '2026-09-14T03:00:00.000Z' };
const live = { anonymizedAt: null };

test('isAnonymized: 只认 anonymizedAt，缺字段 = 未匿名化', () => {
  assert.equal(isAnonymized(anon), true);
  assert.equal(isAnonymized(live), false);
  assert.equal(isAnonymized({}), false);
});

test('AnonTag: 11 节中性标签（2px 黑边 / 0 圆角 / 无阴影），没有红色 / 警告色', () => {
  const html = renderToStaticMarkup(React.createElement(AnonTag));
  const css = readFileSync('src/app/admin/admin.css', 'utf8');
  const tokens = readFileSync('src/styles/tokens.css', 'utf8');
  assert.match(html, />已匿名化</);
  assert.match(html, /class="inq-anon-tag"/);
  assert.match(html, /data-testid="anon-tag"/);
  // 旧 1px/4px/999px 内联值已移除；组件不再内联 --surface/--ink-2，样式走 .inq-anon-tag 命名域。
  assert.doesNotMatch(html, /border:1px|border-radius:4px|999px/);
  assert.doesNotMatch(html, /--surface|--ink-2/);
  // 精确取 .inq-anon-tag 所在规则声明块，而不是全文件任意命中同名字串（M3-T7 壳也有类似声明）。
  const selector = '.inq-anon-tag,.inq-deleted-tag{';
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, '缺少 .inq-anon-tag,.inq-deleted-tag 命名域规则');
  const body = css.slice(start + selector.length, css.indexOf('}', start));
  assert.match(body, /border:var\(--pj-border-width\) solid var\(--pj-border\)/);
  assert.match(body, /border-radius:var\(--pj-radius\)/);
  assert.match(body, /box-shadow:var\(--pj-shadow\)/);
  assert.match(body, /background:var\(--pj-bg\)/);
  assert.match(body, /color:var\(--pj-fg\)/);
  // 实际 token 值来自唯一 minimalist-flat 色板，不靠注释或全文件弱命中。
  assert.match(tokens, /--pj-border-width:\s*2px/);
  assert.match(tokens, /--pj-radius:\s*0px/);
  assert.match(tokens, /--pj-shadow:\s*none/);
  assert.match(tokens, /--pj-border:\s*#000000/);
  // 中性语义：标签文字合法、不泄露 PII、不含 error/warn/红。
  assert.doesNotMatch(body, /--err|--warn|red/);
  assert.doesNotMatch(html, /@|deleted|\[deleted\]/);
});

test('piiField: 已匿名化显示标签而不是 [deleted] / deleted+…@invalid.invalid', () => {
  for (const v of ['[deleted]', 'deleted+abc@invalid.invalid', '', undefined]) {
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null, piiField(anon, v)));
    assert.match(html, /已匿名化/); assert.doesNotMatch(html, /deleted/);
  }
  assert.equal(piiField(live, 'Anna'), 'Anna');
  assert.equal(piiField({}, undefined), '—');
});

test('detailControls: 已匿名化时回复和分配都隐藏（ADMIN 也一样）', () => {
  assert.deepEqual(detailControls(anon, 'ADMIN'), { showReply: false, showAssign: false, showAssigneeText: false, statusEditable: false, showInvalidate: false, showTrust: false });
  assert.deepEqual(detailControls(live, 'ADMIN'), { showReply: true, showAssign: true, showAssigneeText: false, statusEditable: true, showInvalidate: true, showTrust: true });
  assert.deepEqual(detailControls({}, 'SALES'), { showReply: true, showAssign: false, showAssigneeText: true, statusEditable: true, showInvalidate: true, showTrust: true });
});

test('anonymizedNotice 用传入的格式化函数', () => {
  assert.equal(anonymizedNotice(anon.anonymizedAt, () => 'D'), '此询盘已于 D 按数据保留政策匿名化');
});

test('列表开关默认关：不含已匿名化；开了才显示', () => {
  assert.equal(parseIncludeAnon(null), false);
  assert.equal(parseIncludeAnon('1'), true);
  const rows: { id: string; anonymizedAt?: string | null }[] = [{ id: 'a', ...anon }, { id: 'b', ...live }, { id: 'c' }];
  assert.deepEqual(filterAnonymized(rows, parseIncludeAnon(null)).map((r) => r.id), ['b', 'c']);
  assert.deepEqual(filterAnonymized(rows, true).map((r) => r.id), ['a', 'b', 'c']);
});

test('mock 演示数据里有一条已匿名化询盘，列表摘要带 anonymizedAt', async () => {
  const d = await mockAdminApi.getInquiry('inq_anon_1');
  assert.ok(d?.anonymizedAt); assert.equal(d.contact.name, '[deleted]');
  const off = await mockAdminApi.listInquiries({ pageSize: 100 });
  assert.ok(!off.items.some((r) => r.id === 'inq_anon_1'));
  const on = await mockAdminApi.listInquiries({ pageSize: 100, includeAnonymized: true });
  assert.ok(on.items.some((r) => r.id === 'inq_anon_1' && r.anonymizedAt));
  assert.equal(on.total, off.total + 1);
});

test('已匿名化：状态只读纯文本（--ink-2），不是下拉框', () => {
  const html = renderToStaticMarkup(React.createElement(StatusText, { label: '跟进中' }));
  assert.match(html, /状态：跟进中/); assert.match(html, /color:var\(--ink-2\)/);
  assert.doesNotMatch(html, /<select|disabled/);
});

test('409 提示：中性色文案，不是红色', async () => {
  assert.equal(isAnonConflict('anonymized'), true); assert.equal(isAnonConflict('forbidden'), false);
  assert.equal(errorText('anonymized'), '此询盘已匿名化，无法修改');
  const html = renderToStaticMarkup(React.createElement(AnonConflictNotice));
  assert.match(html, new RegExp(ANON_CONFLICT_MSG)); assert.match(html, /--ink-2/); assert.doesNotMatch(html, /--err|warn/);
  await assert.rejects(mockAdminApi.updateInquiry('inq_anon_1', { status: 'INVALID' }), /anonymized/);
  await assert.rejects(mockAdminApi.reply('inq_anon_1', { subject: 's', body: 'b' }), /anonymized/);
});

test('待核实：已匿名化询盘不参与（不分组、无 ⚠）', async () => {
  assert.equal(needsReview({ trustScore: 15, ...anon }), false);
  assert.equal(needsReview({ trustScore: 15, ...live }), true);
  assert.equal(needsReview({ trustScore: 80 }), false);
  const rev = await mockAdminApi.listInquiries({ status: 'REVIEW', pageSize: 100, includeAnonymized: true });
  assert.ok(!rev.items.some((r) => r.id === 'inq_anon_1'));
});

test('往来记录：已匿名化正文显示「内容已删除」（--ink-2），mock ipCountry 已清空', async () => {
  const html = renderToStaticMarkup(React.createElement(DeletedBody));
  assert.match(html, /内容已删除/); assert.match(html, /color:var\(--ink-2\)/); assert.doesNotMatch(html, /deleted\]/);
  const d = await mockAdminApi.getInquiry('inq_anon_1');
  assert.equal(d?.ipCountry, null);
});

test('内部备注：已匿名化时 mock 备注为 [deleted]，新增备注返回 anonymized', async () => {
  const d = await mockAdminApi.getInquiry('inq_anon_1');
  assert.ok(d?.notes.length && d.notes.every((n) => n.body === '[deleted]'));
  await assert.rejects(mockAdminApi.addNote('inq_anon_1', 'x'), /anonymized/);
});

test('可信度卡片：已匿名化时整块不渲染（ADMIN / SALES 都一样）', () => {
  assert.equal(detailControls(anon, 'ADMIN').showTrust, false);
  assert.equal(detailControls(anon, 'SALES').showTrust, false);
  assert.equal(detailControls(live, 'SALES').showTrust, true);
});

test('#74 已匿名化：状态下拉框置灰并说明；409 anonymized 映射到同一句', async () => {
  const { LockedStatus, STATUS_LOCKED_MSG, statusConflictText } = await import('../src/components/admin/anonymized');
  const html = renderToStaticMarkup(React.createElement(LockedStatus, { label: '已成交' }));
  assert.match(html, /<select[^>]*disabled/); assert.match(html, /aria-describedby="status-locked-why"/);
  assert.match(html, /内容已删除，无法更改状态/); assert.equal(STATUS_LOCKED_MSG, '内容已删除，无法更改状态');
  assert.equal(statusConflictText('anonymized'), STATUS_LOCKED_MSG); assert.equal(statusConflictText('invalid'), undefined);
  await assert.rejects(mockAdminApi.updateInquiry('inq_anon_1', { status: 'NEW' }), /anonymized/);
});
