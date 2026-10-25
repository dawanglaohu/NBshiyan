// 队列 ②：admin-reset-initial-password 在真实 Postgres 上的并发测试（FOR UPDATE 串行化）。
// 只在设置了 ADMIN_RESET_TEST_DATABASE_URL 时运行（指向一次性的测试库，例如本机临时 initdb 集群或 CI 的 postgres service），
// 故意不用 DATABASE_URL：避免有人带着开发库地址跑 npm test 时连上开发库。没有这个变量就跳过。
// 在独立 schema 里按 prisma/schema.prisma 建全部表（prisma migrate diff --from-empty，不连任何库），测试结束后 DROP SCHEMA。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { hash as argonHash, verify } from '@node-rs/argon2';
import { ARGON, CLEAR_FLAG, runReset, VIA } from '../scripts/admin-reset-initial-password-lib.mjs';
import { hashEnrollToken } from '../scripts/enroll-token-lib.mjs';

const base = process.env.ADMIN_RESET_TEST_DATABASE_URL;
const SCHEMA = `adminreset_test_${process.pid}`;
const url = base?.startsWith('postgres') ? `${base}${base.includes('?') ? '&' : '?'}schema=${SCHEMA}` : null;
const skip = !url && 'no ADMIN_RESET_TEST_DATABASE_URL';
const db = url ? new PrismaClient({ datasources: { db: { url } }, log: [] }) : null;

const PW_A = 'First-Writer-Password-1';
const PW_B = 'Second-Writer-Password-2';
const HOLD_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!db) return;
  const ddl = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/dummy', PRISMA_HIDE_UPDATE_MESSAGE: '1' } as unknown as NodeJS.ProcessEnv, timeout: 60_000,
  });
  assert.equal(ddl.status, 0, 'prisma migrate diff failed');
  await db.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
  // Prisma 用 ?schema= 设置 search_path，DDL 里的表名不带 schema，都会建在临时 schema 里
  const stmts = ddl.stdout.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  for (const s of stmts) await db.$executeRawUnsafe(s);
  const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('User', 'AuditLog')`, SCHEMA);
  assert.equal(Number(n), 2);
});

after(async () => {
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

type Ev = { who: string; what: string; t: number };

/**
 * 包一层真实 PrismaClient：记录拿到行锁的时间；holdMs>0 时拿到锁、读完行之后停一会儿再写，保证两个事务真的重叠。
 * $disconnect 不往下传（共用一个连接池，测试结束再断开）。
 */
function wrapped(who: string, events: Ev[], holdMs = 0) {
  const c = db!;
  return {
    user: c.user,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return c.$transaction(async (tx) => {
        const proxy = {
          async $executeRaw(strings: TemplateStringsArray, ...vals: unknown[]) {
            events.push({ who, what: 'lock_wait', t: Date.now() });
            const r = await tx.$executeRaw(strings, ...vals);
            events.push({ who, what: 'locked', t: Date.now() });
            return r;
          },
          user: {
            async findUnique(a: Parameters<typeof tx.user.findUnique>[0]) { const r = await tx.user.findUnique(a); if (holdMs) await sleep(holdMs); return r; },
            update: (a: Parameters<typeof tx.user.update>[0]) => tx.user.update(a),
          },
          auditLog: tx.auditLog,
        };
        const r = await fn(proxy);
        events.push({ who, what: 'tx_body_done', t: Date.now() });
        return r;
      }, { timeout: 15_000 });
    },
    async $disconnect() {},
  };
}

async function reset(who: string, events: Ev[], email: string, pw: string, extra: string[] = [], holdMs = 0) {
  let out = '', err = '';
  const code = await runReset({
    argv: ['--email', email, ...extra], env: { DATABASE_URL: 'set', NEXT_PUBLIC_SITE_URL: 'https://geiom.com' }, stdoutIsTTY: true, stdinIsTTY: true,
    readPassword: async () => pw, db: async () => wrapped(who, events, holdMs), hash: (p) => argonHash(p, ARGON),
    fetchImpl: (async () => { throw new Error('no redis in this test'); }) as never,
    out: (s) => { out += s; }, err: (s) => { err += s; },
  });
  assert.ok(!(out + err).includes(pw), 'password leaked');
  return { code, out, err };
}

async function newAdmin(email: string) {
  return db!.user.create({ data: { email, name: 'T', role: 'ADMIN', passwordHash: await argonHash('Initial-Password-000', ARGON) }, select: { id: true } });
}
const t = (ev: Ev[], who: string, what: string) => ev.find((e) => e.who === who && e.what === what)!.t;

/** 终端只打印一次的绑定链接。令牌在 fragment 里，审计里必须没有它。 */
function linkToken(out: string) {
  const m = /#t=(\S+)/.exec(out);
  assert.ok(m, 'stdout missing the one-time enroll link');
  return decodeURIComponent(m[1]);
}

const RESET_META = { actor: 'cli', via: VIA };
const ISSUED_META = { actor: 'cli', source: 'cli', via: VIA, truncated: false };

function assertAuditClosed(audits: { actorId: string | null; meta: unknown }[], secrets: string[]) {
  for (const x of audits) {
    assert.equal(x.actorId, null);
    const text = JSON.stringify(x);
    for (const secret of secrets) assert.equal(text.includes(secret), false, 'audit contains a secret');
    assert.doesNotMatch(text, /argon2/);
    const meta = x.meta as Record<string, unknown> | null;
    if (meta && typeof meta === 'object') {
      for (const key of Object.keys(meta)) assert.doesNotMatch(key, /hash|secret|password|email|token|totp/i);
    }
  }
}

/** A 先开始并拿到行锁；A 持锁期间 B 开始，B 的 FOR UPDATE 必须等到 A 提交后才返回 */
async function race(email: string, a: { pw: string; extra?: string[] }, b: { pw: string; extra?: string[] }) {
  const ev: Ev[] = [];
  const pa = reset('A', ev, email, a.pw, a.extra, HOLD_MS);
  while (!ev.some((e) => e.who === 'A' && e.what === 'locked')) await sleep(5);
  const bStart = Date.now();
  const pb = reset('B', ev, email, b.pw, b.extra);
  const [ra, rb] = await Promise.all([pa, pb]);
  // B 在 A 持锁期间就开始了，并且确实在等锁（不是 A 结束后才跑）
  assert.ok(bStart < t(ev, 'A', 'tx_body_done'), 'B started while A held the lock');
  assert.ok(t(ev, 'B', 'lock_wait') < t(ev, 'A', 'tx_body_done'), 'B requested the row lock while A held it');
  // B 拿到锁一定在 A 的事务体结束（随后 COMMIT）之后
  assert.ok(t(ev, 'B', 'locked') >= t(ev, 'A', 'tx_body_done'), 'B acquired the lock only after A finished');
  return { ra, rb, ev };
}

test('真实 PG：同一账号两次并发重置（都不带参数）→ 串行执行，sessionVersion 加两次，后提交的密码生效，每次签发恰有一条令牌审计', { skip }, async () => {
  const email = `race1-${process.pid}@example.com`;
  const { id } = await newAdmin(email);
  const { ra, rb, ev } = await race(email, { pw: PW_A }, { pw: PW_B });
  assert.equal(ra.code, 0, ra.err); assert.equal(rb.code, 0, rb.err);
  const tokenA = linkToken(ra.out);
  const tokenB = linkToken(rb.out);
  assert.notEqual(tokenA, tokenB);
  const u = await db!.user.findUniqueOrThrow({ where: { id } });
  assert.equal(u.sessionVersion, 2);
  assert.equal(u.enrollTokenHash, hashEnrollToken(tokenB));
  assert.ok(await verify(u.passwordHash, PW_B)); assert.ok(!(await verify(u.passwordHash, PW_A)));
  const audits = await db!.auditLog.findMany({ where: { target: id }, orderBy: { createdAt: 'asc' } });
  // 同一事务的两行 createdAt 都是事务时间戳，不能靠它区分先后；精确多重集仍固定为每次成功签发各一对。
  assert.deepEqual(audits.map((x) => x.action).sort(), [
    'auth.enroll_token_issued', 'auth.enroll_token_issued', 'user.password_reset', 'user.password_reset',
  ]);
  assert.equal(audits.filter((x) => x.action === 'auth.enroll_token_issued').length, 2);
  for (const x of audits) {
    assert.deepEqual(x.meta, x.action === 'auth.enroll_token_issued' ? ISSUED_META : RESET_META);
  }
  assertAuditClosed(audits, [PW_A, PW_B, email, tokenA, tokenB, u.enrollTokenHash!]);
  const waited = t(ev, 'B', 'locked') - t(ev, 'B', 'lock_wait');
  assert.ok(waited >= 100, `B waited ${waited}ms for the lock`);
});

test('真实 PG：A 带 --clear-pending-enroll 持锁时 B（不带参数）开始 → B 在锁内看到 A 已提交的 enrollIssuedAt，拒绝（退出 3），什么都不写', { skip }, async () => {
  const email = `race2-${process.pid}@example.com`;
  const { id } = await newAdmin(email);
  const { ra, rb } = await race(email, { pw: PW_A, extra: [CLEAR_FLAG] }, { pw: PW_B });
  assert.equal(ra.code, 0, ra.err);
  assert.equal(rb.code, 3); assert.match(rb.err, /未完成的 2FA 绑定/);
  assert.equal(rb.out.includes('#t='), false);
  const tokenA = linkToken(ra.out);
  const u = await db!.user.findUniqueOrThrow({ where: { id } });
  assert.equal(u.sessionVersion, 1);
  assert.ok(u.enrollIssuedAt instanceof Date);
  assert.equal(u.enrollTokenHash, hashEnrollToken(tokenA));
  assert.ok(await verify(u.passwordHash, PW_A)); assert.ok(!(await verify(u.passwordHash, PW_B)));
  const audits = await db!.auditLog.findMany({ where: { target: id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.map((x) => x.action).sort(), [
    'auth.enroll_token_issued', 'user.password_reset', 'user.pending_enroll_cleared',
  ]);
  assert.equal(audits.filter((x) => x.action === 'auth.enroll_token_issued').length, 1);
  assert.deepEqual(audits.find((x) => x.action === 'user.password_reset')?.meta, RESET_META);
  assert.deepEqual(audits.find((x) => x.action === 'auth.enroll_token_issued')?.meta, ISSUED_META);
  assert.deepEqual(audits.find((x) => x.action === 'user.pending_enroll_cleared')?.meta, {
    actor: 'cli', via: VIA, hadPending: false, windowReopened: true,
  });
  assertAuditClosed(audits, [PW_A, PW_B, email, tokenA, u.enrollTokenHash!]);
});

test('真实 PG：TOTP 已启用的账号，带参数也拒绝，库里不变', { skip }, async () => {
  const email = `totp-${process.pid}@example.com`;
  const { id } = await newAdmin(email);
  await db!.user.update({ where: { id }, data: { totpEnabled: true, totpSecret: 'v1.x.y.z' } });
  const r = await reset('A', [], email, PW_A, [CLEAR_FLAG]);
  assert.equal(r.code, 3);
  assert.equal(r.out.includes('#t='), false);
  const u = await db!.user.findUniqueOrThrow({ where: { id } });
  assert.equal(u.sessionVersion, 0); assert.equal(u.totpSecret, 'v1.x.y.z');
  assert.equal(u.enrollTokenHash, null);
  assert.ok(await verify(u.passwordHash, 'Initial-Password-000'));
  assert.ok(!(await verify(u.passwordHash, PW_A)));
  assert.equal(await db!.auditLog.count({ where: { target: id } }), 0);
});
