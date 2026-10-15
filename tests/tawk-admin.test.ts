import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminPath } from '../src/lib/chat/adminPath';

test('admin paths block Tawk', () => {
  for (const p of ['/admin', '/admin/', '/admin/inquiries', '/admin/inquiries/42', '/en/admin', '/ru/admin/inquiries', '/ADMIN', '//admin', '/admin?x=1', '/%61dmin'])
    assert.equal(isAdminPath(p), true, p);
});
test('non-admin paths allow Tawk', () => {
  for (const p of ['/', '/en', '/ru/products', '/en/administrator', '/en/products/admin-desk', '/adminx', '', null, undefined])
    assert.equal(isAdminPath(p as string), false, String(p));
});
