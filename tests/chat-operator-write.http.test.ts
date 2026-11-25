import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import {
  AdminChatSyncDTOSchema,
  ChatStatusDTOSchema,
  ChatSummaryPageDTOSchema,
  ChatSyncDTOSchema,
  ConversationReceivedDTOSchema,
  MessageReceivedDTOSchema,
} from '../src/lib/contracts/chat';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { CHAT_RETENTION_MS } from '../src/lib/chat/rules';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const url = process.env.M4T11_TEST_DATABASE_URL ? new URL(process.env.M4T11_TEST_DATABASE_URL) : null;
if (url && (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
  throw new Error('M4T11_TEST_DATABASE_URL must point to a dedicated loopback PostgreSQL database');
}
if (!url && process.env.M4T11_REQUIRE_DATABASE === 'true') throw new Error('M4T11_TEST_DATABASE_URL is required');

const origin = 'http://127.0.0.1:3000';
const inboxPath = '/api/admin/chat/conversations';
const visitorPath = '/api/chat/conversations';
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const message = (bodyText: string) => ({ clientMessageId: randomUUID(), bodyText });

function request(path: string, cookie = '', body?: unknown, method = body === undefined ? 'GET' : 'POST', requestOrigin = origin) {
  return new Request(origin + path, {
    method,
    headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(AppErrorDTOSchema.parse(await response.json()).error, code);
}

describe('M4-T11 operator write HTTP', { skip: !url && 'no dedicated M4T11_TEST_DATABASE_URL', timeout: 120_000 }, () => {
  const schema = `m4t11_${randomBytes(8).toString('hex')}`;
  let owner: PrismaClient;
  let db: PrismaClient;
  let appDb: PrismaClient | undefined;
  let schemaCreated = false;
  let auth: typeof import('../src/app/api/auth/[...nextauth]/route');
  let inbox: typeof import('../src/app/api/admin/chat/conversations/route').GET;
  let detail: typeof import('../src/app/api/admin/chat/conversations/[id]/route');
  let startVisitor: typeof import('../src/app/api/chat/session/route').POST;
  let create: typeof import('../src/app/api/chat/conversations/route').POST;
  let append: typeof import('../src/app/api/chat/conversations/[id]/messages/route').POST;
  let visitorDetail: typeof import('../src/app/api/chat/conversations/[id]/route').GET;
  let admin: Awaited<ReturnType<typeof login>>;
  let sales: Awaited<ReturnType<typeof login>>;

  before(async () => {
    assert.ok(url);
    const isolated = new URL(url);
    isolated.searchParams.delete('schema');
    owner = new PrismaClient({ datasourceUrl: isolated.href });
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    isolated.searchParams.set('schema', schema);
    isolated.searchParams.set('connection_limit', '5');
    process.env.DATABASE_URL = isolated.href;
    process.env.APP_ENV = 'test';
    process.env.AUTH_SECRET = 'm4t11-auth-secret-for-tests-only';
    process.env.PRIVACY_HASH_SECRET = 'm4t11-privacy-secret-for-tests-only';
    process.env.ADMIN_TOTP_KEY = Buffer.alloc(32, 11).toString('base64');
    process.env.EDGE_AUTH_SECRET = 'e'.repeat(32);
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;

    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    db = new PrismaClient({ datasourceUrl: isolated.href });
    ({ prisma: appDb } = await import('../src/lib/server/db'));
    auth = await import('../src/app/api/auth/[...nextauth]/route');
    ({ GET: inbox } = await import('../src/app/api/admin/chat/conversations/route'));
    detail = await import('../src/app/api/admin/chat/conversations/[id]/route');
    ({ POST: startVisitor } = await import('../src/app/api/chat/session/route'));
    ({ POST: create } = await import('../src/app/api/chat/conversations/route'));
    ({ POST: append } = await import('../src/app/api/chat/conversations/[id]/messages/route'));
    ({ GET: visitorDetail } = await import('../src/app/api/chat/conversations/[id]/route'));
    setRateLimitStore(new MemoryStore());
    admin = await login('ADMIN');
    sales = await login('SALES');
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

  async function login(role: Role) {
    const password = 'm4t11-isolated-test-password';
    const secret = authenticator.generateSecret();
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.com`, name: role, role,
        passwordHash: await hashSecret(password), totpEnabled: true, totpSecret: encrypt(secret),
      },
    });
    const csrf = await auth.GET(request('/api/auth/csrf'));
    const { csrfToken } = await csrf.json();
    const signedIn = await auth.POST(new Request(origin + '/api/auth/callback/credentials', {
      method: 'POST',
      headers: { cookie: cookies(csrf), origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: user.email, password, csrfToken, totp: authenticator.generate(secret) }),
    }));
    const cookie = cookies(signedIn);
    assert.match(cookie, /authjs\.session-token=[^;]+/);
    const device = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: user.id } });
    return { userId: user.id, deviceId: device.id, cookie };
  }

  async function conversation() {
    const session = await startVisitor(request('/api/chat/session', '', { locale: 'en' }));
    assert.equal(session.status, 200, await session.clone().text());
    const cookie = cookies(session);
    const created = await create(request(visitorPath, cookie, {
      ...message('Visitor wants a quote'),
      clientConversationId: randomUUID(),
      locale: 'en',
      email: 'visitor@example.com',
    }));
    assert.equal(created.status, 200, await created.clone().text());
    return { ...ConversationReceivedDTOSchema.parse(await created.json()), cookie };
  }

  async function reply(id: string, cookie: string, payload: unknown, requestOrigin = origin) {
    const { POST } = await import('../src/app/api/admin/chat/conversations/[id]/messages/route');
    return POST(request(`${inboxPath}/${id}/messages`, cookie, payload, 'POST', requestOrigin), context(id));
  }

  function close(id: string, cookie: string, payload: unknown, requestOrigin = origin) {
    return detail.PATCH(request(`${inboxPath}/${id}`, cookie, payload, 'PATCH', requestOrigin), context(id));
  }

  async function receipt(response: Response) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return MessageReceivedDTOSchema.parse(await response.json());
  }

  const operatorGet = (id: string, cookie: string) => detail.GET(request(`${inboxPath}/${id}`, cookie), context(id));
  const visitorGet = (id: string, cookie: string, query = '') =>
    visitorDetail(request(`${visitorPath}/${id}${query}`, cookie), context(id));
  const visitorSend = (id: string, cookie: string, payload: unknown) =>
    append(request(`${visitorPath}/${id}/messages`, cookie, payload), context(id));

  test('E-16 / E-31 / E-33: visitor receipt, operator inbox, concurrent human replies and visitor sync', async () => {
    const first = await conversation();
    const id = first.conversationId;
    const adminInbox = await inbox(request(inboxPath, admin.cookie));
    assert.equal(adminInbox.status, 200);
    const listed = ChatSummaryPageDTOSchema.parse(await adminInbox.json());
    assert.equal(listed.unreadTotal, 1);
    assert.equal(listed.items[0]?.id, id);
    const fetched = await operatorGet(id, sales.cookie);
    assert.equal(fetched.status, 200);
    const initial = AdminChatSyncDTOSchema.parse(await fetched.json());
    assert.deepEqual(initial.messages, [first.message]);

    const adminReply = message('I can prepare the quote');
    const salesReply = message('What quantity would you like?');
    await expectError(await reply(id, sales.cookie, { ...salesReply, authorId: admin.userId }), 400, 'invalid');
    const [a, b, retry] = await Promise.all([
      reply(id, admin.cookie, adminReply).then(receipt),
      reply(id, sales.cookie, salesReply).then(receipt),
      reply(id, admin.cookie, adminReply).then(receipt),
    ]);
    assert.deepEqual([a.duplicate, retry.duplicate].sort(), [false, true]);
    assert.deepEqual(retry.message, a.message);
    assert.deepEqual([a.message.seq, b.message.seq].sort(), [2, 3]);
    assert.equal(a.message.bodyText, adminReply.bodyText);
    assert.equal(b.message.bodyText, salesReply.bodyText);

    const stored = await db.chatMessage.findMany({ where: { conversationId: id }, orderBy: { seq: 'asc' } });
    assert.deepEqual(stored.map(({ seq }) => seq), [1, 2, 3]);
    assert.equal(stored.find(({ id }) => id === a.message.id)?.authorId, admin.userId);
    assert.equal(stored.find(({ id }) => id === b.message.id)?.authorId, sales.userId);
    assert.equal(stored[0].authorId, null);
    assert.equal(await db.chatNotification.count({ where: { conversationId: id } }), 1);
    const updatedInbox = await inbox(request(inboxPath, admin.cookie));
    assert.equal(updatedInbox.status, 200);
    assert.equal(ChatSummaryPageDTOSchema.parse(await updatedInbox.json()).unreadTotal, 3);

    const response = await visitorGet(id, first.cookie);
    assert.equal(response.status, 200);
    const view = ChatSyncDTOSchema.parse(await response.json());
    assert.deepEqual(view.messages, [first.message, ...[a.message, b.message].sort((left, right) => left.seq - right.seq)]);
    assert.deepEqual(view.messages.slice(1).map(({ sender }) => sender), ['OPERATOR', 'OPERATOR']);
    assert.equal(view.read.lastReadSeq, 0);
    const conversationRow = await db.chatConversation.findUniqueOrThrow({ where: { id } });
    assert.equal(conversationRow.retainUntil.getTime() - conversationRow.lastActivityAt.getTime(), CHAT_RETENTION_MS);
    assert.equal(conversationRow.lastActivityAt.toISOString(), view.messages.at(-1)?.createdAt);

    await expectError(await reply(id, admin.cookie, { ...adminReply, bodyText: 'Different text' }), 409, 'idempotency_conflict');
    await expectError(await reply(id, sales.cookie, adminReply), 409, 'idempotency_conflict');
    assert.deepEqual(await db.chatConversation.findUniqueOrThrow({ where: { id } }), conversationRow);
  });

  test('E-31: a database error rolls back the allocated sequence and same-key retry returns a receipt', async () => {
    const first = await conversation();
    const id = first.conversationId;
    const payload = message('Reply after retry');
    const before = await db.chatConversation.findUniqueOrThrow({ where: { id } });
    await db.$executeRaw`ALTER TABLE "ChatMessage" ADD CONSTRAINT reject_test_reply CHECK ("sender" <> 'OPERATOR')`;
    try {
      await expectError(await reply(id, admin.cookie, payload), 500, 'internal_error');
      assert.deepEqual(await db.chatConversation.findUniqueOrThrow({ where: { id } }), before);
      assert.equal(await db.chatMessage.count({ where: { conversationId: id } }), 1);
    } finally {
      await db.$executeRaw`ALTER TABLE "ChatMessage" DROP CONSTRAINT reject_test_reply`;
    }
    const saved = await receipt(await reply(id, admin.cookie, payload));
    assert.equal(saved.duplicate, false);
    assert.equal(saved.message.seq, 2);
  });

  test('E-32 / E-78: current version wins one close; both sender paths return 409 after closure', async () => {
    const first = await conversation();
    const id = first.conversationId;
    const sent = await receipt(await reply(id, admin.cookie, message('Closing after the answer')));
    const before = await db.chatConversation.findUniqueOrThrow({ where: { id } });
    await expectError(await close(id, admin.cookie, { status: 'CLOSED', expectedVersion: before.version + 1 }), 409, 'version_conflict');
    const payload = { status: 'CLOSED', expectedVersion: before.version };
    const responses = await Promise.all([close(id, admin.cookie, payload), close(id, sales.cookie, payload)]);
    const [winner, loser] = responses.sort((a, b) => a.status - b.status);
    assert.equal(winner.status, 200, await winner.clone().text());
    const status = ChatStatusDTOSchema.parse(await winner.json());
    assert.equal(status.status, 'CLOSED');
    assert.equal(status.version, before.version + 1);
    await expectError(loser, 409, 'version_conflict');
    await expectError(await close(id, sales.cookie, { ...payload, expectedVersion: status.version }), 409, 'conversation_closed');
    await expectError(await reply(id, admin.cookie, message('Late operator reply')), 409, 'conversation_closed');
    await expectError(await visitorSend(id, first.cookie, message('Late visitor message')), 409, 'conversation_closed');
    const after = await db.chatConversation.findUniqueOrThrow({ where: { id } });
    assert.equal(after.updatedAt.toISOString(), status.updatedAt);
    assert.deepEqual(after.retainUntil, before.retainUntil);
    assert.deepEqual(after.lastActivityAt, before.lastActivityAt);
    assert.equal(after.lastSeq, sent.message.seq);
    const response = await visitorGet(id, first.cookie);
    assert.equal(response.status, 200);
    const view = ChatSyncDTOSchema.parse(await response.json());
    assert.equal(view.conversation.status, 'CLOSED');
    assert.deepEqual(view.messages, [first.message, sent.message]);
    const fetched = await operatorGet(id, sales.cookie);
    assert.equal(fetched.status, 200);
    assert.equal(AdminChatSyncDTOSchema.parse(await fetched.json()).conversation.status, 'CLOSED');
  });

  test('E-32 / E-78: denied users, origins and foreign visitor sessions cannot read or write', async () => {
    const first = await conversation();
    const id = first.conversationId;
    const stranger = await conversation();
    const editor = await login('EDITOR');
    const demoted = await login('SALES');
    const revoked = await login('SALES');
    await db.user.update({ where: { id: demoted.userId }, data: { role: 'EDITOR' } });
    await db.adminDeviceSession.update({ where: { id: revoked.deviceId }, data: { revokedAt: new Date() } });
    const sqlState = await db.chatConversation.findUniqueOrThrow({ where: { id } });
    const payload = message('Should never be saved');
    const closing = { status: 'CLOSED', expectedVersion: sqlState.version };

    for (const [cookie, status, code] of [
      ['', 401, 'unauthorized'],
      [stranger.cookie, 401, 'unauthorized'],
      [editor.cookie, 403, 'forbidden'],
      [demoted.cookie, 403, 'forbidden'],
      [revoked.cookie, 401, 'unauthorized'],
    ] as const) {
      await expectError(await operatorGet(id, cookie), status, code);
      await expectError(await reply(id, cookie, payload), status, code);
      await expectError(await close(id, cookie, closing), status, code);
    }
    await expectError(await reply(id, sales.cookie, payload, 'https://outside.example'), 403, 'forbidden_origin');
    await expectError(await close(id, sales.cookie, closing, 'https://outside.example'), 403, 'forbidden_origin');
    await expectError(await visitorGet(id, stranger.cookie, '?afterSeq=0'), 404, 'not_found');
    await expectError(await visitorGet(id, stranger.cookie, '?email=visitor%40example.com'), 400, 'invalid');
    await expectError(await visitorSend(id, stranger.cookie, payload), 404, 'not_found');
    await expectError(await visitorSend(id, stranger.cookie, { ...payload, email: 'visitor@example.com' }), 400, 'invalid');
    await db.chatVisitorSession.update({
      where: { id: sqlState.visitorSessionId }, data: { revokedAt: new Date() },
    });
    await expectError(await visitorGet(id, first.cookie), 401, 'unauthorized');
    await expectError(await visitorSend(id, first.cookie, payload), 401, 'unauthorized');
    assert.deepEqual(await db.chatConversation.findUniqueOrThrow({ where: { id } }), sqlState);
    assert.equal(await db.chatMessage.count({ where: { conversationId: id } }), 1);
    assert.equal(await db.chatNotification.count({ where: { conversationId: id } }), 1);
  });

  test('E-78: a device revoked after the outer guard cannot write in the transaction', async () => {
    const first = await conversation();
    const id = first.conversationId;
    const operator = await login('SALES');
    class RevokeAfterGuard extends MemoryStore {
      override async hit(key: string, limit: number, windowMs: number) {
        if (key.endsWith(`:admin:chat.write:user:${operator.userId}`)) {
          await db.adminDeviceSession.update({ where: { id: operator.deviceId }, data: { revokedAt: new Date() } });
        }
        return super.hit(key, limit, windowMs);
      }
    }
    setRateLimitStore(new RevokeAfterGuard());
    await expectError(await reply(id, operator.cookie, message('Revoked after auth')), 401, 'unauthorized');
    await expectError(await operatorGet(id, operator.cookie), 401, 'unauthorized');
    assert.equal(await db.chatMessage.count({ where: { conversationId: id } }), 1);
    assert.equal((await db.chatConversation.findUniqueOrThrow({ where: { id } })).lastSeq, 1);
  });

  test('retention restricts operator writes before and after anonymization', async () => {
    const { conversationId: id } = await conversation();
    const past = new Date(0);
    const expired = await db.chatConversation.update({ where: { id }, data: { retainUntil: past } });
    const payload = message('Cannot extend expired consultation');
    const closing = { status: 'CLOSED', expectedVersion: expired.version };
    await expectError(await reply(id, admin.cookie, payload), 404, 'not_found');
    await expectError(await close(id, sales.cookie, closing), 404, 'not_found');
    const anonymized = await db.chatConversation.update({ where: { id }, data: { anonymizedAt: new Date() } });
    await expectError(await reply(id, admin.cookie, payload), 409, 'conversation_anonymized');
    await expectError(await close(id, sales.cookie, closing), 409, 'conversation_anonymized');
    assert.deepEqual(await db.chatConversation.findUniqueOrThrow({ where: { id } }), anonymized);
    assert.equal(await db.chatMessage.count({ where: { conversationId: id } }), 1);
  });
});
