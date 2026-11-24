import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConversationReceivedDTOSchema, MessageReceivedDTOSchema } from '../src/lib/contracts/chat';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { CHAT_RETENTION_MS, CHAT_WRITE_COOKIE_LIMIT } from '../src/lib/chat/rules';
import { CHAT_VISITOR_COOKIE, hashChatToken } from '../src/lib/server/chat/visitor-session';
import { CHAT_VISITOR_POLICY } from '../src/lib/server/config';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

function testDatabaseUrl(): URL | undefined {
  try {
    // Share the visitor PG fixture, never the application's DATABASE_URL.
    const url = new URL(process.env.B10_M4T2_TEST_DATABASE_URL ?? '');
    if (['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url;
  } catch {
    // Missing or malformed test URL.
  }
}
const base = testDatabaseUrl();
if (process.env.CHAT_REQUIRE_DATABASE === 'true' && !base) {
  throw new Error('B10_M4T2_TEST_DATABASE_URL must be a loopback PostgreSQL test URL');
}
const origin = 'http://127.0.0.1';
const email = 'visitor@example.test';

describe('M4-T10 visitor append through route handlers and PostgreSQL', {
  skip: !base && 'no loopback B10_M4T2_TEST_DATABASE_URL',
  timeout: 180_000,
}, () => {
  const schema = `chatappend_${process.pid}_${randomBytes(8).toString('hex')}`;
  let admin: PrismaClient;
  let db: PrismaClient;
  let routeDb: PrismaClient;
  let ownsSchema = false;
  let append: typeof import('../src/app/api/chat/conversations/[id]/messages/route').POST;
  let create: typeof import('../src/app/api/chat/conversations/route').POST;
  let sync: typeof import('../src/app/api/chat/conversations/[id]/route').GET;
  let markRead: typeof import('../src/app/api/chat/conversations/[id]/read/route').POST;

  before(async () => {
    if (!base) return;
    admin = new PrismaClient({ datasourceUrl: base.href });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    ownsSchema = true;
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '5');
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: 'pipe',
    });
    db = new PrismaClient({ datasourceUrl: url.href });
    process.env.DATABASE_URL = url.href;
    process.env.APP_ENV = 'test';
    process.env.EDGE_AUTH_SECRET = 'm4t10-test-edge-secret-0123456789abcdef';
    setRateLimitStore(new MemoryStore());
    ({ prisma: routeDb } = await import('../src/lib/server/db'));
    await routeDb.$connect();
    ({ POST: create } = await import('../src/app/api/chat/conversations/route'));
    ({ GET: sync } = await import('../src/app/api/chat/conversations/[id]/route'));
    ({ POST: markRead } = await import('../src/app/api/chat/conversations/[id]/read/route'));
    ({ POST: append } = await import('../src/app/api/chat/conversations/[id]/messages/route'));
  });

  beforeEach(async () => {
    await db.chatConversation.deleteMany();
    await db.chatVisitorSession.deleteMany();
  });

  after(async () => {
    setRateLimitStore(undefined);
    await routeDb?.$disconnect();
    await db?.$disconnect();
    try {
      if (ownsSchema) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin?.$disconnect();
    }
  });

  function request(path: string, cookie: string, body: unknown, headers?: Record<string, string>) {
    return new Request(`${origin}/api/chat/conversations${path}`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  function params(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function send(id: string, cookie: string, body: unknown, headers?: Record<string, string>) {
    return append(request(`/${id}/messages`, cookie, body, headers), params(id));
  }

  function getSync(id: string, cookie: string) {
    return sync(new Request(`${origin}/api/chat/conversations/${id}`, { headers: { cookie } }), params(id));
  }

  function payload(bodyText = 'Please send the dimensions.') {
    return { clientMessageId: randomUUID(), bodyText };
  }

  async function seed() {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const visitor = await db.chatVisitorSession.create({
      data: {
        id: randomUUID(), tokenHash: hashChatToken(token),
        createdAt: now, lastActivityAt: now,
        absoluteExpiresAt: new Date(now.getTime() + CHAT_VISITOR_POLICY.absoluteMs),
      },
    });
    const cookie = `${CHAT_VISITOR_COOKIE}=${token}`;
    const first = payload('I would like a quote.');
    const response = await create(request('', cookie, {
      ...first, clientConversationId: randomUUID(), locale: 'en', email,
    }));
    assert.equal(response.status, 200);
    const receipt = ConversationReceivedDTOSchema.parse(await response.json());
    return { visitor, cookie, first, receipt, id: receipt.conversationId };
  }

  async function expectError(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = AppErrorDTOSchema.parse(await response.json());
    assert.equal(body.error, code);
    return body;
  }

  async function snapshot(id: string) {
    const conversation = await db.chatConversation.findUniqueOrThrow({
      where: { id }, include: { messages: { orderBy: { seq: 'asc' } } },
    });
    const notifications = await db.chatNotification.findMany({
      where: { conversationId: id }, orderBy: { messageId: 'asc' },
    });
    return { ...conversation, notifications };
  }

  function retentionFields(row: { lastActivityAt: Date; retainUntil: Date }) {
    return { lastActivityAt: row.lastActivityAt, retainUntil: row.retainUntil };
  }

  test('E-18/E-33/E-37/E-86/E-90 discarded response replays the durable receipt, without a second unread, outbox, or renewal', async () => {
    const { id, cookie, visitor } = await seed();
    const past = new Date(Date.now() - 60_000);
    await db.chatConversation.update({
      where: { id }, data: { lastActivityAt: past, retainUntil: new Date(past.getTime() + CHAT_RETENTION_MS) },
    });
    await db.chatVisitorSession.update({ where: { id: visitor.id }, data: { lastActivityAt: past } });

    const body = payload();
    const lost = await send(id, cookie, body);
    assert.equal(lost.status, 200);
    assert.equal(lost.headers.get('cache-control'), 'private, no-store');
    await lost.body?.cancel();
    const saved = await snapshot(id);
    const message = saved.messages[1];
    const outbox = saved.notifications.find((row) => row.messageId === message.id);
    assert.equal(saved.lastSeq, 2);
    assert.equal(saved.visitorReadSeq, 0);
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages.filter((row) => row.sender === 'VISITOR' && row.seq > 1).length, 1);
    assert.equal(message.authorId, null);
    assert.equal(message.clientMessageId, body.clientMessageId);
    assert.equal(message.bodyText, body.bodyText);
    assert.equal(saved.notifications.length, 2);
    assert.equal(outbox?.status, 'QUEUED');
    assert.equal(outbox?.stableMessageId, `${message.id}@chat.packjoyu`);
    assert.ok(saved.lastActivityAt > past);
    assert.deepEqual(saved.lastActivityAt, message.createdAt);
    assert.equal(saved.retainUntil.getTime(), message.createdAt.getTime() + CHAT_RETENTION_MS);
    const touched = await db.chatVisitorSession.findUniqueOrThrow({ where: { id: visitor.id } });
    assert.ok(touched.lastActivityAt > past);

    const retry = await send(id, cookie, body);
    assert.equal(retry.status, 200);
    assert.deepEqual(MessageReceivedDTOSchema.parse(await retry.json()), {
      message: { id: message.id, seq: 2, sender: 'VISITOR', bodyText: body.bodyText, createdAt: message.createdAt.toISOString() },
      receivedAt: message.createdAt.toISOString(),
      duplicate: true,
    });
    const changed = await send(id, cookie, { ...body, bodyText: 'Changed text' });
    assert.ok((await expectError(changed, 409, 'idempotency_conflict')).fieldErrors?.clientMessageId);
    assert.deepEqual(await snapshot(id), saved);
  });

  test('E-18 first-message keys use the same hash and return the original receipt from the append route', async () => {
    const { id, cookie, first, receipt } = await seed();
    const saved = await snapshot(id);
    const response = await send(id, cookie, first);
    assert.equal(response.status, 200);
    assert.deepEqual(MessageReceivedDTOSchema.parse(await response.json()), {
      message: receipt.message, receivedAt: receipt.receivedAt, duplicate: true,
    });
    await expectError(await send(id, cookie, { ...first, bodyText: 'Changed first message' }), 409, 'idempotency_conflict');
    assert.deepEqual(await snapshot(id), saved);
  });

  test('E-33/E-90 concurrent duplicates and distinct keys share a gapless sequence', async () => {
    const { id, cookie } = await seed();
    const repeated = payload();
    const other = payload('A second independent message');
    const responses = await Promise.all([repeated, other, repeated].map((body) => send(id, cookie, body)));
    const receipts = await Promise.all(responses.map(async (response) => {
      assert.equal(response.status, 200);
      return MessageReceivedDTOSchema.parse(await response.json());
    }));
    assert.deepEqual(receipts[0].message, receipts[2].message);
    assert.notEqual(receipts[0].duplicate, receipts[2].duplicate);
    assert.equal(receipts[1].duplicate, false);
    const saved = await snapshot(id);
    assert.equal(saved.lastSeq, 3);
    assert.deepEqual(saved.messages.map((message) => message.seq), [1, 2, 3]);
    assert.deepEqual(new Set(saved.notifications.map((row) => row.messageId)), new Set(saved.messages.map((row) => row.id)));
    assert.equal(saved.notifications.length, 3);
  });

  test('closed and anonymized consultations reject both new writes and replay', async () => {
    const { id, cookie, first } = await seed();
    await db.chatConversation.update({ where: { id }, data: { status: 'CLOSED' } });
    const closed = await snapshot(id);
    for (const body of [payload(), first]) {
      await expectError(await send(id, cookie, body), 409, 'conversation_closed');
    }
    assert.deepEqual(await snapshot(id), closed);
    await db.chatConversation.update({ where: { id }, data: { anonymizedAt: new Date(), email: null } });
    const anonymized = await snapshot(id);
    for (const body of [payload(), first]) {
      await expectError(await send(id, cookie, body), 409, 'conversation_anonymized');
    }
    assert.deepEqual(await snapshot(id), anonymized);
  });

  test('E-78 wrong owner, forged email, and expired or revoked cookies cannot read or append', async () => {
    const owner = await seed();
    const stranger = await seed(); // Same email, different cookie.
    const saved = await snapshot(owner.id);
    await expectError(await send(owner.id, stranger.cookie, payload()), 404, 'not_found');
    await expectError(await getSync(owner.id, stranger.cookie), 404, 'not_found');
    await expectError(await getSync(randomUUID(), stranger.cookie), 404, 'not_found');
    await expectError(await send(owner.id, stranger.cookie, { ...payload(), email }), 400, 'invalid');
    const forgedRead = new Request(`${origin}/api/chat/conversations/${owner.id}?email=${email}`, {
      headers: { cookie: stranger.cookie },
    });
    await expectError(await sync(forgedRead, params(owner.id)), 400, 'invalid');

    for (const invalid of [
      { revokedAt: new Date() },
      { revokedAt: null, absoluteExpiresAt: new Date(0) },
      { absoluteExpiresAt: new Date(Date.now() + 60_000), lastActivityAt: new Date(0) },
    ]) {
      await db.chatVisitorSession.update({ where: { id: owner.visitor.id }, data: invalid });
      const denied = await send(owner.id, owner.cookie, owner.first);
      await expectError(denied, 401, 'unauthorized');
      assert.match(denied.headers.get('set-cookie') ?? '', /Max-Age=0/i);
      await expectError(await getSync(owner.id, owner.cookie), 401, 'unauthorized');
    }
    assert.deepEqual(await snapshot(owner.id), saved);
  });

  test('E-78 a cookie revoked while the append waits for the consultation lock cannot replay', async () => {
    const { id, cookie, first, visitor } = await seed();
    const saved = await snapshot(id);
    const pending = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id" = ${id} FOR UPDATE`;
      const [blocker] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const response = send(id, cookie, first);
      const deadline = performance.now() + 2_500;
      // Revoke only when the route has resolved the cookie and is waiting on PostgreSQL.
      while (true) {
        const [state] = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${blocker.pid} = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `;
        if (state.waiting) break;
        assert.ok(performance.now() < deadline, 'append never waited on the consultation lock');
        await delay(15);
      }
      await tx.chatVisitorSession.update({ where: { id: visitor.id }, data: { revokedAt: new Date() } });
      return { response };
    });
    await expectError(await pending.response, 401, 'unauthorized');
    assert.deepEqual(await snapshot(id), saved);
  });

  test('E-90 an outbox insert failure rolls back the message, seq, retention and session activity', async () => {
    const { id, cookie, visitor } = await seed();
    const saved = await snapshot(id);
    const activity = await db.chatVisitorSession.findUniqueOrThrow({ where: { id: visitor.id } });
    const body = payload();
    // The first notification exists. Reject the next insert so the route must roll back earlier writes.
    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."ChatNotification"
      ADD CONSTRAINT reject_new_notification CHECK (false) NOT VALID`);
    try {
      await expectError(await send(id, cookie, body), 500, 'internal_error');
      assert.deepEqual(await snapshot(id), saved);
      assert.deepEqual(await db.chatVisitorSession.findUniqueOrThrow({ where: { id: visitor.id } }), activity);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."ChatNotification" DROP CONSTRAINT reject_new_notification`);
    }
    const retried = await send(id, cookie, body);
    assert.equal(retried.status, 200);
    const receipt = MessageReceivedDTOSchema.parse(await retried.json());
    assert.equal(receipt.duplicate, false);
    assert.equal(receipt.message.seq, 2);
  });

  test('E-86 GET, read cursor and the real notification retry and completion leave retention unchanged', async () => {
    const { id, cookie, receipt: first } = await seed();
    let now = Date.now();
    const { createNotificationRepo, notificationToken } = await import('../src/lib/server/chat/notification-repo');
    const notifications = createNotificationRepo({ db, clock: () => new Date(now) });
    const claim = await notifications.claimDue('m4t10-worker');
    assert.equal(claim?.messageId, first.message.id);
    assert.ok(claim);
    const firstToken = notificationToken(claim);
    assert.ok(await notifications.startAttempt(firstToken));
    assert.equal(await notifications.finish(firstToken, { kind: 'sent' }), true);

    const response = await send(id, cookie, payload());
    assert.equal(response.status, 200);
    const receipt = MessageReceivedDTOSchema.parse(await response.json());
    const saved = await snapshot(id);
    assert.equal((await getSync(id, cookie)).status, 200);
    assert.equal((await markRead(request(`/${id}/read`, cookie, { lastReadSeq: receipt.message.seq }), params(id))).status, 200);

    now = Date.now();
    const appended = await notifications.claimDue('m4t10-worker');
    assert.equal(appended?.messageId, receipt.message.id);
    assert.ok(appended);
    const token = notificationToken(appended);
    assert.ok(await notifications.startAttempt(token));
    assert.equal(await notifications.finish(token, { kind: 'retry', code: 'CHAT_SMTP_TEMPORARY' }), true);
    const queued = await db.chatNotification.findUniqueOrThrow({ where: { messageId: receipt.message.id } });
    now = queued.availableAt.getTime();
    const claimedAgain = await notifications.claimDue('m4t10-second-worker');
    assert.ok(claimedAgain);
    assert.equal(claimedAgain.messageId, receipt.message.id);
    assert.equal(claimedAgain.stableMessageId, appended.stableMessageId);
    const retryToken = notificationToken(claimedAgain);
    assert.ok(await notifications.startAttempt(retryToken));
    assert.equal(await notifications.finish(retryToken, { kind: 'sent' }), true);

    const current = await snapshot(id);
    assert.equal(current.visitorReadSeq, receipt.message.seq);
    assert.deepEqual(retentionFields(current), retentionFields(saved));
  });

  test('route rejects cross-origin, oversized or untrusted fields and shares the write bucket with creation', async () => {
    const { id, cookie, first } = await seed();
    const saved = await snapshot(id);
    await expectError(await send(id, cookie, first, { origin: 'http://elsewhere.test' }), 403, 'forbidden_origin');
    await expectError(await send(id, '', first), 401, 'unauthorized');
    await expectError(await send(id, cookie, { ...first, sender: 'OPERATOR' }), 400, 'invalid');
    await expectError(await send(id, cookie, { ...first, bodyText: 'x'.repeat(17_000) }), 413, 'too_large');
    for (let requestCount = 1; requestCount < CHAT_WRITE_COOKIE_LIMIT; requestCount++) {
      assert.equal((await send(id, cookie, first)).status, 200);
    }
    const limited = await send(id, cookie, first);
    await expectError(limited, 429, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual(await snapshot(id), saved);
  });
});
