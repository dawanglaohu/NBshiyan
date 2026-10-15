import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换
import { renderToStaticMarkup } from 'react-dom/server';
import { AnonTag, anonymizedNotice, detailControls, filterAnonymized, isAnonymized, parseIncludeAnon, piiField } from '../src/components/admin/anonymized';
import { mockAdminApi } from '../src/lib/admin/mock';

const anon = { anonymizedAt: '2026-09-14T03:00:00.000Z' };
const live = { anonymizedAt: null };

test('isAnonymized: 只认 anonymizedAt，缺字段 = 未匿名化', () => {
  assert.equal(isAnonymized(anon), true);
  assert.equal(isAnonymized(live), false);
  assert.equal(isAnonymized({}), false);
});

test('AnonTag: 中性样式，没有红色 / 警告色', () => {
  const html = renderToStaticMarkup(React.createElement(AnonTag));
  assert.match(html, />已匿名化</);
  assert.match(html, /background:var\(--surface\)/);
  assert.match(html, /color:var\(--ink-2\)/);
  assert.match(html, /border:1px solid var\(--ink-2\)/);
  assert.match(html, /border-radius:4px/);
  assert.match(html, /font-size:12px/);
  assert.doesNotMatch(html, /--err|--warn|red/);
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
  assert.deepEqual(detailControls(anon, 'ADMIN'), { showReply: false, showAssign: false, showAssigneeText: false });
  assert.deepEqual(detailControls(live, 'ADMIN'), { showReply: true, showAssign: true, showAssigneeText: false });
  assert.deepEqual(detailControls({}, 'SALES'), { showReply: true, showAssign: false, showAssigneeText: true });
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
