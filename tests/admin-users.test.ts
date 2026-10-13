import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditDiff, bumpsSession, checkUserChange, normalizeAccountEmail, removesActiveAdmin } from '../src/lib/server/admin/user-policy';
import { errorSummary } from '../src/lib/server/admin/audit';
import { rolesForAdminPath } from '../src/lib/server/admin/layout-gate';

const admin = (id: string, disabled = false) => ({ id, role: 'ADMIN' as const, disabled });
const sales = (id: string) => ({ id, role: 'SALES' as const, disabled: false });

test('admin cannot disable, demote or delete themselves', () => {
  for (const c of [{ disabled: true }, { role: 'SALES' as const }, { role: 'EDITOR' as const }, 'delete' as const, { name: 'x' }])
    assert.equal(checkUserChange('a1', admin('a1'), c, 5), 'cannot_modify_self', JSON.stringify(c));
});

test('never leave zero active ADMINs', () => {
  assert.equal(checkUserChange('a1', admin('a2'), { disabled: true }, 0), 'last_admin');
  assert.equal(checkUserChange('a1', admin('a2'), { role: 'EDITOR' }, 0), 'last_admin');
  assert.equal(checkUserChange('a1', admin('a2'), 'delete', 0), 'last_admin');
  assert.equal(checkUserChange('a1', admin('a2'), { disabled: true }, 1), null);
  assert.equal(checkUserChange('a1', admin('a2', true), { role: 'SALES' }, 0), null, 'already-disabled admin is not active');
  assert.equal(checkUserChange('a1', sales('s1'), { disabled: true }, 0), null);
  assert.equal(removesActiveAdmin(admin('a2'), { role: 'ADMIN' }), false);
  assert.equal(removesActiveAdmin(admin('a2'), { name: 'n' }), false);
});

test('mutateUser calls assertNotLastActiveAdmin inside the same transaction, before the write', () => {
  const src = readFileSync('src/lib/server/admin/accounts.ts', 'utf8');
  const fn = src.slice(src.indexOf('export async function mutateUser'));
  const order = ['$transaction', 'pg_advisory_xact_lock', 'checkUserChange(', 'assertNotLastActiveAdmin(tx, t.id)', 'return fn(tx, t)'].map((s) => fn.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
});

test('disabling / role change / enable / unlock invalidate sessions (sessionVersion+1)', () => {
  assert.ok(bumpsSession({ disabled: true }));
  assert.ok(bumpsSession({ disabled: false }));
  assert.ok(bumpsSession({ role: 'SALES' }));
  assert.ok(bumpsSession({ unlock: true }));
  assert.ok(!bumpsSession({ name: 'x' }));
  const r = readFileSync('src/app/api/admin/users/[id]/route.ts', 'utf8');
  assert.match(r, /bumpsSession\(b\) \? \{ sessionVersion: \{ increment: 1 \} \}/);
});

test('normalizeAccountEmail: trim + NFKC + lowercase, keeps +tag and dots', () => {
  assert.equal(normalizeAccountEmail('  Ryan.J+ops@Example.COM '), 'ryan.j+ops@example.com');
  assert.equal(normalizeAccountEmail('ＡＢ@example.com'), 'ab@example.com');
});

test('audit diff records old→new, never secrets', () => {
  const d = auditDiff({ role: 'ADMIN', disabled: false, name: 'A' }, { role: 'SALES', disabled: true, name: 'A' }, { role: 'SALES', disabled: true });
  assert.deepEqual(d.changes, { role: { from: 'ADMIN', to: 'SALES' }, disabled: { from: false, to: true } });
  assert.ok(!/password|hash|totp|recovery|secret/i.test(JSON.stringify(d)));
});

test('routes: requireAdmin → assertSameOrigin → awaited rate limit → zod; audit with actor/target/ip; no secrets in responses', () => {
  for (const f of ['src/app/api/admin/users/route.ts', 'src/app/api/admin/users/[id]/route.ts']) {
    const src = readFileSync(f, 'utf8');
    for (const m of ['POST', 'PATCH', 'DELETE']) {
      const i = src.indexOf(`export async function ${m}`);
      if (i < 0) continue;
      const body = src.slice(i, src.indexOf('\nexport', i + 10) > 0 ? src.indexOf('\nexport', i + 10) : undefined);
      const order = ["requireAdmin(req, ['ADMIN'])", 'assertSameOrigin(req)', 'await enforceAdminRateLimit('].map((s) => body.indexOf(s));
      assert.ok(order.every((x, n) => x >= 0 && (n === 0 || x > order[n - 1])), `${f} ${m} ${order}`);
      if (m !== 'DELETE') assert.ok(body.indexOf('safeParse') > order[2], `${f} ${m} zod after guards`);
      assert.match(body, /audit\(\{ actorId: ctx\.user\.id, action: 'user\.[a-z]+', target: [a-z.]+, meta: .*ip: ctx\.ip \}\)/);
    }
    assert.ok(!/passwordHash|totpSecret|recoveryCodes/.test(src.replace(/passwordHash: await hashPassword/, '')), f);
  }
  assert.match(readFileSync('src/app/api/admin/users/route.ts', 'utf8'), /transform\(normalizeAccountEmail\)/);
});

test('publicUser exposes no password hash, TOTP secret or recovery codes', async () => {
  const { publicUser } = await import('../src/lib/server/admin/accounts');
  const u = publicUser({ id: 'u', email: 'e@x.com', name: 'n', passwordHash: 'H', role: 'ADMIN', totpSecret: 'S', totpEnabled: true, totpLastStep: 1, recoveryCodes: ['R'], sessionVersion: 3, disabled: false, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(0), reactivatedAt: null, createdAt: new Date(0) });
  const s = JSON.stringify(u);
  for (const bad of ['"H"', '"S"', '"R"', 'passwordHash', 'totpSecret', 'recoveryCodes', 'sessionVersion']) assert.ok(!s.includes(bad), bad);
  assert.equal(u.lastLoginAt?.toISOString(), new Date(0).toISOString());
});

test('logs only errorSummary', () => {
  const e = Object.assign(new Error('secret data in message: hunter2'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
  assert.equal(errorSummary(e), 'PrismaClientKnownRequestError:P2002');
  assert.ok(!errorSummary(e).includes('hunter2'));
  assert.ok(!/console\.\w+\([^)]*,\s*err\s*\)/.test(readFileSync('src/lib/server/admin/audit.ts', 'utf8')));
});

test('/admin/users page: ADMIN only in layout map and own server check', () => {
  assert.deepEqual(rolesForAdminPath('/admin/users'), ['ADMIN']);
  const p = readFileSync('src/app/admin/users/page.tsx', 'utf8');
  assert.match(p, /adminPageDenied\(\['ADMIN'\]\)\) notFound\(\)/);
  assert.ok(!p.includes("'use client'"));
});
