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

test('/admin/users: database unavailable does not redirect or 404', () => {
  assert.deepEqual(adminPageGate({ ok: false, reason: 'unavailable' }, '/admin/users'), { action: 'unavailable' });
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

test('every /admin page is server-checked: enforceAdminPage before render, or a pure redirect', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pages: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === 'page.tsx') pages.push(p); } };
  walk('src/app/admin');
  assert.ok(pages.length >= 5);
  for (const p of pages) {
    const s = readFileSync(p, 'utf8');
    assert.ok(!s.includes("'use client'"), p);
    const pureRedirect = /export default function \w*\(\) \{ redirect\('\/admin[^']*'\); \}/.test(s);
    const guarded = s.includes('await enforceAdminPage(') && s.indexOf('await enforceAdminPage(') < s.lastIndexOf('return');
    assert.ok(pureRedirect || guarded, `${p} must call enforceAdminPage before rendering`);
  }
});
