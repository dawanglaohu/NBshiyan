import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import { AdminChatSyncDTOSchema, ChatSummaryPageDTOSchema, ChatSyncDTOSchema, ConversationReceivedDTOSchema, MessageReceivedDTOSchema } from '../src/lib/contracts/chat';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const url = process.env.M4T3_TEST_DATABASE_URL ? new URL(process.env.M4T3_TEST_DATABASE_URL) : null;
if (url && (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
  throw new Error('M4T3_TEST_DATABASE_URL must point to a dedicated loopback PostgreSQL database');
}
if (!url && process.env.M4T3_REQUIRE_DATABASE === 'true') throw new Error('M4T3_TEST_DATABASE_URL is required');

const origin = 'http://127.0.0.1:3000';
const inboxPath = '/api/admin/chat/conversations';
const visitorPath = '/api/chat/conversations';

describe('M4-T3 operator inbox HTTP', { skip: !url && 'no dedicated M4T3_TEST_DATABASE_URL', timeout: 120_000 }, () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let appDb: PrismaClient | undefined;
  let schemaCreated = false;
  const schema = `m4t3_${randomBytes(8).toString('hex')}`;
  let auth: typeof import('../src/app/api/auth/[...nextauth]/route');
  let list: typeof import('../src/app/api/admin/chat/conversations/route').GET;
  let detail: typeof import('../src/app/api/admin/chat/conversations/[id]/route').GET;
  let read: typeof import('../src/app/api/admin/chat/conversations/[id]/read/route').POST;
  let startVisitor: typeof import('../src/app/api/chat/session/route').POST;
  let create: typeof import('../src/app/api/chat/conversations/route').POST;
  let append: typeof import('../src/app/api/chat/conversations/[id]/messages/route').POST;
  let visitorDetail: typeof import('../src/app/api/chat/conversations/[id]/route').GET;
  let admin: Awaited<ReturnType<typeof operator>>;
  let sales: Awaited<ReturnType<typeof operator>>;

  before(async () => {
    assert.ok(url);
    const base = new URL(url);
    base.searchParams.delete('schema');
    owner = new PrismaClient({ datasourceUrl: base.href });
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    base.searchParams.set('schema', schema);
    base.searchParams.set('connection_limit', '5');
    process.env.DATABASE_URL = base.href;
    process.env.APP_ENV = 'test';
    process.env.AUTH_SECRET = 'm4t3-auth-secret-for-tests-only';
    process.env.ADMIN_TOTP_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.EDGE_AUTH_SECRET = 'e'.repeat(32);
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;

    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    db = new PrismaClient({ datasourceUrl: base.href });
    ({ prisma: appDb } = await import('../src/lib/server/db'));
    auth = await import('../src/app/api/auth/[...nextauth]/route');
    ({ GET: list } = await import('../src/app/api/admin/chat/conversations/route'));
    ({ GET: detail } = await import('../src/app/api/admin/chat/conversations/[id]/route'));
    ({ POST: read } = await import('../src/app/api/admin/chat/conversations/[id]/read/route'));
    ({ POST: startVisitor } = await import('../src/app/api/chat/session/route'));
    ({ POST: create } = await import('../src/app/api/chat/conversations/route'));
    ({ POST: append } = await import('../src/app/api/chat/conversations/[id]/messages/route'));
    ({ GET: visitorDetail } = await import('../src/app/api/chat/conversations/[id]/route'));
    setRateLimitStore(new MemoryStore());
    admin = await operator('ADMIN');
    sales = await operator('SALES');
  });

  beforeEach(async () => {
    await db.chatConversation.deleteMany();
    await db.chatVisitorSession.deleteMany();
    setRateLimitStore(new MemoryStore());
  });

  after(async () => {
    setRateLimitStore(undefined);
    await appDb?.$disconnect();
    await db?.$disconnect();
    try {
      if (schemaCreated) await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await owner?.$disconnect();
    }
  });

  function request(path: string, cookie = '', body?: unknown, requestOrigin = origin) {
    return new Request(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function cookies(response: Response) {
    return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  }

  async function operator(role: Role) {
    const password = 'm4t3-isolated-test-password';
    const secret = authenticator.generateSecret();
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.com`, name: role, role,
        passwordHash: await hashSecret(password), totpEnabled: true, totpSecret: encrypt(secret),
      },
    });
    const csrf = await auth.GET(request('/api/auth/csrf'));
    const { csrfToken } = await csrf.json();
    const login = await auth.POST(new Request(origin + '/api/auth/callback/credentials', {
      method: 'POST',
      headers: { cookie: cookies(csrf), origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: user.email, password, csrfToken, totp: authenticator.generate(secret) }),
    }));
    const cookie = cookies(login);
    assert.match(cookie, /authjs\.session-token=[^;]+/);
    const device = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: user.id } });
    return { userId: user.id, deviceId: device.id, cookie };
  }

  function context(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  async function conversation() {
    const session = await startVisitor(request('/api/chat/session', '', { locale: 'en' }));
    assert.equal(session.status, 200, await session.clone().text());
    const cookie = cookies(session);
    const payload = {
      clientConversationId: randomUUID(), clientMessageId: randomUUID(),
      locale: 'en', bodyText: 'First consultation', email: 'visitor@example.com',
    };
    const created = await create(request(visitorPath, cookie, payload));
    assert.equal(created.status, 200, await created.clone().text());
    return { ...ConversationReceivedDTOSchema.parse(await created.json()), cookie, payload };
  }

  async function expectError(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(AppErrorDTOSchema.parse(await response.json()).error, code);
  }

  function getDetail(id: string, cookie: string, query = '') {
    return detail(request(`${inboxPath}/${id}${query}`, cookie), context(id));
  }

  function mark(id: string, cookie: string, lastReadSeq: number) {
    return read(request(`${inboxPath}/${id}/read`, cookie, { lastReadSeq }), context(id));
  }

  async function inbox(cookie: string, query = '') {
    const res = await list(request(inboxPath + query, cookie));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    return ChatSummaryPageDTOSchema.parse(await res.json());
  }

  async function sync(id: string, cookie = admin.cookie, query = '') {
    const res = await getDetail(id, cookie, query);
    assert.equal(res.status, 200, await res.clone().text());
    return AdminChatSyncDTOSchema.parse(await res.json());
  }

  test('E-19 / E-32 / E-78: all routes recheck Auth.js device and current role', async () => {
    const { conversationId: id, cookie: visitorCookie } = await conversation();
    const editor = await operator('EDITOR');
    const demoted = await operator('SALES');
    const revoked = await operator('SALES');
    for (const cookie of [admin.cookie, sales.cookie, demoted.cookie, revoked.cookie]) {
      assert.equal((await sync(id, cookie)).conversation.email, 'visitor@example.com');
    }
    await db.user.update({ where: { id: demoted.userId }, data: { role: 'EDITOR' } });
    await db.adminDeviceSession.update({ where: { id: revoked.deviceId }, data: { revokedAt: new Date() } });

    for (const [cookie, status, code] of [
      ['', 401, 'unauthorized'], [visitorCookie, 401, 'unauthorized'],
      [revoked.cookie, 401, 'unauthorized'], [editor.cookie, 403, 'forbidden'],
      [demoted.cookie, 403, 'forbidden'],
    ] as const) {
      await expectError(await list(request(inboxPath, cookie)), status, code);
      await expectError(await getDetail(id, cookie), status, code);
      await expectError(await mark(id, cookie, 1), status, code);
    }
    assert.equal(await db.chatReadCursor.count(), 0);
    assert.equal((await inbox(sales.cookie)).items[0]?.id, id);
  });

  test('E-34: keyset ordering uses id for equal timestamps; total spans all pages and filters', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await conversation()).conversationId);
    ids.sort().reverse();
    await db.chatConversation.updateMany({ data: { updatedAt: new Date() } });
    await db.chatConversation.update({ where: { id: ids[2] }, data: { status: 'CLOSED' } });
    const first = await inbox(admin.cookie, '?limit=2');
    assert.deepEqual(first.items.map((item) => item.id), ids.slice(0, 2));
    assert.equal(first.unreadTotal, 4);
    assert.ok(first.nextCursor);
    const second = await inbox(admin.cookie, `?limit=2&cursor=${first.nextCursor}`);
    assert.deepEqual(second.items.map((item) => item.id), ids.slice(2));
    assert.equal(second.unreadTotal, 4);
    assert.equal(second.nextCursor, null);

    assert.equal((await mark(ids[0]!, admin.cookie, 1)).status, 200);
    const filtered = await inbox(admin.cookie, '?status=OPEN&unreadOnly=true');
    assert.deepEqual(filtered.items.map((item) => item.id), [ids[1], ids[3]]);
    assert.equal(filtered.unreadTotal, 3);
    assert.equal((await inbox(sales.cookie)).unreadTotal, 4);
  });

  test('E-34 / E-79: bounded pages catch up across a real append, GET leaves both cursors unread', async () => {
    const { conversationId: id, cookie, message } = await conversation();
    await db.$transaction([
      db.chatMessage.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(), conversationId: id, seq: index + 2, sender: 'VISITOR',
        clientMessageId: randomUUID(), payloadHash: 'fixture', bodyText: 'Pagination fixture', createdAt: new Date(),
      })) }),
      db.chatConversation.update({ where: { id }, data: { lastSeq: 102 } }),
    ]);
    const first = await sync(id, admin.cookie, '?limit=100');
    assert.equal(first.messages.length, 100);
    assert.equal(first.nextAfterSeq, 100);
    assert.equal(first.lastSeq, 102);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.read, { lastReadSeq: 0 });
    assert.deepEqual(first.notifications, [{ messageId: message.id, status: 'QUEUED' }]);

    const newMessagePath = `${visitorPath}/${id}/messages`;
    const appended = await append(request(newMessagePath, cookie, {
      clientMessageId: randomUUID(), bodyText: 'Arrived between pages',
    }), context(id));
    assert.equal(appended.status, 200, await appended.clone().text());
    assert.equal(await db.chatReadCursor.count(), 0);
    assert.equal((await inbox(admin.cookie)).unreadTotal, 103);

    // Acknowledge only the first page while the next page is still unseen.
    const writes = await Promise.all([100, 12, 98, 99].map((seq) => mark(id, admin.cookie, seq)));
    assert.ok(writes.every((response) => response.status === 200));
    assert.equal((await inbox(admin.cookie)).unreadTotal, 3);
    const second = await sync(id, admin.cookie, `?afterSeq=${first.nextAfterSeq}&limit=100`);
    const seen = [...first.messages, ...second.messages];
    assert.deepEqual(seen.map((item) => item.seq), Array.from({ length: 103 }, (_, index) => index + 1));
    assert.equal(new Set(seen.map((item) => item.id)).size, 103);
    assert.equal(seen[0]?.id, message.id);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.read, { lastReadSeq: 100 });
    assert.deepEqual((await sync(id, sales.cookie)).read, { lastReadSeq: 0 });
    assert.equal((await mark(id, admin.cookie, 102)).status, 200);
    assert.equal((await inbox(admin.cookie)).unreadTotal, 1);
    assert.equal((await inbox(sales.cookie)).unreadTotal, 103);
    assert.equal((await db.chatConversation.findUniqueOrThrow({ where: { id } })).visitorReadSeq, 0);
    assert.deepEqual(await (await mark(id, admin.cookie, 2147483647)).json(), { lastReadSeq: 103 });
    assert.deepEqual(await (await mark(id, admin.cookie, 50)).json(), { lastReadSeq: 103 });
  });

  test('E-35: detail returns all six stored statuses in visitor message page order', async () => {
    const { conversationId: id, cookie, message } = await conversation();
    await conversation();
    const replyId = randomUUID();
    const now = new Date();
    await db.$transaction([
      db.chatMessage.create({ data: {
        id: replyId, conversationId: id, seq: 2, sender: 'OPERATOR', authorId: admin.userId,
        clientMessageId: randomUUID(), payloadHash: 'fixture', bodyText: 'Operator reply', createdAt: now,
      } }),
      db.chatNotification.create({ data: {
        id: randomUUID(), conversationId: id, messageId: replyId, status: 'SENT',
        availableAt: now, stableMessageId: 'reply-fixture', createdAt: now, updatedAt: now,
      } }),
      db.chatConversation.update({ where: { id }, data: { lastSeq: 2 } }),
    ]);
    const statuses = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'DISABLED'] as const;
    const ids = [message.id];
    for (const status of statuses.slice(1)) {
      const res = await append(request(`${visitorPath}/${id}/messages`, cookie, {
        clientMessageId: randomUUID(), bodyText: `Message for ${status}`,
      }), context(id));
      assert.equal(res.status, 200, await res.clone().text());
      ids.push(MessageReceivedDTOSchema.parse(await res.json()).message.id);
    }
    const expected = statuses.map((status, index) => ({ messageId: ids[index]!, status }));
    for (const [index, { messageId, status }] of expected.entries()) {
      await db.chatNotification.update({ where: { messageId }, data: {
        status, createdAt: new Date(now.getTime() - index * 1000),
        leaseOwner: 'internal-worker', providerMessageId: 'internal-provider-id',
      } });
    }

    const first = await sync(id, admin.cookie, '?limit=3');
    assert.deepEqual(first.messages.map((row) => row.id), [ids[0], replyId, ids[1]]);
    assert.deepEqual(first.notifications, expected.slice(0, 2));
    assert.equal(first.nextAfterSeq, 3);
    const rest = await sync(id, sales.cookie, `?afterSeq=${first.nextAfterSeq}`);
    assert.deepEqual(rest.notifications, expected.slice(2));
    assert.deepEqual((await sync(id)).notifications, expected);
    assert.deepEqual((await sync(id, admin.cookie, '?afterSeq=7')).notifications, []);

    const visitor = await visitorDetail(request(`${visitorPath}/${id}`, cookie), context(id));
    assert.equal(visitor.status, 200, await visitor.clone().text());
    assert.deepEqual(ChatSyncDTOSchema.parse(await visitor.json()).messages[0], message);
  });

  test('E-35: a worker commit after the conversation read appears only in the next snapshot', async () => {
    const { conversationId: id, message } = await conversation();
    const { pending } = await db.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "ChatMessage" IN ACCESS EXCLUSIVE MODE`;
      const pending = getDetail(id, admin.cookie);
      // The message query can block only after the route has read the conversation.
      const deadline = Date.now() + 3_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [state] = await tx.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE relation = '"ChatMessage"'::regclass AND mode = 'AccessShareLock' AND NOT granted
          ) AS waiting
        `;
        waiting = state!.waiting;
        if (!waiting) await delay(20);
      }
      assert.ok(waiting, 'detail must reach the message query before the worker commits');
      await tx.chatNotification.update({ where: { messageId: message.id }, data: { status: 'SENT' } });
      return { pending };
    }, { timeout: 10_000 });
    const response = await pending;
    assert.equal(response.status, 200, await response.clone().text());
    const snapshot = AdminChatSyncDTOSchema.parse(await response.json());
    assert.deepEqual(snapshot.messages, [message]);
    assert.deepEqual(snapshot.notifications, [{ messageId: message.id, status: 'QUEUED' }]);
    assert.deepEqual((await sync(id)).notifications, [{ messageId: message.id, status: 'SENT' }]);
  });

  test('E-35 / E-41 / E-86 / E-89: delivery failure and cookie expiry leave retained messages processable', async () => {
    const { conversationId: id, cookie, message, receivedAt, payload } = await conversation();
    const before = await db.chatConversation.findUniqueOrThrow({ where: { id } });
    const outbox = await db.chatNotification.findUniqueOrThrow({ where: { messageId: message.id } });
    assert.equal(outbox.status, 'QUEUED');
    await db.chatNotification.update({ where: { id: outbox.id }, data: { status: 'FAILED' } });
    const replay = await create(request(visitorPath, cookie, payload));
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(ConversationReceivedDTOSchema.parse(await replay.json()), {
      conversationId: id, message, receivedAt, duplicate: true,
    });
    await db.chatVisitorSession.update({
      where: { id: before.visitorSessionId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
    });
    const visitor = await visitorDetail(request(`${visitorPath}/${id}`, cookie), context(id));
    assert.equal(visitor.status, 401);

    assert.equal((await inbox(admin.cookie, '?status=OPEN')).items[0]?.id, id);
    for (const cookie of [admin.cookie, sales.cookie]) {
      const current = await sync(id, cookie);
      assert.equal(current.conversation.status, 'OPEN');
      assert.equal(current.conversation.email, 'visitor@example.com');
      assert.deepEqual(current.messages, [message]);
      assert.deepEqual(current.notifications, [{ messageId: message.id, status: 'FAILED' }]);
      assert.equal(current.messages[0]?.createdAt, receivedAt);
      assert.equal((await mark(id, cookie, 1)).status, 200);
    }
    assert.deepEqual(await db.chatConversation.findUniqueOrThrow({ where: { id } }), before);
    assert.equal((await db.chatNotification.findUniqueOrThrow({ where: { id: outbox.id } })).status, 'FAILED');

    await db.chatConversation.update({
      where: { id }, data: { retainUntil: new Date(Date.now() - 1_000) },
    });
    assert.deepEqual((await inbox(admin.cookie)).items, []);
    await expectError(await getDetail(id, admin.cookie), 404, 'not_found');
    await expectError(await mark(id, admin.cookie, 1), 404, 'not_found');
  });

  test('write rechecks authorization after the initial guard', async () => {
    const { conversationId: id } = await conversation();
    const operatorToRevoke = await operator('SALES');
    class RevokeDuringRateLimit extends MemoryStore {
      override async hit(key: string, limit: number, windowMs: number) {
        if (key.endsWith(`:admin:chat.sync:user:${operatorToRevoke.userId}`)) {
          await db.adminDeviceSession.update({
            where: { id: operatorToRevoke.deviceId }, data: { revokedAt: new Date() },
          });
        }
        return super.hit(key, limit, windowMs);
      }
    }
    setRateLimitStore(new RevokeDuringRateLimit());
    await expectError(await mark(id, operatorToRevoke.cookie, 1), 401, 'unauthorized');
    assert.ok((await db.adminDeviceSession.findUniqueOrThrow({ where: { id: operatorToRevoke.deviceId } })).revokedAt);
    assert.equal(await db.chatReadCursor.count(), 0);
  });

  test('strict query and body limits, exact same origin and shared 60/min operator rate limit', async () => {
    const { conversationId: id } = await conversation();
    for (const query of ['?limit=101', '?limit=0', '?cursor=broken', '?email=visitor@example.com', '?limit=1&limit=2']) {
      await expectError(await list(request(inboxPath + query, admin.cookie)), 400, 'invalid');
    }
    await expectError(await getDetail(id, admin.cookie, '?limit=101'), 400, 'invalid');
    await expectError(await getDetail(id, admin.cookie, '?afterSeq=2147483648'), 400, 'invalid');
    const path = `${inboxPath}/${id}/read`;
    await expectError(await read(request(path, admin.cookie, { lastReadSeq: 1 }, 'https://elsewhere.example'), context(id)), 403, 'forbidden_origin');
    await expectError(await read(request(path, admin.cookie, { lastReadSeq: '1' }), context(id)), 400, 'invalid');
    await expectError(await read(request(path, admin.cookie, { lastReadSeq: 1, userId: sales.userId }), context(id)), 400, 'invalid');
    await expectError(await read(request(path, admin.cookie, { large: 'x'.repeat(16384) }), context(id)), 413, 'too_large');
    assert.equal(await db.chatReadCursor.count(), 0);

    setRateLimitStore(new MemoryStore());
    for (let i = 0; i < 60; i++) await inbox(admin.cookie);
    const limited = await mark(id, admin.cookie, 1);
    await expectError(limited, 429, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await getDetail(id, sales.cookie)).status, 200);
    assert.equal(await db.chatReadCursor.count(), 0);
  });
});
