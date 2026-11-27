import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import { ConversationReceivedDTOSchema, MessageReceivedDTOSchema } from '../src/lib/contracts/chat';
import { StatsDTOSchema, StatsSourceDTOSchema, type StatsDTO, type StatsSource } from '../src/lib/contracts/ops';
import { AppError } from '../src/lib/server/http/errors';
import { createBusinessSourceReaders, BUSINESS_SOURCES } from '../src/lib/server/ops/business-source';
import { createStatsService, type StatsDb } from '../src/lib/server/ops/stats-service';

const ORIGIN = 'http://localhost:3000';
const BUSINESS_QUERY = `sources=${BUSINESS_SOURCES.join(',')}`;
const SCOPE = {
  from: '2026-11-26',
  toExclusive: '2026-11-27',
  startUtc: '2026-11-26T00:00:00.000Z',
  endUtc: '2026-11-27T00:00:00.000Z',
  productSlug: undefined as string | undefined,
  timezone: 'UTC',
  timezoneRevision: 1,
};
const CONTEXT = { timezone: 'UTC', timezoneRevision: 1, queriedAt: '2026-11-26T12:00:00.000Z' };
const NOW = new Date('2026-11-26T12:00:00.000Z');

type Call = { model: string; where: unknown };

/** 记录每次 count 的 where，以及它们是否发生在 SET TRANSACTION READ ONLY 之后。 */
function fakeBusinessDb(options: { fail?: boolean; counts?: Partial<Record<'inquiry' | 'chatConversation' | 'chatMessage', number>> } = {}) {
  const calls: Call[] = [];
  const statements: string[] = [];
  const countOf = (model: 'inquiry' | 'chatConversation' | 'chatMessage') => ({
    async count(args: { where: unknown }) {
      if (options.fail) throw new Error('database unavailable');
      calls.push({ model, where: args.where });
      return options.counts?.[model] ?? 0;
    },
  });
  const tx = {
    async $executeRaw(strings: TemplateStringsArray) {
      statements.push(strings.join('?'));
      return 0;
    },
    inquiry: countOf('inquiry'),
    chatConversation: countOf('chatConversation'),
    chatMessage: countOf('chatMessage'),
  };
  const db = {
    async $transaction<T>(fn: (client: typeof tx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  } as unknown as StatsDb;
  return { db, calls, statements };
}

function readerInput(role: Role, userId?: string, productSlug?: string) {
  return { role, userId, scope: { ...SCOPE, productSlug }, context: CONTEXT, now: NOW, connected: true };
}

describe('M6-T2 business source adapters (no database)', () => {
  test('ADMIN counts every row and SALES counts only inquiries assigned to them (E-66)', async () => {
    const { db, calls, statements } = fakeBusinessDb({ counts: { inquiry: 3, chatConversation: 2, chatMessage: 5 } });
    const readers = createBusinessSourceReaders(db);

    const admin = await readers.inquiries(readerInput('ADMIN', 'admin-1'));
    assert.deepEqual([admin.state, admin.value, admin.coverage], ['ok', 3, 'full']);
    const adminWhere = JSON.stringify(calls[0].where);
    assert.equal(adminWhere.includes('assigneeId'), false);

    const sales = await readers.inquiries(readerInput('SALES', 'sales-1'));
    assert.equal(sales.value, 3);
    assert.match(JSON.stringify(calls[1].where), /"assigneeId":"sales-1"/);

    // 聊天来源与运营聊天接口同样不按人分配。
    await readers.chat_conversations(readerInput('SALES', 'sales-1'));
    await readers.chat_messages(readerInput('SALES', 'sales-1'));
    assert.equal(JSON.stringify(calls[2].where).includes('sales-1'), false);
    assert.equal(JSON.stringify(calls[3].where).includes('sales-1'), false);

    // 每次读取都先声明只读事务。
    assert.equal(statements.length, 4);
    assert.ok(statements.every((statement) => statement.includes('SET TRANSACTION READ ONLY')));
  });

  test('window is [startUtc, endUtc) and productSlug narrows all three sources', async () => {
    const { db, calls } = fakeBusinessDb();
    const readers = createBusinessSourceReaders(db);
    for (const source of BUSINESS_SOURCES) await readers[source](readerInput('ADMIN', 'a', 'pillow-box'));

    const windows = calls.map((call) => JSON.stringify(call.where));
    for (const where of windows) {
      assert.match(where, /"gte":"2026-11-26T00:00:00.000Z"/);
      assert.match(where, /"lt":"2026-11-27T00:00:00.000Z"/);
      assert.match(where, /pillow-box/);
    }
  });

  test('zero is a real zero; dataThrough never passes the query instant (E-49/E-62)', async () => {
    const { db } = fakeBusinessDb();
    const readers = createBusinessSourceReaders(db);
    const today = await readers.chat_messages(readerInput('ADMIN', 'a'));
    assert.deepEqual([today.state, today.value, today.coverage], ['zero', 0, 'full']);
    assert.equal(today.dataThrough, NOW.toISOString());
    assert.equal(today.lastSucceededAt, NOW.toISOString());

    const past = await readers.chat_messages({
      ...readerInput('ADMIN', 'a'),
      scope: { ...SCOPE, startUtc: '2026-11-20T00:00:00.000Z', endUtc: '2026-11-21T00:00:00.000Z' },
    });
    assert.equal(past.dataThrough, '2026-11-21T00:00:00.000Z');

    const future = await readers.inquiries({
      ...readerInput('ADMIN', 'a'),
      scope: { ...SCOPE, from: '2026-11-28', toExclusive: '2026-11-29', startUtc: '2026-11-28T00:00:00.000Z', endUtc: '2026-11-29T00:00:00.000Z' },
    });
    assert.deepEqual([future.state, future.value, future.coverage, future.dataThrough], ['no_data', null, 'unavailable', null]);
  });

  test('result keeps to the shared DTO: counts only, no personal fields (E-62)', async () => {
    const { db } = fakeBusinessDb({ counts: { inquiry: 1, chatConversation: 1, chatMessage: 1 } });
    const readers = createBusinessSourceReaders(db);
    for (const source of BUSINESS_SOURCES) {
      const dto = await readers[source](readerInput('ADMIN', 'a'));
      assert.deepEqual(StatsSourceDTOSchema.parse(dto), dto);
      assert.deepEqual(Object.keys(dto).sort(), [
        'coverage', 'dataThrough', 'lastSucceededAt', 'queriedAt', 'source', 'state', 'timezone', 'timezoneRevision', 'value',
      ]);
    }
  });

  test('a failing read becomes query_failed with no number; no user id never widens SALES scope (E-62)', async () => {
    const failing = createBusinessSourceReaders(fakeBusinessDb({ fail: true }).db);
    for (const source of BUSINESS_SOURCES) {
      const dto = await failing[source](readerInput('ADMIN', 'a'));
      assert.deepEqual([dto.state, dto.value, dto.coverage], ['query_failed', null, 'unavailable']);
    }

    const { db, calls } = fakeBusinessDb({ counts: { inquiry: 9 } });
    const dto = await createBusinessSourceReaders(db).inquiries(readerInput('SALES'));
    assert.deepEqual([dto.state, dto.value], ['query_failed', null]);
    assert.equal(calls.length, 0);
  });

  test('EDITOR is refused before any query (E-66)', async () => {
    const { db, calls } = fakeBusinessDb();
    const readers = createBusinessSourceReaders(db);
    for (const source of BUSINESS_SOURCES) {
      await assert.rejects(
        () => Promise.resolve(readers[source](readerInput('EDITOR', 'e'))),
        (error) => error instanceof AppError && error.code === 'forbidden',
      );
    }
    assert.equal(calls.length, 0);
  });

  test('stats service hands the signed-in user to business readers and trims EDITOR before them (E-66)', async () => {
    const seen: Array<{ role: Role; userId?: string }> = [];
    const settingsDb = {
      async $transaction<T>(fn: (tx: { $queryRaw: () => Promise<unknown[]> }) => Promise<T>): Promise<T> {
        return fn({ $queryRaw: async () => [] });
      },
    } as unknown as StatsDb;
    const reader = (source: StatsSource) => async ({ role, userId, context }: { role: Role; userId?: string; context: typeof CONTEXT }) => {
      seen.push({ role, userId });
      return createBusinessSourceReaders(fakeBusinessDb({ counts: { inquiry: 1 } }).db)[source as 'inquiries']({
        ...readerInput(role, userId),
        context,
      });
    };
    const service = createStatsService({
      db: settingsDb,
      clock: () => NOW,
      nonCoreReaders: { inquiries: reader('inquiries') },
    });

    const result = await service.query({ role: 'SALES', userId: 'sales-7', query: { sources: ['inquiries'] } });
    assert.deepEqual(seen, [{ role: 'SALES', userId: 'sales-7' }]);
    assert.equal(result.dto.sources[0].value, 1);

    await assert.rejects(
      () => service.query({ role: 'EDITOR', userId: 'editor-1', query: { sources: ['inquiries', 'chat_messages'] } }),
      (error) => error instanceof AppError && error.code === 'forbidden',
    );
    assert.equal(seen.length, 1);
  });

  test('one-way module boundary: M4 chat and inquiry write paths do not import M6 ops (AC2)', () => {
    const collectTsFiles = (dir: string): string[] => {
      const full = path.resolve(process.cwd(), dir);
      const entries = readdirSync(full);
      const files: string[] = [];
      for (const entry of entries) {
        const child = path.join(full, entry);
        if (statSync(child).isDirectory()) files.push(...collectTsFiles(path.join(dir, entry)));
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(child);
      }
      return files;
    };
    const targets = [
      ...collectTsFiles('src/lib/server/chat'),
      ...collectTsFiles('src/app/api/chat'),
      ...collectTsFiles('src/app/api/inquiries'),
    ];
    assert.ok(targets.length > 0);
    const m6Roots = [
      path.resolve(process.cwd(), 'src/lib/server/ops'),
      path.resolve(process.cwd(), 'src/lib/client/ops'),
      path.resolve(process.cwd(), 'src/components/admin/stats'),
      path.resolve(process.cwd(), 'src/app/admin/stats'),
      path.resolve(process.cwd(), 'src/app/api/admin/stats'),
    ];
    for (const file of targets) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(/(?:from|import)\s*\(?['"]([^'"]+)['"]\)?/g)) {
        const spec = match[1];
        const resolved = spec.startsWith('@/')
          ? path.resolve(process.cwd(), 'src', spec.slice(2))
          : spec.startsWith('.')
            ? path.resolve(path.dirname(file), spec)
            : null;
        if (!resolved) continue;
        for (const forbidden of m6Roots) {
          assert.equal(
            resolved === forbidden || resolved.startsWith(forbidden + path.sep),
            false,
            `${file} must not import M6 module (${spec})`,
          );
        }
      }
    }
  });
});

const databaseUrl = process.env.M6T2_TEST_DATABASE_URL ? new URL(process.env.M6T2_TEST_DATABASE_URL) : null;
if (databaseUrl && (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname))) {
  throw new Error('M6T2_TEST_DATABASE_URL must point to a dedicated loopback PostgreSQL database');
}
if (!databaseUrl && process.env.M6T2_REQUIRE_DATABASE === 'true') {
  throw new Error('M6T2_TEST_DATABASE_URL is required when M6T2_REQUIRE_DATABASE=true');
}

describe('M6-T2 business counts over real HTTP routes (PostgreSQL + Auth.js)', {
  concurrency: false,
  skip: !databaseUrl && 'no dedicated M6T2_TEST_DATABASE_URL',
  timeout: 240_000,
}, () => {
  const schema = `m6t2_${randomBytes(6).toString('hex')}`;
  const savedEnv: Record<string, string | undefined> = {};
  let owner: PrismaClient;
  let db: PrismaClient;
  let appDb: PrismaClient;
  let schemaCreated = false;
  let auth: typeof import('../src/app/api/auth/[...nextauth]/route');
  let statsRoute: typeof import('../src/app/api/admin/stats/route');
  let adminInquiries: typeof import('../src/app/api/admin/inquiries/route');
  let submitInquiry: typeof import('../src/app/api/inquiries/route').POST;
  let startVisitor: typeof import('../src/app/api/chat/session/route').POST;
  let createConversation: typeof import('../src/app/api/chat/conversations/route').POST;
  let appendMessage: typeof import('../src/app/api/chat/conversations/[id]/messages/route').POST;
  let composition: typeof import('../src/lib/server/composition');
  let stats: typeof import('../src/lib/server/ops/stats-service');
  let setStore: (store: unknown) => void;
  let MemoryStoreCtor: new () => unknown;
  let hashSecret: typeof import('../src/lib/server/admin/crypto').hashSecret;
  let encrypt: typeof import('../src/lib/server/admin/crypto').encrypt;
  let admin: Operator;
  let salesA: Operator;
  let salesB: Operator;
  let editor: Operator;

  type Operator = { userId: string; cookie: string };

  const ENV: Record<string, string> = {
    AUTH_SECRET: 'm6t2-test-auth-secret-0123456789abcdef',
    EDGE_AUTH_SECRET: 'm6t2-test-edge-secret-0123456789abcdef',
    ADMIN_TOTP_KEY: Buffer.alloc(32, 9).toString('base64'),
    PRIVACY_HASH_SECRET: 'm6t2-test-privacy-hash-secret-0123456789abcdef',
    CRON_SECRET: 'm6t2-test-cron-secret-0123456789abcdef-long-enough',
    NEXT_PUBLIC_SITE_URL: ORIGIN,
    AUTH_URL: ORIGIN,
    RATE_LIMIT_STORE: 'memory',
    APP_ENV: 'test',
  };
  const NO_MAIL_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'INQUIRY_NOTIFY_EMAIL', 'TURNSTILE_SECRET_KEY', 'ADMIN_ALERT_EMAIL'];

  function cookies(response: Response, previous = ''): string {
    const jar = new Map<string, string>();
    for (const part of previous.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name) jar.set(name, value.join('='));
    }
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';', 1);
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function request(path: string, init: { cookie?: string; body?: unknown; method?: string; origin?: string } = {}) {
    return new Request(ORIGIN + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { cookie: init.cookie ?? '', origin: init.origin ?? ORIGIN, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async function operator(role: Role): Promise<Operator> {
    const password = 'm6t2-isolated-test-password';
    const secret = authenticator.generateSecret();
    const user = await db.user.create({
      data: {
        email: `m6t2-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`,
        name: `M6T2 ${role}`,
        role,
        passwordHash: await hashSecret(password),
        totpEnabled: true,
        totpSecret: encrypt(secret),
      },
    });
    const csrf = await auth.GET(request('/api/auth/csrf'));
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const jar = cookies(csrf);
    const login = await auth.POST(new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { cookie: jar, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: user.email, password, csrfToken, totp: authenticator.generate(secret) }),
    }));
    const cookie = cookies(login, jar);
    assert.match(cookie, /authjs\.session-token=[^;]+/);
    return { userId: user.id, cookie };
  }

  function inquiryBody(overrides: Record<string, unknown> = {}) {
    return {
      source: 'FORM',
      locale: 'en',
      contact: {
        name: 'Synthetic Buyer',
        email: `buyer-${randomBytes(4).toString('hex')}@buyer-co.example`,
        company: 'Synthetic Co',
        region: 'US',
      },
      message: 'Synthetic inquiry body that must never reach statistics.',
      ...overrides,
    };
  }

  async function postInquiry(body: unknown) {
    return submitInquiry(request('/api/inquiries', { body }));
  }

  async function newVisitor(): Promise<string> {
    const response = await startVisitor(request('/api/chat/session', { body: { locale: 'en' } }));
    assert.equal(response.status, 200, await response.clone().text());
    return cookies(response);
  }

  function chatPayload(overrides: Record<string, unknown> = {}) {
    return {
      clientConversationId: randomUUID(),
      clientMessageId: randomUUID(),
      locale: 'en',
      bodyText: 'Synthetic chat body that must never reach statistics.',
      email: 'visitor-m6t2@visitor.example',
      ...overrides,
    };
  }

  async function openConversation(cookie: string, payload = chatPayload()) {
    const response = await createConversation(request('/api/chat/conversations', { cookie, body: payload }));
    assert.equal(response.status, 200, await response.clone().text());
    return { ...ConversationReceivedDTOSchema.parse(await response.json()), payload };
  }

  async function reply(cookie: string, conversationId: string, payload: { clientMessageId: string; bodyText: string }) {
    const response = await appendMessage(
      request(`/api/chat/conversations/${conversationId}/messages`, { cookie, body: payload }),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(response.status, 200, await response.clone().text());
    return MessageReceivedDTOSchema.parse(await response.json());
  }

  async function readStats(who: Operator | null, query = BUSINESS_QUERY) {
    return statsRoute.GET(request(`/api/admin/stats?${query}`, { cookie: who?.cookie ?? '' }));
  }

  async function businessCounts(who: Operator = admin) {
    const response = await readStats(who);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const text = await response.text();
    const dto = StatsDTOSchema.parse(JSON.parse(text));
    return { dto, text, ...Object.fromEntries(dto.sources.map((item) => [item.source, item])) } as {
      dto: StatsDTO;
      text: string;
    } & Record<'inquiries' | 'chat_conversations' | 'chat_messages', StatsDTO['sources'][number]>;
  }

  before(async () => {
    assert.ok(databaseUrl);
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    for (const key of NO_MAIL_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const base = new URL(databaseUrl);
    base.searchParams.delete('schema');
    owner = new PrismaClient({ datasourceUrl: base.href });
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    base.searchParams.set('schema', schema);
    base.searchParams.set('connection_limit', '5');
    savedEnv.DATABASE_URL = process.env.DATABASE_URL;
    process.env.DATABASE_URL = base.href;
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
      stdio: 'pipe',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
    });
    db = new PrismaClient({ datasourceUrl: base.href });
    ({ prisma: appDb } = await import('../src/lib/server/db'));
    auth = await import('../src/app/api/auth/[...nextauth]/route');
    statsRoute = await import('../src/app/api/admin/stats/route');
    adminInquiries = await import('../src/app/api/admin/inquiries/route');
    ({ POST: submitInquiry } = await import('../src/app/api/inquiries/route'));
    ({ POST: startVisitor } = await import('../src/app/api/chat/session/route'));
    ({ POST: createConversation } = await import('../src/app/api/chat/conversations/route'));
    ({ POST: appendMessage } = await import('../src/app/api/chat/conversations/[id]/messages/route'));
    composition = await import('../src/lib/server/composition');
    stats = await import('../src/lib/server/ops/stats-service');
    ({ hashSecret, encrypt } = await import('../src/lib/server/admin/crypto'));
    const limiter = await import('../src/lib/server/ratelimit');
    setStore = (store) => limiter.setRateLimitStore(store as never);
    MemoryStoreCtor = limiter.MemoryStore as never;
    setStore(new MemoryStoreCtor());
    admin = await operator('ADMIN');
    salesA = await operator('SALES');
    salesB = await operator('SALES');
    editor = await operator('EDITOR');
  });

  beforeEach(async () => {
    await db.inquiry.deleteMany();
    await db.contact.deleteMany();
    await db.chatConversation.deleteMany();
    await db.chatVisitorSession.deleteMany();
    setStore(new MemoryStoreCtor());
  });

  after(async () => {
    setStore(undefined);
    await appDb?.$disconnect();
    await db?.$disconnect();
    try {
      if (schemaCreated) await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await owner?.$disconnect();
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('E-62 AC1: persisted ids drive the counts; same-UUID retries and rejected junk add nothing; no email/body leak', async () => {
    const empty = await businessCounts();
    for (const source of BUSINESS_SOURCES) {
      assert.deepEqual([empty[source].state, empty[source].value, empty[source].coverage], ['zero', 0, 'full'], source);
    }

    // 询盘：两条合法提交；蜜罐、非法邮箱、超限正文都不落库。
    assert.equal((await postInquiry(inquiryBody())).status, 201);
    assert.equal((await postInquiry(inquiryBody())).status, 201);
    const honeypot = await postInquiry(inquiryBody({ website: 'https://spam.example' }));
    assert.equal(honeypot.status, 201);
    assert.equal(((await honeypot.json()) as { ref: string }).ref, 'PJ-OK');
    assert.equal((await postInquiry(inquiryBody({ contact: { name: 'x', email: 'not-an-email', region: 'US' } }))).status, 400);
    assert.equal((await postInquiry(inquiryBody({ message: 'x'.repeat(5_001) }))).status, 400);

    // 聊天：首条消息、同 UUID 重试、追加消息及其重试、再开一个会话。
    const cookie = await newVisitor();
    const first = await openConversation(cookie);
    const retried = await createConversation(request('/api/chat/conversations', { cookie, body: first.payload }));
    assert.equal(retried.status, 200);
    const retriedDto = ConversationReceivedDTOSchema.parse(await retried.json());
    assert.equal(retriedDto.duplicate, true);
    assert.equal(retriedDto.conversationId, first.conversationId);

    const followUp = { clientMessageId: randomUUID(), bodyText: 'Second synthetic visitor message.' };
    assert.equal((await reply(cookie, first.conversationId, followUp)).duplicate, false);
    assert.equal((await reply(cookie, first.conversationId, followUp)).duplicate, true);

    const rejected = [
      await createConversation(request('/api/chat/conversations', { cookie, body: chatPayload({ bodyText: '' }) })),
      await createConversation(request('/api/chat/conversations', { cookie, body: chatPayload({ extra: 'field' }) })),
      await createConversation(request('/api/chat/conversations', { cookie: '', body: chatPayload() })),
      await createConversation(request('/api/chat/conversations', { cookie, body: chatPayload(), origin: 'https://evil.example' })),
    ];
    assert.deepEqual(rejected.map((response) => response.status), [400, 400, 401, 403]);

    const second = await openConversation(await newVisitor(), chatPayload({ bodyText: 'Another synthetic chat.' }));
    assert.notEqual(second.conversationId, first.conversationId);

    const counts = await businessCounts();
    assert.deepEqual(
      [counts.inquiries.value, counts.chat_conversations.value, counts.chat_messages.value],
      [2, 2, 3],
    );
    for (const source of BUSINESS_SOURCES) {
      assert.equal(counts[source].state, 'ok');
      assert.equal(counts[source].coverage, 'full');
      assert.ok(counts[source].dataThrough);
      assert.ok(counts[source].lastSucceededAt);
    }
    // 计数等于库里已持久化的稳定主键个数。
    assert.deepEqual(
      [await db.inquiry.count(), await db.chatConversation.count(), await db.chatMessage.count()],
      [2, 2, 3],
    );

    // 响应只有数字与时间，不含邮箱、正文、留言、编号或会话标识。
    const ids = [
      ...(await db.inquiry.findMany({ select: { id: true, ref: true } })).flatMap((row) => [row.id, row.ref]),
      first.conversationId,
      second.conversationId,
      first.message.id,
    ];
    for (const leak of ['@buyer-co.example', '@visitor.example', 'Synthetic', 'must never reach', ...ids]) {
      assert.equal(counts.text.includes(leak), false, `stats leaked ${leak}`);
    }
  });

  test('E-62 AC2: SALES counts follow the existing inquiry scope and match the inquiry list total', async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await postInquiry(inquiryBody())).status, 201);
    const rows = await db.inquiry.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    await db.inquiry.update({ where: { id: rows[0].id }, data: { assigneeId: salesA.userId } });
    await db.inquiry.update({ where: { id: rows[1].id }, data: { assigneeId: salesA.userId } });
    await db.inquiry.update({ where: { id: rows[2].id }, data: { assigneeId: salesB.userId } });
    await openConversation(await newVisitor());

    const forAdmin = await businessCounts(admin);
    const forA = await businessCounts(salesA);
    const forB = await businessCounts(salesB);
    assert.equal(forAdmin.inquiries.value, 3);
    assert.equal(forA.inquiries.value, 2);
    assert.equal(forB.inquiries.value, 1);
    // 聊天没有按人分配：ADMIN 与 SALES 看到同样的数。
    for (const view of [forAdmin, forA, forB]) {
      assert.deepEqual([view.chat_conversations.value, view.chat_messages.value], [1, 1]);
    }

    const list = await adminInquiries.GET(request('/api/admin/inquiries?pageSize=1', { cookie: salesA.cookie }));
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { total: number }).total, forA.inquiries.value);

    // 没有分配给 SALES 的询盘是真实的 0，不是缺数据。
    await db.inquiry.updateMany({ data: { assigneeId: salesA.userId } });
    const none = await businessCounts(salesB);
    assert.deepEqual([none.inquiries.state, none.inquiries.value], ['zero', 0]);
  });

  test('E-62: product filter, multi-item deduplication, day window, and analytics-disconnected independence', async () => {
    // 同一询盘带两个不同 productSlug 条目，按稳定 Inquiry.id 在每个匹配产品下只计 1 次，全站也只计 1 次。
    const withItems = inquiryBody({
      items: [{ productSlug: 'pillow-box-no-such-slug-x' }, { productSlug: 'pillow-box-no-such-slug-y' }],
    });
    // WIZARD/CART 才校验目录；FORM 条目只做格式校验，可用合成 slug 归因。
    assert.equal((await postInquiry(withItems)).status, 201);
    assert.equal((await postInquiry(inquiryBody())).status, 201);
    const cookie = await newVisitor();
    await openConversation(cookie, chatPayload());

    const filtered = await readStats(admin, `${BUSINESS_QUERY}&productSlug=pillow-box-no-such-slug-x`);
    assert.equal(filtered.status, 200);
    const dto = StatsDTOSchema.parse(await filtered.json());
    const byName = Object.fromEntries(dto.sources.map((item) => [item.source, item.value]));
    assert.deepEqual(byName, { inquiries: 1, chat_conversations: 0, chat_messages: 0 });

    const pastDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const oldDay = await readStats(admin, `${BUSINESS_QUERY}&from=${pastDay}&to=${pastDay}`);
    assert.equal(oldDay.status, 200);
    const oldDto = StatsDTOSchema.parse(await oldDay.json());
    assert.ok(oldDto.sources.every((item) => item.state === 'zero' && item.value === 0));

    const futureDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const futureRes = await readStats(admin, `${BUSINESS_QUERY}&from=${futureDay}&to=${futureDay}`);
    assert.equal(futureRes.status, 200);
    const futureDto = StatsDTOSchema.parse(await futureRes.json());
    assert.ok(futureDto.sources.every((item) => item.state === 'no_data' && item.value === null && item.coverage === 'unavailable'));

    // 即使分析同意密钥未配置（核心分析来源 not_connected），必要咨询与询盘计数仍正常返回真实值。
    const prevSecret = process.env.PRIVACY_HASH_SECRET;
    delete process.env.PRIVACY_HASH_SECRET;
    try {
      const mixedWhenAnalyticsOff = await readStats(admin, `sources=visitors,${BUSINESS_SOURCES.join(',')}`);
      assert.equal(mixedWhenAnalyticsOff.status, 200);
      const offDto = StatsDTOSchema.parse(await mixedWhenAnalyticsOff.json());
      assert.equal(offDto.sources.find((item) => item.source === 'visitors')?.state, 'not_connected');
      assert.equal(offDto.sources.find((item) => item.source === 'inquiries')?.value, 2);
      assert.equal(offDto.sources.find((item) => item.source === 'chat_conversations')?.value, 1);
    } finally {
      if (prevSecret === undefined) delete process.env.PRIVACY_HASH_SECRET;
      else process.env.PRIVACY_HASH_SECRET = prevSecret;
    }
  });

  test('E-62/E-66: anonymous and EDITOR requests for business sources are refused before any count', async () => {
    assert.equal((await postInquiry(inquiryBody())).status, 201);
    await openConversation(await newVisitor());

    const anonymous = await readStats(null);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');

    for (const source of BUSINESS_SOURCES) {
      const direct = await readStats(editor, `sources=${source}`);
      assert.equal(direct.status, 403, `EDITOR ${source}`);
      assert.equal((await direct.text()).includes('"value"'), false);
    }
    const mixed = await readStats(editor, `sources=visitors,${BUSINESS_SOURCES.join(',')}`);
    assert.equal(mixed.status, 200);
    const mixedText = await mixed.text();
    assert.deepEqual(StatsDTOSchema.parse(JSON.parse(mixedText)).sources.map((item) => item.source), ['visitors']);
    for (const source of BUSINESS_SOURCES) assert.equal(mixedText.includes(source), false);

    const everything = await readStats(editor, '');
    const everythingText = await everything.text();
    for (const source of BUSINESS_SOURCES) assert.equal(everythingText.includes(source), false);

    // SALES 会话被降权为 EDITOR 后，下一请求重读当前角色并拒绝业务来源。
    const demoted = await operator('SALES');
    assert.equal((await readStats(demoted, 'sources=inquiries')).status, 200);
    await db.user.update({ where: { id: demoted.userId }, data: { role: 'EDITOR' } });
    const afterDemote = await readStats(demoted, 'sources=inquiries');
    assert.equal(afterDemote.status, 403);
    assert.equal((await afterDemote.text()).includes('"value"'), false);
  });

  test('E-62: a failing or read-only statistics read never blocks or rolls back saving', async () => {
    const readOnlyStates: string[] = [];
    let failBusiness = true;
    const probeDb = new Proxy(appDb, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => target.$transaction(async (tx) => fn(
          new Proxy(tx, {
            get(inner, name, innerReceiver) {
              if (name === 'inquiry') {
                return {
                  count: async (args: Parameters<typeof tx.inquiry.count>[0]) => {
                    const [row] = await tx.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
                    readOnlyStates.push(row.transaction_read_only);
                    if (failBusiness) throw new Error('simulated statistics outage');
                    return tx.inquiry.count(args);
                  },
                };
              }
              return Reflect.get(inner, name, innerReceiver);
            },
          }),
        ), options as never);
      },
    }) as PrismaClient;
    const services = composition.createAdminServices({ db: probeDb });
    const gate = { user: { id: admin.userId, role: 'ADMIN' as Role } };
    const query = () => stats.handleGetStats(request(`/api/admin/stats?${BUSINESS_QUERY}`), gate, services);

    assert.equal((await postInquiry(inquiryBody())).status, 201);
    const failed = await query();
    assert.equal(failed.status, 200);
    const failedDto = StatsDTOSchema.parse(await failed.json());
    const bySource = Object.fromEntries(failedDto.sources.map((item) => [item.source, item]));
    assert.deepEqual([bySource.inquiries.state, bySource.inquiries.value], ['query_failed', null]);
    assert.equal(bySource.chat_conversations.state, 'zero');
    assert.deepEqual(readOnlyStates, ['on']);

    // 统计失败之后保存仍然成功，并在下次读取里被数到。
    assert.equal((await postInquiry(inquiryBody())).status, 201);
    const cookie = await newVisitor();
    await openConversation(cookie);
    failBusiness = false;
    const recovered = StatsDTOSchema.parse(await (await query()).json());
    assert.equal(recovered.sources.find((item) => item.source === 'inquiries')?.value, 2);
    assert.equal(recovered.sources.find((item) => item.source === 'chat_conversations')?.value, 1);
    assert.equal(await db.inquiry.count(), 2);
  });

  test('wiring: createAdminServices registers all three business readers and leaves the rest unconnected', async () => {
    const response = await readStats(admin, '');
    assert.equal(response.status, 200);
    const dto = StatsDTOSchema.parse(await response.json());
    const state = (source: StatsSource) => dto.sources.find((item) => item.source === source)?.state;
    for (const source of BUSINESS_SOURCES) assert.notEqual(state(source), 'not_connected', source);
    assert.equal(state('chat_notifications'), 'not_connected');
    assert.equal(state('mail'), 'not_connected');
  });
});
