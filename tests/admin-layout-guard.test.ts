import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { safeCallbackPath, adminLoginHref } from '../src/lib/admin/safe-callback';
import { adminGate, ADMIN_AREA_ROLES } from '../src/lib/server/admin/layout-gate';

const cb = (to: string) => new URL(to, 'https://x.test').searchParams.get('callbackUrl')!;

test('unauthenticated → redirect to signin with same-site callbackUrl', () => {
  const g = adminGate({ ok: false, status: 401 }, '/admin/specs/gift-boxes?tab=ru');
  assert.equal(g.action, 'redirect');
  assert.ok(g.action === 'redirect' && g.to.startsWith('/api/auth/signin?callbackUrl='));
  assert.equal(g.action === 'redirect' && cb(g.to), '/admin/specs/gift-boxes?tab=ru');
  const none = adminGate({ ok: false, status: 401 }, null);
  assert.equal(none.action === 'redirect' && cb(none.to), '/admin');
});

test('open-redirect attempts fall back to /admin', () => {
  for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/\t/evil.com', '/%0a', ' /admin', '', 'admin', '/' + 'a'.repeat(3000)]) {
    const r = safeCallbackPath(bad);
    assert.ok(r === '/admin' || (r.startsWith('/') && !r.startsWith('//')), bad);
    if (bad !== '/%0a') assert.equal(r, '/admin', JSON.stringify(bad));
    assert.equal(cb(adminLoginHref(bad)), r);
  }
  assert.equal(safeCallbackPath('/admin/inquiries/abc'), '/admin/inquiries/abc');
});

test('wrong role → 404, correct role → render', () => {
  assert.deepEqual(adminGate({ ok: false, status: 403 }, '/admin'), { action: 'notFound' });
  assert.deepEqual(adminGate({ ok: true }, '/admin'), { action: 'render' });
  assert.deepEqual([...ADMIN_AREA_ROLES].sort(), ['ADMIN', 'EDITOR', 'SALES']);
});

test('admin layout: server-side check before render, noindex, AdminGuard removed', () => {
  const src = readFileSync('src/app/admin/layout.tsx', 'utf8');
  assert.ok(!src.includes("'use client'"));
  const order = ['checkAdminSession(', 'adminGate(', 'redirect(gate.to)', 'notFound()', '<AdminShell>'].map((s) => src.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  assert.match(src, /robots: \{ index: false, follow: false \}/);
  assert.match(src, /dynamic = 'force-dynamic'/);
  assert.ok(!existsSync('src/components/admin/AdminGuard.tsx'));
  assert.ok(!readFileSync('src/components/admin/AdminShell.tsx', 'utf8').includes('AdminGuard'));
  const mw = readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /'\/admin', '\/admin\/:path\*'/);
});
