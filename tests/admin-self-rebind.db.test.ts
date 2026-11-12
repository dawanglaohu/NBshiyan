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
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
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
// 注意：`admin/self-rebind` 会在模块加载时值导入 `@/lib/server/db`（构造并缓存业务 Prisma）。
// 本文件必须先建好 owned schema 并把 `DATABASE_URL` 指到它，再加载该模块；因此这里只用类型，
// 运行时从 before 钩子里的同一次动态 import 取（见 `classifySelfResetBody` 的赋值处）。

process.env.APP_ENV ??= 'test';
process.env.AUTH_SECRET ??= 'm3t20-test-auth-secret-32b-0001';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 11).toString('base64');
authenticator.options = { window: 1, step: 30 };

const PASSWORD = 'm3t20-test-pw-0001';
const REQUIRE_DB = process.env.B10_M3T20_REQUIRE_DATABASE === 'true';
const LOCAL_DB = 'b10_m3t20_20261112';
const LOCAL_USER = 'b10_m3t20_app';
const CI_DB = 'e2e';
const CI_USER = 'postgres';
const CI_MODE = process.env.B10_M3T20_CI_MODE === 'true';
if (CI_MODE && process.env.CI !== 'true') throw new Error('M3T20_CI_MODE_REQUIRES_CI');
const EXPECTED_IDENTITY = { database: CI_MODE ? CI_DB : LOCAL_DB, user: CI_MODE ? CI_USER : LOCAL_USER };

/**
 * 只接受 loopback 基础库 URL，且不得自带 schema（schema 由本测试独占创建）。
 * local 模式固定本卡 b10_m3t20_20261112 / b10_m3t20_app；CI 模式必须先显式 B10_M3T20_CI_MODE=true 且 CI=true，
 * 只接受一次性 e2e/postgres。不回退通用 DATABASE_URL；不打印 URL 或口令。
 */
export function validateBaseDatabaseUrl(raw: string | undefined, mode: 'local' | 'ci' = 'local'): string {
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
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(parsed.username);
  if (!database) throw new Error('B10_M3T20_TEST_DATABASE_URL must name a database');
  if (mode === 'local' && (database !== LOCAL_DB || user !== LOCAL_USER)) {
    throw new Error('B10_M3T20_TEST_DATABASE_URL must target b10_m3t20_20261112 as b10_m3t20_app');
  }
  if (mode === 'ci' && (database !== CI_DB || user !== CI_USER)) {
    throw new Error('M3T20_CI_DATABASE_MISMATCH');
  }
  return raw;
}

const rawDatabaseUrl = process.env.B10_M3T20_TEST_DATABASE_URL;
const baseDatabaseUrl = rawDatabaseUrl
  ? validateBaseDatabaseUrl(rawDatabaseUrl, CI_MODE ? 'ci' : 'local')
  : (REQUIRE_DB ? validateBaseDatabaseUrl(undefined, CI_MODE ? 'ci' : 'local') : '');
const skipDatabase = !baseDatabaseUrl && 'no dedicated B10_M3T20_TEST_DATABASE_URL';

const schema = `m3t20_${process.pid}_${randomBytes(4).toString('hex')}`;
if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema)) throw new Error('M3T20_SCHEMA_NAME_INVALID');

let databaseUrl = '';
if (baseDatabaseUrl) {
  const parsed = new URL(baseDatabaseUrl);
  parsed.searchParams.set('schema', schema);
  databaseUrl = parsed.toString();
}

type Identity = { database: string; user: string };
type SchemaAdmin = {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
  $executeRawUnsafe: (query: string) => Promise<unknown>;
};

export function assertIdentity(identity: Identity | undefined, expected: Identity): void {
  if (!identity || identity.database !== expected.database || identity.user !== expected.user) {
    throw new Error('M3T20_DATABASE_IDENTITY_MISMATCH');
  }
}

export async function createOwnedSchema(admin: SchemaAdmin, name: string): Promise<{ created: boolean }> {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error('M3T20_SCHEMA_NAME_INVALID');
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  } catch {
    throw new Error('M3T20_SCHEMA_CREATE_FAILED');
  }
  return { created: true };
}

/** 只清理本次 CREATE 明确成功的 schema；既有同名 schema 绝不接管/删除。 */
export async function cleanupOwnedSchema(admin: SchemaAdmin, name: string, owned: boolean): Promise<void> {
  if (!owned) return;
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA "${name}" CASCADE`);
  } catch {
    throw new Error('M3T20_SCHEMA_DROP_FAILED');
  }
}

/** 身份（只读）必须在任何 CREATE/db push 之前；失败不产生副作用。 */
export async function prepareSchema(
  admin: SchemaAdmin,
  expected: Identity,
  name: string,
): Promise<{ created: boolean }> {
  const rows = await admin.$queryRawUnsafe(
    'SELECT current_database() AS database, current_user AS "user"',
  ) as Identity[];
  assertIdentity(rows[0], expected);
  return createOwnedSchema(admin, name);
}

type ExecLike = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'ignore', 'ignore'] },
) => unknown;

/** db push 失败只给安全码；不把 raw 异常/stderr/DSN 带到测试输出。 */
export function pushSchema(url: string, run: ExecLike = execFileSync as unknown as ExecLike): void {
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    run(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new Error('M3T20_DBPUSH_FAILED');
  }
}

/** 绑定 127.0.0.1:0 取空闲端口；EADDRINUSE/无端口只报安全码。 */
export async function pickFreePort(factory: () => Server = () => createServer()): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = factory();
    const fail = () => {
      try { server.close(); } catch { /* ignore */ }
      reject(new Error('M3T20_PORT_UNAVAILABLE'));
    };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error || !port) reject(new Error('M3T20_PORT_UNAVAILABLE'));
        else resolve(port);
      });
    });
  });
}

/** 有界停止本次子进程；先挂 exit/close 监听再发信号，已信号退出不再误等/误杀。 */
export async function stopChild(child: ChildProcess, graceMs = 10_000, killMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const waitExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });

  const graceful = waitExit(graceMs);
  child.kill('SIGTERM');
  if (await graceful || child.exitCode !== null || child.signalCode !== null) return;

  const forced = waitExit(killMs);
  child.kill('SIGKILL');
  if (await forced || child.exitCode !== null || child.signalCode !== null) return;
  throw new Error('M3T20_STANDALONE_KILL_FAILED');
}

export type CleanupPlan = {
  stop: () => Promise<void>;
  disconnectDb: () => Promise<void>;
  drop: () => Promise<void>;
  disconnectAdmin: () => Promise<void>;
  owned: boolean;
};

export type CleanupResult = {
  failure: string | null;
  preservedOwned: boolean;
  schemaDropped: boolean;
};

export type CleanupResources = {
  db: { $disconnect: () => Promise<void> } | null;
  adminDb: (SchemaAdmin & { $disconnect: () => Promise<void> }) | null;
  schema: string;
  schemaCreated: boolean;
  stop: () => Promise<void>;
};

/**
 * 真实 after 与负控共用同一资源闭包：工厂自己定义断测试库、用 adminDb DROP、断 adminDb，
 * 调用方只给资源对象。若工厂回退成“先断 admin 再 DROP”，假 admin 关闭后 $executeRawUnsafe
 * 会抛，负控必红；不再接受调用方传入的 disconnect/drop 回调。
 */
export function createCleanupPlan({
  db, adminDb, schema, schemaCreated, stop,
}: CleanupResources): CleanupPlan {
  return {
    stop,
    disconnectDb: async () => {
      if (!db) return;
      await db.$disconnect();
    },
    drop: async () => {
      if (!adminDb || !schemaCreated) throw new Error('M3T20_SCHEMA_DROP_FAILED');
      await cleanupOwnedSchema(adminDb, schema, schemaCreated);
    },
    disconnectAdmin: async () => {
      if (!adminDb) return;
      await adminDb.$disconnect();
    },
    owned: schemaCreated,
  };
}

/**
 * 单一 cleanup owner：停服→断测试 schema 连接→用仍连接的 adminDb DROP 本次 schema→断 adminDb。
 * 停服/断测试库失败时保留 owned 并不 DROP；DROP 失败保留 owned；DROP 成功后 admin 断连失败不得谎称 schema 仍在。
 */
export async function runCleanup(plan: CleanupPlan): Promise<CleanupResult> {
  try {
    await plan.stop();
  } catch {
    return { failure: 'M3T20_STANDALONE_KILL_FAILED', preservedOwned: plan.owned, schemaDropped: false };
  }
  try {
    await plan.disconnectDb();
  } catch {
    return { failure: 'M3T20_DB_DISCONNECT_FAILED', preservedOwned: plan.owned, schemaDropped: false };
  }
  let schemaDropped = false;
  if (plan.owned) {
    try {
      await plan.drop();
      schemaDropped = true;
    } catch {
      await plan.disconnectAdmin().catch(() => undefined);
      return { failure: 'M3T20_SCHEMA_DROP_FAILED', preservedOwned: true, schemaDropped: false };
    }
  }
  try {
    await plan.disconnectAdmin();
  } catch {
    return { failure: 'M3T20_ADMIN_DISCONNECT_FAILED', preservedOwned: false, schemaDropped };
  }
  return { failure: null, preservedOwned: false, schemaDropped };
}

/** 清理失败必须让测试进程非 0，而不是只写日志/只在 console 里报错。 */
export async function finalizeCleanup(
  plan: CleanupPlan,
  setExitCode: (code: number) => void = (code) => { process.exitCode = code; },
): Promise<void> {
  const result = await runCleanup(plan);
  if (result.failure) {
    setExitCode(1);
    throw new Error(result.failure);
  }
}

type CleanupFakeOptions = {
  dbError?: Error;
  dropError?: Error;
  adminError?: Error;
  adminClosed?: boolean;
};

/** 负控假资源：DROP 只能经 adminDb.$executeRawUnsafe；admin 已断开时该调用必抛。 */
export function cleanupFakes(calls: string[], options: CleanupFakeOptions = {}) {
  const state = { closed: options.adminClosed ?? false, dropped: false };
  const db = {
    $disconnect: async () => {
      calls.push('disconnectDb');
      if (options.dbError) throw options.dbError;
    },
  };
  const adminDb = {
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async (query: string) => {
      if (state.closed) throw new Error('adminDb closed before drop');
      calls.push(`drop:${query}`);
      if (options.dropError) throw options.dropError;
      state.dropped = true;
      return 1;
    },
    $disconnect: async () => {
      calls.push('disconnectAdmin');
      state.closed = true;
      if (options.adminError) throw options.adminError;
    },
  };
  return { db, adminDb, state };
}

let schemaCreated = false;
let adminDb: PrismaClient | null = null;
let db: PrismaClient = null as unknown as PrismaClient;
let actionGrants: import('../src/lib/server/admin/action-grant').ActionGrantService;
let selfRebind: import('../src/lib/server/admin/self-rebind').SelfRebindService;
let recoveryEnrollment: import('../src/lib/server/admin/recovery-enrollment').RecoveryEnrollmentService;
let recoveryRepo: import('../src/lib/server/admin/recovery-repo').RecoveryRepo;
let classifySelfResetBody: typeof import('../src/lib/server/admin/self-rebind')['classifySelfResetBody'];

const start = new Date('2026-11-12T09:00:00.000Z');
let now = start;
const clock = () => now;

/**
 * 两条链的 TOTP 判定钟不同，夹具必须跟着各自的钟生成：
 * - `issue` → `consumeTotpStep`（`login.ts:124`）用 `Date.now()` 取时间步；
 * - `recoveryEnrollment.confirm`（`recovery-enrollment.ts:184/200`）用注入的 `clock()`。
 * 注入的 `now` 仍只驱动账户/设备/过期窗口；这里只按各自链路选对时钟。
 * 需要“同一码重放/并发”时复用同一个生成结果，不重新生成。
 */
function wallCode(secret: string): string {
  return authenticator.clone({ epoch: Date.now() }).generate(secret);
}
function serviceCode(secret: string, at: Date = now): string {
  return authenticator.clone({ epoch: at.getTime() }).generate(secret);
}

before(async () => {
  if (!baseDatabaseUrl) return;
  setRateLimitStore(new MemoryStore());
  adminDb = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
  const prepared = await prepareSchema(adminDb as unknown as SchemaAdmin, EXPECTED_IDENTITY, schema);
  schemaCreated = prepared.created;
  pushSchema(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  const loaded = await import('../src/lib/server/db');
  db = loaded.prisma;
  const rows = await db.$queryRawUnsafe<{ database: string; user: string; schema: string }[]>(
    'SELECT current_database() AS database, current_user AS "user", current_schema() AS schema',
  );
  assertIdentity(rows[0], EXPECTED_IDENTITY);
  if (rows[0].schema !== schema) throw new Error('M3T20_SCHEMA_PATH_MISMATCH');
  const grantMod = await import('../src/lib/server/admin/action-grant');
  const rebindMod = await import('../src/lib/server/admin/self-rebind');
  classifySelfResetBody = rebindMod.classifySelfResetBody;
  const enrollMod = await import('../src/lib/server/admin/recovery-enrollment');
  const repoMod = await import('../src/lib/server/admin/recovery-repo');
  recoveryRepo = repoMod.createRecoveryRepo();
  actionGrants = grantMod.createActionGrantService({ db, clock });
  selfRebind = rebindMod.createSelfRebindService({ db, clock, grants: actionGrants });
  recoveryEnrollment = enrollMod.createRecoveryEnrollmentService({ db, clock });
});

after(async () => {
  await finalizeCleanup(createCleanupPlan({
    db,
    adminDb,
    schema,
    schemaCreated,
    stop: stopStandalone,
  }));
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
    totp: wallCode(member.plain),
  });
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

async function userRow(userId: string) {
  return db.user.findUniqueOrThrow({ where: { id: userId } });
}

describe('M3-T20 隔离库 URL 校验（无库可跑）', () => {
  test('只接受 loopback、无 schema、本卡固定库/角色、postgres scheme', () => {
    assert.throws(() => validateBaseDatabaseUrl(undefined), /required/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://b10_m3t20_app:p@db.example.com:5432/b10_m3t20_20261112'), /loopback/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://b10_m3t20_app:p@127.0.0.1:5432/b10_m3t20_20261112?schema=m3t20'), /must not carry schema/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://b10_m3t20_app:p@127.0.0.1:5432/'), /name a database/);
    assert.throws(() => validateBaseDatabaseUrl('mysql://b10_m3t20_app:p@127.0.0.1:5432/b10_m3t20_20261112'), /postgres/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://b10_m3t20_app:p@127.0.0.1:5432/other'), /must target/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://postgres:p@127.0.0.1:5432/b10_m3t20_20261112'), /must target/);
    assert.equal(
      validateBaseDatabaseUrl('postgresql://b10_m3t20_app:p@127.0.0.1:5432/b10_m3t20_20261112'),
      'postgresql://b10_m3t20_app:p@127.0.0.1:5432/b10_m3t20_20261112',
    );
  });

  test('CI 模式只接受显式 e2e/postgres', () => {
    assert.equal(
      validateBaseDatabaseUrl('postgresql://postgres:p@127.0.0.1:5432/e2e', 'ci'),
      'postgresql://postgres:p@127.0.0.1:5432/e2e',
    );
    assert.throws(() => validateBaseDatabaseUrl('postgresql://postgres:p@127.0.0.1:5432/other', 'ci'), /M3T20_CI_DATABASE_MISMATCH/);
    assert.throws(() => validateBaseDatabaseUrl('postgresql://b10_m3t20_app:p@127.0.0.1:5432/b10_m3t20_20261112', 'ci'), /M3T20_CI_DATABASE_MISMATCH/);
  });
});

describe('M3-T20 安全前置负控（无库/无监听）', () => {
  function responseWithCookies(...values: string[]): Response {
    const headers = new Headers();
    for (const value of values) headers.append('set-cookie', value);
    return new Response(null, { headers });
  }

  test('CookieJar 识别安全/非安全 session 与合法 chunk，拒相似前缀，清除后不算会话', () => {
    const SECURE = '__' + 'Secure-';
    const accepted = new CookieJar();
    accepted.absorb(responseWithCookies(
      'authjs.session-token=plain; Path=/',
      `${SECURE}authjs.session-token.1=secure-chunk; Path=/`,
    ));
    assert.equal(accepted.hasSession(), true);

    const lookalike = new CookieJar();
    lookalike.absorb(responseWithCookies(
      'look-alike.session-token',
      `${SECURE}authjs.session-token.0.1=y; Path=/`,
      'xauthjs.session-token=z; Path=/',
    ));
    assert.equal(lookalike.hasSession(), false);

    const cleared = new CookieJar();
    cleared.absorb(responseWithCookies(
      'authjs.session-token=gone; Path=/',
      'authjs.session-token=; Max-Age=0; Path=/',
    ));
    assert.equal(cleared.hasSession(), false);
  });

  test('身份只读校验先于 CREATE；失败不建 schema；只 drop 本次创建', async () => {
    const calls: string[] = [];
    const admin = {
      $queryRawUnsafe: async () => { calls.push('identity'); return [{ database: LOCAL_DB, user: LOCAL_USER }]; },
      $executeRawUnsafe: async (query: string) => { calls.push(query.startsWith('CREATE') ? 'create' : 'drop'); },
    };
    const prepared = await prepareSchema(admin as never, { database: LOCAL_DB, user: LOCAL_USER }, 'm3t20_abc');
    assert.deepEqual(calls, ['identity', 'create']);
    assert.equal(prepared.created, true);

    const wrongCalls: string[] = [];
    const wrong = {
      $queryRawUnsafe: async () => { wrongCalls.push('identity'); return [{ database: 'other', user: 'postgres' }]; },
      $executeRawUnsafe: async () => { wrongCalls.push('create'); },
    };
    await assert.rejects(
      prepareSchema(wrong as never, { database: LOCAL_DB, user: LOCAL_USER }, 'm3t20_abc'),
      /M3T20_DATABASE_IDENTITY_MISMATCH/,
    );
    assert.deepEqual(wrongCalls, ['identity']);

    const failCalls: string[] = [];
    const failCreate = {
      $queryRawUnsafe: async () => [{ database: LOCAL_DB, user: LOCAL_USER }],
      $executeRawUnsafe: async () => { failCalls.push('create'); throw new Error('duplicate schema'); },
    };
    await assert.rejects(createOwnedSchema(failCreate as never, 'm3t20_abc'), /M3T20_SCHEMA_CREATE_FAILED/);
    assert.deepEqual(failCalls, ['create']);

    const dropCalls: string[] = [];
    const dropAdmin = {
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async (query: string) => { dropCalls.push(query); },
    };
    await cleanupOwnedSchema(dropAdmin as never, 'm3t20_abc', false);
    assert.equal(dropCalls.length, 0, '既有 schema 不得接管/删除');
    await cleanupOwnedSchema(dropAdmin as never, 'm3t20_abc', true);
    assert.equal(dropCalls.length, 1);
    assert.match(dropCalls[0], /^DROP SCHEMA "m3t20_abc" CASCADE$/);
  });

  test('dbpush 失败只给安全码，不带原始 stderr/DSN', () => {
    const secretish = ['postgresql://user:', 'not-a-credential', '@127.0.0.1:5432/e2e'].join('');
    let thrown: Error | null = null;
    try {
      pushSchema(secretish, () => {
        throw Object.assign(new Error('spawn failed'), { stderr: secretish });
      });
    } catch (error) {
      thrown = error as Error;
    }
    assert.ok(thrown);
    assert.equal(thrown.message, 'M3T20_DBPUSH_FAILED');
    assert.equal(thrown.message.includes('not-a-credential'), false);
    assert.equal(thrown.message.includes('postgresql://'), false);
  });

  test('端口占用与 kill 失败都只给安全码', async () => {
    const busy = new EventEmitter() as unknown as Server;
    Object.assign(busy, {
      listen: () => {
        queueMicrotask(() => busy.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })));
      },
      close: () => undefined,
    });
    await assert.rejects(pickFreePort(() => busy), /M3T20_PORT_UNAVAILABLE/);

    const stuck = new EventEmitter() as unknown as ChildProcess;
    Object.assign(stuck, { exitCode: null, signalCode: null, kill: () => true });
    await assert.rejects(stopChild(stuck, 5, 5), /M3T20_STANDALONE_KILL_FAILED/);

    let killed = 0;
    const already = new EventEmitter() as unknown as ChildProcess;
    Object.assign(already, { exitCode: null, signalCode: 'SIGTERM', kill: () => { killed += 1; return true; } });
    await stopChild(already, 5, 5);
    assert.equal(killed, 0, '已信号退出不再发信号/误等');

    const exiting = new EventEmitter() as unknown as ChildProcess;
    Object.assign(exiting, {
      exitCode: null,
      signalCode: null,
      kill: (signal: string) => {
        if (signal === 'SIGTERM') queueMicrotask(() => exiting.emit('exit', 0, null));
        return true;
      },
    });
    await stopChild(exiting, 50, 50);
  });

  test('cleanup 单一 owner：停服失败保 schema，确认退出才按序 disconnectDb→DROP→disconnectAdmin', async () => {
    const stopCalls: string[] = [];
    const stopFake = cleanupFakes(stopCalls);
    const stopFailed = await runCleanup(createCleanupPlan({
      db: stopFake.db,
      adminDb: stopFake.adminDb,
      schema: 'm3t20_fake',
      schemaCreated: true,
      stop: async () => { stopCalls.push('stop'); throw new Error('kill failed'); },
    }));
    assert.deepEqual(stopFailed, { failure: 'M3T20_STANDALONE_KILL_FAILED', preservedOwned: true, schemaDropped: false });
    assert.deepEqual(stopCalls, ['stop']);
    assert.equal(stopFake.state.dropped, false);

    const notOwnedCalls: string[] = [];
    const notOwnedFake = cleanupFakes(notOwnedCalls);
    const notOwned = await runCleanup(createCleanupPlan({
      db: notOwnedFake.db,
      adminDb: notOwnedFake.adminDb,
      schema: 'm3t20_fake',
      schemaCreated: false,
      stop: async () => { notOwnedCalls.push('stop'); },
    }));
    assert.deepEqual(notOwned, { failure: null, preservedOwned: false, schemaDropped: false });
    assert.deepEqual(notOwnedCalls, ['stop', 'disconnectDb', 'disconnectAdmin']);
    assert.equal(notOwnedFake.state.closed, true);

    const dbFailedCalls: string[] = [];
    const dbFailedFake = cleanupFakes(dbFailedCalls, { dbError: new Error('db disconnect') });
    const dbFailed = await runCleanup(createCleanupPlan({
      db: dbFailedFake.db,
      adminDb: dbFailedFake.adminDb,
      schema: 'm3t20_fake',
      schemaCreated: true,
      stop: async () => { dbFailedCalls.push('stop'); },
    }));
    assert.deepEqual(dbFailed, { failure: 'M3T20_DB_DISCONNECT_FAILED', preservedOwned: true, schemaDropped: false });
    assert.deepEqual(dbFailedCalls, ['stop', 'disconnectDb']);
    assert.equal(dbFailedFake.state.closed, false, 'db 断连失败后不得继续 DROP/断 admin');

    const dropFailedCalls: string[] = [];
    const dropFailedFake = cleanupFakes(dropFailedCalls, { dropError: new Error('drop failed') });
    const dropFailed = await runCleanup(createCleanupPlan({
      db: dropFailedFake.db,
      adminDb: dropFailedFake.adminDb,
      schema: 'm3t20_fake',
      schemaCreated: true,
      stop: async () => { dropFailedCalls.push('stop'); },
    }));
    assert.deepEqual(dropFailed, { failure: 'M3T20_SCHEMA_DROP_FAILED', preservedOwned: true, schemaDropped: false });
    assert.equal(dropFailedFake.state.dropped, false);

    const adminFailedCalls: string[] = [];
    const adminFailedFake = cleanupFakes(adminFailedCalls, { adminError: new Error('admin disconnect') });
    const adminFailed = await runCleanup(createCleanupPlan({
      db: adminFailedFake.db,
      adminDb: adminFailedFake.adminDb,
      schema: 'm3t20_fake',
      schemaCreated: true,
      stop: async () => { adminFailedCalls.push('stop'); },
    }));
    assert.deepEqual(adminFailed, { failure: 'M3T20_ADMIN_DISCONNECT_FAILED', preservedOwned: false, schemaDropped: true });
    assert.equal(adminFailedFake.state.dropped, true);
  });

  test('cleanup 顺序：DROP 前 adminDb 仍连接；工厂先断 admin 则同一负控必红', async () => {
    const calls: string[] = [];
    const fake = cleanupFakes(calls);
    const result = await runCleanup(createCleanupPlan({
      db: fake.db,
      adminDb: fake.adminDb,
      schema: 'm3t20_order',
      schemaCreated: true,
      stop: async () => { calls.push('stop'); },
    }));
    assert.deepEqual(result, { failure: null, preservedOwned: false, schemaDropped: true });
    assert.deepEqual(calls, ['stop', 'disconnectDb', 'drop:DROP SCHEMA "m3t20_order" CASCADE', 'disconnectAdmin']);
    assert.equal(fake.state.dropped, true);
    assert.equal(fake.state.closed, true);

    // 负控自检：adminDb 已 closed 时 DROP 必抛，证明上面的顺序断言不是空转。
    const closedCalls: string[] = [];
    const closedFake = cleanupFakes(closedCalls, { adminClosed: true });
    const closedResult = await runCleanup(createCleanupPlan({
      db: closedFake.db,
      adminDb: closedFake.adminDb,
      schema: 'm3t20_order',
      schemaCreated: true,
      stop: async () => { closedCalls.push('stop'); },
    }));
    assert.deepEqual(closedResult, { failure: 'M3T20_SCHEMA_DROP_FAILED', preservedOwned: true, schemaDropped: false });
    assert.equal(closedFake.state.dropped, false);
  });

  test('finalizeCleanup 失败置进程非0并抛出，成功不置', async () => {
    const codes: number[] = [];
    const failedFake = cleanupFakes([]);
    await assert.rejects(
      finalizeCleanup(createCleanupPlan({
        db: failedFake.db,
        adminDb: failedFake.adminDb,
        schema: 'm3t20_finalize',
        schemaCreated: true,
        stop: async () => { throw new Error('kill failed'); },
      }), (code) => codes.push(code)),
      /M3T20_STANDALONE_KILL_FAILED/,
    );
    assert.deepEqual(codes, [1]);
    codes.length = 0;
    const okFake = cleanupFakes([]);
    await finalizeCleanup(createCleanupPlan({
      db: okFake.db,
      adminDb: okFake.adminDb,
      schema: 'm3t20_finalize',
      schemaCreated: false,
      stop: async () => undefined,
    }), (code) => codes.push(code));
    assert.deepEqual(codes, []);
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
    const oldCodeWall = wallCode(member.plain);
    assert.equal(authenticator.clone({ epoch: Date.now() }).check(oldCodeWall, decrypt(afterReset.totpSecret as string)), true);

    const completed = await recoveryEnrollment.confirm({ token, totp: serviceCode(secret), ip: '203.0.113.12' });
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
    assert.equal(authenticator.clone({ epoch: Date.now() }).check(wallCode(member.plain), decrypt(final.totpSecret as string)), false);
    assert.equal(authenticator.clone({ epoch: Date.now() }).check(wallCode(secret), decrypt(final.totpSecret as string)), true);

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
    const totp = serviceCode(secret);
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
    assert.throws(() => classifySelfResetBody({ totp: wallCode(member.plain) }), (error) => error instanceof AppError && error.code === 'invalid');
    assert.throws(() => classifySelfResetBody({ recoveryCode: '0123456789' }), (error) => error instanceof AppError && error.code === 'invalid');
    await expectAppError(actionGrants.issue({
      userId: member.user.id, sid: member.deviceId, purpose: 'TOTP_RESET', password: 'wrong-password', totp: wallCode(member.plain),
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

async function stopStandalone(): Promise<void> {
  if (!standalone) return;
  const child = standalone;
  await stopChild(child);
  if (child.exitCode !== null || child.signalCode !== null) standalone = null;
}

async function waitForServer(child: ChildProcess, base: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('M3T20_STANDALONE_EXITED_BEFORE_READY');
    }
    try {
      const response = await fetch(`${base}/api/auth/csrf`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // not up yet; per-request 5s cap, overall deadline above is not reset
    }
    await delay(500);
  }
  throw new Error('M3T20_STANDALONE_READY_TIMEOUT');
}

const SESSION_COOKIE_NAME = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

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
    return [...this.cookies.keys()].some((name) => SESSION_COOKIE_NAME.test(name));
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
  const response = await fetch(`${httpBase}${pathname}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers,
    redirect: 'manual',
  });
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
    const port = await pickFreePort();
    httpBase = `http://127.0.0.1:${port}`;
    standalone = spawn(process.execPath, [serverJs], {
      cwd: standaloneDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        NODE_ENV: 'production',
        APP_ENV: 'test',
        AUTH_URL: httpBase,
        AUTH_TRUST_HOST: 'true',
        ORIGIN: httpBase,
        APP_ORIGIN: httpBase,
        NEXTAUTH_URL: httpBase,
        NEXT_PUBLIC_SITE_URL: httpBase,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await waitForServer(standalone, httpBase);
  });

  test('登录→reauth 签 grant→reset→受限 enroll/confirm→旧 TOTP 拒/新 TOTP 可登录', { timeout: 300_000 }, async () => {
    const member = await makeAccount();
    const firstCode = authenticator.generate(member.plain);
    const first = await login(member.user.email, PASSWORD, firstCode);
    assert.equal(loginSucceeded(first), true, '旧 TOTP 应能先登录');
    assert.equal((await http('/api/admin/account', {}, first.jar)).status, 200);

    // 仅登录会话（空 body）、仅 TOTP、仅密码都不能签 grant
    const onlySession = await http('/api/admin/account/reauth', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, first.jar);
    assert.equal(onlySession.status, 401);
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
