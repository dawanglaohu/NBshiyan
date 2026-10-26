import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { safeCallbackPath, adminCallbackPath, adminLoginHref } from '../src/lib/admin/safe-callback';
import { adminGate, ADMIN_AREA_ROLES, rolesForAdminPath } from '../src/lib/server/admin/layout-gate';

const cb = (to: string) => new URL(to, 'https://x.test').searchParams.get('callbackUrl')!;

test('unauthenticated → redirect to the admin login page with a same-site callbackUrl', () => {
  const g = adminGate({ ok: false, reason: 'unauthenticated' }, '/admin/specs/gift-boxes?tab=ru');
  assert.equal(g.action, 'redirect');
  assert.ok(g.action === 'redirect' && g.to.startsWith('/admin-login?callbackUrl='));
  assert.equal(g.action === 'redirect' && cb(g.to), '/admin/specs/gift-boxes?tab=ru');
  const none = adminGate({ ok: false, reason: 'unauthenticated' }, null);
  assert.equal(none.action === 'redirect' && cb(none.to), '/admin/inquiries');
});

test('open-redirect attempts fall back to /admin', () => {
  for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/\t/evil.com', '/%0a', ' /admin', '', 'admin', '/' + 'a'.repeat(3000)]) {
    const r = safeCallbackPath(bad);
    assert.ok(r === '/admin' || (r.startsWith('/') && !r.startsWith('//')), bad);
    if (bad !== '/%0a') assert.equal(r, '/admin', JSON.stringify(bad));
    assert.equal(adminCallbackPath(bad), '/admin/inquiries', JSON.stringify(bad));
    assert.ok(adminLoginHref(bad).startsWith('/admin-login?callbackUrl='), bad);
    assert.equal(cb(adminLoginHref(bad)), '/admin/inquiries', JSON.stringify(bad));
  }
  assert.equal(safeCallbackPath('/admin/inquiries/abc'), '/admin/inquiries/abc');
  assert.equal(adminCallbackPath('/admin/inquiries/abc'), '/admin/inquiries/abc');
});

test('database unavailable stays on the admin shell instead of the login page', () => {
  assert.deepEqual(adminGate({ ok: false, reason: 'unavailable' }, '/admin/inquiries/abc'), { action: 'unavailable' });
  assert.deepEqual(adminGate({ ok: false, reason: 'unavailable' }, null), { action: 'unavailable' });
  assert.deepEqual(adminGate({ ok: false, reason: 'internal' }, '/admin/users'), { action: 'internal' });
});

test('wrong role → 404, correct role → render', () => {
  assert.deepEqual(adminGate({ ok: false, reason: 'forbidden' }, '/admin'), { action: 'notFound' });
  for (const p of ['/admin', '/admin/inquiries', '/admin/x']) assert.deepEqual(adminGate({ ok: false, reason: 'disabled' }, p), { action: 'notFound' }, 'disabled → 404, not login');
  assert.deepEqual(adminGate({ ok: true, role: 'ADMIN' }, '/admin'), { action: 'render' });
  assert.deepEqual([...ADMIN_AREA_ROLES].sort(), ['ADMIN', 'EDITOR', 'SALES']);
});

test('admin layout: server-side check before render, noindex, AdminGuard removed', () => {
  const src = readFileSync('src/app/admin/layout.tsx', 'utf8');
  assert.ok(!src.includes("'use client'"));
  const order = ['checkAdminSession(', 'adminGate(', 'redirect(gate.to)', 'notFound()', '<AdminShell'] .map((s) => src.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  assert.match(src, /robots: \{ index: false, follow: false \}/);
  assert.match(src, /dynamic = 'force-dynamic'/);
  assert.ok(!existsSync('src/components/admin/AdminGuard.tsx'));
  assert.ok(!readFileSync('src/components/admin/AdminShell.tsx', 'utf8').includes('AdminGuard'));
  const mw = readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /'\/admin', '\/admin\/:path\*'/);
});

const g = (role: string, p: string | null) => adminGate({ ok: true, role }, p).action;

test('per-route roles: SALES', () => {
  for (const p of ['/admin/models/new', '/admin/models', '/admin/specs', '/admin/specs/gift-boxes', '/admin/settings', '/admin/users']) assert.equal(g('SALES', p), 'notFound', p);
  for (const p of ['/admin/inquiries', '/admin/inquiries/', '/admin/inquiries/abc123', '/admin/inquiries/abc?x=1', '/admin']) assert.equal(g('SALES', p), 'render', p);
});

test('per-route roles: EDITOR', () => {
  assert.equal(g('EDITOR', '/admin/inquiries'), 'notFound');
  assert.equal(g('EDITOR', '/admin/inquiries/abc'), 'notFound');
  assert.equal(g('EDITOR', '/admin/models/new'), 'render');
  assert.equal(g('EDITOR', '/admin/specs/'), 'render');
  assert.equal(g('EDITOR', '/admin/settings'), 'notFound');
});

test('unknown / missing / invalid paths default to ADMIN only', () => {
  for (const p of ['/admin/unknown', '/admin/foo/bar', '/admin/x', null, '', '//evil.com/admin/inquiries', '/admin\\inquiries']) {
    assert.deepEqual(rolesForAdminPath(p), ['ADMIN'], String(p));
    assert.equal(g('SALES', p), 'notFound');
    assert.equal(g('EDITOR', p), 'notFound');
    assert.equal(g('ADMIN', p), 'render');
  }
});

test('segment prefix: no confusion with look-alike paths', () => {
  for (const p of ['/admin/inquiries-x', '/admin/inquiriesx/1', '/admin/specs-evil', '/admin/models.json', '/adminx', '/admin/inquiries/../users']) {
    assert.equal(g('SALES', p), 'notFound', p);
    assert.equal(g('EDITOR', p), 'notFound', p);
  }
  assert.equal(g('EDITOR', '/admin/x'), 'notFound'); // /admin 仅精确匹配
});
