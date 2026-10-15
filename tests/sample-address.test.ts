import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealSampleAddress, canViewFullAddress } from '../src/lib/server/sample';

const ADDR = { line1: 'Hauptstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' };
const SID = 'cmsample0000000000000001';
function deps(assigneeId: string | null, addr: unknown = ADDR) {
  const audits: unknown[] = [];
  const seen = new Set<string>();
  return {
    audits,
    d: {
      findSample: async (id: string) => (id === SID ? { id, shippingAddress: addr, inquiry: { id: 'inq1', assigneeId } } : null),
      audit: async (e: unknown) => { audits.push(e); },
      allowDenyAudit: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)),
    },
  };
}

test('ADMIN sees full address and it is audited without address content', async () => {
  const { d, audits } = deps(null);
  assert.deepEqual(await revealSampleAddress({ user: { id: 'a1', role: 'ADMIN' }, ip: '1.2.3.4' }, SID, d), ADDR);
  assert.deepEqual(audits, [{ actorId: 'a1', action: 'sample.address.view', target: SID, ip: '1.2.3.4' }]);
  assert.ok(!JSON.stringify(audits).includes('Hauptstr'));
});

test('assigned SALES allowed; unassigned SALES and EDITOR denied and audited as forbidden', async () => {
  let x = deps('s1');
  assert.deepEqual(await revealSampleAddress({ user: { id: 's1', role: 'SALES' }, ip: null }, SID, x.d), ADDR);
  assert.deepEqual(x.audits, [{ actorId: 's1', action: 'sample.address.view', target: SID, ip: 'unknown' }]);
  x = deps('s1');
  assert.equal(await revealSampleAddress({ user: { id: 's2', role: 'SALES' }, ip: '9.9.9.9' }, SID, x.d), null);
  assert.equal(await revealSampleAddress({ user: { id: 'e1', role: 'EDITOR' }, ip: null }, SID, x.d), null);
  assert.deepEqual(x.audits, [
    { actorId: 's2', action: 'sample.address.denied', target: SID, meta: { reason: 'forbidden' }, ip: '9.9.9.9' },
    { actorId: 'e1', action: 'sample.address.denied', target: SID, meta: { reason: 'forbidden' }, ip: 'unknown' },
  ]);
  assert.ok(!JSON.stringify(x.audits).includes('Hauptstr'));
});

test('missing sample, missing address, bad id -> null', async () => {
  const x = deps(null, null);
  const admin = { user: { id: 'a1', role: 'ADMIN' }, ip: null };
  assert.equal(await revealSampleAddress(admin, SID, x.d), null);
  assert.equal(await revealSampleAddress(admin, 'cmsample0000000000000002', x.d), null);
  assert.equal(await revealSampleAddress(admin, '../x', x.d), null);
  assert.deepEqual(x.audits.map((a: any) => [a.action, a.target, a.meta.reason]), [
    ['sample.address.denied', SID, 'no_address'],
    ['sample.address.denied', 'cmsample0000000000000002', 'not_found'],
    ['sample.address.denied', null, 'bad_id'],
  ]);
});

test('canViewFullAddress matrix', () => {
  assert.equal(canViewFullAddress({ id: 'e', role: 'EDITOR' }, { assigneeId: 'e' }), false);
  assert.equal(canViewFullAddress({ id: 's', role: 'SALES' }, { assigneeId: null }), false);
});

test('denied audit deduped per actor+reason', async () => {
  const x = deps('s1');
  const s2 = { user: { id: 's2', role: 'SALES' }, ip: null };
  for (let i = 0; i < 5; i++) assert.equal(await revealSampleAddress(s2, SID, x.d), null);
  await revealSampleAddress(s2, '../x', x.d); // 不同 reason 单独计
  await revealSampleAddress({ user: { id: 's3', role: 'SALES' }, ip: null }, SID, x.d); // 不同 actor 单独计
  assert.deepEqual(x.audits.map((a: any) => [a.actorId, a.meta.reason]), [['s2', 'forbidden'], ['s2', 'bad_id'], ['s3', 'forbidden']]);
});
