// M4-T1 咨询首消息与唯一通知出箱的真实 PostgreSQL 验收。
//
// 载体安全：只认专属变量 B9_M4T1_TEST_DATABASE_URL，必须 loopback；**绝不回退通用 DATABASE_URL**
// （通用变量是业务库）。CHAT_REQUIRE_DATABASE=true 时缺专属 URL 直接失败，不静默 skip。
// schema 所有权：先查 pg_namespace 确认不存在，再 CREATE SCHEMA（无 IF NOT EXISTS）；
// 只有本进程确认创建成功才在事后删除，预存同名 schema 会拒绝认领（见负例）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConversationReceivedDTOSchema } from '../src/lib/contracts/chat';
import { CHAT_RETENTION_MS } from '../src/lib/chat/rules';
import {
  ChatIdempotencyConflict,
  ChatSessionNoLongerValid,
  ChatTransactionBudgetExceeded,
  createConversationService,
} from '../src/lib/server/chat/conversation-service';
import { createChatRepo, isDatabaseUnavailable } from '../src/lib/server/chat/repo';
import {
  CHAT_VISITOR_COOKIE,
  createVisitorSessionRepo,
  createVisitorSessionService,
  hashChatToken,
  type ValidatedSession,
} from '../src/lib/server/chat/visitor-session';
import { CHAT_VISITOR_POLICY } from '../src/lib/server/config';

const DEDICATED = process.env.B9_M4T1_TEST_DATABASE_URL?.trim();
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isLoopbackUrl(value: string | undefined): boolean {
  if (!value || !/^postgres(ql)?:\/\//.test(value)) return false;
  try {
    return LOOPBACK.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}
const BASE_URL = isLoopbackUrl(DEDICATED) ? (DEDICATED as string) : null;
if (process.env.CHAT_REQUIRE_DATABASE === 'true' && !BASE_URL) {
  throw new Error('B9_M4T1_TEST_DATABASE_URL must be a loopback postgres URL when CHAT_REQUIRE_DATABASE=true');
}
const skip = !BASE_URL && 'no loopback B9_M4T1_TEST_DATABASE_URL';
const NOW = new Date('2026-05-01T10:00:00.000Z');
const EDGE_SECRET = 'm4t1-edge-auth-secret-0123456789abcdef';
const CATALOG_SLUG = 'gift-boxes';

type Payload = {
  clientConversationId: string;
  clientMessageId: string;
  locale: 'en' | 'ru';
  bodyText: string;
  email?: string;
  productSlug?: string;
  sourcePath?: string;
};

function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    clientConversationId: randomUUID(),
    clientMessageId: randomUUID(),
    locale: 'en',
    bodyText: 'Hello, I would like a quote.',
    email: 'visitor@example.com',
    ...overrides,
  };
}

/** 254 字符、结构合法的邮箱：local 64 + @ + 三个标签（63/63/61）。 */
const VALID_254_EMAIL = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
const INVALID_255_EMAIL = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;

describe('M4-T1 原子保存咨询首消息与唯一通知出箱', { concurrency: false, skip, timeout: 180_000 }, () => {
  let admin: PrismaClient | null = null;
  let conn: PrismaClient | null = null;
  let schema = '';
  let createdByUs = false;
  let route: typeof import('../src/app/api/chat/conversations/route');
  let ipSeq = 0;
  /** 测试侧计量：事务耗时（含回滚）与逐条 SQL 前的 arm 审计。 */
  let txDurations: number[] = [];
  let armAudit: { method: string; sql: string }[] = [];

  function db(): PrismaClient {
    if (!conn) throw new Error('no database');
    return conn;
  }

  async function createOwnedSchema(client: PrismaClient, name: string): Promise<void> {
    const existing = await client.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM pg_namespace WHERE nspname = ${name}
    `;
    if (existing.length > 0) throw new Error(`schema ${name} already exists; refusing to claim it`);
    await client.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  }

  before(async () => {
    if (!BASE_URL) return;
    admin = new PrismaClient({ datasources: { db: { url: BASE_URL } } });
    schema = `chatfirst_${process.pid}_${randomBytes(4).toString('hex')}`;
    await createOwnedSchema(admin, schema);
    createdByUs = true;

    const url = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}schema=${encodeURIComponent(schema)}&connection_limit=5&pool_timeout=10`;
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    conn = new PrismaClient({ datasources: { db: { url } } });
    // 路由通过组合点拿全局 prisma，必须在导入路由之前把连接指向本次独占 schema。
    process.env.DATABASE_URL = url;
    process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
    // 测试侧计量：包装全局 prisma 的 $transaction，记录事务耗时（含回滚）与每条 SQL 前的 SET LOCAL。
    // 只替换测试进程内的客户端方法，不新增生产测试钩子，也不改 composition。
    const dbModule = await import('../src/lib/server/db');
    const client = dbModule.prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
    const originalTx = client.$transaction.bind(client);
    client.$transaction = async (arg: unknown, options?: unknown) => {
      if (typeof arg !== 'function') return originalTx(arg, options);
      const started = performance.now();
      try {
        return await originalTx(async (tx: unknown) => {
          const wrapped = new Proxy(tx as object, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (prop === '$queryRaw' || prop === '$executeRaw' || prop === '$executeRawUnsafe') {
                return (...args: unknown[]) => {
                  armAudit.push({ method: String(prop), sql: sqlOf(args[0]) });
                  return (value as (...inner: unknown[]) => unknown).apply(target, args);
                };
              }
              return typeof value === 'function' ? (value as (...inner: unknown[]) => unknown).bind(target) : value;
            },
          });
          return await (arg as (inner: unknown) => Promise<unknown>)(wrapped);
        }, options);
      } finally {
        txDurations.push(performance.now() - started);
      }
    };
    route = await import('../src/app/api/chat/conversations/route');
  });

  after(async () => {
    if (admin && createdByUs && schema) {
      assert.match(schema, /^chatfirst_\d+_[0-9a-f]{8}$/);
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await conn?.$disconnect();
    await admin?.$disconnect();
  });

  async function reset() {
    const client = db();
    await client.$executeRawUnsafe(`DELETE FROM "ChatNotification"`);
    await client.$executeRawUnsafe(`DELETE FROM "ChatMessage"`);
    await client.$executeRawUnsafe(`DELETE FROM "ChatReadCursor"`);
    await client.$executeRawUnsafe(`DELETE FROM "ChatConversation"`);
    await client.$executeRawUnsafe(`DELETE FROM "ChatVisitorSession"`);
  }

  async function seedVisitor(): Promise<{ id: string; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const signedAt = new Date();
    await db().chatVisitorSession.create({
      data: {
        id,
        tokenHash: hashChatToken(token),
        createdAt: signedAt,
        lastActivityAt: signedAt,
        absoluteExpiresAt: new Date(signedAt.getTime() + CHAT_VISITOR_POLICY.absoluteMs),
      },
    });
    return { id, token };
  }

  /** 测试用已校验会话句柄：品牌字段只由 resolve 产生，这里按类型边界显式构造。 */
  function sessionOf(visitor: { id: string; token: string }): ValidatedSession {
    return {
      id: visitor.id,
      tokenHash: hashChatToken(visitor.token),
      expiresAt: new Date(Date.now() + CHAT_VISITOR_POLICY.absoluteMs),
    } as unknown as ValidatedSession;
  }

  const counts = async () => ({
    conversations: await db().chatConversation.count(),
    messages: await db().chatMessage.count(),
    notifications: await db().chatNotification.count(),
    readCursors: await db().chatReadCursor.count(),
  });

  /** 从 Prisma 的模板串 / Prisma.Sql / 普通字符串里取出 SQL 文本，供 arm 审计用。 */
  function sqlOf(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (Array.isArray(arg)) return arg.join('?');
    const shaped = arg as { sql?: unknown } | null;
    return shaped && typeof shaped.sql === 'string' ? shaped.sql : String(arg);
  }

  function beginTxAudit() {
    txDurations = [];
    armAudit = [];
  }

  function dataStatementCount(): number {
    return armAudit.filter((entry) => !/^\s*SET LOCAL /.test(entry.sql)).length;
  }

  /** 每条数据语句前面必须紧挨着 statement_timeout 与 lock_timeout 两次 SET LOCAL（arm）。 */
  function assertArmedPrefix(): void {
    const dataIndexes = armAudit
      .map((entry, index) => (/^\s*SET LOCAL (statement_timeout|lock_timeout) = \d+\s*$/.test(entry.sql) ? -1 : index))
      .filter((index) => index >= 0);
    assert.ok(dataIndexes.length > 0, '至少应记录到一条数据语句');
    for (const index of dataIndexes) {
      const timeout = armAudit[index - 2];
      const lock = armAudit[index - 1];
      const label = armAudit[index].sql.replace(/\s+/g, ' ').slice(0, 80);
      assert.ok(timeout && /SET LOCAL statement_timeout/.test(timeout.sql), `数据语句前缺少 statement_timeout arm：${label}`);
      assert.ok(lock && /SET LOCAL lock_timeout/.test(lock.sql), `数据语句前缺少 lock_timeout arm：${label}`);
    }
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** 每个用例一枚新的可信边缘 IP，避免限流桶互相污染。 */
  function nextIp(): string {
    ipSeq += 1;
    return `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  }

  function post(
    body: unknown,
    options: { cookie?: string; origin?: string | null; ip?: string; edgeAuth?: boolean } = {},
  ) {
    const ip = options.ip ?? nextIp();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    };
    if (options.edgeAuth !== false) {
      headers['x-edge-auth'] = EDGE_SECRET;
      headers.origin = options.origin ?? 'http://127.0.0.1';
    }
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    return route.POST(new Request('http://127.0.0.1/api/chat/conversations', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
  }

  function postStream(chunks: string[], options: { cookie: string; ip?: string }) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const init = {
      method: 'POST',
      // 不写 content-length：走流式限体路径，而不是只信头部。
      headers: {
        'content-type': 'application/json',
        cookie: options.cookie,
        'x-edge-auth': EDGE_SECRET,
        'cf-connecting-ip': options.ip ?? nextIp(),
        origin: 'http://127.0.0.1',
      },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' };
    return route.POST(new Request('http://127.0.0.1/api/chat/conversations', init));
  }

  async function expectStatus(response: Response, status: number, label: string) {
    const text = await response.clone().text();
    assert.equal(response.status, status, `${label}: ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  }

  // ---------- 服务/事务层 ----------

  test('首次提交：会话、首消息 seq=1 与唯一出箱在同一事务里落库', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });

    const received = await service.createFirstMessage({ session: sessionOf(visitor), payload: input });
    ConversationReceivedDTOSchema.parse(received);
    assert.equal(received.duplicate, false);
    assert.equal(received.message.seq, 1);
    assert.equal(received.receivedAt, received.message.createdAt);

    const conversation = await db().chatConversation.findUniqueOrThrow({ where: { id: received.conversationId } });
    assert.equal(conversation.visitorSessionId, visitor.id);
    assert.equal(conversation.lastSeq, 1);
    assert.equal(conversation.retainUntil.getTime(), NOW.getTime() + CHAT_RETENTION_MS);
    const notification = await db().chatNotification.findUniqueOrThrow({ where: { messageId: received.message.id } });
    assert.equal(notification.status, 'QUEUED');
    assert.equal(notification.stableMessageId, `${received.message.id}@chat.packjoyu`);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
  });

  test('同 UUID 同载荷重复提交：返回原 id/seq/receivedAt，不新增消息或通知', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });
    const first = await service.createFirstMessage({ session: sessionOf(visitor), payload: input });
    const replay = await service.createFirstMessage({ session: sessionOf(visitor), payload: input });

    assert.equal(replay.duplicate, true);
    assert.equal(replay.conversationId, first.conversationId);
    assert.deepEqual(replay.message, first.message);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
  });

  test('同 UUID 异载荷：抛 409 冲突，不写任何行', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });
    await service.createFirstMessage({ session: sessionOf(visitor), payload: input });

    await assert.rejects(
      () => service.createFirstMessage({
        session: sessionOf(visitor),
        payload: { ...input, bodyText: 'A different message.' },
      }),
      (error: unknown) => error instanceof ChatIdempotencyConflict && error.field === 'clientConversationId',
    );
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
  });

  test('并发同名提交：只落一条消息、一条通知（同一 client 的并发发起，不主张已证明事务重叠）', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });
    const [a, b] = await Promise.all([
      service.createFirstMessage({ session: sessionOf(visitor), payload: input }),
      service.createFirstMessage({ session: sessionOf(visitor), payload: input }),
    ]);

    assert.equal(a.conversationId, b.conversationId);
    assert.equal(a.message.id, b.message.id);
    assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
  });

  test('访客身份隔离：不同访客会话用同一 clientConversationId 各自建自己的会话', async () => {
    await reset();
    const first = await seedVisitor();
    const second = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });
    const a = await service.createFirstMessage({ session: sessionOf(first), payload: input });
    const b = await service.createFirstMessage({ session: sessionOf(second), payload: input });

    assert.notEqual(a.conversationId, b.conversationId);
    assert.deepEqual(await counts(), { conversations: 2, messages: 2, notifications: 2, readCursors: 0 });
  });

  test('预存同名 schema 负例：拒绝认领，预存对象原样保留', async () => {
    const client = admin as PrismaClient;
    const name = `chatfirst_guard_${process.pid}`;
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await client.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
    try {
      await assert.rejects(() => createOwnedSchema(client, name), /already exists/);
      const rows = await client.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM pg_namespace WHERE nspname = ${name}
      `;
      assert.equal(rows.length, 1, '预存 schema 不得被删除或认领');
    } finally {
      await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
  });

  // ---------- 真实 SQL 故障 ----------

  type TriggerTable = 'ChatConversation' | 'ChatMessage' | 'ChatNotification';
  async function createTrigger(name: string, body: string, table: TriggerTable) {
    const client = admin as PrismaClient;
    await client.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION "${schema}"."${name}"() RETURNS trigger AS $fn$ BEGIN ${body} END; $fn$ LANGUAGE plpgsql`,
    );
    await client.$executeRawUnsafe(
      `CREATE TRIGGER "${name}" BEFORE INSERT ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}"."${name}"()`,
    );
  }

  async function dropTrigger(name: string, table: TriggerTable) {
    const client = admin as PrismaClient;
    await client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "${schema}"."${table}"`);
    await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${name}"()`);
  }

  // 插入尝试探针：序列的 nextval 不随事务回滚，能数清"守卫前"与"已尝试写入"。
  const ATTEMPT_TABLES = ['ChatConversation', 'ChatMessage'] as const;
  async function installAttemptProbe() {
    const client = admin as PrismaClient;
    await client.$executeRawUnsafe(`CREATE SEQUENCE "${schema}"."m4t1_attempt_seq"`);
    for (const table of ATTEMPT_TABLES) {
      const fn = `m4t1_attempt_${table}`;
      await client.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION "${schema}"."${fn}"() RETURNS trigger AS $fn$ BEGIN PERFORM nextval('"${schema}"."m4t1_attempt_seq"'); RETURN NEW; END; $fn$ LANGUAGE plpgsql`,
      );
      await client.$executeRawUnsafe(
        `CREATE TRIGGER "${fn}" BEFORE INSERT ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}"."${fn}"()`,
      );
    }
  }

  async function attemptCount(): Promise<number> {
    const rows = await db().$queryRawUnsafe<{ last_value: bigint; is_called: boolean }[]>(
      `SELECT last_value, is_called FROM "${schema}"."m4t1_attempt_seq"`,
    );
    return rows[0]?.is_called ? Number(rows[0].last_value) : 0;
  }

  async function removeAttemptProbe() {
    const client = admin as PrismaClient;
    for (const table of ATTEMPT_TABLES) {
      const fn = `m4t1_attempt_${table}`;
      await client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fn}" ON "${schema}"."${table}"`);
      await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${fn}"()`);
    }
    await client.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${schema}"."m4t1_attempt_seq"`);
  }

  test('真实 SQL 数据层故障：HTTP 500，四表零增量，既有行与预置会话保留，失败不续期、同键恢复后严格续期', async () => {
    await reset();
    const baseline = await seedVisitor();
    const keeper = await seedVisitor();
    const baseInput = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });
    const kept = await service.createFirstMessage({ session: sessionOf(keeper), payload: baseInput });
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });

    await createTrigger('m4t1_fail_notification', `RAISE EXCEPTION 'synthetic notification failure';`, 'ChatNotification');
    // K2：失败后必须用同一个 payload（同一对 UUID）重试，不能改名绕开。
    const pending = payload();
    const activityBefore = await lastActivity(baseline.id);
    try {
      beginTxAudit();
      const started = performance.now();
      const response = await post(pending, { cookie: `${CHAT_VISITOR_COOKIE}=${baseline.token}` });
      const httpMs = performance.now() - started;
      const body = await expectStatus(response, 500, '触发器故障不是数据库不可用');
      assert.equal(body?.error, 'internal_error');
      assert.equal(txDurations.length, 1, '应只有一笔事务');
      assert.ok(txDurations[0] <= 5_000, `失败事务也应受预算约束，实际 ${txDurations[0].toFixed(1)}ms`);
      assert.ok(httpMs >= txDurations[0] - 200, `HTTP 不应短于事务：http=${httpMs.toFixed(1)} tx=${txDurations[0].toFixed(1)}`);
      assertArmedPrefix();
      assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 }, '失败请求不得留下任何行');
      assert.equal(await lastActivity(baseline.id), activityBefore, '500 不得续期');
      const still = await db().chatConversation.findUniqueOrThrow({ where: { id: kept.conversationId } });
      assert.equal(still.id, kept.conversationId, '既有咨询必须保留');
    } finally {
      await dropTrigger('m4t1_fail_notification', 'ChatNotification');
    }

    const ok = await post(pending, { cookie: `${CHAT_VISITOR_COOKIE}=${baseline.token}` });
    await expectStatus(ok, 200, '移除触发器后用同一 payload 与 UUID 可成功');
    assert.deepEqual(await counts(), { conversations: 2, messages: 2, notifications: 2, readCursors: 0 });
    assert.ok((await lastActivity(baseline.id)) > activityBefore, '成功响应必须严格推进闲置期限');
  });

  test('慢 SQL 越过事务预算：事务在 5s 内被截断为 503，整笔回滚，失败不续期、同键恢复后严格续期', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const activityBefore = await lastActivity(visitor.id);
    await createTrigger('m4t1_slow_notification', `PERFORM pg_sleep(7); RETURN NEW;`, 'ChatNotification');
    const input = payload();
    try {
      beginTxAudit();
      const started = performance.now();
      const response = await post(input, { cookie });
      const httpMs = performance.now() - started;
      const body = await expectStatus(response, 503, '语句超时应映射 service_unavailable');
      assert.equal(body?.error, 'service_unavailable');
      assert.equal(txDurations.length, 1, '应只有一笔事务');
      const txMs = txDurations[0];
      // 首个语句拿到的剩余预算是 5000−0−800 量级；截断必须发生在 5s 契约内，而不是客户端兜底。
      assert.ok(txMs >= 3_500 && txMs <= 4_800, `事务应被剩余预算截断在 5s 内，实际 ${txMs.toFixed(1)}ms`);
      assert.ok(httpMs >= txMs - 200, `HTTP 不应短于事务：http=${httpMs.toFixed(1)} tx=${txMs.toFixed(1)}`);
      console.log(`[B2 single-7s] tx=${txMs.toFixed(1)}ms http=${httpMs.toFixed(1)}ms`);
      assertArmedPrefix();
      assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 }, '慢语句失败后整笔回滚');
      assert.equal(await lastActivity(visitor.id), activityBefore, '503 不得续期');
    } finally {
      await dropTrigger('m4t1_slow_notification', 'ChatNotification');
    }

    // K2：原 payload 与原 UUID 重试。
    const retry = await post(input, { cookie });
    await expectStatus(retry, 200, '移除慢触发器后用同一 payload 与 UUID 重试成功');
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
    assert.ok((await lastActivity(visitor.id)) > activityBefore, '成功响应必须严格推进闲置期限');
  });

  test('B2：两条不同语句各 3.5s 可单独成功，组合后第二条按剩余预算被取消', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;

    // 1) 只有会话插入慢 3.5s：单条可单独成功。
    await createTrigger('m4t1_slow_conv_only', `PERFORM pg_sleep(3.5); RETURN NEW;`, 'ChatConversation');
    try {
      beginTxAudit();
      const started = performance.now();
      await expectStatus(await post(payload(), { cookie }), 200, '单条会话慢语句可单独成功');
      const httpMs = performance.now() - started;
      assert.equal(txDurations.length, 1);
      assert.ok(txDurations[0] >= 3_400 && txDurations[0] <= 4_900, `单条会话慢语句的事务应约 3.5s，实际 ${txDurations[0].toFixed(1)}ms`);
      assert.ok(httpMs >= txDurations[0] - 200);
      assertArmedPrefix();
      assert.equal(dataStatementCount(), 7);
      assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
      console.log(`[B2 conv-only] tx=${txDurations[0].toFixed(1)}ms http=${httpMs.toFixed(1)}ms`);
    } finally {
      await dropTrigger('m4t1_slow_conv_only', 'ChatConversation');
    }

    // 2) 只有消息插入慢 3.5s：单条可单独成功。
    await createTrigger('m4t1_slow_msg_only', `PERFORM pg_sleep(3.5); RETURN NEW;`, 'ChatMessage');
    try {
      beginTxAudit();
      const started = performance.now();
      await expectStatus(await post(payload(), { cookie }), 200, '单条消息慢语句可单独成功');
      const httpMs = performance.now() - started;
      assert.equal(txDurations.length, 1);
      assert.ok(txDurations[0] >= 3_400 && txDurations[0] <= 4_900, `单条消息慢语句的事务应约 3.5s，实际 ${txDurations[0].toFixed(1)}ms`);
      assert.ok(httpMs >= txDurations[0] - 200);
      assertArmedPrefix();
      assert.equal(dataStatementCount(), 7);
      assert.deepEqual(await counts(), { conversations: 2, messages: 2, notifications: 2, readCursors: 0 });
      console.log(`[B2 msg-only] tx=${txDurations[0].toFixed(1)}ms http=${httpMs.toFixed(1)}ms`);
    } finally {
      await dropTrigger('m4t1_slow_msg_only', 'ChatMessage');
    }

    // 3) 两条不同语句各 3.5s：累计会超过 5s，第二条必须按剩余预算取消。
    await createTrigger('m4t1_slow_conv_both', `PERFORM pg_sleep(3.5); RETURN NEW;`, 'ChatConversation');
    await createTrigger('m4t1_slow_msg_both', `PERFORM pg_sleep(3.5); RETURN NEW;`, 'ChatMessage');
    const input = payload();
    const before = await counts();
    const activityBefore = await lastActivity(visitor.id);
    try {
      beginTxAudit();
      const started = performance.now();
      const response = await post(input, { cookie });
      const httpMs = performance.now() - started;
      const body = await expectStatus(response, 503, '跨两条语句累计超预算应 503');
      assert.equal(body?.error, 'service_unavailable');
      assert.equal(txDurations.length, 1, '应只有一笔事务');
      const txMs = txDurations[0];
      assert.ok(txMs >= 3_400, `首条 3.5s 语句应真实执行，实际 ${txMs.toFixed(1)}ms`);
      assert.ok(txMs <= 4_800, `事务须在 5s 前由剩余预算取消（不是 5s 客户端兜底），实际 ${txMs.toFixed(1)}ms`);
      assert.ok(httpMs >= txMs - 200, `HTTP 不应短于事务：http=${httpMs.toFixed(1)} tx=${txMs.toFixed(1)}`);
      assertArmedPrefix();
      assert.ok(dataStatementCount() >= 5, `被取消前至少应有 5 条数据语句，实际 ${dataStatementCount()}`);
      assert.deepEqual(await counts(), before, '失败后四表零增量');
      assert.equal(await lastActivity(visitor.id), activityBefore, '503 不得续期');
      console.log(`[B2 both] tx=${txMs.toFixed(1)}ms http=${httpMs.toFixed(1)}ms dataStatements=${dataStatementCount()}`);
    } finally {
      await dropTrigger('m4t1_slow_conv_both', 'ChatConversation');
      await dropTrigger('m4t1_slow_msg_both', 'ChatMessage');
    }

    const retry = await post(input, { cookie });
    await expectStatus(retry, 200, '两条慢触发器移除后同一 payload 恢复成功');
    assert.deepEqual(await counts(), {
      conversations: before.conversations + 1,
      messages: before.messages + 1,
      notifications: before.notifications + 1,
      readCursors: 0,
    });
    assert.ok((await lastActivity(visitor.id)) > activityBefore, '成功响应必须严格推进闲置期限');
  });

  // ---------- 真实 HTTP 边界 ----------

  test('已发布 productSlug 可创建；未发布产品 400 且不写库', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const published = await post(payload({ productSlug: CATALOG_SLUG }), { cookie });
    await expectStatus(published, 200, '目录内已发布产品');
    const unpublished = await post(payload({ productSlug: 'not-a-real-product' }), { cookie });
    const body = await expectStatus(unpublished, 400, '未发布产品必须拒绝');
    assert.equal(body?.error, 'invalid');
    assert.ok((body?.fieldErrors as Record<string, string> | undefined)?.productSlug);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
  });

  test('16,384 字节仍在限体内（400 字段错误而非 413），16,385 与流式超限都 413', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;

    const exact = (bytes: number) => {
      const input = { clientConversationId: randomUUID(), clientMessageId: randomUUID(), locale: 'en', bodyText: '' };
      const base = Buffer.byteLength(JSON.stringify(input), 'utf8');
      input.bodyText = 'x'.repeat(bytes - base);
      const json = JSON.stringify(input);
      assert.equal(Buffer.byteLength(json, 'utf8'), bytes);
      return json;
    };

    const atLimit = await post(exact(16_384), { cookie });
    assert.equal(atLimit.status, 400, '16,384 字节先过限体，再因正文过长报字段错误');

    const overLimit = await post(exact(16_385), { cookie });
    assert.equal(overLimit.status, 413);

    const streamed = await postStream([exact(16_385).slice(0, 8_000), exact(16_385).slice(8_000)], { cookie });
    assert.equal(streamed.status, 413, '无 content-length 的流式请求体也必须限体');
  });

  test('Unicode 正文按 code point 计：4000 接受，4001 返回字段错误', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const emojiOk = await post(payload({ bodyText: '😀'.repeat(4_000) }), { cookie });
    await expectStatus(emojiOk, 200, '4000 个 emoji 合法');
    const emojiTooLong = await post(payload({ bodyText: '😀'.repeat(4_001) }), { cookie });
    const body = await expectStatus(emojiTooLong, 400, '4001 个 emoji 超限');
    assert.ok((body?.fieldErrors as Record<string, string> | undefined)?.bodyText);
  });

  test('邮箱边界：合法 254 可发，255、CRLF 与显示名都返回字段错误，空值按未填处理', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;

    assert.equal(VALID_254_EMAIL.length, 254);
    await expectStatus(await post(payload({ email: VALID_254_EMAIL }), { cookie }), 200, '合法 254 邮箱');

    assert.equal(INVALID_255_EMAIL.length, 255);
    const tooLong = await expectStatus(await post(payload({ email: INVALID_255_EMAIL }), { cookie }), 400, '255 邮箱');
    assert.ok((tooLong?.fieldErrors as Record<string, string> | undefined)?.email);

    const crlf = await expectStatus(await post(payload({ email: 'Name <a@b.co>\r\n' }), { cookie }), 400, 'CRLF/显示名');
    assert.ok((crlf?.fieldErrors as Record<string, string> | undefined)?.email);

    await expectStatus(await post(payload({ email: '   ' }), { cookie }), 200, '空白邮箱按未填');
    const stored = await db().chatConversation.findFirstOrThrow({ where: { email: null } });
    assert.equal(stored.email, null);
  });

  test('HTTP 幂等与拒分析：重复提交返回 duplicate，且不创建分析身份', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const input = payload();

    const first = await post(input, { cookie });
    const firstBody = ConversationReceivedDTOSchema.parse(await first.json());
    assert.equal(firstBody.duplicate, false);
    const second = await post(input, { cookie });
    const secondBody = ConversationReceivedDTOSchema.parse(await second.json());
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.message.id, firstBody.message.id);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
    // 拒绝分析仍可聊天：请求只带必要 cookie，不创建任何分析身份或事件。
    assert.equal(await db().analyticsEvent.count(), 0);
  });

  test('无 cookie、畸形 cookie、多张同名 cookie 都 401，不写库', async () => {
    await reset();
    assert.equal((await post(payload())).status, 401);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=not-a-token` })).status, 401);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=a; ${CHAT_VISITOR_COOKIE}=b` })).status, 401);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 });
  });

  test('非 JSON、未知字段与错源都被拒绝', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    assert.equal((await post('{', { cookie })).status, 400);
    assert.equal((await post({ ...payload(), identity: 'someone-else' }, { cookie })).status, 400);
    assert.equal((await post(payload(), { cookie, origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 });
  });

  // ---------- 10 节:121 新会话两桶（与写桶是两个配额） ----------

  test('新会话 cookie 桶：同一 cookie 第 11 次返回 429 且带 Retry-After', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      await expectStatus(await post(payload(), { cookie, ip }), 200, `第 ${i + 1} 次应通过`);
    }
    const limited = await post(payload(), { cookie, ip });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '600');
    const body = await limited.json() as { error?: string };
    assert.equal(body.error, 'rate_limited');
  });

  test('新会话 IP 桶：同一可信边缘 IP 第 21 次返回 429（不同 cookie 也拦）', async () => {
    await reset();
    const ip = nextIp();
    for (let i = 0; i < 20; i++) {
      const visitor = await seedVisitor();
      await expectStatus(
        await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}`, ip }),
        200,
        `同 IP 第 ${i + 1} 次应通过`,
      );
    }
    const visitor = await seedVisitor();
    const limited = await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}`, ip });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '600');
  });

  // ---------- C3：只有成功响应才 touch ----------

  async function lastActivity(id: string): Promise<number> {
    const row = await db().chatVisitorSession.findUniqueOrThrow({ where: { id } });
    return row.lastActivityAt.getTime();
  }

  test('C3：400/409 失败请求不推进闲置期限，200 新建与重放都严格推进', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const seeded = await lastActivity(visitor.id);

    assert.equal((await post(payload({ productSlug: 'not-a-real-product' }), { cookie })).status, 400);
    assert.equal(await lastActivity(visitor.id), seeded, '400 不得 touch');

    await sleep(5);
    const input = payload();
    assert.equal((await post(input, { cookie })).status, 200);
    const afterCreate = await lastActivity(visitor.id);
    assert.ok(afterCreate > seeded, `200 新建必须严格推进闲置期限（seeded=${seeded}, after=${afterCreate}）`);
    assert.equal((await post({ ...input, bodyText: 'different content' }, { cookie })).status, 409);
    assert.equal(await lastActivity(visitor.id), afterCreate, '409 不得 touch');

    await sleep(10);
    assert.equal((await post(input, { cookie })).status, 200);
    assert.ok((await lastActivity(visitor.id)) > afterCreate, '幂等重放 200 也要严格 touch');
  });

  test('C3：过期与撤销会话 401，不 touch 也不写库', async () => {
    await reset();
    const visitor = await seedVisitor();
    await db().chatVisitorSession.update({ where: { id: visitor.id }, data: { revokedAt: new Date() } });
    const revokedAt = await lastActivity(visitor.id);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` })).status, 401);
    assert.equal(await lastActivity(visitor.id), revokedAt);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 });

    const expired = await seedVisitor();
    await db().chatVisitorSession.update({
      where: { id: expired.id },
      data: { absoluteExpiresAt: new Date(Date.now() - 1_000) },
    });
    const expiredAt = await lastActivity(expired.id);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=${expired.token}` })).status, 401);
    assert.equal(await lastActivity(expired.id), expiredAt);
  });

  test('C3：bootstrap（会话签发/复用）仍然 touch', async () => {
    await reset();
    const visitor = await seedVisitor();
    const before = await lastActivity(visitor.id);
    await sleep(10);
    // 动态导入：composition 会加载 db.ts，必须在 before 设好 DATABASE_URL 之后。
    const { createChatServices } = await import('../src/lib/server/composition');
    const services = createChatServices({ db: db() as never, clock: () => new Date() });
    const outcome = await services.visitorSessions.establish(visitor.token);
    assert.equal(outcome.kind, 'reused');
    assert.ok((await lastActivity(visitor.id)) > before, 'bootstrap 必须严格推进闲置期限');
  });

  test('C3：resolve 后撤销 → 事务内首守卫拒绝，零插入尝试、零行、不续期', async () => {
    await reset();
    const visitor = await seedVisitor();
    const sessions = createVisitorSessionService({ repo: createVisitorSessionRepo(db() as never) });
    const resolved = await sessions.resolve(visitor.token);
    if (resolved.kind !== 'valid') assert.fail('resolve 应返回有效会话');
    const activityBefore = await lastActivity(visitor.id);
    await db().chatVisitorSession.update({ where: { id: visitor.id }, data: { revokedAt: new Date() } });
    await installAttemptProbe();
    try {
      const service = createConversationService({ db: db(), clock: () => new Date() });
      await assert.rejects(
        () => service.createFirstMessage({ session: resolved.session, payload: payload() }),
        (error: unknown) => error instanceof ChatSessionNoLongerValid,
      );
      assert.equal(await attemptCount(), 0, '守卫在 readExisting 前，不得尝试任何插入');
      assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 });
      assert.equal(await lastActivity(visitor.id), activityBefore, '失败不得续期');
    } finally {
      await removeAttemptProbe();
    }
  });

  test('C3：慢写期间撤销 → 最终 touch 零行，401 整笔回滚、插入已尝试、既有行保留', async () => {
    await reset();
    const visitor = await seedVisitor();
    const keeper = await seedVisitor();
    const keeperService = createConversationService({ db: db(), clock: () => new Date() });
    const kept = await keeperService.createFirstMessage({ session: sessionOf(keeper), payload: payload() });
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 });
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const activityBefore = await lastActivity(visitor.id);
    await installAttemptProbe();
    await createTrigger('m4t1_slow_notify_revoke', `PERFORM pg_sleep(1.5); RETURN NEW;`, 'ChatNotification');
    try {
      const pending = post(payload(), { cookie });
      await sleep(500);
      await db().chatVisitorSession.update({ where: { id: visitor.id }, data: { revokedAt: new Date() } });
      const response = await pending;
      const body = await expectStatus(response, 401, '事务内撤销应 401');
      assert.equal(body?.error, 'unauthorized');
      assert.match(response.headers.get('set-cookie') ?? '', /pj_chat=;/, '应清除访客 cookie');
      assert.equal(await attemptCount(), 2, '守卫已过：会话与消息插入各尝试 1 次（共 2 次 nextval）');
      assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 }, '四表差量 0');
      const still = await db().chatConversation.findUniqueOrThrow({ where: { id: kept.conversationId } });
      assert.equal(still.id, kept.conversationId, '既有咨询必须保留');
      assert.equal(await lastActivity(visitor.id), activityBefore, '失败不得续期');
    } finally {
      await dropTrigger('m4t1_slow_notify_revoke', 'ChatNotification');
      await removeAttemptProbe();
    }
  });

  test('C3：慢写期间自然过期 → 最终 touch 零行，401 整笔回滚、插入已尝试', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const activityBefore = await lastActivity(visitor.id);
    await installAttemptProbe();
    await createTrigger('m4t1_slow_notify_expire', `PERFORM pg_sleep(1.5); RETURN NEW;`, 'ChatNotification');
    try {
      const pending = post(payload(), { cookie });
      await sleep(500);
      await db().chatVisitorSession.update({
        where: { id: visitor.id },
        data: { absoluteExpiresAt: new Date(Date.now() - 1_000) },
      });
      const response = await pending;
      await expectStatus(response, 401, '事务内自然过期应 401');
      assert.equal(await attemptCount(), 2, '守卫已过：会话与消息插入各尝试 1 次（共 2 次 nextval）');
      assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 }, '四表差量 0');
      assert.equal(await lastActivity(visitor.id), activityBefore, '失败不得续期');
    } finally {
      await dropTrigger('m4t1_slow_notify_expire', 'ChatNotification');
      await removeAttemptProbe();
    }
  });

  test('C3：撤销后同键重放也过守卫（401 而非 duplicate）', async () => {
    await reset();
    const visitor = await seedVisitor();
    const service = createConversationService({ db: db(), clock: () => new Date() });
    const input = payload();
    await service.createFirstMessage({ session: sessionOf(visitor), payload: input });
    const sessions = createVisitorSessionService({ repo: createVisitorSessionRepo(db() as never) });
    const resolved = await sessions.resolve(visitor.token);
    if (resolved.kind !== 'valid') assert.fail('resolve 应返回有效会话');
    await db().chatVisitorSession.update({ where: { id: visitor.id }, data: { revokedAt: new Date() } });
    await assert.rejects(
      () => service.createFirstMessage({ session: resolved.session, payload: input }),
      (error: unknown) => error instanceof ChatSessionNoLongerValid,
    );
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1, readCursors: 0 }, '重放不得新增或返回 duplicate');
  });

  test('resolve 段数据库不可用 → HTTP 503；未知数据错误仍 500', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const dbModule = await import('../src/lib/server/db');
    const client = dbModule.prisma as unknown as { chatVisitorSession: { findUnique: (...args: unknown[]) => unknown } };
    const delegate = client.chatVisitorSession;
    const original = delegate.findUnique.bind(delegate);
    try {
      delegate.findUnique = async () => {
        throw Object.assign(new Error('simulated pool timeout'), { code: 'P2024', name: 'PrismaClientKnownRequestError' });
      };
      const response = await post(payload(), { cookie });
      const body = await expectStatus(response, 503, 'resolve 段池超时应 503');
      assert.equal(body?.error, 'service_unavailable');
      assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0, readCursors: 0 });
    } finally {
      delegate.findUnique = original;
    }
    try {
      delegate.findUnique = async () => {
        throw Object.assign(new Error('simulated data error'), { code: 'P2010', name: 'PrismaClientKnownRequestError' });
      };
      const response = await post(payload(), { cookie });
      const body = await expectStatus(response, 500, '未知数据错误仍 500');
      assert.equal(body?.error, 'internal_error');
    } finally {
      delegate.findUnique = original;
    }
  });

  test('arm 覆盖：每条数据语句前都按剩余预算重设语句/锁上限，事务受 5s 约束', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    beginTxAudit();
    await expectStatus(await post(payload(), { cookie }), 200, '普通创建成功');
    assert.equal(txDurations.length, 1, '应只有一笔事务');
    assert.ok(txDurations[0] <= 5_000, `事务超 5s：${txDurations[0].toFixed(1)}ms`);
    assertArmedPrefix();
    assert.equal(dataStatementCount(), 7, '新会话应有 7 条数据语句（守卫/查找/插入会话/seq/消息/通知/touch）');
    console.log(`[ARM] dataStatements=${dataStatementCount()} tx=${txDurations[0].toFixed(1)}ms`);
  });

  test('剩余预算主动耗尽：剩余 <50ms 时抛 ChatTransactionBudgetExceeded 且不写库（假 DB 单元）', async () => {
    let writes = 0;
    const fakeTx = {
      $executeRawUnsafe: async (sql: string) => {
        if (!String(sql).startsWith('SET LOCAL')) writes += 1;
      },
      $executeRaw: async () => {
        writes += 1;
      },
      $queryRaw: async () => {
        // 守卫查询吃掉 4.2s；下一次 arm 的剩余预算必然 < 50ms。
        const until = performance.now() + 4_200;
        while (performance.now() < until) { /* busy wait */ }
        return [{ id: 'fake-session' }];
      },
    };
    const fakeDb = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx) };
    const service = createConversationService({ db: fakeDb as never, clock: () => new Date() });
    const started = performance.now();
    await assert.rejects(
      () => service.createFirstMessage({ session: sessionOf({ id: 'fake-session', token: 'fake-token' }), payload: payload() }),
      (error: unknown) => error instanceof ChatTransactionBudgetExceeded,
    );
    console.log(`[BUDGET] exhausted_after=${(performance.now() - started).toFixed(1)}ms writes=${writes}`);
    assert.equal(writes, 0, '预算耗尽不得尝试写入');
  });

  test('K5：精确 16,384 字节的合法载荷返回 200', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = {
      clientConversationId: randomUUID(),
      clientMessageId: randomUUID(),
      locale: 'en' as const,
      bodyText: '😀'.repeat(4_000),
    };
    let json = JSON.stringify(input);
    const pad = 16_384 - Buffer.byteLength(json, 'utf8');
    assert.ok(pad > 0, '4000 个 emoji 的 JSON 必须小于 16KiB');
    json += ' '.repeat(pad);
    assert.equal(Buffer.byteLength(json, 'utf8'), 16_384);
    assert.equal((await post(json, { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` })).status, 200);
  });

  test('数据库不可用分类只认连接/超时，不误判数据层异常', () => {
    assert.equal(isDatabaseUnavailable({ name: 'PrismaClientInitializationError' }), true);
    assert.equal(isDatabaseUnavailable({ code: 'P1001' }), true);
    assert.equal(isDatabaseUnavailable({ code: 'P2028' }), true);
    assert.equal(isDatabaseUnavailable({ code: 'P2010', meta: { code: '57014' } }), true);
    assert.equal(isDatabaseUnavailable({ code: 'ECONNREFUSED' }), true);
    assert.equal(isDatabaseUnavailable({ code: 'P0001' }), false, '触发器 RAISE 默认 P0001 不是不可用');
    assert.equal(isDatabaseUnavailable({ code: 'P2002' }), false, '唯一冲突不是不可用');
    assert.equal(isDatabaseUnavailable(new Error('boom')), false);
  });
});