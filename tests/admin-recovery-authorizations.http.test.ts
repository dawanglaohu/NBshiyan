import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { authenticator } from 'otplib';
import { RecoveryPermitDTOSchema } from '../src/lib/contracts/recovery';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { hashRecoveryPermitToken } from '../src/lib/server/admin/recovery-repo';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

// 与 M3-T3 共用专用测试库；缺地址由 CI 的 M3T3_REQUIRE_DATABASE=true 拦截，本地默认跳过。
const databaseUrl = process.env.M3T3_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M3T3_TEST_DATABASE_URL
  : '';
if (process.env.M3T3_REQUIRE_DATABASE === 'true' && !databaseUrl) {
  throw new Error('M3T3_TEST_DATABASE_URL must be a postgres URL when M3T3_REQUIRE_DATABASE=true');
}
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';
process.env.APP_ENV = 'test';
Object.assign(process.env, { NODE_ENV: 'test' });
process.env.AUTH_SECRET ??= 'm3t4-recovery-http-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.EDGE_AUTH_SECRET ??= 'm'.repeat(40);
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
authenticator.options = { window: 1, step: 30 };

const origin = 'http://127.0.0.1:3000';
const edge = process.env.EDGE_AUTH_SECRET;
const sessionName = 'authjs.session-token';
const password = 'correct-horse-battery';
let ipSeq = 1;
let db: PrismaClient = null as unknown as PrismaClient;
let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let postReauth: (request: Request) => Promise<Response> = async () => { throw new Error('reauth not loaded'); };
let postAuthorize: (request: Request) => Promise<Response> = async () => { throw new Error('authorize not loaded'); };
let postResetAlias: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> = async () => { throw new Error('alias not loaded'); };

function nextIp() { const n = ipSeq++; return `198.51.100.${n}`; }
function trustedHeaders(ip: string, extra: Record<string, string> = {}) {
  return { origin, 'x-edge-auth': edge, 'cf-connecting-ip': ip, ...extra };
}
function cookieJar(response: Response, previous = ''): string {
  const pairs = new Map<string, string>();
  for (const part of previous.split(';')) {
    const trimmed = part.trim(); if (!trimmed) continue;
    const name = trimmed.split('=', 1)[0] ?? '';
    pairs.set(name, trimmed.slice(name.length + 1));
  }
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const name = pair.split('=', 1)[0] ?? '';
    const value = pair.slice(name.length + 1);
    if (!value) pairs.delete(name); else pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}
function hasSession(response: Response) {
  return response.headers.getSetCookie().some((cookie) => {
    if (!cookie.startsWith(`${sessionName}=`)) return false;
    return ((cookie.split(';', 1)[0] ?? '').slice(sessionName.length + 1)).length > 0;
  });
}
function codeForStep(secret: string, step: number) { return authenticator.clone({ epoch: step * 30_000 + 5_000 }).generate(secret); }
const STEP_MS = 30_000;
// 服务端只接受严格大于 totpLastStep、且落在 ±1 窗口内的步。优先取未来一步；
// 该步已消费时同一窗口内已无合法新码，只能等真实时间推进到这一步，再取下一步。
async function unusedCode(secret: string, lastStep: number | null) {
  const choose = () => {
    const nowStep = Math.floor(Date.now() / STEP_MS);
    for (const step of [nowStep + 1, nowStep, nowStep - 1]) {
      if (lastStep === null || step > lastStep) return step;
    }
    return null;
  };
  let step = choose();
  if (step === null) {
    const waitMs = (lastStep as number) * STEP_MS + 500 - Date.now();
    if (waitMs > STEP_MS + 1_000) throw new Error('no unused totp step within one time window');
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 50)));
    step = choose();
  }
  if (step === null) throw new Error('no unused totp step in the current window');
  return codeForStep(secret, step);
}

before(async () => {
  if (!databaseUrl) return;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new Error('prisma db push failed'); }
  ({ prisma: db } = await import('../src/lib/server/db'));
  ({ handleAuth } = await import('../src/auth'));
  ({ POST: postReauth } = await import('../src/app/api/admin/account/reauth/route'));
  ({ POST: postAuthorize } = await import('../src/app/api/admin/account/recovery-authorizations/route'));
  ({ POST: postResetAlias } = await import('../src/app/api/admin/users/[id]/reset-2fa/route'));
});
after(async () => { await db?.$disconnect?.(); });

async function makeUser(over: { role?: User['role']; passwordlessEnabled?: boolean } = {}) {
  const plain = authenticator.generateSecret();
  const email = `m3t4-http-${randomBytes(4).toString('hex')}@example.com`;
  const row = await db.user.create({
    data: {
      email, name: 'Ada', passwordHash: await hashSecret(password), role: over.role ?? 'ADMIN',
      totpSecret: encrypt(plain), totpEnabled: true, passwordlessEnabled: over.passwordlessEnabled ?? false,
    },
  });
  return { row, email, plain };
}
async function csrf(ip: string) {
  const response = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: trustedHeaders(ip) }));
  const body = await response.json() as { csrfToken: string };
  return { token: body.csrfToken, jar: cookieJar(response) };
}
async function postLogin(fields: Record<string, string>, ip: string) {
  const first = await csrf(ip);
  const form = new URLSearchParams({ csrfToken: first.token, callbackUrl: `${origin}/admin`, ...fields });
  const response = await handleAuth(new Request(`${origin}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip), 'content-type': 'application/x-www-form-urlencoded', cookie: first.jar },
    body: form,
  }));
  return { response, jar: cookieJar(response, first.jar) };
}
async function grantFor(actor: { row: User; email: string; plain: string }, jar: string, targetId: string, ip: string) {
  const fresh = await unusedCode(actor.plain, (await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).totpLastStep);
  const response = await postReauth(new Request(`${origin}/api/admin/account/reauth`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'RECOVERY_AUTHORIZE', targetId, password, totp: fresh }),
  }));
  assert.equal(response.status, 200, 'fresh ADMIN grant must be issued');
  return (await response.json() as { token: string }).token;
}
function authorize(jar: string, body: unknown, ip: string, headerOrigin = origin) {
  return postAuthorize(new Request(`${origin}/api/admin/account/recovery-authorizations`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip, { origin: headerOrigin }), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
function resetAlias(jar: string, id: string, body: unknown, ip: string, headerOrigin = origin) {
  return postResetAlias(new Request(`${origin}/api/admin/users/${id}/reset-2fa`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip, { origin: headerOrigin }), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}
function permitRows(targetId: string) { return db.adminRecoveryPermit.findMany({ where: { targetUserId: targetId } }); }
function grantRows(userId: string) { return db.adminActionGrant.findMany({ where: { userId } }); }

describe('POST /api/admin/account/recovery-authorizations', { concurrency: 1, skip }, () => {
  test('E-13 fresh ADMIN grant issues one 15min permit; hash only, target factors unchanged, audit in same tx', { timeout: 180_000 }, async () => {
    const actor = await makeUser({ role: 'ADMIN' });
    const target = await makeUser({ role: 'EDITOR' });
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    assert.equal(hasSession(signed.response), true);
    const before = await db.user.findUniqueOrThrow({ where: { id: target.row.id } });
    const grant = await grantFor(actor, signed.jar, target.row.id, ip);

    const response = await authorize(signed.jar, { targetUserId: target.row.id, reason: 'lost authenticator device', actionGrant: grant }, ip);
    assert.equal(response.status, 200);
    const body = RecoveryPermitDTOSchema.parse(await response.json());
    assert.equal(Buffer.from(body.token, 'base64url').length, 32);
    const remaining = Date.parse(body.expiresAt) - Date.now();
    assert.ok(remaining > 13 * 60_000 && remaining <= 15 * 60_000);

    const rows = await permitRows(target.row.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tokenHash, hashRecoveryPermitToken(body.token));
    assert.equal(JSON.stringify(rows).includes(body.token), false, 'permit plaintext never stored');
    assert.equal(rows[0]?.source, 'ADMIN');
    assert.equal(rows[0]?.issuedById, actor.row.id);
    assert.equal(rows[0]?.targetUserId, target.row.id);
    assert.equal(rows[0]?.sessionVersion, before.sessionVersion);
    assert.equal(rows[0]?.consumedAt, null);
    const after = await db.user.findUniqueOrThrow({ where: { id: target.row.id } });
    assert.equal(after.totpSecret, before.totpSecret);
    assert.equal(after.totpEnabled, before.totpEnabled);
    assert.deepEqual(after.recoveryCodes, before.recoveryCodes);
    assert.equal(after.sessionVersion, before.sessionVersion, 'no factor reset or sv bump at permit issuance');
    const used = (await grantRows(actor.row.id)).find((g) => g.purpose === 'RECOVERY_AUTHORIZE');
    assert.ok(used?.usedAt, 'grant consumed in the same transaction');
    const issuedAudit = await db.auditLog.findMany({ where: { action: 'recovery.issued', target: target.row.id } });
    assert.equal(issuedAudit.length, 1);
    assert.deepEqual(issuedAudit[0]?.meta, { source: 'ADMIN', reason: 'lost authenticator device' });
    assert.equal((issuedAudit[0]?.meta as Record<string, unknown>).token, undefined);
  });

  test('E-73 one grant cannot issue a second permit: replay, wrong purpose, wrong target, response loss not retried', { timeout: 180_000 }, async () => {
    const actor = await makeUser({ role: 'ADMIN' });
    const target = await makeUser({ role: 'EDITOR' });
    const other = await makeUser({ role: 'EDITOR' });
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    const grant = await grantFor(actor, signed.jar, target.row.id, ip);

    const ok = await authorize(signed.jar, { targetUserId: target.row.id, reason: 'lost device', actionGrant: grant }, ip);
    assert.equal(ok.status, 200);
    const replay = await authorize(signed.jar, { targetUserId: target.row.id, reason: 'lost device', actionGrant: grant }, ip);
    assert.equal(replay.status, 401);
    assert.equal((await replay.json() as { error: string }).error, 'action_grant_invalid');
    const wrongTarget = await authorize(signed.jar, { targetUserId: other.row.id, reason: 'lost device', actionGrant: grant }, ip);
    assert.equal(wrongTarget.status, 401);
    assert.equal((await permitRows(target.row.id)).length, 1, 'no second permit');
    assert.equal((await permitRows(other.row.id)).length, 0);

    // 目的不符：PASSWORD grant 不能用来签 permit，目标因素不变。
    const fresh = await unusedCode(actor.plain, (await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).totpLastStep);
    const pwGrant = await postReauth(new Request(`${origin}/api/admin/account/reauth`, {
      method: 'POST', headers: { ...trustedHeaders(ip), cookie: signed.jar, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'PASSWORD', password, totp: fresh }),
    }));
    assert.equal(pwGrant.status, 200);
    const pwToken = (await pwGrant.json() as { token: string }).token;
    const wrongPurpose = await authorize(signed.jar, { targetUserId: other.row.id, reason: 'lost device', actionGrant: pwToken }, ip);
    assert.equal(wrongPurpose.status, 401);
    assert.equal((await permitRows(other.row.id)).length, 0);
  });

  test('E-13/E-75 legacy no-body reset, session-only, anonymous, SALES/EDITOR, and self are refused with target unchanged', { timeout: 180_000 }, async () => {
    const actor = await makeUser({ role: 'ADMIN' });
    const target = await makeUser({ role: 'EDITOR' });
    const sales = await makeUser({ role: 'SALES' });
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    const before = await db.user.findUniqueOrThrow({ where: { id: target.row.id } });

    const noBody = await resetAlias(signed.jar, target.row.id, {}, ip);
    assert.equal(noBody.status, 400);
    assert.equal((await noBody.json() as { error: string }).error, 'invalid');
    const sessionOnly = await authorize(signed.jar, { targetUserId: target.row.id, reason: 'x' }, ip);
    assert.equal(sessionOnly.status, 400);
    const anonymous = await authorize('', { targetUserId: target.row.id, reason: 'x', actionGrant: 'a'.repeat(43) }, nextIp());
    assert.equal(anonymous.status, 401);
    const crossOrigin = await authorize(signed.jar, { targetUserId: target.row.id, reason: 'x', actionGrant: 'a'.repeat(43) }, ip, 'https://evil.example');
    assert.equal(crossOrigin.status, 403);
    const selfGrant = await grantFor(actor, signed.jar, target.row.id, ip);
    const self = await authorize(signed.jar, { targetUserId: actor.row.id, reason: 'x', actionGrant: selfGrant }, ip);
    assert.equal(self.status, 401);

    const salesSigned = await postLogin({ email: sales.email, password, totp: authenticator.generate(sales.plain) }, nextIp());
    const salesDenied = await authorize(salesSigned.jar, { targetUserId: target.row.id, reason: 'x', actionGrant: 'a'.repeat(43) }, nextIp());
    assert.equal(salesDenied.status, 403);
    assert.equal((await salesDenied.json() as { error: string }).error, 'forbidden');

    const after = await db.user.findUniqueOrThrow({ where: { id: target.row.id } });
    assert.equal(after.totpSecret, before.totpSecret);
    assert.equal(after.totpEnabled, before.totpEnabled);
    assert.deepEqual(after.recoveryCodes, before.recoveryCodes);
    assert.equal(after.sessionVersion, before.sessionVersion);
    assert.equal((await permitRows(target.row.id)).length, 0);
  });

  test('compatible alias consumes the same grant and returns the same RecoveryPermitDTO once', { timeout: 180_000 }, async () => {
    const actor = await makeUser({ role: 'ADMIN' });
    const target = await makeUser({ role: 'EDITOR' });
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    const grant = await grantFor(actor, signed.jar, target.row.id, ip);
    const response = await resetAlias(signed.jar, target.row.id, { reason: 'lost device', actionGrant: grant }, ip);
    assert.equal(response.status, 200);
    const body = RecoveryPermitDTOSchema.parse(await response.json());
    assert.equal((await permitRows(target.row.id)).length, 1);
    assert.equal((await permitRows(target.row.id))[0]?.tokenHash, hashRecoveryPermitToken(body.token));
    const replay = await resetAlias(signed.jar, target.row.id, { reason: 'lost device', actionGrant: grant }, ip);
    assert.equal(replay.status, 401);
    assert.equal((await permitRows(target.row.id)).length, 1);
  });
});
