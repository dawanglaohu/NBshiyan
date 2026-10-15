import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminPageGate } from '../src/lib/server/admin/page-access';

const cb = (to: string) => new URL(to, 'https://x.test').searchParams.get('callbackUrl');

test('/admin/users: logged out → sign-in redirect (not 404)', () => {
  const g = adminPageGate({ ok: false, reason: 'unauthenticated' }, '/admin/users');
  assert.equal(g.action, 'redirect');
  assert.ok(g.action === 'redirect' && g.to.startsWith('/api/auth/signin?callbackUrl='));
  assert.equal(g.action === 'redirect' && cb(g.to), '/admin/users');
});

test('/admin/users: disabled or wrong role → 404; ok → render', () => {
  assert.deepEqual(adminPageGate({ ok: false, reason: 'disabled' }, '/admin/users'), { action: 'notFound' });
  assert.deepEqual(adminPageGate({ ok: false, reason: 'forbidden' }, '/admin/users'), { action: 'notFound' });
  assert.deepEqual(adminPageGate({ ok: true }, '/admin/users'), { action: 'render' });
});

test('open-redirect path falls back to /admin', () => {
  const g = adminPageGate({ ok: false, reason: 'unauthenticated' }, '//evil.com');
  assert.equal(g.action === 'redirect' && cb(g.to), '/admin');
});
