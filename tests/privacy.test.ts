import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyDeleteBody, PrivacyExportBody, emailHash, contactIdsFor, anonymizedContact } from '../src/lib/server/privacy';
import { retention, cleanupAuditLogs, clearSampleCounters } from '../src/lib/server/retention';

process.env.AUTH_SECRET = 'test-secret-'.repeat(4);

test('delete body: email and confirmEmail must match after normalization', () => {
  assert.ok(PrivacyDeleteBody.safeParse({ email: 'John.Doe+x@gmail.com', confirmEmail: 'johndoe@googlemail.com' }).success);
  const r = PrivacyDeleteBody.safeParse({ email: 'a@acme.de', confirmEmail: 'b@acme.de' });
  assert.equal(r.success, false);
  assert.ok(!r.success && r.error.issues.some((i) => i.message === 'confirm_mismatch'));
  assert.equal(PrivacyDeleteBody.safeParse({ email: 'a@acme.de', confirm: true }).success, false);
  assert.equal(PrivacyExportBody.safeParse({ email: 'a@acme.de', extra: 1 }).success, false);
});

test('emailHash: HMAC of normalized email, no plaintext, secret-dependent', () => {
  const h = emailHash('John.Doe+x@gmail.com');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, emailHash('johndoe@gmail.com'));
  assert.ok(!h.includes('john'));
  process.env.AUTH_SECRET = 'other-secret-'.repeat(4);
  assert.notEqual(emailHash('johndoe@gmail.com'), h);
  process.env.AUTH_SECRET = 'test-secret-'.repeat(4);
  assert.ok(!JSON.stringify(anonymizedContact(h)).includes('john'));
});

test('contactIdsFor: normalized match across gmail domains only', async () => {
  let where: unknown;
  const db = { contact: { findMany: async (a: { where: unknown }) => { where = a.where; return [
    { id: '1', email: 'John.Doe@gmail.com' }, { id: '2', email: 'johndoe+promo@googlemail.com' }, { id: '3', email: 'johndoe2@gmail.com' },
  ]; } } };
  assert.deepEqual(await contactIdsFor(db as never, 'johndoe@gmail.com'), ['1', '2']);
  assert.match(JSON.stringify(where), /googlemail\.com/);
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

test('cleanup jobs use the configured cutoffs', async () => {
  const now = new Date('2026-10-13T00:00:00Z');
  const seen: Record<string, unknown> = {};
  const db = {
    auditLog: { deleteMany: async (a: unknown) => { seen.audit = a; return { count: 3 }; } },
    sampleRequest: { updateMany: async (a: unknown) => { seen.sample = a; return { count: 2 }; } },
  };
  assert.equal(await cleanupAuditLogs(db as never, now), 3);
  assert.equal(await clearSampleCounters(db as never, now), 2);
  assert.deepEqual(seen.audit, { where: { createdAt: { lt: new Date('2025-10-13T00:00:00Z') } } });
  assert.deepEqual(seen.sample, { where: { normalizedEmail: { not: null }, createdAt: { lt: new Date('2026-09-13T00:00:00Z') } }, data: { normalizedEmail: null } });
});
