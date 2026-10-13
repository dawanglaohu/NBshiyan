import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory } from '../src/lib/server/admin/history';

test('history: created, status, assignment, reply, inbound; actor name/role only', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 13, 10, m));
  const users = [{ id: 'u1', name: '王经理', role: 'ADMIN' as const }, { id: 'u2', name: '小李', role: 'SALES' as const }];
  const h = buildHistory({ createdAt: t(0), source: 'CART' },
    [
      { action: 'inquiry.update', actorId: 'u1', createdAt: t(1), meta: { before: { status: 'NEW', assigneeId: null }, after: { status: 'NEW', assigneeId: 'u2' } } },
      { action: 'inquiry.update', actorId: 'u2', createdAt: t(2), meta: { before: { status: 'NEW', assigneeId: 'u2' }, after: { status: 'QUOTED', assigneeId: 'u2' } } },
      { action: 'inquiry.view', actorId: 'u2', createdAt: t(3), meta: null },
    ],
    [{ direction: 'OUTBOUND', authorId: 'u2', createdAt: t(4) }, { direction: 'INBOUND', authorId: null, createdAt: t(5) }],
    users);
  assert.deepEqual(h.map((e) => e.type), ['created', 'assignment', 'status', 'reply', 'inbound']);
  assert.equal(h[1].summary, '分配给 小李');
  assert.equal(h[2].summary, '状态：新询盘 → 已报价');
  assert.deepEqual(h[3].actor, { name: '小李', role: 'SALES' });
  for (const e of h) assert.deepEqual(Object.keys(e).sort(), ['actor', 'at', 'summary', 'type']);
  assert.ok(!JSON.stringify(h).includes('u2'), 'no user ids leaked');
});
