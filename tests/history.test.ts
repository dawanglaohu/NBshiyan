import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, pageHistory, maskAddressIn } from '../src/lib/server/admin/history';

const t = (m: number) => new Date(Date.UTC(2026, 9, 13, 10, m));
const users = [{ id: 'u1', name: '王经理', role: 'ADMIN' as const }, { id: 'u2', name: '小李', role: 'SALES' as const }];
const ADDR = { line1: 'Hauptstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' };
const audits = [
  { id: 'a1', action: 'inquiry.update', actorId: 'u1', createdAt: t(1), meta: { before: { status: 'NEW', assigneeId: null }, after: { status: 'NEW', assigneeId: 'u2' } } },
  { id: 'a2', action: 'inquiry.update', actorId: 'u2', createdAt: t(2), meta: { before: { status: 'NEW', assigneeId: 'u2' }, after: { status: 'QUOTED', assigneeId: 'u2' } } },
  { id: 'a3', action: 'inquiry.view', actorId: 'u2', createdAt: t(3), meta: null },
];
const msgs = [
  { id: 'm1', direction: 'OUTBOUND' as const, subject: 'Shipping to Hauptstr 1, 10115 berlin', authorId: 'u2', createdAt: t(4) },
  { id: 'm2', direction: 'INBOUND' as const, subject: 'Re: quote', authorId: null, createdAt: t(5) },
];
const all = () => buildHistory({ id: 'inq1', createdAt: t(0), source: 'CART' }, audits, msgs, users, ADDR);

test('history newest first, includes pre-assignment entries, actor name/role only', () => {
  const h = all();
  assert.deepEqual(h.map((e) => e.type), ['inbound', 'reply', 'status', 'assignment', 'created']);
  assert.equal(h[3].summary, '分配给 小李');
  assert.equal(h[2].summary, '状态：新询盘 → 已报价');
  assert.deepEqual(h[1].actor, { name: '小李', role: 'SALES' });
  for (const e of h) assert.deepEqual(Object.keys(e).sort(), ['actor', 'at', 'cursor', 'summary', 'type']);
  assert.ok(!JSON.stringify(h).includes('"u2"'));
});

test('addresses in reply summaries are masked', () => {
  const s = all()[1].summary;
  assert.ok(!/Hauptstr|10115|berlin/i.test(s), s);
  assert.equal(maskAddressIn('see Berlin', null), 'see Berlin');
});

test('pagination: limit + before cursor, total stable, bad cursor -> null', () => {
  const h = all();
  const p1 = pageHistory(h, 2)!;
  assert.equal(p1.total, 5); assert.deepEqual(p1.items.map((e) => e.type), ['inbound', 'reply']);
  const p2 = pageHistory(h, 2, p1.items[1].cursor)!;
  assert.deepEqual(p2.items.map((e) => e.type), ['status', 'assignment']);
  const p3 = pageHistory(h, 2, p2.items[1].cursor)!;
  assert.deepEqual(p3.items.map((e) => e.type), ['created']);
  assert.deepEqual(pageHistory(h, 2, p3.items[0].cursor)!.items, []);
  assert.equal(pageHistory(h, 2, '!!notbase64'), null);
});
