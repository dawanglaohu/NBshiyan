import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppErrorCodeSchema } from '../src/lib/contracts/errors';
import { AppError, classifyThrown, mapAppError, mapUnknownFailure } from '../src/lib/server/http/errors';
import {
  ANALYTICS_SETTINGS_KEY,
  API_ROUTE_IDS,
  createApiCounter,
  type ApiCounterDb,
  type CounterLog,
} from '../src/lib/server/http/metrics';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';

const ROUTE = 'GET /api/admin/account' as const;
const REQUEST_ID = '5fcf5ba2-7d35-4d50-8798-e6f65b1268ef';
const STATUS_BY_CODE: Record<string, number> = {
  invalid: 400, too_large: 413, unauthorized: 401, account_disabled: 403, forbidden: 403, forbidden_origin: 403,
  not_found: 404, rate_limited: 429, version_conflict: 409, idempotency_conflict: 409, conversation_closed: 409,
  conversation_anonymized: 409, analytics_consent_required: 403, event_time_out_of_range: 400, action_grant_invalid: 401,
  bad_credentials: 401, recovery_expired: 401, job_busy: 409, source_unavailable: 503, service_unavailable: 503,
  internal_error: 500,
};

test('new AppError maps to the section 10 status and envelope; unknown failures stay redacted', () => {
  assert.deepEqual(Object.keys(STATUS_BY_CODE).sort(), [...AppErrorCodeSchema.options].sort());
  for (const code of AppErrorCodeSchema.options) {
    const mapped = mapAppError(new AppError(code), REQUEST_ID);
    assert.equal(mapped.status, STATUS_BY_CODE[code], code);
    assert.equal(mapped.body.error, code);
    assert.equal(mapped.body.requestId, REQUEST_ID);
    assert.equal(mapped.headers['cache-control'], 'private, no-store');
    assert.equal('fieldErrors' in mapped.body, false);
  }

  const fields = mapAppError(new AppError('invalid', { fieldErrors: { email: 'Use a valid email.' } }), REQUEST_ID);
  assert.deepEqual(fields.body.fieldErrors, { email: 'Use a valid email.' });
  const dropped = mapAppError(new AppError('invalid', { fieldErrors: { email: 'bad\nvalue' } as never }), REQUEST_ID);
  assert.equal('fieldErrors' in dropped.body, false);

  const limited = mapAppError(new AppError('rate_limited', { retryAfterSeconds: 12 }), 'not-a-uuid');
  assert.equal(limited.headers['retry-after'], '12');
  assert.equal(limited.body.requestId === 'not-a-uuid', false);
  assert.match(limited.body.requestId, /^[0-9a-f-]{36}$/);

  const legacyResponse = new Response(JSON.stringify({ error: 'CredentialsSignin' }), { status: 401 });
  const passed = classifyThrown(legacyResponse);
  assert.equal(passed.kind, 'legacy-response');
  if (passed.kind === 'legacy-response') assert.equal(passed.response, legacyResponse);
  const legacyBody = { error: 'bad_credentials' };
  const legacy = classifyThrown(legacyBody);
  assert.deepEqual(legacy, { kind: 'legacy-body', body: legacyBody });

  const logs: unknown[] = [];
  const leak = new Error('smtp password hunter2 at /secret/path.ts');
  leak.name = 'PrismaClientKnownRequestError';
  const hidden = mapUnknownFailure(leak, REQUEST_ID, (event) => logs.push(event));
  assert.deepEqual(hidden.body, { error: 'internal_error', requestId: REQUEST_ID });
  assert.equal(JSON.stringify(hidden).includes('hunter2'), false);
  assert.equal(JSON.stringify(logs).includes('hunter2'), false);
  assert.equal(JSON.stringify(logs).includes('PrismaClientKnownRequestError'), true);
});

function sqlValues(query: unknown): unknown[] {
  if (query && typeof query === 'object' && 'values' in query) return (query as Prisma.Sql).values;
  return [];
}

test('counter keeps the caller payload when the route is outside the whitelist or storage fails', async () => {
  const queries: unknown[] = [];
  const logs: CounterLog[] = [];
  const body = { error: 'bad_credentials', note: 'BODY_PROBE ada@example.com 203.0.113.9' };
  const db = {
    siteSetting: { findUnique: async () => null },
    $executeRaw: async (query: unknown) => {
      queries.push(query);
      return 1;
    },
  } as unknown as ApiCounterDb;
  const counter = createApiCounter({ db, log: (event) => logs.push(event), clock: () => new Date('2026-03-01T00:30:00.000Z') });

  const rejected = await counter.recordFinalResponse({
    routeId: 'GET /api/admin/account?email=ada@example.com',
    status: 200,
    body,
  });
  assert.equal(rejected.recorded, false);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body, body);
  assert.equal(queries.length, 0);
  assert.equal(JSON.stringify(logs).includes('ada@example.com'), false);

  const counted = await counter.recordFinalResponse({ routeId: ROUTE, status: 200, body });
  assert.equal(counted.recorded, true);
  assert.equal(counted.body, body);
  assert.deepEqual(sqlValues(queries[0]).slice(0, 3), ['2026-03-01', 1, ROUTE]);
  assert.equal(sqlValues(queries[0])[3], 0);
  assert.equal(sqlValues(queries[0])[5], 0);
  assert.match(String((queries[0] as Prisma.Sql).strings), /"requestCount" = "ApiDailyCounter"\."requestCount" \+ 1/);
  assert.equal(JSON.stringify(queries).includes('BODY_PROBE'), false);
  assert.equal(JSON.stringify(queries).includes('203.0.113.9'), false);

  const clientError = await counter.recordFinalResponse({ routeId: ROUTE, status: 404, body });
  assert.equal(clientError.recorded, true);
  assert.equal(sqlValues(queries[1])[3], 0);
  const serverError = await counter.recordFinalResponse({ routeId: ROUTE, status: 500, body });
  assert.equal(serverError.recorded, true);
  assert.equal(sqlValues(queries[2])[3], 1);
  assert.equal(sqlValues(queries[2])[5], 1);

  const failing = {
    siteSetting: {
      findUnique: async () => ({ value: { updatedBy: 'ada@example.com', timezone: 'Not/AZone' } }),
    },
    $executeRaw: async () => { throw new Error('should not write'); },
  } as unknown as ApiCounterDb;
  const unreadableLogs: CounterLog[] = [];
  const unreadable = createApiCounter({ db: failing, log: (event) => unreadableLogs.push(event) });
  const kept = await unreadable.recordFinalResponse({ routeId: ROUTE, status: 200, body });
  assert.deepEqual(kept, { status: 200, body, recorded: false });
  assert.equal(JSON.stringify(unreadableLogs).includes('ada@example.com'), false);

  const down = createApiCounter({
    db: {
      siteSetting: { findUnique: async () => null },
      $executeRaw: async () => { throw Object.assign(new Error('postgres://user:hunter2@db/app'), { name: 'PrismaClientKnownRequestError' }); },
    } as unknown as ApiCounterDb,
    log: (event) => unreadableLogs.push(event),
  });
  const failed = await down.recordFinalResponse({ routeId: ROUTE, status: 500, body });
  assert.equal(failed.status, 500);
  assert.equal(failed.body, body);
  assert.equal(failed.recorded, false);
  assert.equal(JSON.stringify(unreadableLogs).includes('hunter2'), false);
  assert.equal(unreadableLogs.at(-1)?.errorCategory, 'PrismaClientKnownRequestError');
  assert.equal(unreadableLogs.at(-1)?.routeId, ROUTE);
});

test('stored analytics settings choose the site date; a missing row stays UTC revision 1', async () => {
  const queries: unknown[] = [];
  let value: unknown = {
    version: 3,
    timezone: 'America/New_York',
    timezoneRevision: 4,
    changedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: null,
  };
  const db = {
    siteSetting: { findUnique: async (args: { where: { key: string } }) => (args.where.key === ANALYTICS_SETTINGS_KEY ? { value } : null) },
    $executeRaw: async (query: unknown) => { queries.push(query); return 1; },
  } as unknown as ApiCounterDb;
  const counter = createApiCounter({ db, clock: () => new Date('2026-01-16T03:30:00.000Z') });
  const zoned = await counter.recordFinalResponse({ routeId: ROUTE, status: 200, body: { ok: true } });
  assert.equal(zoned.recorded, true);
  assert.deepEqual(sqlValues(queries[0]).slice(0, 3), ['2026-01-15', 4, ROUTE]);

  value = null;
  const dbMissing = {
    siteSetting: { findUnique: async () => null },
    $executeRaw: db.$executeRaw,
  } as unknown as ApiCounterDb;
  const initial = await createApiCounter({ db: dbMissing, clock: () => new Date('2026-01-16T03:30:00.000Z') })
    .recordFinalResponse({ routeId: ROUTE, status: 200, body: { ok: true } });
  assert.equal(initial.recorded, true);
  assert.deepEqual(sqlValues(queries[1]).slice(0, 3), ['2026-01-16', 1, ROUTE]);
});

test('composition registers the counter, and this layer does not import M5 or M6', async () => {
  for (const file of [
    'src/lib/server/config.ts',
    'src/lib/server/composition.ts',
    'src/lib/server/http/errors.ts',
    'src/lib/server/http/metrics.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /lib\/server\/(analytics|ops|jobs)\b/);
    assert.doesNotMatch(source, /queryRawUnsafe/);
  }
  assert.equal(API_ROUTE_IDS.includes(ROUTE), true);
  assert.equal(API_ROUTE_IDS.includes('GET /api/auth/[...nextauth]' as never), false);
  assert.equal(API_ROUTE_IDS.includes('POST /api/admin/cron/mail-queue' as never), false);
  assert.equal(ADMIN_SESSION_POLICY.activityThrottleMs < ADMIN_SESSION_POLICY.idleMs, true);

  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= 'postgresql://counter:counter@127.0.0.1:1/counter?connection_limit=5&pool_timeout=10';
  const { createHttpServices } = await import('../src/lib/server/composition');
  const queries: unknown[] = [];
  const services = createHttpServices({
    config: { session: ADMIN_SESSION_POLICY, grant: { ttlMs: 300000, permitTtlMs: 900000, restrictedTtlMs: 600000 }, production: false },
    db: {
      siteSetting: { findUnique: async () => null },
      $executeRaw: async (query: unknown) => { queries.push(query); return 1; },
    } as unknown as ApiCounterDb,
    clock: () => new Date('2026-03-01T00:30:00.000Z'),
  });
  const recorded = await services.apiCounter.recordFinalResponse({ routeId: ROUTE, status: 201, body: { id: 'acct' } });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.body.id, 'acct');
  assert.equal(queries.length, 1);
  if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
});

const databaseUrl = process.env.ADMIN_RESET_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.ADMIN_RESET_TEST_DATABASE_URL
  : null;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
after(async () => { await db?.$disconnect(); });

async function ensureCounterTable(client: PrismaClient) {
  const found = await client.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ApiDailyCounter'
    ) AS "exists"
  `;
  if (found[0]?.exists) return;
  await client.$executeRaw`
    CREATE TABLE "ApiDailyCounter" (
      "localDate" TEXT NOT NULL,
      "timezoneRevision" INTEGER NOT NULL,
      "routeId" TEXT NOT NULL,
      "requestCount" INTEGER NOT NULL,
      "errorCount" INTEGER NOT NULL,
      "lastObservedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ApiDailyCounter_pkey" PRIMARY KEY ("localDate", "timezoneRevision", "routeId")
    )
  `;
}

test('dedicated postgres increments requestCount on every final response and errorCount only for 5xx', { skip: !db }, async () => {
  const client = db as PrismaClient;
  await ensureCounterTable(client);
  const clock = () => new Date('2026-07-02T03:30:00.000Z');
  const localDate = '2026-07-02';
  await client.apiDailyCounter.deleteMany({ where: { localDate, routeId: ROUTE } });
  const previous = await client.siteSetting.findUnique({ where: { key: ANALYTICS_SETTINGS_KEY } });
  await client.siteSetting.deleteMany({ where: { key: ANALYTICS_SETTINGS_KEY } });
  try {
    const counter = createApiCounter({ db: client, clock });
    const body = { id: 'acct', email: 'ada@example.com', ip: '203.0.113.9', raw: 'BODY_PROBE' };
    for (const status of [200, 404, 500, 500]) {
      const result = await counter.recordFinalResponse({ routeId: ROUTE, status, body });
      assert.equal(result.recorded, true);
      assert.equal(result.status, status);
      assert.equal(result.body, body);
    }
    const [first, second] = await Promise.all([
      counter.recordFinalResponse({ routeId: ROUTE, status: 200, body }),
      counter.recordFinalResponse({ routeId: ROUTE, status: 503, body }),
    ]);
    assert.equal(first.recorded && second.recorded, true);
    const row = await client.apiDailyCounter.findUnique({
      where: { localDate_timezoneRevision_routeId: { localDate, timezoneRevision: 1, routeId: ROUTE } },
    });
    assert.ok(row);
    assert.equal(row.requestCount, 6);
    assert.equal(row.errorCount, 3);
    assert.equal(row.timezoneRevision, 1);
    const columns = await client.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ApiDailyCounter'
    `;
    assert.deepEqual(columns.map((column) => column.column_name).sort(), [
      'errorCount', 'lastObservedAt', 'localDate', 'requestCount', 'routeId', 'timezoneRevision',
    ]);
    const stored = JSON.stringify(row);
    assert.equal(stored.includes('BODY_PROBE'), false);
    assert.equal(stored.includes('ada@example.com'), false);
    assert.equal(stored.includes('203.0.113.9'), false);

    await client.siteSetting.create({
      data: {
        key: ANALYTICS_SETTINGS_KEY,
        value: {
          version: 2,
          timezone: 'America/New_York',
          timezoneRevision: 9,
          changedAt: '2026-07-01T00:00:00.000Z',
          updatedBy: null,
        },
      },
    });
    const zoned = await counter.recordFinalResponse({ routeId: ROUTE, status: 500, body });
    assert.equal(zoned.recorded, true);
    const zonedRow = await client.apiDailyCounter.findUnique({
      where: { localDate_timezoneRevision_routeId: { localDate: '2026-07-01', timezoneRevision: 9, routeId: ROUTE } },
    });
    assert.equal(zonedRow?.requestCount, 1);
    assert.equal(zonedRow?.errorCount, 1);
    await client.apiDailyCounter.deleteMany({ where: { routeId: ROUTE, timezoneRevision: 9 } });
  } finally {
    await client.apiDailyCounter.deleteMany({ where: { routeId: ROUTE, localDate } });
    await client.siteSetting.deleteMany({ where: { key: ANALYTICS_SETTINGS_KEY } });
    if (previous) await client.siteSetting.create({ data: { key: previous.key, value: previous.value as never } });
  }
});

const unavailableLog = () => { throw new Error('log unavailable'); };

test('counter storage and log failure preserve original response', async () => {
  const body = { ok: true };
  const counter = createApiCounter({
    db: {
      siteSetting: { findUnique: async () => null },
      $executeRaw: async () => { throw new Error('db unavailable'); },
    } as unknown as ApiCounterDb,
    log: unavailableLog,
  });
  const actual = await counter.recordFinalResponse({ routeId: ROUTE, status: 200, body });
  assert.equal(actual.status, 200);
  assert.equal(actual.body, body);
  assert.equal(actual.recorded, false);
  assert.equal(JSON.stringify(actual).includes('log unavailable'), false);
  assert.equal(JSON.stringify(actual).includes('db unavailable'), false);
});

test('log failure cannot interrupt controlled unknown-error mapping', () => {
  const actual = mapUnknownFailure(new Error('private database detail'), REQUEST_ID, unavailableLog);
  assert.equal(actual.status, 500);
  assert.deepEqual(actual.body, { error: 'internal_error', requestId: REQUEST_ID });
  assert.equal(JSON.stringify(actual).includes('private database detail'), false);
  assert.equal(JSON.stringify(actual).includes('log unavailable'), false);
});

test('whitelist rejection and unreadable settings keep the original response when logging throws', async () => {
  const body = { ok: true };
  const rejected = await createApiCounter({
    db: {
      siteSetting: { findUnique: async () => null },
      $executeRaw: async () => 1,
    } as unknown as ApiCounterDb,
    log: unavailableLog,
  }).recordFinalResponse({ routeId: 'GET /api/admin/account?email=ada@example.com', status: 200, body });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body, body);
  assert.equal(rejected.recorded, false);

  const unreadable = await createApiCounter({
    db: {
      siteSetting: { findUnique: async () => ({ value: { timezone: 'Not/AZone', updatedBy: 'ada@example.com' } }) },
      $executeRaw: async () => { throw new Error('should not write'); },
    } as unknown as ApiCounterDb,
    log: unavailableLog,
  }).recordFinalResponse({ routeId: ROUTE, status: 503, body });
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.body, body);
  assert.equal(unreadable.recorded, false);
  assert.equal(JSON.stringify(unreadable).includes('ada@example.com'), false);
  assert.equal(JSON.stringify(unreadable).includes('log unavailable'), false);
});


test('lastObservedAt never regresses when an older response writes after a newer response', { skip: !db }, async () => {
  const client = db as PrismaClient;
  await ensureCounterTable(client);
  const localDate = '2026-07-03';
  const olderTime = new Date('2026-07-03T12:00:00.000Z');
  const newerTime = new Date('2026-07-03T12:00:01.000Z');
  const previous = await client.siteSetting.findUnique({ where: { key: ANALYTICS_SETTINGS_KEY } });
  await client.siteSetting.deleteMany({ where: { key: ANALYTICS_SETTINGS_KEY } });
  await client.apiDailyCounter.deleteMany({ where: { localDate, routeId: ROUTE } });
  let releaseOlderRead!: () => void;
  let reportOlderRead!: () => void;
  const olderReadHeld = new Promise<void>((resolve) => { releaseOlderRead = resolve; });
  const olderReadStarted = new Promise<void>((resolve) => { reportOlderRead = resolve; });
  let settingsReads = 0;
  const orderedDb = {
    siteSetting: {
      findUnique: async (args: Parameters<typeof client.siteSetting.findUnique>[0]) => {
        settingsReads += 1;
        if (settingsReads === 1) {
          reportOlderRead();
          await olderReadHeld;
        }
        return client.siteSetting.findUnique(args);
      },
    },
    $executeRaw: client.$executeRaw.bind(client),
  } as unknown as ApiCounterDb;
  const olderCounter = createApiCounter({ db: orderedDb, clock: () => olderTime });
  const newerCounter = createApiCounter({ db: orderedDb, clock: () => newerTime });
  const olderResponse = olderCounter.recordFinalResponse({ routeId: ROUTE, status: 200, body: { ok: true } });
  try {
    // Hold only the earlier settings read; both writes still use the real PostgreSQL adapter.
    await olderReadStarted;
    const newerResponse = await newerCounter.recordFinalResponse({ routeId: ROUTE, status: 500, body: { error: 'internal_error' } });
    assert.equal(newerResponse.recorded, true);
    const newestRow = await client.apiDailyCounter.findUnique({
      where: { localDate_timezoneRevision_routeId: { localDate, timezoneRevision: 1, routeId: ROUTE } },
    });
    assert.ok(newestRow);
    releaseOlderRead();
    assert.equal((await olderResponse).recorded, true);
    const row = await client.apiDailyCounter.findUnique({
      where: { localDate_timezoneRevision_routeId: { localDate, timezoneRevision: 1, routeId: ROUTE } },
    });
    assert.ok(row);
    assert.equal(row.requestCount, 2);
    assert.equal(row.errorCount, 1);
    assert.equal(row.lastObservedAt.toISOString(), newestRow.lastObservedAt.toISOString());
    assert.equal(row.lastObservedAt.toISOString(), newerTime.toISOString());
  } finally {
    releaseOlderRead();
    await olderResponse;
    await client.apiDailyCounter.deleteMany({ where: { localDate, routeId: ROUTE } });
    await client.siteSetting.deleteMany({ where: { key: ANALYTICS_SETTINGS_KEY } });
    if (previous) await client.siteSetting.create({ data: { key: previous.key, value: previous.value as never } });
  }
});


test('counter stores UTC observed times when the PostgreSQL session uses another timezone', { skip: !db }, async () => {
  const client = db as PrismaClient;
  await ensureCounterTable(client);
  const localDate = '2026-07-04';
  const observedAt = new Date('2026-07-04T12:00:00.000Z');
  // The transaction pins SET LOCAL and the real insert to one connection.
  await client.$transaction(async (tx) => {
    const previous = await tx.siteSetting.findUnique({ where: { key: ANALYTICS_SETTINGS_KEY } });
    await tx.siteSetting.deleteMany({ where: { key: ANALYTICS_SETTINGS_KEY } });
    await tx.apiDailyCounter.deleteMany({ where: { localDate, routeId: ROUTE } });
    await tx.$queryRaw`SELECT set_config('TimeZone', 'America/Los_Angeles', true)`;
    const counter = createApiCounter({ db: tx as unknown as ApiCounterDb, clock: () => observedAt });
    const result = await counter.recordFinalResponse({ routeId: ROUTE, status: 200, body: { ok: true } });
    assert.equal(result.recorded, true);
    const row = await tx.apiDailyCounter.findUnique({
      where: { localDate_timezoneRevision_routeId: { localDate, timezoneRevision: 1, routeId: ROUTE } },
    });
    assert.ok(row);
    assert.equal(row.lastObservedAt.toISOString(), observedAt.toISOString());
    await tx.apiDailyCounter.deleteMany({ where: { localDate, routeId: ROUTE } });
    if (previous) await tx.siteSetting.create({ data: { key: previous.key, value: previous.value as never } });
  });
});


test('default HTTP log sinks report sanitized counter and unknown failures', async () => {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  console.error = (...args: unknown[]) => { errors.push(args); };
  const body = { ok: true, secret: 'BODY_PRIVATE_PROBE' };
  try {
    const counter = createApiCounter({
      db: {
        siteSetting: { findUnique: async () => null },
        $executeRaw: async () => { throw new Error('DATABASE_PRIVATE_PROBE'); },
      } as unknown as ApiCounterDb,
    });
    const result = await counter.recordFinalResponse({ routeId: ROUTE, status: 200, body });
    assert.equal(result.status, 200);
    assert.equal(result.body, body);
    assert.equal(result.recorded, false);
    const mapped = mapUnknownFailure(new Error('ERROR_PRIVATE_PROBE'), REQUEST_ID);
    assert.equal(mapped.status, 500);
    assert.equal(warnings.length, 1);
    assert.equal(errors.length, 1);
    const warning = JSON.parse(String(warnings[0][0]));
    const failure = JSON.parse(String(errors[0][0]));
    assert.equal(warning.level, 'WARN');
    assert.equal(warning.outcomeCode, 'counter_write_failed');
    assert.equal(failure.level, 'ERROR');
    assert.equal(failure.requestId, mapped.body.requestId);
    assert.doesNotMatch(JSON.stringify([warnings, errors]), /PRIVATE_PROBE/);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('unknown failure log and response share the same validated or generated requestId', () => {
  for (const input of [REQUEST_ID, 'invalid-private-request-id']) {
    const logs: Record<string, unknown>[] = [];
    const mapped = mapUnknownFailure(new Error('hidden'), input, (event) => logs.push(event));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].requestId, mapped.body.requestId);
    assert.match(mapped.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(logs).includes('invalid-private-request-id'), false);
  }
});

test('unknown internal failures use ERROR severity with an injected logger', () => {
  const logs: Record<string, unknown>[] = [];
  const mapped = mapUnknownFailure(new Error('hidden'), REQUEST_ID, (event) => logs.push(event));
  assert.equal(mapped.status, 500);
  assert.equal(logs[0].level, 'ERROR');
});
