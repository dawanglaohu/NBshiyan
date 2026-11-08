// M4-T1 咨询首消息与唯一通知出箱的真实 PostgreSQL 验收。
//
// 覆盖：真实插入（会话 + 首消息 + seq + messageId 唯一出箱同事务）、幂等重放、异载荷 409、
// 并发同名只落一条、通知写入失败零部分写入、访客身份隔离、以及真实 HTTP 路由的
// 401/413/400 与 16KiB/邮箱/正文校验边界。
//
// 缺库时整组 skip（与仓库既有 db 测试一致）；CHAT_REQUIRE_DATABASE=true 时缺库直接抛错。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConversationReceivedDTOSchema } from '../src/lib/contracts/chat';
import { CHAT_RETENTION_MS } from '../src/lib/chat/rules';
import { ChatIdempotencyConflict, createConversationService } from '../src/lib/server/chat/conversation-service';
import { createChatRepo } from '../src/lib/server/chat/repo';
import { CHAT_VISITOR_COOKIE, hashChatToken } from '../src/lib/server/chat/visitor-session';
import { CHAT_VISITOR_POLICY } from '../src/lib/server/config';

const base = process.env.DATABASE_URL;
const SCHEMA = `chatfirst_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
if (process.env.CHAT_REQUIRE_DATABASE === 'true' && !url) {
  throw new Error('DATABASE_URL must be a postgres URL when CHAT_REQUIRE_DATABASE=true');
}
const skip = !url && 'no DATABASE_URL';
const NOW = new Date('2026-05-01T10:00:00.000Z');

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

describe('M4-T1 原子保存咨询首消息与唯一通知出箱', { concurrency: false, skip, timeout: 120_000 }, () => {
  let conn: PrismaClient;
  let route: typeof import('../src/app/api/chat/conversations/route');

  before(async () => {
    if (!url) return;
    conn = new PrismaClient({ datasources: { db: { url } } });
    await conn.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 路由通过组合点拿全局 prisma，必须在导入路由模块之前把连接指向同一隔离 schema。
    process.env.DATABASE_URL = url;
    route = await import('../src/app/api/chat/conversations/route');
  });

  after(async () => {
    if (!conn) return;
    assert.match(SCHEMA, /^chatfirst_\d+$/);
    await conn.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await conn.$disconnect();
  });

  async function reset() {
    await conn.$executeRawUnsafe(`DELETE FROM "ChatNotification"`);
    await conn.$executeRawUnsafe(`DELETE FROM "ChatMessage"`);
    await conn.$executeRawUnsafe(`DELETE FROM "ChatReadCursor"`);
    await conn.$executeRawUnsafe(`DELETE FROM "ChatConversation"`);
    await conn.$executeRawUnsafe(`DELETE FROM "ChatVisitorSession"`);
  }

  async function seedVisitor(): Promise<{ id: string; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    // 必要会话按真实时钟签发：HTTP 用例走真实路由，固定业务时钟会让 cookie 显得早已过期。
    const signedAt = new Date();
    await conn.chatVisitorSession.create({
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

  const counts = async () => ({
    conversations: await conn.chatConversation.count(),
    messages: await conn.chatMessage.count(),
    notifications: await conn.chatNotification.count(),
  });

  test('首次提交：会话、首消息 seq=1 与唯一出箱在同一事务里落库', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: conn, clock: () => NOW });

    const received = await service.createFirstMessage({ visitorSessionId: visitor.id, payload: input });
    ConversationReceivedDTOSchema.parse(received);
    assert.equal(received.duplicate, false);
    assert.equal(received.message.seq, 1);
    assert.equal(received.message.sender, 'VISITOR');
    assert.equal(received.receivedAt, received.message.createdAt);

    const conversation = await conn.chatConversation.findUniqueOrThrow({ where: { id: received.conversationId } });
    assert.equal(conversation.visitorSessionId, visitor.id);
    assert.equal(conversation.clientConversationId, input.clientConversationId);
    assert.equal(conversation.lastSeq, 1);
    assert.equal(conversation.status, 'OPEN');
    assert.equal(conversation.email, input.email);
    assert.equal(conversation.sourcePath, null);
    assert.equal(conversation.retainUntil.getTime(), NOW.getTime() + CHAT_RETENTION_MS);

    const notification = await conn.chatNotification.findUniqueOrThrow({ where: { messageId: received.message.id } });
    assert.equal(notification.status, 'QUEUED');
    assert.equal(notification.conversationId, received.conversationId);
    assert.equal(notification.stableMessageId, `${received.message.id}@chat.packjoyu`);
    assert.equal(notification.attempts, 0);
    // 通知只存收件事实，不复制正文或邮箱。
    assert.equal('bodyText' in notification, false);
    assert.equal(JSON.stringify(notification).includes(input.bodyText), false);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
  });

  test('同 UUID 同载荷重复提交：返回原 id/seq/receivedAt，不新增消息或通知', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: conn, clock: () => NOW });

    const first = await service.createFirstMessage({ visitorSessionId: visitor.id, payload: input });
    const replay = await service.createFirstMessage({ visitorSessionId: visitor.id, payload: input });

    assert.equal(replay.duplicate, true);
    assert.equal(replay.conversationId, first.conversationId);
    assert.deepEqual(replay.message, first.message);
    assert.equal(replay.receivedAt, first.receivedAt);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
  });

  test('同 UUID 异载荷：抛 409 冲突，不写任何行', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: conn, clock: () => NOW });
    await service.createFirstMessage({ visitorSessionId: visitor.id, payload: input });

    await assert.rejects(
      () => service.createFirstMessage({
        visitorSessionId: visitor.id,
        payload: { ...input, bodyText: 'A different message.' },
      }),
      (error: unknown) => error instanceof ChatIdempotencyConflict && error.field === 'clientConversationId',
    );
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
  });

  test('并发同名提交：只落一条消息、一条通知，两边拿到同一结果', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: conn, clock: () => NOW });

    const [a, b] = await Promise.all([
      service.createFirstMessage({ visitorSessionId: visitor.id, payload: input }),
      service.createFirstMessage({ visitorSessionId: visitor.id, payload: input }),
    ]);

    assert.equal(a.conversationId, b.conversationId);
    assert.equal(a.message.id, b.message.id);
    assert.equal(a.message.seq, b.message.seq);
    assert.equal(a.receivedAt, b.receivedAt);
    assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
  });

  test('通知写入失败：整笔回滚，不留下半个会话或没有出箱的消息', async () => {
    await reset();
    const visitor = await seedVisitor();
    const failingRepo = {
      ...createChatRepo(conn),
      insertNotification: async () => {
        throw new Error('notification insert failed');
      },
    };
    const service = createConversationService({ db: conn, clock: () => NOW, repo: failingRepo });

    await assert.rejects(
      () => service.createFirstMessage({ visitorSessionId: visitor.id, payload: payload() }),
      /notification insert failed/,
    );
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });
  });

  test('访客身份隔离：不同访客会话用同一 clientConversationId 各自建自己的会话', async () => {
    await reset();
    const first = await seedVisitor();
    const second = await seedVisitor();
    const input = payload();
    const service = createConversationService({ db: conn, clock: () => NOW });

    const a = await service.createFirstMessage({ visitorSessionId: first.id, payload: input });
    const b = await service.createFirstMessage({ visitorSessionId: second.id, payload: input });

    assert.notEqual(a.conversationId, b.conversationId);
    assert.deepEqual(await counts(), { conversations: 2, messages: 2, notifications: 2 });
    const rows = await conn.chatConversation.findMany({ select: { visitorSessionId: true } });
    assert.deepEqual(rows.map((row) => row.visitorSessionId).sort(), [first.id, second.id].sort());
  });

  // ---- 真实 HTTP 路由：只带必要 cookie，不依赖分析同意 ----
  function post(body: unknown, options: { cookie?: string; origin?: string | null } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.origin !== null) headers.origin = options.origin ?? 'http://127.0.0.1';
    return route.POST(new Request('http://127.0.0.1/api/chat/conversations', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
  }

  test('真实 POST + 必要 cookie：200，返回 DTO 并落库（无分析同意也可用）', async () => {
    await reset();
    const visitor = await seedVisitor();
    const input = payload({ email: undefined });
    const response = await post(input, { cookie: `${CHAT_VISITOR_COOKIE}=${visitor.token}` });
    assert.equal(response.status, 200);
    const body = ConversationReceivedDTOSchema.parse(await response.json());
    assert.equal(body.duplicate, false);
    assert.equal(body.message.seq, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(JSON.stringify(body).includes(visitor.token), false);
    assert.deepEqual(await counts(), { conversations: 1, messages: 1, notifications: 1 });
  });

  test('无 cookie、畸形 cookie、多张同名 cookie 都 401，不写库', async () => {
    await reset();
    const missing = await post(payload());
    assert.equal(missing.status, 401);
    const malformed = await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=not-a-token` });
    assert.equal(malformed.status, 401);
    const ambiguous = await post(payload(), { cookie: `${CHAT_VISITOR_COOKIE}=a; ${CHAT_VISITOR_COOKIE}=b` });
    assert.equal(ambiguous.status, 401);
    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });
  });

  test('超 16KiB 先限体返回 413，正文 4001 code point 与含 CRLF 的邮箱返回 400 字段错误', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;

    const tooLarge = await post({ ...payload(), bodyText: 'x'.repeat(17 * 1024) }, { cookie });
    assert.equal(tooLarge.status, 413);

    const tooLong = await post(payload({ bodyText: 'x'.repeat(4_001) }), { cookie });
    assert.equal(tooLong.status, 400);
    const tooLongBody = await tooLong.json() as { error: string; fieldErrors?: Record<string, string> };
    assert.equal(tooLongBody.error, 'invalid');
    assert.ok(tooLongBody.fieldErrors?.bodyText);

    const badEmail = await post(payload({ email: 'Name <visitor@example.com>\r\n' }), { cookie });
    assert.equal(badEmail.status, 400);
    const badEmailBody = await badEmail.json() as { error: string; fieldErrors?: Record<string, string> };
    assert.equal(badEmailBody.error, 'invalid');
    assert.ok(badEmailBody.fieldErrors?.email);

    assert.deepEqual(await counts(), { conversations: 0, messages: 0, notifications: 0 });
  });

  test('空邮箱按未填写处理；非 JSON、未知字段与错源都被拒绝', async () => {
    await reset();
    const visitor = await seedVisitor();
    const cookie = `${CHAT_VISITOR_COOKIE}=${visitor.token}`;

    const blankEmail = await post(payload({ email: '   ' }), { cookie });
    assert.equal(blankEmail.status, 200);
    const created = await conn.chatConversation.findFirstOrThrow();
    assert.equal(created.email, null);

    const notJson = await post('{', { cookie });
    assert.equal(notJson.status, 400);

    const unknownField = await post({ ...payload(), identity: 'someone-else' }, { cookie });
    assert.equal(unknownField.status, 400);

    const wrongOrigin = await post(payload(), { cookie, origin: 'https://evil.example' });
    assert.equal(wrongOrigin.status, 403);
  });
});
