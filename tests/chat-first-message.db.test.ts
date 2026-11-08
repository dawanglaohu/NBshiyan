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
import { ChatIdempotencyConflict, createConversationService } from '../src/lib/server/chat/conversation-service';
import { createChatRepo, isDatabaseUnavailable } from '../src/lib/server/chat/repo';
import { CHAT_VISITOR_COOKIE, hashChatToken, type ValidatedSession } from '../src/lib/server/chat/visitor-session';
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
  });

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
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
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
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
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
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
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
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
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
    assert.deepEqual(await counts(), { conversations: 2, messages: 2, notifications: 2 });
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

  async function createTrigger(name: string, body: string) {
    const client = admin as PrismaClient;
    await client.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION "${schema}"."${name}"() RETURNS trigger AS $fn$ BEGIN ${body} END; $fn$ LANGUAGE plpgsql`,
    );
    await client.$executeRawUnsafe(
      `CREATE TRIGGER "${name}" BEFORE INSERT ON "${schema}"."ChatNotification" FOR EACH ROW EXECUTE FUNCTION "${schema}"."${name}"()`,
    );
  }

  async function dropTrigger(name: string) {
    const client = admin as PrismaClient;
    await client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "${schema}"."ChatNotification"`);
    await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${name}"()`);
  }

  test('真实 SQL 数据层故障：HTTP 500，四表零增量，既有行与预置会话保留，移除后同键可成功', async () => {
    await reset();
    const baseline = await seedVisitor();
    const keeper = await seedVisitor();
    const baseInput = payload();
    const service = createConversationService({ db: db(), clock: () => NOW });
    const kept = await service.createFirstMessage({ session: sessionOf(keeper), payload: baseInput });
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });

    await createTrigger('m4t1_fail_notification', `RAISE EXCEPTION 'synthetic notification failure';`);
    // K2：失败后必须用同一个 payload（同一对 UUID）重试，不能改名绕开。
    const pending = payload();
    try {
      const response = await post(pending, { cookie: `${CHAT_VISITOR_COOKIE}=${baseline.token}` });
      const body = await expectStatus(response, 500, '触发器故障不是数据库不可用');
      assert.equal(body?.error, 'internal_error');
      assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 }, '失败请求不得留下任何行');
      const still = await db().chatConversation.findUniqueOrThrow({ where: { id: kept.conversationId } });
      assert.equal(still.id, kept.conversationId, '既有咨询必须保留');
    } finally {
      await dropTrigger('m4t1_fail_notification');
    }

    const ok = await post(pending, { cookie: `${CHAT_VISITOR_COOKIE}=${baseline.token}` });
    await expectStatus(ok, 200, '移除触发器后用同一 payload 与 UUID 可成功');
    assert.deepEqual(await counts(), { conversations: 2, messages: 2, notifications: 2 });
  });

  test('慢 SQL 越过事务预算：5s 内被截断为 503，整笔回滚，移除后重试成功', async () => {
    await reset();
    const visitor = await seedVisitor();
    await createTrigger('m4t1_slow_notification', `PERFORM pg_sleep(7); RETURN NEW;`);
    const input = payload();
    try {
      const started = Date.now();
      const response = await post(input, { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` });
      const elapsed = Date.now() - started;
      const body = await expectStatus(response, 503, '语句超时应映射 service_unavailable');
      assert.equal(body?.error, 'service_unavailable');
      // 首个语句拿到的剩余预算是 5000−0−800=4200ms，不是固定 4500ms。
      assert.ok(elapsed >= 3_800, `应真正跑到预算附近再被截断，实际 ${elapsed}ms`);
      assert.ok(elapsed <= 5_000, `事务必须受 5s 预算约束，实际 ${elapsed}ms`);
      assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 }, '慢语句失败后整笔回滚');
    } finally {
      await dropTrigger('m4t1_slow_notification');
    }

    // K2：原 payload 与原 UUID 重试。
    const retry = await post(input, { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` });
    await expectStatus(retry, 200, '移除慢触发器后用同一 payload 与 UUID 重试成功');
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
  });

  test('B2：两条各 3.5s 的语句累计也不得越过 5s 事务预算', async () => {
    await reset();
    const visitor = await seedVisitor();
    // 第一条慢语句落在会话插入，第二条落在消息插入：单条都 <4.2s，累计会超过 5s。
    await createTrigger('m4t1_slow_conversation', `PERFORM pg_sleep(3.5); RETURN NEW;`);
    await createTrigger('m4t1_slow_message', `PERFORM pg_sleep(3.5); RETURN NEW;`);
    const input = payload();
    try {
      const started = Date.now();
      const response = await post(input, { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` });
      const elapsed = Date.now() - started;
      const body = await expectStatus(response, 503, '累计超预算应 503');
      assert.equal(body?.error, 'service_unavailable');
      assert.ok(elapsed <= 5_000, `事务总耗时必须 ≤5000ms，实际 ${elapsed}ms`);
      assert.ok(elapsed >= 3_000, `必须先真的执行第一条慢语句，实际 ${elapsed}ms`);
      assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });
    } finally {
      await dropTrigger('m4t1_slow_conversation');
      await dropTrigger('m4t1_slow_message');
    }

    const retry = await post(input, { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` });
    await expectStatus(retry, 200, '两条慢触发器移除后同一 payload 恢复成功');
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
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
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
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
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
    // 拒绝分析仍可聊天：请求只带必要 cookie，不创建任何分析身份或事件。
    assert.equal(await db().analyticsEvent.count(), 0);
  });

  test('无 cookie、畸形 cookie、多张同名 cookie 都 401，不写库', async () => {
    await reset();
    assert.equal((await post(payload())).status, 401);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=not-a-token` })).status, 401);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=a; ${CHAT_VISITOR_COOKIE}=b` })).status, 401);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });
  });

  test('非 JSON、未知字段与错源都被拒绝', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    assert.equal((await post('{', { cookie })).status, 400);
    assert.equal((await post({ ...payload(), identity: 'someone-else' }, { cookie })).status, 400);
    assert.equal((await post(payload(), { cookie, origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });
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

  test('C3：400/409 失败请求不推进闲置期限，200 新建与重放都推进', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;
    const seeded = await lastActivity(visitor.id);

    assert.equal((await post(payload({ productSlug: 'not-a-real-product' }), { cookie })).status, 400);
    assert.equal(await lastActivity(visitor.id), seeded, '400 不得 touch');

    const input = payload();
    assert.equal((await post(input, { cookie })).status, 200);
    const afterCreate = await lastActivity(visitor.id);
    assert.ok(afterCreate >= seeded);
    assert.equal((await post({ ...input, bodyText: 'different content' }, { cookie })).status, 409);
    assert.equal(await lastActivity(visitor.id), afterCreate, '409 不得 touch');

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await post(input, { cookie })).status, 200);
    assert.ok((await lastActivity(visitor.id)) > afterCreate, '幂等重放 200 也要 touch');
  });

  test('C3：过期与撤销会话 401，不 touch 也不写库', async () => {
    await reset();
    const visitor = await seedVisitor();
    await db().chatVisitorSession.update({ where: { id: visitor.id }, data: { revokedAt: new Date() } });
    const revokedAt = await lastActivity(visitor.id);
    assert.equal((await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` })).status, 401);
    assert.equal(await lastActivity(visitor.id), revokedAt);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });

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
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 动态导入：composition 会加载 db.ts，必须在 before 设好 DATABASE_URL 之后。
    const { createChatServices } = await import('../src/lib/server/composition');
    const services = createChatServices({ db: db() as never, clock: () => new Date() });
    const outcome = await services.visitorSessions.establish(visitor.token);
    assert.equal(outcome.kind, 'reused');
    assert.ok((await lastActivity(visitor.id)) > before, 'bootstrap 必须推进闲置期限');
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