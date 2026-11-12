// M3-T20 真实 PG/HTTP 验收：合法本人 reauth→TOTP_RESET grant→reset→SELF_REAUTH enroll/confirm。
//
// 本文件只在显式提供隔离库时运行；缺库整体 skip 并在报告里记为未跑，不冒充 PG 绿。
// - 基础 env：B10_M3T20_TEST_DATABASE_URL（loopback、无 schema、非通用 DATABASE_URL）
//   + B10_M3T20_REQUIRE_DATABASE=true 时缺地址即抛错。
// - 每次运行创建独占随机 schema m3t20_<pid>_<hex>，prisma db push 后校验 current_database/current_user/current_schema，
//   结束后只 DROP 本 schema；不向 M3T3 旧套件灌 m3t20 URL。
// - HTTP 段另需 B10_M3T20_STANDALONE_DIR（同次 build 的 .next/standalone，含 server.js 与复制后的 static/public）；
//   由本文件以同一 DATABASE_URL（本 schema）启动，走真实 socket/Next HTTP。缺产物即 skip 并记为实例阶段未跑。
import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { decrypt, encrypt, hashSecret, verifySecret } from '../src/lib/server/admin/crypto';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import { AppError } from '../src/lib/server/http/errors';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import { classifySelfResetBody } from '../src/lib/server/admin/self-rebind';

process.env.APP_ENV ??= 'test';
process.env.AUTH_SECRET ??= 'm3t20-db-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 11).toString('base64');
authenticator.options = { window: 1, step: 30 };

const PASSWORD = 'm3t20-db-test-pw-20261112';
const REQUIRE_DB = process.env.B10_M3T20_REQUIRE_DATABASE === 'true';

/**
 * 只接受 loopback 基础库 URL，且不得自带 schema（schema 由本测试独占创建）。
 * 不回退通用 DATABASE_URL；不打印 URL 或口令。
 */
export function validateBaseDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error('B10_M3T20_TEST_DATABASE_URL is required when B10_M3T20_REQUIRE_DATABASE=true');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('B10_M3T20_TEST_DATABASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('B10_M3T20_TEST_DATABASE_URL must use the postgres scheme');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('B10_M3T20_TEST_DATABASE_URL must point at loopback');
  }
  if (parsed.searchParams.has('schema')) {
    throw new Error('B10_M3T20_TEST_DATABASE_URL must not carry schema; the test creates its own');
  }
  if (!parsed.pathname.replace(/^\//, '')) throw new Error('B10_M3T20_TEST_DATABASE_URL must name a database');
  return raw;
}

const rawDatabaseUrl = process.env.B10_M3T20_TEST_DATABASE_URL;
const baseDatabaseUrl = rawDatabaseUrl
  ? validateBaseDatabaseUrl(rawDatabaseUrl)
  : (REQUIRE_DB ? validateBaseDatabaseUrl(undefined) : '');
const skipDatabase = !baseDatabaseUrl && 'no dedicated B10_M3T20_TEST_DATABASE_URL';

const schema = `m3t20_${process.pid}_${randomBytes(4).toString('hex')}`;
if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema)) throw new Error('invalid test schema name');

let databaseUrl = '';
if (baseDatabaseUrl) {
  const parsed = new URL(baseDatabaseUrl);
  parsed.searchParams.set('schema', schema);
  databaseUrl = parsed.toString();
}
const databaseName = baseDatabaseUrl ? decodeURIComponent(new URL(baseDatabaseUrl).pathname.replace(/^\//, '')) : '';
const databaseUser = baseDatabaseUrl ? decodeURIComponent(new URL(baseDatabaseUrl).username) : '';

let adminDb: PrismaClient | null = null;
let db: PrismaClient = null as unknown as PrismaClient;
let actionGrants: import('../src/lib/server/admin/action-grant').ActionGrantService;
let selfRebind: import('../src/lib/server/admin/self-rebind').SelfRebindService;
let recoveryEnrollment: import('../src/lib/server/admin/recovery-enrollment').RecoveryEnrollmentService;
let recoveryRepo: import('../src/lib/server/admin/recovery-repo').RecoveryRepo;

const start = new Date('2026-11-12T09:00:00.000Z');
let now = start;
const clock = () => now;

function codeAt(secret: string, at: Date): string {
  return authenticator.clone({ epoch: at.getTime() }).generate(secret);
}

before(async () => {
  if (!baseDatabaseUrl) return;
  setRateLimitStore(new MemoryStore());
  adminDb = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
  await adminDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.env.DATABASE_URL = databaseUrl;
  const loaded = await import('../src/lib/server/db');
  db = loaded.prisma;
  const [identity] = await db.$queryRawUnsafe<{ database: string; user: string; schema: string }[]>(
    'SELECT current_database() AS database, current_user AS "user", current_schema() AS schema',
  );
  assert.equal(identity.database, databaseName, 'current_database must match the dedicated URL');
  assert.equal(identity.user, databaseUser, 'current_user must match the dedicated URL');
  assert.equal(identity.schema, schema, 'search_path must resolve to the owned schema');
  const grantMod = await import('../src/lib/server/admin/action-grant');
  const rebindMod = await import('../src/lib/server/admin/self-rebind');
  const enrollMod = await import('../src/lib/server/admin/recovery-enrollment');
  const repoMod = await import('../src/lib/server/admin/recovery-repo');
  recoveryRepo = repoMod.createRecoveryRepo();
  actionGrants = grantMod.createActionGrantService({ db, clock });
  selfRebind = rebindMod.createSelfRebindService({ db, clock, grants: actionGrants });
  recoveryEnrollment = enrollMod.createRecoveryEnrollmentService({ db, clock });
});

after(async () => {
  await db?.$disconnect?.();
  if (adminDb) {
    await adminDb.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await adminDb.$disconnect().catch(() => undefined);
  }
});

async function makeAccount(): Promise<{ user: User; deviceId: string; plain: string }> {
  const plain = authenticator.generateSecret();
  const email = `m3t20-${randomBytes(5).toString('hex')}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      name: 'Self rebind acceptance',
      passwordHash: await hashSecret(PASSWORD),
      role: 'ADMIN',
      totpSecret: encrypt(plain),
      totpEnabled: true,
      recoveryCodes: [await hashSecret('old-recovery-code')],
    },
  });
  const device = await db.adminDeviceSession.create({
    data: {
      id: randomBytes(24).toString('base64url'),
      userId: user.id,
      sessionVersion: user.sessionVersion,
      remembered: false,
      createdAt: start,
      lastActivityAt: start,
      hardExpiresAt: new Date(start.getTime() + ADMIN_SESSION_POLICY.ordinaryAbsoluteMs),
    },
  });
  return { user, deviceId: device.id, plain };
}

async function issueResetGrant(member: { user: User; deviceId: string; plain: string }) {
  return actionGrants.issue({
    userId: member.user.id,
    sid: member.deviceId,
    purpose: 'TOTP_RESET',
    password: PASSWORD,
    totp: codeAt(member.plain, now),
  });
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

async function userRow(userId: string) {
  return db.user.findUniqueOrThrow({ where: { id: userId } });
}

describe('M3-T20 隔离库 URL 校验（无库可跑）', () => {
  test('只接受 loopback、无 schema、非空库名、postgres scheme', () => {
    assert.throws(() => validateBaseDatabaseUrl(undefined), /required/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://u:p@db.example.com:5432/e2e'), /loopback/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://u:p@127.0.0.1:5432/e2e?schema=m3t20'), /must not carry schema/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://u:p@127.0.0.1:5432/'), /name a database/);
    assert.throws(() => validateBaseDatabaseUrl('mysql://u:p@127.0.0.1:5432/e2e'), /postgres/);
    assert.equal(
      validateBaseDatabaseUrl('postgresql://u:p@127.0.0.1:5432/b10_m3t20_20261112'),
      'postgresql://u:p@127.0.0.1:5432/b10_m3t20_20261112',
    );
  });
});

describe('M3-T20 真实 PG：reset→enroll→confirm', { concurrency: 1, skip: skipDatabase }, () => {
  test('合法本人 reauth 签 grant→reset 建 SELF_REAUTH 且旧因素保留', async () => {
    now = start;
    const member = await makeAccount();
    const before = await userRow(member.user.id);
    const grant = await issueResetGrant(member);
    const grantRow = await db.adminActionGrant.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.equal(grantRow.usedAt, null);
    assert.equal(grantRow.purpose, 'TOTP_RESET');

    const result = await selfRebind.rebind({
      kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: grant.token, ip: '203.0.113.10',
    });
    const afterReset = await userRow(member.user.id);
    assert.equal(afterReset.sessionVersion, before.sessionVersion + 1);
    assert.equal(afterReset.totpSecret, before.totpSecret, '旧 TOTP 保留到 confirm');
    assert.equal(afterReset.totpEnabled, true);
    assert.equal(afterReset.passwordHash, before.passwordHash, '密码字节不变');
    assert.deepEqual(afterReset.recoveryCodes, before.recoveryCodes, '旧恢复码保留到 confirm');

    const device = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: member.deviceId } });
    assert.ok(device.revokedAt, '旧设备被撤销');
    assert.equal(device.revokedReason, 'self_reauth');
    const used = await db.adminActionGrant.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.ok(used.usedAt, 'grant 在 reset 事务内消费');

    const session = await db.adminRecoverySession.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.equal(session.source, 'SELF_REAUTH');
    assert.equal(session.pendingPasswordHash, null);
    assert.equal(session.passwordResetSource, null);
    assert.equal(session.sessionVersion, afterReset.sessionVersion);
    assert.equal(session.completedAt, null);
    assert.equal(session.revokedAt, null);

    const audits = await db.auditLog.findMany({ where: { actorId: member.user.id }, orderBy: { createdAt: 'asc' } });
    assert.ok(audits.some((row) => row.action === 'account.2fa_reset'));
    assert.equal(result.page, '/admin-recovery');
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  });

  test('enroll 首次写 pending；重入返回同 URI/同期限；sv 不变', async () => {
    now = start;
    const member = await makeAccount();
    const grant = await issueResetGrant(member);
    const { token } = await selfRebind.rebind({
      kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: grant.token, ip: null,
    });
    const before = await userRow(member.user.id);
    const first = await recoveryEnrollment.enroll({ token, ip: '203.0.113.11' });
    const secret = new URL(first.otpauthUri).searchParams.get('secret');
    assert.ok(secret && secret.length >= 16);
    const pending = await db.adminRecoverySession.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.equal(decrypt(pending.pendingSecretEncrypted as string), secret);
    assert.equal(pending.pendingUntil?.toISOString(), first.expiresAt.toISOString());
    const reentry = await recoveryEnrollment.enroll({ token });
    assert.equal(reentry.otpauthUri, first.otpauthUri);
    assert.equal(reentry.expiresAt.toISOString(), first.expiresAt.toISOString());
    const after = await userRow(member.user.id);
    assert.equal(after.sessionVersion, before.sessionVersion, 'enroll 不递增 sv');
    assert.equal(after.totpSecret, before.totpSecret, 'enroll 不换旧 TOTP');
    assert.equal(after.passwordHash, before.passwordHash);
  });

  test('confirm 一次成功：原子发布新 TOTP+10 恢复码，密码不变，旧 TOTP 失效', async () => {
    now = start;
    const member = await makeAccount();
    const before = await userRow(member.user.id);
    const grant = await issueResetGrant(member);
    const { token } = await selfRebind.rebind({
      kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: grant.token, ip: null,
    });
    now = new Date(start.getTime() + 60_000);
    const enrolled = await recoveryEnrollment.enroll({ token });
    const secret = new URL(enrolled.otpauthUri).searchParams.get('secret');
    assert.ok(secret);
    const afterReset = await userRow(member.user.id);
    const oldCodeAtNow = codeAt(member.plain, now);
    assert.equal(authenticator.clone({ epoch: now.getTime() }).check(oldCodeAtNow, decrypt(afterReset.totpSecret as string)), true);

    const completed = await recoveryEnrollment.confirm({ token, totp: codeAt(secret, now), ip: '203.0.113.12' });
    assert.equal(completed.recoveryCodes.length, 10);
    assert.equal(new Set(completed.recoveryCodes).size, 10);
    const final = await userRow(member.user.id);
    assert.equal(decrypt(final.totpSecret as string), secret);
    assert.equal(final.totpEnabled, true);
    assert.equal(final.passwordHash, before.passwordHash, 'SELF_REAUTH 不改密码');
    assert.equal(final.sessionVersion, afterReset.sessionVersion + 1, 'confirm 再递增 sv');
    assert.equal(final.recoveryCodes.length, 10);
    for (let i = 0; i < completed.recoveryCodes.length; i += 1) {
      assert.equal(await verifySecret(final.recoveryCodes[i], completed.recoveryCodes[i]), true);
    }
    assert.equal(authenticator.clone({ epoch: now.getTime() }).check(codeAt(member.plain, now), decrypt(final.totpSecret as string)), false);
    assert.equal(authenticator.clone({ epoch: now.getTime() }).check(codeAt(secret, now), decrypt(final.totpSecret as string)), true);

    const session = await db.adminRecoverySession.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.ok(session.completedAt, '受限会话已消费');
    assert.equal(session.pendingSecretEncrypted, null);
    const audits = await db.auditLog.findMany({ where: { actorId: member.user.id }, orderBy: { createdAt: 'asc' } });
    const done = audits.find((row) => row.action === 'recovery.completed');
    assert.ok(done);
    const meta = done.meta as unknown as { source?: string; passwordReset?: boolean };
    assert.equal(meta.source, 'SELF_REAUTH');
    assert.equal(meta.passwordReset, false);
  });

  test('并发 confirm 仅一次成功，另一次 bad_credentials', async () => {
    now = start;
    const member = await makeAccount();
    const grant = await issueResetGrant(member);
    const { token } = await selfRebind.rebind({
      kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: grant.token, ip: null,
    });
    now = new Date(start.getTime() + 60_000);
    const enrolled = await recoveryEnrollment.enroll({ token });
    const secret = new URL(enrolled.otpauthUri).searchParams.get('secret');
    assert.ok(secret);
    const totp = codeAt(secret, now);
    const settled = await Promise.allSettled([
      recoveryEnrollment.confirm({ token, totp }),
      recoveryEnrollment.confirm({ token, totp }),
    ]);
    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof AppError && rejected.reason.code === 'bad_credentials');
    const audits = await db.auditLog.findMany({ where: { actorId: member.user.id, action: 'recovery.completed' } });
    assert.equal(audits.length, 1);
    const session = await db.adminRecoverySession.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.ok(session.completedAt);
  });

  test('reset 后旧设备/旧 sv 不能再次走本人重绑', async () => {
    now = start;
    const member = await makeAccount();
    const grant = await issueResetGrant(member);
    await selfRebind.rebind({
      kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: grant.token, ip: null,
    });
    const locked = await db.$transaction((tx) => recoveryRepo.lockActiveAccountForSelfRebind(tx, member.user.id, member.deviceId));
    assert.equal(locked, undefined);
  });

  test('缺现密码/仅 TOTP 不能签 grant；recoveryCode 拒绝且不消费 grant', async () => {
    now = start;
    const member = await makeAccount();
    assert.throws(() => classifySelfResetBody({ totp: codeAt(member.plain, now) }), (error) => error instanceof AppError && error.code === 'invalid');
    assert.throws(() => classifySelfResetBody({ recoveryCode: '0123456789' }), (error) => error instanceof AppError && error.code === 'invalid');
    await expectAppError(actionGrants.issue({
      userId: member.user.id, sid: member.deviceId, purpose: 'TOTP_RESET', password: 'wrong-password', totp: codeAt(member.plain, now),
    }), 'bad_credentials');
    assert.equal((await db.adminActionGrant.count({ where: { userId: member.user.id } })), 0);

    now = new Date(start.getTime() + 30_000);
    const grant = await issueResetGrant(member);
    assert.throws(
      () => classifySelfResetBody({ actionGrant: grant.token, recoveryCode: '0123456789' }),
      (error) => error instanceof AppError && error.code === 'invalid' && error.fieldErrors?.recoveryCode !== undefined,
    );
    const stored = await db.adminActionGrant.findFirstOrThrow({ where: { userId: member.user.id } });
    assert.equal(stored.usedAt, null, 'recoveryCode 不得消费 grant');
    await selfRebind.rebind({ kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: grant.token, ip: null });
  });

  test('无效 grant：reset 拒绝且 sv/设备/会话/审计不变', async () => {
    now = start;
    const member = await makeAccount();
    const before = await userRow(member.user.id);
    const beforeSessions = await db.adminRecoverySession.count({ where: { userId: member.user.id } });
    const beforeAudits = await db.auditLog.count({ where: { actorId: member.user.id } });
    await expectAppError(selfRebind.rebind({
      kind: 'grant', userId: member.user.id, sid: member.deviceId, actionGrant: 'x'.repeat(43), ip: null,
    }), 'action_grant_invalid');
    const after = await userRow(member.user.id);
    assert.equal(after.sessionVersion, before.sessionVersion);
    assert.equal(after.totpSecret, before.totpSecret);
    assert.equal(await db.adminRecoverySession.count({ where: { userId: member.user.id } }), beforeSessions);
    assert.equal(await db.auditLog.count({ where: { actorId: member.user.id } }), beforeAudits);
    const device = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: member.deviceId } });
    assert.equal(device.revokedAt, null);
  });
});

// ---------------------------------------------------------------------------
// 真实 socket / Next HTTP 段（实例运行卡：B10_M3T20_STANDALONE_DIR）
// ---------------------------------------------------------------------------

const standaloneDir = process.env.B10_M3T20_STANDALONE_DIR ?? '';
const skipHttp = skipDatabase || (!standaloneDir && 'no B10_M3T20_STANDALONE_DIR');

let httpBase = '';
let standalone: ChildProcess | null = null;

function freePort(): number {
  return 3400 + (process.pid % 200);
}

async function waitForServer(child: ChildProcess, base: string): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    if (child.exitCode !== null) throw new Error(`standalone exited before readiness (code ${child.exitCode})`);
    try {
      const response = await fetch(`${base}/api/auth/csrf`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(500);
  }
  throw new Error('standalone did not become ready within 120s');
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const parts = header.split(';');
      const pair = parts[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const attrs = new Map(parts.slice(1).map((part) => {
        const at = part.indexOf('=');
        return at < 0 ? [part.trim().toLowerCase(), ''] : [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
      }));
      const maxAge = attrs.get('max-age');
      const expires = attrs.get('expires');
      const cleared = value === ''
        || (maxAge !== undefined && Number(maxAge) <= 0)
        || (expires !== undefined && Date.parse(expires) <= Date.now());
      if (cleared) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  hasSession(): boolean {
    return [...this.cookies.keys()].some((name) => /^authjs\.session-token/.test(name));
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  copyFrom(response: Response): void {
    this.absorb(response);
  }
}

async function http(pathname: string, init: RequestInit = {}, jar?: CookieJar): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('origin', httpBase);
  if (jar) {
    const cookie = jar.header();
    if (cookie) headers.set('cookie', cookie);
  }
  const response = await fetch(`${httpBase}${pathname}`, { ...init, headers, redirect: 'manual' });
  jar?.absorb(response);
  return response;
}

async function login(email: string, password: string, totp: string): Promise<{ jar: CookieJar; response: Response }> {
  const jar = new CookieJar();
  const csrfResponse = await http('/api/auth/csrf', {}, jar);
  assert.equal(csrfResponse.status, 200);
  const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
  const response = await http('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrfToken, email, password, totp, rememberDevice: 'false', callbackUrl: `${httpBase}/admin`,
    }).toString(),
  }, jar);
  return { jar, response };
}

function loginSucceeded(result: { jar: CookieJar; response: Response }): boolean {
  const location = result.response.headers.get('location') ?? '';
  return result.response.status === 302 && !location.includes('error') && result.jar.hasSession();
}

describe('M3-T20 真实 socket/Next HTTP（实例阶段）', { concurrency: 1, skip: skipHttp }, () => {
  before(async () => {
    if (!standaloneDir) return;
    const serverJs = path.join(standaloneDir, 'server.js');
    if (!existsSync(serverJs)) throw new Error('B10_M3T20_STANDALONE_DIR must contain server.js');
    const port = freePort();
    httpBase = `http://127.0.0.1:${port}`;
    standalone = spawn(process.execPath, [serverJs], {
      cwd: standaloneDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        APP_ENV: 'test',
        AUTH_TRUST_HOST: 'true',
        NEXTAUTH_URL: httpBase,
        NEXT_PUBLIC_SITE_URL: httpBase,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(standalone, httpBase);
  });

  after(async () => {
    if (!standalone || standalone.exitCode !== null) return;
    standalone.kill('SIGTERM');
    await Promise.race([once(standalone, 'exit'), delay(10_000)]);
    if (standalone.exitCode === null) standalone.kill('SIGKILL');
  });

  test('登录→reauth 签 grant→reset→受限 enroll/confirm→旧 TOTP 拒/新 TOTP 可登录', { timeout: 300_000 }, async () => {
    const member = await makeAccount();
    const firstCode = authenticator.generate(member.plain);
    const first = await login(member.user.email, PASSWORD, firstCode);
    assert.equal(loginSucceeded(first), true, '旧 TOTP 应能先登录');
    assert.equal((await http('/api/admin/account', {}, first.jar)).status, 200);

    // 仅 TOTP / 仅会话不能签 grant
    const onlyTotp = await http('/api/admin/account/reauth', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'TOTP_RESET', totp: authenticator.clone({ epoch: Date.now() + 30_000 }).generate(member.plain) }),
    }, first.jar);
    assert.equal(onlyTotp.status, 401);
    const onlyPassword = await http('/api/admin/account/reauth', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'TOTP_RESET', password: PASSWORD }),
    }, first.jar);
    assert.equal(onlyPassword.status, 401);

    const reauthCode = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(member.plain);
    const reauth = await http('/api/admin/account/reauth', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'TOTP_RESET', password: PASSWORD, totp: reauthCode }),
    }, first.jar);
    assert.equal(reauth.status, 200);
    const { token } = await reauth.json() as { token: string };

    // recoveryCode 拒绝且不消费 grant
    const rejected = await http('/api/admin/account/2fa/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionGrant: token, recoveryCode: '0123456789' }),
    }, first.jar);
    assert.equal(rejected.status, 400);

    const reset = await http('/api/admin/account/2fa/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionGrant: token }),
    }, first.jar);
    assert.equal(reset.status, 200);
    const restricted = new CookieJar();
    restricted.copyFrom(reset);
    assert.equal(restricted.has('pj_recovery'), true);

    // 旧 sv 后台 cookie 与受限 cookie 都不能访问后台
    assert.equal((await http('/api/admin/account', {}, first.jar)).status, 401);
    assert.equal((await http('/api/admin/account', {}, restricted)).status, 401);

    const enroll = await http('/api/auth-admin/recovery/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, restricted);
    assert.equal(enroll.status, 200);
    const enrolled = await enroll.json() as { otpauthUri: string; expiresAt: string };
    const newSecret = new URL(enrolled.otpauthUri).searchParams.get('secret');
    assert.ok(newSecret && newSecret.length >= 16);
    const reentry = await http('/api/auth-admin/recovery/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, restricted);
    assert.equal(reentry.status, 200);
    const reentryBody = await reentry.json() as { otpauthUri: string; expiresAt: string };
    assert.equal(reentryBody.otpauthUri, enrolled.otpauthUri);
    assert.equal(reentryBody.expiresAt, enrolled.expiresAt);

    const confirm = await http('/api/auth-admin/recovery/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totp: authenticator.generate(newSecret) }),
    }, restricted);
    assert.equal(confirm.status, 200);
    const completed = await confirm.json() as { completed: boolean; recoveryCodes: string[] };
    assert.equal(completed.completed, true);
    assert.equal(completed.recoveryCodes.length, 10);
    assert.equal(restricted.has('pj_recovery'), false, 'confirm 清受限 cookie');

    // 旧 TOTP 登录拒绝、新 TOTP 登录可用
    const oldLogin = await login(member.user.email, PASSWORD, authenticator.generate(member.plain));
    assert.equal(loginSucceeded(oldLogin), false);
    const newLogin = await login(member.user.email, PASSWORD, authenticator.clone({ epoch: Date.now() + 30_000 }).generate(newSecret));
    assert.equal(loginSucceeded(newLogin), true);
    assert.equal((await http('/api/admin/account', {}, newLogin.jar)).status, 200);
  });
});
