import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealSampleAddress, canViewFullAddress } from '../src/lib/server/sample';

const ADDR = { line1: 'Hauptstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' };
const SID = 'cmsample0000000000000001';
function deps(assigneeId: string | null, addr: unknown = ADDR) {
  const audits: unknown[] = [];
  return {
    audits,
    d: {
      findSample: async (id: string) => (id === SID ? { id, shippingAddress: addr, inquiry: { id: 'inq1', assigneeId } } : null),
      audit: async (e: unknown) => { audits.push(e); },
    },
  };
}

test('ADMIN sees full address and it is audited without address content', async () => {
  const { d, audits } = deps(null);
  assert.deepEqual(await revealSampleAddress({ user: { id: 'a1', role: 'ADMIN' }, ip: '1.2.3.4' }, SID, d), ADDR);
  assert.deepEqual(audits, [{ actorId: 'a1', action: 'sample.address.view', target: SID, ip: '1.2.3.4' }]);
  assert.ok(!JSON.stringify(audits).includes('Hauptstr'));
});

test('assigned SALES allowed; unassigned SALES and EDITOR denied (no audit)', async () => {
  let x = deps('s1');
  assert.deepEqual(await revealSampleAddress({ user: { id: 's1', role: 'SALES' }, ip: null }, SID, x.d), ADDR);
  assert.equal(x.audits.length, 1);
  x = deps('s1');
  assert.equal(await revealSampleAddress({ user: { id: 's2', role: 'SALES' }, ip: null }, SID, x.d), null);
  assert.equal(await revealSampleAddress({ user: { id: 'e1', role: 'EDITOR' }, ip: null }, SID, x.d), null);
  assert.equal(x.audits.length, 0);
});

test('missing sample, missing address, bad id -> null', async () => {
  const x = deps(null, null);
  const admin = { user: { id: 'a1', role: 'ADMIN' }, ip: null };
  assert.equal(await revealSampleAddress(admin, SID, x.d), null);
  assert.equal(await revealSampleAddress(admin, 'cmsample0000000000000002', x.d), null);
  assert.equal(await revealSampleAddress(admin, '../x', x.d), null);
  assert.equal(x.audits.length, 0);
});

test('canViewFullAddress matrix', () => {
  assert.equal(canViewFullAddress({ id: 'e', role: 'EDITOR' }, { assigneeId: 'e' }), false);
  assert.equal(canViewFullAddress({ id: 's', role: 'SALES' }, { assigneeId: null }), false);
});
