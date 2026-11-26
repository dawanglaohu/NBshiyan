import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import { products } from '../src/data/products';
import { shiftLocalDate } from '../src/lib/analytics/aggregate-plan';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { CONSENT_VERSION } from '../src/lib/consent';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import {
  StatsDTOSchema,
  StatsSourceSchema,
  type StatsDTO,
  type StatsSource,
} from '../src/lib/contracts/ops';
import { AppError } from '../src/lib/server/http/errors';
import type { ApiCounter } from '../src/lib/server/http/metrics';
import { ANALYTICS_TIMEZONE_CHANGE_ACTION } from '../src/lib/server/analytics/settings-repo';
import {
  createStatsService,
  handleGetStats,
  parseStatsSearchParams,
  STATS_RATE_LIMIT,
  STATS_ROUTE_ID,
  type StatsDb,
} from '../src/lib/server/ops/stats-service';

const ORIGIN = 'http://localhost:3000';
const REAL_PRODUCT_A = products[0].slug;
const REAL_PRODUCT_B = products[1].slug;
const REAL_PRODUCT_C = products[2].slug;

function validateDatabaseUrl(raw: string | undefined): { url: string; schema: string } | null {
  if (!raw?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M6T6_TEST_DATABASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('M6T6_TEST_DATABASE_URL must use postgres scheme');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('M6T6_TEST_DATABASE_URL must point at loopback');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('M6T6_TEST_DATABASE_URL must name a database');
  }
  const schema = parsed.searchParams.get('schema');
  if (schema !== 'm6t6') {
    throw new Error('M6T6_TEST_DATABASE_URL must carry schema=m6t6');
  }
  return { url: parsed.toString(), schema };
}

const rawDbUrl = process.env.M6T6_TEST_DATABASE_URL;
const database = validateDatabaseUrl(rawDbUrl);
if (process.env.M6T6_REQUIRE_DATABASE === 'true' && !database) {
  throw new Error('M6T6_TEST_DATABASE_URL is required when M6T6_REQUIRE_DATABASE=true');
}
const skipDb = !database && 'no dedicated M6T6_TEST_DATABASE_URL';

function stubCounter(records: { routeId: string; status: number; body: unknown }[] = []): ApiCounter {
  return {
    async recordFinalResponse<T>(response: { routeId: string; status: number; body: T }) {
      records.push({ routeId: response.routeId, status: response.status, body: response.body });
      return { recorded: true, status: response.status, body: response.body };
    },
  };
}

function fakeSettingsDb(rows: unknown[]): StatsDb {
  return {
    async $transaction<T>(fn: (tx: { $queryRaw: () => Promise<unknown[]> }) => Promise<T>): Promise<T> {
      return fn({ $queryRaw: async () => rows });
    },
  } as unknown as StatsDb;
}

describe('M6-T6 GET /api/admin/stats pure rules & HTTP contract', () => {
  test('route file exports only GET/runtime/dynamic and uses static requireAdmin guard', () => {
    const routePath = path.resolve(process.cwd(), 'src/app/api/admin/stats/route.ts');
    const source = readFileSync(routePath, 'utf8');
    assert.match(source, /export const runtime = 'nodejs'/);
    assert.match(source, /export const dynamic = 'force-dynamic'/);
    assert.match(source, /export async function GET\(/);
    assert.match(source, /requireAdmin\(/);
    assert.doesNotMatch(source, /export async function (POST|PATCH|PUT|DELETE)\(/);
  });

  test('parseStatsSearchParams strictly validates allowed keys, duplicates, ranges, and source lists', () => {
    assert.deepEqual(parseStatsSearchParams(`${ORIGIN}/api/admin/stats`), {});
    assert.deepEqual(
      parseStatsSearchParams(
        `${ORIGIN}/api/admin/stats?from=2026-11-01&to=2026-11-10&productSlug=${REAL_PRODUCT_A}&timezoneRevision=2&sources=visitors,page_views`,
      ),
      {
        from: '2026-11-01',
        to: '2026-11-10',
        productSlug: REAL_PRODUCT_A,
        timezoneRevision: 2,
        sources: ['visitors', 'page_views'],
      },
    );
    assert.deepEqual(
      parseStatsSearchParams(`${ORIGIN}/api/admin/stats?sources=visitors&sources=model_starts`),
      { sources: ['visitors', 'model_starts'] },
    );

    const invalidCases = [
      `${ORIGIN}/api/admin/stats?unknown=1`,
      `${ORIGIN}/api/admin/stats?from=2026-11-01&from=2026-11-02`,
      `${ORIGIN}/api/admin/stats?to=2026-11-01&to=2026-11-02`,
      `${ORIGIN}/api/admin/stats?productSlug=${REAL_PRODUCT_A}&productSlug=${REAL_PRODUCT_B}`,
      `${ORIGIN}/api/admin/stats?timezoneRevision=1&timezoneRevision=2`,
      `${ORIGIN}/api/admin/stats?sources=`,
      `${ORIGIN}/api/admin/stats?sources=visitors,`,
      `${ORIGIN}/api/admin/stats?sources=visitors,visitors`,
      `${ORIGIN}/api/admin/stats?sources=visitors,%20page_views`,
      `${ORIGIN}/api/admin/stats?from=2026-02-30`,
      `${ORIGIN}/api/admin/stats?from=2026-11-10&to=2026-11-01`,
      `${ORIGIN}/api/admin/stats?from=2025-01-01&to=2026-06-01`,
      `${ORIGIN}/api/admin/stats?timezoneRevision=0`,
      `${ORIGIN}/api/admin/stats?timezoneRevision=01`,
      `${ORIGIN}/api/admin/stats?productSlug=INVALID_SLUG`,
    ];
    for (const url of invalidCases) {
      assert.throws(() => parseStatsSearchParams(url), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'invalid');
        if (error.fieldErrors) {
          assert.equal('productSlug' in error.fieldErrors, false);
        }
        return true;
      }, `expected invalid for ${url}`);
    }
  });

  test('disconnection of either consent secret or analytics-aggregate job yields not_connected for core sources', async () => {
    const mockDb = fakeSettingsDb([]);
    const now = new Date('2026-11-25T12:00:00.000Z');
    const queries = [
      { analyticsConfigured: () => false, aggregateJobRegistered: () => true },
      { analyticsConfigured: () => true, aggregateJobRegistered: () => false },
    ];
    for (const flags of queries) {
      const stats = createStatsService({ db: mockDb, clock: () => now, ...flags });
      const records: { routeId: string; status: number; body: unknown }[] = [];
      const res = await handleGetStats(
        new Request(`${ORIGIN}/api/admin/stats?sources=visitors,mean_load_duration_ms,inquiries`),
        { user: { id: 'rl-disconnect-check', role: 'ADMIN' } },
        { stats, apiCounter: stubCounter(records) },
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const body = StatsDTOSchema.parse(await res.json());
      assert.deepEqual(body.sources.map((s) => s.source), ['visitors', 'mean_load_duration_ms', 'inquiries']);
      assert.equal(body.sources[0].state, 'not_connected');
      assert.equal(body.sources[0].value, null);
      assert.equal(body.sources[1].state, 'not_connected');
      assert.equal(body.sources[1].value, null);
      assert.equal(body.sources[1].loadDurationSamples, 0);
      assert.equal(body.sources[2].state, 'not_connected');
      assert.equal(records.length, 1);
      assert.equal(records[0].routeId, STATS_ROUTE_ID);
      assert.equal(records[0].status, 200);
    }
  });

  test('corrupt analytics.settings yields 503 service_unavailable; pre-query RBAC forbids sensitive sources; user rate limit is 30/min', async () => {
    const corruptDb = fakeSettingsDb([{ value: { broken: true } }]);
    const service = createStatsService({
      db: corruptDb,
      clock: () => new Date('2026-11-25T12:00:00.000Z'),
      analyticsConfigured: () => true,
      aggregateJobRegistered: () => true,
    });
    const records: { routeId: string; status: number; body: unknown }[] = [];
    const counter = stubCounter(records);

    const errForbidden = await handleGetStats(
      new Request(`${ORIGIN}/api/admin/stats?sources=mail`),
      { user: { id: `pure-editor-${randomUUID()}`, role: 'EDITOR' } },
      { stats: service, apiCounter: counter },
    );
    assert.equal(errForbidden.status, 403);
    assert.equal(errForbidden.headers.get('cache-control'), 'private, no-store');
    assert.equal(AppErrorDTOSchema.parse(await errForbidden.json()).error, 'forbidden');

    const errCorrupt = await handleGetStats(
      new Request(`${ORIGIN}/api/admin/stats?sources=visitors`),
      { user: { id: `pure-admin-${randomUUID()}`, role: 'ADMIN' } },
      { stats: service, apiCounter: counter },
    );
    assert.equal(errCorrupt.status, 503);
    assert.equal(errCorrupt.headers.get('cache-control'), 'private, no-store');
    assert.equal(AppErrorDTOSchema.parse(await errCorrupt.json()).error, 'service_unavailable');

    const prevStore = process.env.RATE_LIMIT_STORE;
    process.env.RATE_LIMIT_STORE = 'memory';
    try {
      const fastStats = createStatsService({
        db: fakeSettingsDb([]),
        clock: () => new Date('2026-11-25T12:00:00.000Z'),
        analyticsConfigured: () => false,
        aggregateJobRegistered: () => false,
      });
      const rateUser = `pure-rate-${randomUUID()}`;
      const otherUser = `pure-rate-other-${randomUUID()}`;
      for (let i = 0; i < STATS_RATE_LIMIT; i += 1) {
        const res = await handleGetStats(
          new Request(`${ORIGIN}/api/admin/stats?sources=visitors`),
          { user: { id: rateUser, role: 'ADMIN' } },
          { stats: fastStats, apiCounter: counter },
        );
        assert.equal(res.status, 200, `request ${i + 1} should succeed`);
      }
      const blocked = await handleGetStats(
        new Request(`${ORIGIN}/api/admin/stats?sources=visitors`),
        { user: { id: rateUser, role: 'ADMIN' } },
        { stats: fastStats, apiCounter: counter },
      );
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '60');
      assert.equal(blocked.headers.get('cache-control'), 'private, no-store');
      assert.equal(AppErrorDTOSchema.parse(await blocked.json()).error, 'rate_limited');

      const isolated = await handleGetStats(
        new Request(`${ORIGIN}/api/admin/stats?sources=visitors`),
        { user: { id: otherUser, role: 'ADMIN' } },
        { stats: fastStats, apiCounter: counter },
      );
      assert.equal(isolated.status, 200);
    } finally {
      if (prevStore === undefined) delete process.env.RATE_LIMIT_STORE;
      else process.env.RATE_LIMIT_STORE = prevStore;
    }
  });
});

describe('M6-T6 GET /api/admin/stats PostgreSQL + Auth.js integration', { concurrency: false, skip: skipDb, timeout: 300_000 }, () => {
  let db: PrismaClient;
  let route: typeof import('../src/app/api/admin/stats/route');
  let settingsRoute: typeof import('../src/app/api/admin/settings/analytics/route');
  let consentRoute: typeof import('../src/app/api/analytics/consent/route');
  let eventsRoute: typeof import('../src/app/api/analytics/events/route');
  let operationsRoute: typeof import('../src/app/api/admin/cron/operations/route');
  let handleAuth: typeof import('../src/auth').handleAuth;
  let composition: typeof import('../src/lib/server/composition');
  let hashSecret: typeof import('../src/lib/server/admin/crypto').hashSecret;
  let encrypt: typeof import('../src/lib/server/admin/crypto').encrypt;

  const savedEnv: Record<string, string | undefined> = {};
  const TEST_ENV: Record<string, string> = {
    DATABASE_URL: database?.url ?? '',
    AUTH_SECRET: 'm6t6-test-auth-secret-0123456789abcdef',
    EDGE_AUTH_SECRET: 'm6t6-test-edge-secret-0123456789abcdef',
    ADMIN_TOTP_KEY: Buffer.alloc(32, 9).toString('base64'),
    PRIVACY_HASH_SECRET: 'm6t6-privacy-hash-secret-0123456789abcdef',
    CRON_SECRET: 'm6t6-cron-secret-0123456789abcdef-long-enough',
    NEXT_PUBLIC_SITE_URL: ORIGIN,
    AUTH_URL: ORIGIN,
    RATE_LIMIT_STORE: 'memory',
  };

  function cookieJar(response: Response, previous = ''): string {
    const pairs = new Map<string, string>();
    for (const part of previous.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) pairs.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    }
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0] ?? '';
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (!value) pairs.delete(name);
      else pairs.set(name, value);
    }
    return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async function seedUser(role: Role, opts: { disabled?: boolean } = {}) {
    const secret = authenticator.generateSecret();
    const email = `m6t6-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
    const password = 'correct-horse-battery-packjoyu';
    const user = await db.user.create({
      data: {
        email,
        name: `M6T6 ${role}`,
        role,
        passwordHash: await hashSecret(password),
        totpSecret: encrypt(secret),
        totpEnabled: true,
        ...(opts.disabled ? { disabled: true } : {}),
      },
    });
    return {
      id: user.id,
      email,
      password,
      code: () => authenticator.generate(secret),
    };
  }

  async function loginAs(role: Role): Promise<{ userId: string; cookie: string }> {
    const user = await seedUser(role);
    const csrfRes = await handleAuth(new Request(`${ORIGIN}/api/auth/csrf`, { headers: { cookie: '' } }));
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const jar = cookieJar(csrfRes);
    const form = new URLSearchParams({
      email: user.email,
      password: user.password,
      totp: user.code(),
      csrfToken,
      callbackUrl: `${ORIGIN}/admin`,
    });
    const res = await handleAuth(new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar, origin: ORIGIN },
      body: form,
    }));
    const cookie = cookieJar(res, jar);
    assert.ok(cookie.includes('authjs.session-token='), `${role} login must issue session cookie`);
    return { userId: user.id, cookie };
  }

  async function acceptConsent(): Promise<string> {
    const res = await consentRoute.POST(new Request(`${ORIGIN}/api/analytics/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ analytics: true, consentVersion: CONSENT_VERSION }),
    }));
    assert.equal(res.status, 200);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('pj_analytics='));
    assert.ok(raw, 'consent endpoint must issue pj_analytics cookie');
    return raw.split(';', 1)[0];
  }

  async function postEvents(cookie: string | null, events: unknown[]): Promise<Response> {
    return eventsRoute.POST(new Request(`${ORIGIN}/api/analytics/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ events }),
    }));
  }

  async function runAggregateCron(): Promise<void> {
    const res = await operationsRoute.POST(new Request(`${ORIGIN}/api/admin/cron/operations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_ENV.CRON_SECRET}`,
      },
      body: JSON.stringify({ jobKey: 'analytics-aggregate' }),
    }));
    assert.equal(res.status, 200, `cron operations failed: ${res.status}`);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'SUCCEEDED');
  }

  function findSource(dto: StatsDTO, source: StatsSource) {
    const item = dto.sources.find((s) => s.source === source);
    assert.ok(item, `expected source ${source} in DTO`);
    return item;
  }

  before(async () => {
    assert.ok(database);
    for (const [key, value] of Object.entries(TEST_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    const baseUrl = new URL(database.url);
    baseUrl.searchParams.delete('schema');
    const bootstrap = new PrismaClient({ datasources: { db: { url: baseUrl.toString() } } });
    try {
      await bootstrap.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${database.schema}" CASCADE`);
      await bootstrap.$executeRawUnsafe(`CREATE SCHEMA "${database.schema}"`);
    } finally {
      await bootstrap.$disconnect();
    }

    const push = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--accept-data-loss'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
          CHECKPOINT_DISABLE: '1',
        },
        encoding: 'utf8',
        timeout: 240_000,
      },
    );
    assert.equal(
      push.status,
      0,
      `prisma db push failed (${push.error ? push.error.message : `status=${String(push.status)}`}): ${push.stderr}\n${push.stdout}`,
    );

    db = new PrismaClient({ datasources: { db: { url: database.url } } });
    route = await import('../src/app/api/admin/stats/route');
    settingsRoute = await import('../src/app/api/admin/settings/analytics/route');
    consentRoute = await import('../src/app/api/analytics/consent/route');
    eventsRoute = await import('../src/app/api/analytics/events/route');
    operationsRoute = await import('../src/app/api/admin/cron/operations/route');
    ({ handleAuth } = await import('../src/auth'));
    composition = await import('../src/lib/server/composition');
    ({ hashSecret, encrypt } = await import('../src/lib/server/admin/crypto'));
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditLog",
        "ApiDailyCounter",
        "JobState",
        "AnalyticsEvent",
        "AnalyticsDaily",
        "AnalyticsAggregateDayState",
        "AnalyticsDayChange",
        "AnalyticsDailyRollup",
        "AnalyticsRollupDay",
        "SiteSetting",
        "AdminDeviceSession",
        "User"
      RESTART IDENTITY CASCADE
    `);
  });

  after(async () => {
    await db?.$disconnect();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('auth boundaries (401 unauthenticated, 403 disabled) & role source matrix with pre-query trimming (E-66)', async () => {
    const unauth = await route.GET(new Request(`${ORIGIN}/api/admin/stats`));
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get('cache-control'), 'private, no-store');

    // Disabled user cannot hold valid access even if seeded directly
    const disabled = await seedUser('ADMIN', { disabled: true });
    const csrfRes = await handleAuth(new Request(`${ORIGIN}/api/auth/csrf`, { headers: { cookie: '' } }));
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const jar = cookieJar(csrfRes);
    const disabledLogin = await handleAuth(new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar, origin: ORIGIN },
      body: new URLSearchParams({
        email: disabled.email,
        password: disabled.password,
        totp: disabled.code(),
        csrfToken,
      }),
    }));
    assert.equal(cookieJar(disabledLogin, jar).includes('authjs.session-token='), false);

    // An already-signed-in session becomes 403 once the user is disabled
    const doomed = await loginAs('EDITOR');
    await db.user.update({ where: { id: doomed.userId }, data: { disabled: true } });
    const disabledSessionRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?sources=visitors`, {
      headers: { cookie: doomed.cookie },
    }));
    assert.equal(disabledSessionRes.status, 403);
    assert.equal(disabledSessionRes.headers.get('cache-control'), 'private, no-store');

    const admin = await loginAs('ADMIN');
    const sales = await loginAs('SALES');
    const editor = await loginAs('EDITOR');

    const adminRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats`, { headers: { cookie: admin.cookie } }));
    assert.equal(adminRes.status, 200);
    const adminDto = StatsDTOSchema.parse(await adminRes.json());
    assert.deepEqual(
      new Set(adminDto.sources.map((s) => s.source)),
      new Set(StatsSourceSchema.options),
    );
    assert.equal(findSource(adminDto, 'inquiries').state, 'not_connected');
    assert.equal(findSource(adminDto, 'mail').state, 'not_connected');
    assert.equal(findSource(adminDto, 'storage').state, 'not_connected');
    assert.equal(findSource(adminDto, 'backup').state, 'not_connected');

    const salesRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats`, { headers: { cookie: sales.cookie } }));
    assert.equal(salesRes.status, 200);
    const salesDto = StatsDTOSchema.parse(await salesRes.json());
    const salesNames = new Set(salesDto.sources.map((s) => s.source));
    for (const forbidden of ['api_requests', 'api_errors', 'mail', 'storage', 'backup'] as const) {
      assert.equal(salesNames.has(forbidden), false, `SALES must not see ${forbidden}`);
    }
    assert.equal(salesNames.has('chat_starts'), true);
    assert.equal(salesNames.has('inquiries'), true);

    const editorRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats`, { headers: { cookie: editor.cookie } }));
    assert.equal(editorRes.status, 200);
    const editorDto = StatsDTOSchema.parse(await editorRes.json());
    assert.deepEqual(
      editorDto.sources.map((s) => s.source),
      ['page_views', 'visitors', 'product_views', 'model_starts', 'model_successes', 'model_failures', 'mean_load_duration_ms'],
    );

    // Direct request for sensitive sources -> 403
    for (const pathQuery of ['?sources=storage', '?sources=mail', '?sources=inquiries', '?sources=chat_starts']) {
      const r = await route.GET(new Request(`${ORIGIN}/api/admin/stats${pathQuery}`, { headers: { cookie: editor.cookie } }));
      assert.equal(r.status, 403, `EDITOR ${pathQuery} must return 403`);
    }
    for (const pathQuery of ['?sources=storage', '?sources=api_errors,mail']) {
      const r = await route.GET(new Request(`${ORIGIN}/api/admin/stats${pathQuery}`, { headers: { cookie: sales.cookie } }));
      assert.equal(r.status, 403, `SALES ${pathQuery} must return 403`);
    }

    // Mixed sources trimmed pre-query with no hidden counts leaked
    const editorMixed = await route.GET(new Request(`${ORIGIN}/api/admin/stats?sources=visitors,storage,chat_starts,model_starts`, {
      headers: { cookie: editor.cookie },
    }));
    assert.equal(editorMixed.status, 200);
    const editorMixedDto = StatsDTOSchema.parse(await editorMixed.json());
    assert.deepEqual(editorMixedDto.sources.map((s) => s.source), ['visitors', 'model_starts']);

    const salesMixed = await route.GET(new Request(`${ORIGIN}/api/admin/stats?sources=chat_starts,storage,mail`, {
      headers: { cookie: sales.cookie },
    }));
    assert.equal(salesMixed.status, 200);
    const salesMixedDto = StatsDTOSchema.parse(await salesMixed.json());
    assert.deepEqual(salesMixedDto.sources.map((s) => s.source), ['chat_starts']);

    // Verify real ApiDailyCounter recorded GET /api/admin/stats requests
    const counterRows = await db.apiDailyCounter.findMany({
      where: { routeId: STATS_ROUTE_ID },
    });
    const totalCount = counterRows.reduce((sum, r) => sum + r.requestCount, 0);
    assert.equal(totalCount, 11);
  });

  test('E-61/E-63 end-to-end consent -> events -> aggregate cron -> real metrics, product pageViews no_data, weighted duration, 0% vs null rate', async () => {
    const now = new Date();
    const today = siteLocalDate(now, 'UTC');
    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterday = shiftLocalDate(today, -1);

    const browserA = await acceptConsent();
    const browserB = await acceptConsent();

    // Unconsented event MUST be rejected and never counted
    const unconsented = await postEvents(null, [{
      eventId: randomUUID(),
      occurredAt: now.toISOString(),
      locale: 'en',
      navigationId: randomUUID(),
      viewId: randomUUID(),
      productSlug: REAL_PRODUCT_A,
      kind: 'model_view_start',
    }]);
    assert.equal(unconsented.status, 403);

    // Browser A today: home page_view, product A en+ru product_view (UV=1), 2 starts (420ms success + 15000ms TIMEOUT failure), 1 chat_start
    const viewSuccess = randomUUID();
    const viewTimeout = randomUUID();
    const resA = await postEvents(browserA, [
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), kind: 'page_view', path: '/en' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), kind: 'product_view', productSlug: REAL_PRODUCT_A, path: `/en/products/${REAL_PRODUCT_A}` },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'ru', navigationId: randomUUID(), kind: 'product_view', productSlug: REAL_PRODUCT_A, path: `/ru/products/${REAL_PRODUCT_A}` },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewSuccess, productSlug: REAL_PRODUCT_A, kind: 'model_view_start' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewSuccess, productSlug: REAL_PRODUCT_A, kind: 'model_load_success', durationMs: 420 },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewTimeout, productSlug: REAL_PRODUCT_A, kind: 'model_view_start' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewTimeout, productSlug: REAL_PRODUCT_A, kind: 'model_load_failure', durationMs: 15_000, failureReason: 'TIMEOUT' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), kind: 'chat_start', path: '/en/contact' },
    ]);
    assert.equal(resA.status, 200);

    // Browser B today: incomplete start on product C (site model_starts=3, loadDurationSamples=2) and yesterday failure on product A (200ms -> 0% rate)
    const viewOpen = randomUUID();
    const viewYestFail = randomUUID();
    const resB = await postEvents(browserB, [
      { eventId: randomUUID(), occurredAt: yesterdayDate.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewYestFail, productSlug: REAL_PRODUCT_A, kind: 'model_view_start' },
      { eventId: randomUUID(), occurredAt: yesterdayDate.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewYestFail, productSlug: REAL_PRODUCT_A, kind: 'model_load_failure', durationMs: 200, failureReason: 'LOAD_ERROR' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), kind: 'page_view', path: '/en' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId: viewOpen, productSlug: REAL_PRODUCT_C, kind: 'model_view_start' },
    ]);
    assert.equal(resB.status, 200);

    await runAggregateCron();

    const admin = await loginAs('ADMIN');
    // 1. Today site-wide query via real HTTP route
    const todayRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${today}&to=${today}`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(todayRes.status, 200);
    const todayDto = StatsDTOSchema.parse(await todayRes.json());
    assert.equal(findSource(todayDto, 'visitors').value, 2);
    assert.equal(findSource(todayDto, 'visitors').state, 'ok');
    assert.equal(findSource(todayDto, 'visitors').coverage, 'full');
    assert.equal(findSource(todayDto, 'visitors').timezone, 'UTC');
    assert.equal(findSource(todayDto, 'visitors').timezoneRevision, 1);
    assert.ok(findSource(todayDto, 'visitors').dataThrough);
    assert.ok(findSource(todayDto, 'visitors').lastSucceededAt);
    assert.equal(findSource(todayDto, 'page_views').value, 2);
    assert.equal(findSource(todayDto, 'product_views').value, 2);
    assert.equal(findSource(todayDto, 'model_starts').value, 3);
    assert.equal(findSource(todayDto, 'model_successes').value, 1);
    assert.equal(findSource(todayDto, 'model_failures').value, 1);
    assert.equal(findSource(todayDto, 'chat_starts').value, 1);
    const todayMean = findSource(todayDto, 'mean_load_duration_ms');
    assert.equal(todayMean.value, 7710);
    assert.equal(todayMean.loadDurationSamples, 2);

    // 2. Product attribution: product A today has UV=1 across en+ru, page_views=no_data (null, NEVER 0)
    const prodARes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${today}&to=${today}&productSlug=${REAL_PRODUCT_A}`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(prodARes.status, 200);
    const prodADto = StatsDTOSchema.parse(await prodARes.json());
    assert.equal(findSource(prodADto, 'visitors').value, 1);
    assert.equal(findSource(prodADto, 'product_views').value, 2);
    assert.equal(findSource(prodADto, 'page_views').state, 'no_data');
    assert.equal(findSource(prodADto, 'page_views').value, null);
    assert.equal(findSource(prodADto, 'model_starts').value, 2);

    // 3. Complete day with zero traffic on product B: zero (0) vs mean_load_duration_ms null/no_data (samples=0)
    const prodBRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${today}&to=${today}&productSlug=${REAL_PRODUCT_B}`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(prodBRes.status, 200);
    const prodBDto = StatsDTOSchema.parse(await prodBRes.json());
    assert.equal(findSource(prodBDto, 'visitors').state, 'zero');
    assert.equal(findSource(prodBDto, 'visitors').value, 0);
    assert.equal(findSource(prodBDto, 'model_starts').state, 'zero');
    assert.equal(findSource(prodBDto, 'model_starts').value, 0);
    assert.equal(findSource(prodBDto, 'page_views').state, 'no_data');
    assert.equal(findSource(prodBDto, 'page_views').value, null);
    const prodBMean = findSource(prodBDto, 'mean_load_duration_ms');
    assert.equal(prodBMean.state, 'no_data');
    assert.equal(prodBMean.value, null);
    assert.equal(prodBMean.loadDurationSamples, 0);

    // 4. Weighted multi-day duration mean (never average daily means!): (200 + 420 + 15000) / 3 != (200 + 7710)/2
    const rangeRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${yesterday}&to=${today}`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(rangeRes.status, 200);
    const rangeDto = StatsDTOSchema.parse(await rangeRes.json());
    const rangeMean = findSource(rangeDto, 'mean_load_duration_ms');
    assert.equal(rangeMean.loadDurationSamples, 3);
    assert.ok(Math.abs((rangeMean.value ?? 0) - 15620 / 3) < 1e-6);

    // 5. Verify modelSuccessRate rules directly through production StatsService
    const services = composition.createAdminServices({ db });
    const rateZero = await services.stats.query({ role: 'ADMIN', query: { from: yesterday, to: yesterday } });
    assert.equal(rateZero.modelSuccessRate?.value, 0);
    const ratePartialDenom = await services.stats.query({ role: 'ADMIN', query: { from: today, to: today } });
    assert.ok(Math.abs((ratePartialDenom.modelSuccessRate?.value ?? 0) - 1 / 3) < 1e-9);
    const rateNull = await services.stats.query({ role: 'ADMIN', query: { from: today, to: today, productSlug: REAL_PRODUCT_B } });
    assert.equal(rateNull.modelSuccessRate?.value, null);

    // 6. Disconnecting PRIVACY_HASH_SECRET switches core sources to not_connected through real route
    const prevSecret = process.env.PRIVACY_HASH_SECRET;
    delete process.env.PRIVACY_HASH_SECRET;
    try {
      const discRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?sources=visitors,model_starts`, {
        headers: { cookie: admin.cookie },
      }));
      assert.equal(discRes.status, 200);
      const discDto = StatsDTOSchema.parse(await discRes.json());
      assert.equal(findSource(discDto, 'visitors').state, 'not_connected');
      assert.equal(findSource(discDto, 'model_starts').state, 'not_connected');
    } finally {
      process.env.PRIVACY_HASH_SECRET = prevSecret;
    }
  });

  test('E-55/E-58 timezone switch -> identical across browser TZ, historical revision preserves original timezone, legacy cutover merge', async () => {
    const admin = await loginAs('ADMIN');
    const now = new Date();
    const todayUtc = siteLocalDate(now, 'UTC');

    const cookie = await acceptConsent();
    const viewId = randomUUID();
    const ingest = await postEvents(cookie, [
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), kind: 'page_view', path: '/en' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId, productSlug: REAL_PRODUCT_A, kind: 'model_view_start' },
      { eventId: randomUUID(), occurredAt: now.toISOString(), locale: 'en', navigationId: randomUUID(), viewId, productSlug: REAL_PRODUCT_A, kind: 'model_load_success', durationMs: 310 },
    ]);
    assert.equal(ingest.status, 200);
    await runAggregateCron();

    // Switch site timezone from UTC (rev 1) to America/New_York (rev 2) via real settings PATCH route
    const settingsBefore = await settingsRoute.GET(new Request(`${ORIGIN}/api/admin/settings/analytics`, { headers: { cookie: admin.cookie } }));
    assert.equal(settingsBefore.status, 200);
    const beforeJson = (await settingsBefore.json()) as { version: number; timezoneRevision: number; recomputableFrom: string | null };
    assert.equal(beforeJson.timezoneRevision, 1);

    const patchRes = await settingsRoute.PATCH(new Request(`${ORIGIN}/api/admin/settings/analytics`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: admin.cookie, origin: ORIGIN },
      body: JSON.stringify({ timezone: 'America/New_York', expectedVersion: beforeJson.version }),
    }));
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { timezoneRevision: number; timezone: string; recomputableFrom: string | null };
    assert.equal(patched.timezoneRevision, 2);
    assert.equal(patched.timezone, 'America/New_York');
    assert.ok(patched.recomputableFrom, 'timezone change must expose non-null recomputableFrom within 30d retention');

    await runAggregateCron();

    // Browser TZ independence (E-55): Tokyo vs Los Angeles viewing same NY site day
    const todayNy = siteLocalDate(new Date(), 'America/New_York');
    const prevTz = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const tokyoRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${todayNy}&to=${todayNy}&sources=visitors,model_successes`, {
        headers: { cookie: admin.cookie },
      }));
      assert.equal(tokyoRes.status, 200);
      const tokyoDto = StatsDTOSchema.parse(await tokyoRes.json());

      process.env.TZ = 'America/Los_Angeles';
      const laRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${todayNy}&to=${todayNy}&sources=visitors,model_successes`, {
        headers: { cookie: admin.cookie },
      }));
      assert.equal(laRes.status, 200);
      const laDto = StatsDTOSchema.parse(await laRes.json());

      assert.equal(findSource(tokyoDto, 'visitors').timezone, 'America/New_York');
      assert.equal(findSource(tokyoDto, 'visitors').timezoneRevision, 2);
      assert.equal(findSource(tokyoDto, 'visitors').value, findSource(laDto, 'visitors').value);
      assert.equal(findSource(tokyoDto, 'model_successes').value, findSource(laDto, 'model_successes').value);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }

    // Explicit query of historical rev 1 still returns original UTC label & values without mixing revisions
    const rev1Res = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${todayUtc}&to=${todayUtc}&timezoneRevision=1&sources=visitors,page_views`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(rev1Res.status, 200);
    const rev1Dto = StatsDTOSchema.parse(await rev1Res.json());
    assert.equal(findSource(rev1Dto, 'visitors').timezone, 'UTC');
    assert.equal(findSource(rev1Dto, 'visitors').timezoneRevision, 1);
    assert.equal(findSource(rev1Dto, 'visitors').value, 1);

    // Future revision must be rejected with 400 invalid
    const futureRes = await route.GET(new Request(`${ORIGIN}/api/admin/stats?timezoneRevision=99`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(futureRes.status, 400);
    assert.equal(AppErrorDTOSchema.parse(await futureRes.json()).error, 'invalid');

    // Beyond 30d retention: purged daily/state rows still keep historical timezone label via AuditLog as no_data (never silent trend stitch)
    const oldDay = shiftLocalDate(todayUtc, -35);
    await db.analyticsDaily.deleteMany({ where: { timezoneRevision: 1 } });
    await db.analyticsAggregateDayState.deleteMany({ where: { timezoneRevision: 1 } });
    const expiredRev1 = await route.GET(new Request(`${ORIGIN}/api/admin/stats?from=${oldDay}&to=${oldDay}&timezoneRevision=1&sources=visitors`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(expiredRev1.status, 200);
    const expiredDto = StatsDTOSchema.parse(await expiredRev1.json());
    assert.equal(findSource(expiredDto, 'visitors').timezone, 'UTC');
    assert.equal(findSource(expiredDto, 'visitors').timezoneRevision, 1);
    assert.equal(findSource(expiredDto, 'visitors').state, 'no_data');

    // Pre-deployment AnalyticsDailyRollup + AnalyticsRollupDay phased merge without double-counting when trusted legacyBefore is supplied
    const legacyDay1 = shiftLocalDate(todayUtc, -40);
    const legacyDay2 = shiftLocalDate(todayUtc, -39);
    const expiresFuture = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
    await db.analyticsRollupDay.createMany({
      data: [
        { siteDate: legacyDay1, timezoneRevision: 1, completedAt: now, eventCount: 4 },
        { siteDate: legacyDay2, timezoneRevision: 1, completedAt: now, eventCount: 9 },
      ],
    });
    await db.analyticsDailyRollup.createMany({
      data: [
        { siteDate: legacyDay1, kind: 'page_view', locale: 'en', productSlug: '', count: 4, uniqueBrowsers: 4 },
        { siteDate: legacyDay2, kind: 'page_view', locale: 'en', productSlug: '', count: 99, uniqueBrowsers: 99 },
      ],
    });
    await db.analyticsDaily.create({
      data: {
        localDate: legacyDay2,
        timezoneRevision: 1,
        timezone: 'UTC',
        dimension: 'site',
        visitors: 2,
        pageViews: 5,
        productViews: 0,
        modelStarts: 0,
        modelSuccesses: 0,
        modelFailures: 0,
        chatStarts: 0,
        durationMsSum: BigInt(0),
        loadDurationSamples: 0,
        aggregatedAt: now,
        expiresAt: expiresFuture,
      },
    });
    await db.analyticsAggregateDayState.create({
      data: { localDate: legacyDay2, timezoneRevision: 1, timezone: 'UTC', markerVersions: {} },
    });

    // Ensure AuditLog row exists so rev 1 still resolves cleanly
    const audits = await db.auditLog.count({ where: { action: ANALYTICS_TIMEZONE_CHANGE_ACTION } });
    assert.ok(audits >= 1);

    const legacyServices = {
      stats: createStatsService({
        db,
        clock: () => now,
        analyticsConfigured: () => true,
        aggregateJobRegistered: () => true,
        resolveLegacyBefore: () => shiftLocalDate(legacyDay2, 1),
      }),
      apiCounter: composition.createAdminServices({ db }).apiCounter,
    };
    const mergedRes = await (await import('../src/lib/server/ops/stats-service')).handleGetStats(
      new Request(`${ORIGIN}/api/admin/stats?from=${legacyDay1}&to=${legacyDay2}&timezoneRevision=1&sources=page_views`),
      { user: { id: admin.userId, role: 'ADMIN' } },
      legacyServices,
    );
    assert.equal(mergedRes.status, 200);
    const mergedDto = StatsDTOSchema.parse(await mergedRes.json());
    // legacyDay1 uses rollup (4) + legacyDay2 uses modern AnalyticsDaily (5, NOT 99) -> 9 total without double counting
    assert.equal(findSource(mergedDto, 'page_views').value, 9);
  });
});
