import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { anonymizeInquiriesTx } from '../src/lib/server/privacy';
import { auditEmailHash } from '../src/lib/server/admin/login';
import { normalizeEmail } from '../src/lib/server/sample';

test('anonymizeInquiriesTx also clears ipCountry', async () => {
  const calls: [string, any][] = [];
  const rec = (n: string) => async (a: any) => { calls.push([n, a]); return { count: 0 }; };
  const db = {
    inquiry: { updateMany: rec('inquiry.updateMany'), update: rec('inquiry.update') },
    inquiryItem: { updateMany: rec('x'), update: rec('x'), findMany: async () => [] },
    inquiryMessage: { updateMany: rec('x') }, inquiryNote: { updateMany: rec('x') }, sampleRequest: { updateMany: rec('x') },
    logoUpload: { deleteMany: rec('x'), findMany: async () => [] },
  };
  await anonymizeInquiriesTx(db as never, ['i1']);
  const d = calls.find((c) => c[0] === 'inquiry.updateMany')![1].data;
  assert.ok('ipCountry' in d);
  assert.equal(d.ipCountry, null);
});

test('auditEmailHash: domain-separated subkey HMAC(AUTH_SECRET, "audit-email-v1"), normalized, no plaintext', () => {
  const env = { AUTH_SECRET: 'test-secret-abc' };
  const sub = createHmac('sha256', env.AUTH_SECRET).update('audit-email-v1').digest();
  const exp = 'emailh:' + createHmac('sha256', sub).update('admin@example.com').digest('base64url').slice(0, 32);
  assert.equal(auditEmailHash(' Admin@Example.com ', env), exp);
  const direct = 'emailh:' + createHmac('sha256', env.AUTH_SECRET).update('admin@example.com').digest('base64url').slice(0, 32);
  assert.notEqual(exp, direct);
  assert.notEqual(auditEmailHash('admin@example.com', { AUTH_SECRET: 'other' }), exp);
  const devA = auditEmailHash('a@b.com', {});
  assert.equal(devA, auditEmailHash('a@b.com', {}));
  for (const h of [exp, devA]) { assert.ok(!h.includes('@')); assert.match(h, /^emailh:[A-Za-z0-9_-]{32}$/); }
});

test('every auth.login_fail audit stores the hashed email, never plaintext', () => {
  const src = readFileSync('src/lib/server/admin/login.ts', 'utf8');
  const fails = src.split('\n').filter((l) => l.includes("action: 'auth.login_fail'"));
  assert.ok(fails.length >= 4);
  for (const l of fails) assert.match(l, /target: auditEmailHash\(email\)/, l);
  assert.doesNotMatch(src, /login_fail'[^\n]*target: email[,. ]/);
});

test('auditEmailHash normalizes with normalizeEmail (same as normalizedEmail): aliases hash equal', () => {
  const env = { AUTH_SECRET: 'k' };
  const sub = createHmac('sha256', 'k').update('audit-email-v1').digest();
  const raw = ' J.Doe+tag@GoogleMail.com ';
  assert.equal(auditEmailHash(raw, env), 'emailh:' + createHmac('sha256', sub).update(normalizeEmail(raw)).digest('base64url').slice(0, 32));
  assert.equal(auditEmailHash(raw, env), auditEmailHash(normalizeEmail(raw), env));
  const src = readFileSync('src/lib/server/admin/login.ts', 'utf8');
  assert.match(src, /import \{ normalizeEmail \} from '\.\.\/sample'/);
  assert.doesNotMatch(src.slice(src.indexOf('export function auditEmailHash'), src.indexOf('export function auditEmailHash') + 400), /toLowerCase/);
});

test('auth.login_success audit stores the admin userId, never the email', () => {
  const src = readFileSync('src/lib/server/admin/login.ts', 'utf8');
  const lines = src.split('\n').filter((l) => l.includes("action: 'auth.login_success'"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /target: user\.id/);
  assert.doesNotMatch(lines[0], /target: (input\.)?email/);
});
