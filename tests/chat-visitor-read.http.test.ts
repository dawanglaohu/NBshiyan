// M4-T2 访客消息页与读位置的真实 PostgreSQL + HTTP 验收。
//
// 载体安全：只认专属变量 B10_M4T2_TEST_DATABASE_URL，必须 loopback；**绝不回退通用 DATABASE_URL**
// （通用变量是业务库）。CHAT_REQUIRE_DATABASE=true 时缺专属 URL 直接失败，不静默 skip。
// schema 所有权：先查 pg_namespace 确认不存在，再 CREATE SCHEMA；只有本进程确认创建成功才在事后删除。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  ChatConversationDTOSchema,
  ChatSyncDTOSchema,
  ReadDTOSchema,
} from '../src/lib/contracts/chat';
import { createConversationService } from '../src/lib/server/chat/conversation-service';
import {
  CHAT_SEQ_MAX,
  consecutivePage,
  nextVisitorReadSeq,
  pageStartSeq,
} from '../src/lib/server/chat/read-cursor';
import { hashChatToken, type ValidatedSession } from '../src/lib/server/chat/visitor-session';
import { CHAT_VISITOR_POLICY } from '../src/lib/server/config';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const DEDICATED = process.env.B10_M4T2_TEST_DATABASE_URL?.trim();
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
  throw new Error('B10_M4T2_TEST_DATABASE_URL must be a loopback postgres URL when CHAT_REQUIRE_DATABASE=true');
}
const skip = !BASE_URL && 'no loopback B10_M4T2_TEST_DATABASE_URL';
const EDGE_SECRET = 'e'.repeat(32);

// ---------------------------------------------------------------------------
// 纯规则（不依赖数据库）
// ---------------------------------------------------------------------------

describe('M4-T2 读位置与分页纯规则', () => {
  test('read MAX：前进、不回退、不越过 lastSeq', () => {
    assert.equal(nextVisitorReadSeq(0, 3, 5), 3);
    assert.equal(nextVisitorReadSeq(3, 1, 5), 3, '旧响应不能倒退读位置');
    assert.equal(nextVisitorReadSeq(3, 99, 5), 5, '越过 lastSeq 只推进到已存在的最大 seq');
    assert.equal(nextVisitorReadSeq(5, 0, 5), 5);
    assert.equal(nextVisitorReadSeq(0, 0, 0), 0);
    assert.throws(() => nextVisitorReadSeq(-1, 0, 0), /chat seq/);
    assert.throws(() => nextVisitorReadSeq(0, CHAT_SEQ_MAX + 1, CHAT_SEQ_MAX), /chat seq/);
  });

  test('afterSeq 落在 lastSeq 之后时从尾部起算，返回空页且 hasMore=false', () => {
    assert.equal(pageStartSeq(9, 5), 5);
    const page = consecutivePage([], pageStartSeq(9, 5), 5);
    assert.deepEqual(page.messages, []);
    assert.equal(page.nextAfterSeq, 5);
    assert.equal(page.hasMore, false);
  });

  test('缺号立即截断：游标停在已完整接收的范围', () => {
    const rows = [{ seq: 3 }, { seq: 4 }, { seq: 6 }];
    const page = consecutivePage(rows, 2, 6);
    assert.deepEqual(page.messages.map((row) => row.seq), [3, 4]);
    assert.equal(page.nextAfterSeq, 4);
    assert.equal(page.hasMore, true, '缺号后面的消息不能算已收齐');
  });
});

// ---------------------------------------------------------------------------
// 真实库 + 真实路由
// ---------------------------------------------------------------------------

describe('M4-T2 访客 GET 同步与 read 单调推进', { concurrency: false, skip, timeout: 180_000 }, () => {
  let admin: PrismaClient | null = null;
  let conn: PrismaClient | null = null;
  let schema = '';
  let createdByUs = false;
  let getRoute: typeof import('../src/app/api/chat/conversations/[id]/route');
  let readRoute: typeof import('../src/app/api/chat/conversations/[id]/read/route');
  let conversationsRoute: typeof import('../src/app/api/chat/conversations/route');

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
    schema = `chatread_${process.pid}_${randomBytes(4).toString('hex')}`;
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
    // 路由通过组合点拿全局 prisma；必须在导入路由之前把连接指向本次独占 schema。
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = 'test';
    process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
    setRateLimitStore(new MemoryStore());

    getRoute = await import('../src/app/api/chat/conversations/[id]/route');
    readRoute = await import('../src/app/api/chat/conversations/[id]/read/route');
    conversationsRoute = await import('../src/app/api/chat/conversations/route');
  });

  after(async () => {
    await conn?.$disconnect().catch(() => undefined);
    if (createdByUs && admin && schema) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin?.$disconnect().catch(() => undefined);
    setRateLimitStore(undefined);
  });

  type Visitor = { id: string; token: string; tokenHash: string };

  async function seedVisitor(options: { idleExpired?: boolean; absoluteExpired?: boolean; revoked?: boolean } = {}): Promise<Visitor> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashChatToken(token);
    const id = randomBytes(16).toString('base64url');
    const now = Date.now();
    const lastActivityAt = new Date(now - (options.idleExpired ? CHAT_VISITOR_POLICY.idleMs + 5_000 : 0));
    const absoluteExpiresAt = new Date(now + (options.absoluteExpired ? -5_000 : CHAT_VISITOR_POLICY.absoluteMs));
    await db().$executeRaw`
      INSERT INTO "ChatVisitorSession" ("id", "tokenHash", "createdAt", "lastActivityAt", "absoluteExpiresAt", "revokedAt")
      VALUES (${id}, ${tokenHash},
              ${lastActivityAt.toISOString()}::timestamptz AT TIME ZONE 'UTC',
              ${lastActivityAt.toISOString()}::timestamptz AT TIME ZONE 'UTC',
              ${absoluteExpiresAt.toISOString()}::timestamptz AT TIME ZONE 'UTC',
              ${options.revoked ? new Date().toISOString() : null}::timestamptz AT TIME ZONE 'UTC')
    `;
    return { id, token, tokenHash };
  }

  function sessionOf(visitor: Visitor): ValidatedSession {
    return {
      id: visitor.id,
      tokenHash: visitor.tokenHash,
      expiresAt: new Date(Date.now() + CHAT_VISITOR_POLICY.idleMs),
    } as unknown as ValidatedSession;
  }

  function cookieOf(visitor: Visitor): string {
    return `pj_chat=${visitor.token}`;
  }

  async function createConversation(visitor: Visitor, bodyText = 'Hello, I need a quote.'): Promise<{ conversationId: string }> {
    const service = createConversationService({ db: db() });
    const received = await service.createFirstMessage({
      session: sessionOf(visitor),
      payload: {
        clientConversationId: randomUUID(),
        clientMessageId: randomUUID(),
        locale: 'en',
        bodyText,
      },
    });
    return { conversationId: received.conversationId };
  }

  async function addMessage(conversationId: string, sender: 'VISITOR' | 'OPERATOR', bodyText: string): Promise<number> {
    const rows = await db().$queryRaw<{ lastSeq: number }[]>`
      UPDATE "ChatConversation"
      SET "lastSeq" = "lastSeq" + 1,
          "updatedAt" = (now() AT TIME ZONE 'UTC'),
          "lastActivityAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = ${conversationId}
      RETURNING "lastSeq"
    `;
    const seq = rows[0]?.lastSeq;
    if (typeof seq !== 'number') throw new Error('conversation missing');
    await db().$executeRaw`
      INSERT INTO "ChatMessage" ("id", "conversationId", "seq", "sender", "authorId", "clientMessageId",
        "payloadHash", "bodyText", "createdAt", "redactedAt")
      VALUES (${randomUUID()}, ${conversationId}, ${seq}, ${sender}::"ChatSender", ${null}, ${randomUUID()},
        ${'seed'}, ${bodyText}, (now() AT TIME ZONE 'UTC'), ${null})
    `;
    return seq;
  }

  function getSync(
    conversationId: string,
    options: { cookie?: string | null; afterSeq?: number; limit?: number; rawQuery?: string } = {},
  ): Promise<Response> {
    const url = new URL(`http://127.0.0.1/api/chat/conversations/${conversationId}`);
    if (options.rawQuery !== undefined) url.search = options.rawQuery;
    else {
      if (options.afterSeq !== undefined) url.searchParams.set('afterSeq', String(options.afterSeq));
      if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
    }
    const headers: Record<string, string> = {};
    if (options.cookie !== null && options.cookie !== undefined) headers.cookie = options.cookie;
    return Promise.resolve(
      getRoute.GET(new Request(url, { method: 'GET', headers }), { params: Promise.resolve({ id: conversationId }) }),
    );
  }

  function postRead(
    conversationId: string,
    body: unknown,
    options: { cookie?: string | null; origin?: string | null; rawBody?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.cookie !== null && options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.origin !== null) headers.origin = options.origin ?? 'http://127.0.0.1';
    return Promise.resolve(
      readRoute.POST(
        new Request(`http://127.0.0.1/api/chat/conversations/${conversationId}/read`, {
          method: 'POST',
          headers,
          body: options.rawBody ?? JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: conversationId }) },
      ),
    );
  }

  async function json(response: Response): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, text };
  }

  test('GET 首屏：本人会话按 seq 升序返回，nextAfterSeq/hasMore/read 与 lastSeq 自洽', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    await addMessage(conversationId, 'OPERATOR', 'Thanks, how many units?');

    const response = await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0, limit: 50 });
    const parsed = await json(response);
    assert.equal(parsed.status, 200, parsed.text);
    const dto = ChatSyncDTOSchema.parse(parsed.body);
    ChatConversationDTOSchema.parse(dto.conversation);
    assert.equal(dto.lastSeq, 2);
    assert.deepEqual(dto.messages.map((message) => message.seq), [1, 2]);
    assert.equal(dto.nextAfterSeq, 2);
    assert.equal(dto.hasMore, false);
    assert.equal(dto.read.lastReadSeq, 0, 'GET 不得替访客标已读');
  });

  test('翻页：limit=2 分两页取完，页间插入的新消息补齐且 ID 恰出现一次', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    await addMessage(conversationId, 'OPERATOR', 'second');
    await addMessage(conversationId, 'OPERATOR', 'third');

    const first = ChatSyncDTOSchema.parse((await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0, limit: 2 }))).body);
    assert.deepEqual(first.messages.map((message) => message.seq), [1, 2]);
    assert.equal(first.nextAfterSeq, 2);
    assert.equal(first.hasMore, true);

    // 页间插入：lastSeq 从 3 变成 5。
    await addMessage(conversationId, 'VISITOR', 'fourth');
    await addMessage(conversationId, 'OPERATOR', 'fifth');

    const second = ChatSyncDTOSchema.parse(
      (await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: first.nextAfterSeq, limit: 2 }))).body,
    );
    assert.deepEqual(second.messages.map((message) => message.seq), [3, 4]);
    assert.equal(second.nextAfterSeq, 4);
    assert.equal(second.hasMore, true);

    const third = ChatSyncDTOSchema.parse(
      (await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: second.nextAfterSeq, limit: 2 }))).body,
    );
    assert.deepEqual(third.messages.map((message) => message.seq), [5]);
    assert.equal(third.hasMore, false);

    const ids = [...first.messages, ...second.messages, ...third.messages].map((message) => message.id);
    assert.equal(new Set(ids).size, ids.length, '同一批翻页里消息 ID 必须唯一');
    assert.equal(ids.length, 5);
  });

  test('afterSeq 越过 lastSeq：空页、nextAfterSeq=lastSeq、hasMore=false，DTO 仍自洽', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    const parsed = await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 99 }));
    assert.equal(parsed.status, 200, parsed.text);
    const dto = ChatSyncDTOSchema.parse(parsed.body);
    assert.deepEqual(dto.messages, []);
    assert.equal(dto.nextAfterSeq, dto.lastSeq);
    assert.equal(dto.hasMore, false);
  });

  test('read MAX：只前进、不回退、越过 lastSeq 只推进到最大已有 seq', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    await addMessage(conversationId, 'OPERATOR', 'second');
    await addMessage(conversationId, 'OPERATOR', 'third');

    const first = ReadDTOSchema.parse((await json(await postRead(conversationId, { lastReadSeq: 2 }, { cookie: cookieOf(visitor) }))).body);
    assert.equal(first.lastReadSeq, 2);

    const stale = ReadDTOSchema.parse((await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor) }))).body);
    assert.equal(stale.lastReadSeq, 2, '旧响应/重试不能回退读位置');

    const beyond = ReadDTOSchema.parse((await json(await postRead(conversationId, { lastReadSeq: 999 }, { cookie: cookieOf(visitor) }))).body);
    assert.equal(beyond.lastReadSeq, 3, '读位置不得超过服务端 lastSeq');

    const sync = ChatSyncDTOSchema.parse((await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0 }))).body);
    assert.equal(sync.read.lastReadSeq, 3);
    assert.ok(sync.read.lastReadSeq <= sync.lastSeq);
  });

  test('轮询只更新收件游标：多次 GET 不推进 read，read 之后 GET 也不重复写', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    await addMessage(conversationId, 'OPERATOR', 'second');

    for (let i = 0; i < 3; i += 1) {
      const dto = ChatSyncDTOSchema.parse((await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0 }))).body);
      assert.equal(dto.read.lastReadSeq, 0);
    }

    ReadDTOSchema.parse((await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor) }))).body);
    const afterRead = ChatSyncDTOSchema.parse((await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0 }))).body);
    assert.equal(afterRead.read.lastReadSeq, 1);

    const repeated = ReadDTOSchema.parse((await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor) }))).body);
    assert.equal(repeated.lastReadSeq, 1);
  });

  test('90 天保留：真实 POST conversations 存首消息后，反复 GET/read 不改 retainUntil/lastActivityAt', async () => {
    const visitor = await seedVisitor();
    const clientConversationId = randomUUID();
    const created = await json(
      await conversationsRoute.POST(
        new Request('http://127.0.0.1/api/chat/conversations', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: cookieOf(visitor),
            origin: 'http://127.0.0.1',
            'cf-connecting-ip': '10.44.0.1',
            'x-edge-auth': EDGE_SECRET,
          },
          body: JSON.stringify({
            clientConversationId,
            clientMessageId: randomUUID(),
            locale: 'en',
            bodyText: 'Hello, I need a quote.',
          }),
        }),
      ),
    );
    assert.equal(created.status, 200, created.text);
    const conversationId = String((created.body as { conversationId: string }).conversationId);

    await addMessage(conversationId, 'OPERATOR', 'second');

    const before = await db().chatConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { retainUntil: true, lastActivityAt: true, lastSeq: true, visitorReadSeq: true },
    });
    await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0 });
    await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor) });
    await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 1 });

    const after = await db().chatConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { retainUntil: true, lastActivityAt: true, lastSeq: true, visitorReadSeq: true },
    });
    assert.equal(after.retainUntil.toISOString(), before.retainUntil.toISOString(), 'GET/read 不能延长保留期');
    assert.equal(after.lastActivityAt.toISOString(), before.lastActivityAt.toISOString(), 'GET/read 不能改最后活动时间');
    assert.equal(after.lastSeq, before.lastSeq, 'GET/read 不改 lastSeq');
    assert.equal(after.visitorReadSeq, 1);
  });

  test('归属：别人的会话、随机 id、非法 id 一律 404；无 cookie 或过期 cookie 401', async () => {
    const owner = await seedVisitor();
    const other = await seedVisitor();
    const { conversationId } = await createConversation(owner);

    const foreign = await json(await getSync(conversationId, { cookie: cookieOf(other) }));
    assert.equal(foreign.status, 404);

    const randomId = await json(await getSync(`missing-${randomUUID()}`, { cookie: cookieOf(owner) }));
    assert.equal(randomId.status, 404);

    const invalidId = await json(await getSync('bad.id', { cookie: cookieOf(owner) }));
    assert.equal(invalidId.status, 404);

    const noCookie = await json(await getSync(conversationId, { cookie: null }));
    assert.equal(noCookie.status, 401);

    const idleExpired = await seedVisitor({ idleExpired: true });
    const expired = await json(await getSync(conversationId, { cookie: cookieOf(idleExpired) }));
    assert.equal(expired.status, 401, '闲置过期的 cookie 不能读');

    const absoluteExpired = await seedVisitor({ absoluteExpired: true });
    const absolute = await json(await getSync(conversationId, { cookie: cookieOf(absoluteExpired) }));
    assert.equal(absolute.status, 401, '超过绝对期限的 cookie 不能读');

    const revoked = await seedVisitor({ revoked: true });
    const revokedResponse = await json(await getSync(conversationId, { cookie: cookieOf(revoked) }));
    assert.equal(revokedResponse.status, 401, '被撤销的 cookie 不能读');
  });

  test('过期 cookie 被拒绝时，保留中的消息与正文不变（E-85）', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor, 'Keep my body intact.');
    const before = await db().chatMessage.findMany({
      where: { conversationId },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, bodyText: true, createdAt: true },
    });

    const expired = await seedVisitor({ absoluteExpired: true });
    const response = await json(await getSync(conversationId, { cookie: cookieOf(expired) }));
    assert.equal(response.status, 401);

    const after = await db().chatMessage.findMany({
      where: { conversationId },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, bodyText: true, createdAt: true },
    });
    assert.deepEqual(after, before);
  });

  test('read 的写入口：缺 Origin/跨源 403，非法请求 400，非本人 404', async () => {
    const owner = await seedVisitor();
    const other = await seedVisitor();
    const { conversationId } = await createConversation(owner);

    const noOrigin = await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(owner), origin: null }));
    assert.equal(noOrigin.status, 403);

    const crossOrigin = await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(owner), origin: 'https://evil.example' }));
    assert.equal(crossOrigin.status, 403);

    const negative = await json(await postRead(conversationId, { lastReadSeq: -1 }, { cookie: cookieOf(owner) }));
    assert.equal(negative.status, 400);

    const extraField = await json(await postRead(conversationId, { lastReadSeq: 1, extra: true }, { cookie: cookieOf(owner) }));
    assert.equal(extraField.status, 400);

    const foreign = await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(other) }));
    assert.equal(foreign.status, 404);
  });

  test('查询串严格校验：limit 超上限/afterSeq 负数 400；关闭后读与同步仍允许', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);

    assert.equal((await getSync(conversationId, { cookie: cookieOf(visitor), limit: 101 })).status, 400);
    assert.equal((await getSync(conversationId, { cookie: cookieOf(visitor), rawQuery: 'afterSeq=-1' })).status, 400);
    assert.equal((await getSync(conversationId, { cookie: cookieOf(visitor), rawQuery: 'afterSeq=abc' })).status, 400);

    await db().$executeRaw`UPDATE "ChatConversation" SET "status" = ${'CLOSED'}::"ChatConversationStatus" WHERE "id" = ${conversationId}`;
    const closed = await json(await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0 }));
    assert.equal(closed.status, 200, '09：关闭后读/同步仍允许');
    const readClosed = await json(await postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor) }));
    assert.equal(readClosed.status, 200);
  });

  async function counterTotals(routeId: string): Promise<{ requestCount: number; errorCount: number }> {
    const rows = await db().$queryRaw<{ requestCount: number; errorCount: number }[]>`
      SELECT COALESCE(SUM("requestCount"), 0)::int AS "requestCount",
             COALESCE(SUM("errorCount"), 0)::int AS "errorCount"
      FROM "ApiDailyCounter"
      WHERE "routeId" = ${routeId}
    `;
    return rows[0] ?? { requestCount: 0, errorCount: 0 };
  }

  test('每个响应恰计一次：200 与 400/401/403/404/413 都进 ApiDailyCounter，5xx 之外 errorCount 不变', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    const GET_ID = 'GET /api/chat/conversations/[id]';
    const READ_ID = 'POST /api/chat/conversations/[id]/read';

    async function expectOnce(routeId: string, run: () => Promise<Response>, expectedStatus: number) {
      const before = await counterTotals(routeId);
      const response = await run();
      assert.equal(response.status, expectedStatus);
      const after = await counterTotals(routeId);
      assert.equal(after.requestCount - before.requestCount, 1, `${routeId} ${expectedStatus} 必须恰计一次`);
      assert.equal(after.errorCount - before.errorCount, 0, '4xx 不增加 errorCount');
    }

    await expectOnce(GET_ID, () => getSync(conversationId, { cookie: cookieOf(visitor) }), 200);
    await expectOnce(GET_ID, () => getSync(conversationId, { cookie: cookieOf(visitor), limit: 101 }), 400);
    await expectOnce(GET_ID, () => getSync(conversationId, { cookie: null }), 401);
    await expectOnce(GET_ID, () => getSync(`missing-${randomUUID()}`, { cookie: cookieOf(visitor) }), 404);
    await expectOnce(
      READ_ID,
      () => postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor), origin: 'https://evil.example' }),
      403,
    );
    await expectOnce(
      READ_ID,
      () => postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor), rawBody: 'x'.repeat(16 * 1024 + 1) }),
      413,
    );
    await expectOnce(READ_ID, () => postRead(conversationId, { lastReadSeq: 1 }, { cookie: cookieOf(visitor) }), 200);
  });

  test('同步限流 429 也计数：同 cookie 第 61 次为 429，共 61 次入账', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    const routeId = 'GET /api/chat/conversations/[id]';
    const before = await counterTotals(routeId);
    let lastStatus = 0;
    for (let i = 0; i < 61; i += 1) {
      lastStatus = (await getSync(conversationId, { cookie: cookieOf(visitor), afterSeq: 0 })).status;
    }
    assert.equal(lastStatus, 429);
    const after = await counterTotals(routeId);
    assert.equal(after.requestCount - before.requestCount, 61, '每个响应（含 429）恰计一次，不重复计数');
    assert.equal(after.errorCount - before.errorCount, 0);
  });

  test('多张同名 cookie：401 清 cookie 的 Set-Cookie 不丢', async () => {
    const visitor = await seedVisitor();
    const { conversationId } = await createConversation(visitor);
    const response = await getSync(conversationId, { cookie: `pj_chat=${visitor.token}; pj_chat=other` });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('set-cookie') ?? '', /pj_chat=;/, '歧义 cookie 必须被清除');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
});
