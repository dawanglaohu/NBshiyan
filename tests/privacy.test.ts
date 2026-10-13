import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyDeleteBody, PrivacyExportBody, emailHash, contactIdsFor, anonymizedContact, privacyHashReady } from '../src/lib/server/privacy';
import { isLogoKey } from '../src/lib/server/uploads';
import { retention, cleanupAuditLogs, clearSampleCounters, BATCH_SIZE, maxPerRun } from '../src/lib/server/retention';

process.env.AUTH_SECRET = 'test-secret-'.repeat(4);

test('delete body: email and confirmEmail must match after normalization', () => {
  assert.ok(PrivacyDeleteBody.safeParse({ email: 'John.Doe+x@gmail.com', confirmEmail: 'johndoe@googlemail.com' }).success);
  const r = PrivacyDeleteBody.safeParse({ email: 'a@acme.de', confirmEmail: 'b@acme.de' });
  assert.equal(r.success, false);
  assert.ok(!r.success && r.error.issues.some((i) => i.message === 'confirm_mismatch'));
  assert.equal(PrivacyDeleteBody.safeParse({ email: 'a@acme.de', confirm: true }).success, false);
  assert.equal(PrivacyExportBody.safeParse({ email: 'a@acme.de', extra: 1 }).success, false);
});

test('emailHash: HMAC of normalized email with PRIVACY_HASH_SECRET, no plaintext', () => {
  const env = { PRIVACY_HASH_SECRET: 'p'.repeat(32) } as unknown as NodeJS.ProcessEnv;
  const h = emailHash('John.Doe+x@gmail.com', env);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, emailHash('johndoe@gmail.com', env));
  assert.ok(!h.includes('john'));
  assert.notEqual(emailHash('johndoe@gmail.com', { PRIVACY_HASH_SECRET: 'q'.repeat(32) } as never), h);
  // 与 AUTH_SECRET 无关：轮换 AUTH_SECRET 不改变哈希
  assert.equal(emailHash('johndoe@gmail.com', { ...env, AUTH_SECRET: 'a'.repeat(40) } as never), h);
  assert.ok(!JSON.stringify(anonymizedContact(h)).includes('john'));
  assert.equal((anonymizedContact(h) as { normalizedEmail: unknown }).normalizedEmail, null);
});

test('PRIVACY_HASH_SECRET: refused in production when unset/short, dev falls back to AUTH_SECRET', () => {
  const prod = [{ VERCEL_ENV: 'production', AUTH_SECRET: 'a'.repeat(40) }, { NODE_ENV: 'production', AUTH_SECRET: 'a'.repeat(40) }, { VERCEL_ENV: 'production', PRIVACY_HASH_SECRET: 'short', AUTH_SECRET: 'a'.repeat(40) }];
  for (const e of prod) { assert.equal(privacyHashReady(e as never), false); assert.throws(() => emailHash('a@b.co', e as never)); }
  assert.ok(privacyHashReady({ VERCEL_ENV: 'production', PRIVACY_HASH_SECRET: 'p'.repeat(32) } as never));
  assert.ok(privacyHashReady({ NODE_ENV: 'development', AUTH_SECRET: 'a'.repeat(40) } as never));
  assert.equal(privacyHashReady({ NODE_ENV: 'development' } as never), false);
});

test('contactIdsFor: exact match on indexed normalizedEmail, no cap', async () => {
  let args: { where: unknown; take?: number } | undefined;
  const db = { contact: { findMany: async (a: { where: unknown; take?: number }) => { args = a; return [{ id: '1' }, { id: '2' }]; } } };
  assert.deepEqual(await contactIdsFor(db as never, 'John.Doe+x@googlemail.com'), ['1', '2']);
  assert.deepEqual(args!.where, { normalizedEmail: 'johndoe@gmail.com' });
  assert.equal(args!.take, undefined);
});

test('logo key prefix check before delete', () => {
  assert.ok(isLogoKey('logos/2026-10/abcdefghijklmnopqrstuvwx.png'));
  for (const k of ['models/x.glb', 'logos/../secret.png', '/etc/passwd', 'logos/2026-10/a.png', 'logos/2026-10/abcdefghij.svg', 'xlogos/2026-10/abcdefghij.png'])
    assert.equal(isLogoKey(k), false, k);
});

test('retention: defaults, env override, out-of-range falls back', () => {
  assert.equal(retention.auditDays, 365);
  process.env.AUDIT_RETAIN_DAYS = '90'; assert.equal(retention.auditDays, 90);
  process.env.AUDIT_RETAIN_DAYS = '5'; assert.equal(retention.auditDays, 365);
  delete process.env.AUDIT_RETAIN_DAYS;
  assert.equal(retention.sampleCounterDays, 30);
  assert.equal(retention.designTtlDays, 180);
  assert.equal(retention.designGraceDays, 90);
  assert.equal(retention.inquiryDays, 730);
});

// 模拟表：findMany 按 where 截取 id、记录每批 take
function fakeTable(n: number) {
  let rows = Array.from({ length: n }, (_, i) => `id${i}`);
  const takes: number[] = []; const wheres: unknown[] = [];
  return {
    takes, wheres, left: () => rows.length,
    findMany: async (a: { where: unknown; take: number }) => { takes.push(a.take); wheres.push(a.where); return rows.slice(0, a.take).map((id) => ({ id })); },
    deleteMany: async (a: { where: { id: { in: string[] } } }) => { const s = new Set(a.where.id.in); const before = rows.length; rows = rows.filter((r) => !s.has(r)); return { count: before - rows.length }; },
    updateMany: async (a: { where: { id: { in: string[] } } }) => { const s = new Set(a.where.id.in); const before = rows.length; rows = rows.filter((r) => !s.has(r)); return { count: before - rows.length }; },
  };
}

test('cleanup jobs: configured cutoffs, batches of 500, per-run cap', async () => {
  const now = new Date('2026-10-13T00:00:00Z');
  const audit = fakeTable(1_234), sample = fakeTable(3);
  const db = { auditLog: audit, sampleRequest: sample };
  assert.equal(await cleanupAuditLogs(db as never, now), 1_234);
  assert.deepEqual(audit.takes, [500, 500, 500]);
  assert.deepEqual(audit.wheres[0], { createdAt: { lt: new Date('2025-10-13T00:00:00Z') } });
  assert.equal(await clearSampleCounters(db as never, now), 3);
  assert.deepEqual(sample.wheres[0], { normalizedEmail: { not: null }, createdAt: { lt: new Date('2026-09-13T00:00:00Z') } });
  const big = fakeTable(5_000);
  assert.equal(await cleanupAuditLogs({ auditLog: big, sampleRequest: sample } as never, now, 1_200), 1_200);
  assert.deepEqual(big.takes, [500, 500, 200]);
  assert.equal(big.left(), 3_800);
  assert.equal(BATCH_SIZE, 500);
  process.env.RETENTION_MAX_PER_RUN = '100'; assert.equal(maxPerRun(), 20_000); // 低于一批的值回退默认
  process.env.RETENTION_MAX_PER_RUN = '5000'; assert.equal(maxPerRun(), 5_000);
  delete process.env.RETENTION_MAX_PER_RUN;
});

test('privacy routes: requireAdmin -> assertSameOrigin -> rate limit -> secret check', async () => {
  const { readFileSync } = await import('node:fs');
  for (const n of ['export', 'delete']) {
    const src = readFileSync(`src/app/api/admin/privacy/${n}/route.ts`, 'utf8');
    const idx = ["requireAdmin(req, ['ADMIN'])", 'assertSameOrigin(req)', 'enforceAdminRateLimit(req', 'privacyHashReady()', 'safeParse'].map((s) => src.indexOf(s));
    assert.ok(idx.every((v, k) => v >= 0 && (k === 0 || v > idx[k - 1])), `${n}: ${idx}`);
  }
});
