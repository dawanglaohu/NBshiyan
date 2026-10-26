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

test('/admin/users: an internal fault stays on the page like a database outage', () => {
  assert.deepEqual(adminPageGate({ ok: false, reason: 'internal' }, '/admin/users'), { action: 'internal' });
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

test('every admin route handler calls requireAdmin or secretMatches', async () => {
  const { existsSync, readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = 'src/app/api/admin';
  assert.equal(existsSync(root), true);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length >= 1);
  for (const file of files) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const exportsHandler = /export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(src);
    if (!exportsHandler) continue;
    assert.ok(src.includes('requireAdmin(') || src.includes('secretMatches('), file);
  }
});

test('admin-login contains only the page, layout, and stylesheet, with no server data import', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  assert.deepEqual(readdirSync('src/app/admin-login').sort(), ['layout.tsx', 'login.css', 'page.tsx']);
  for (const name of ['layout.tsx', 'login.css', 'page.tsx']) {
    const src = readFileSync(`src/app/admin-login/${name}`, 'utf8');
    assert.doesNotMatch(src, /prisma|@prisma\/client|from ['"][^'"]*\/db['"]/);
  }
});
