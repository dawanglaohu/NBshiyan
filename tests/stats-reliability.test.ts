import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import { products } from '../src/data/products';
import { shiftLocalDate } from '../src/lib/analytics/aggregate-plan';
import { siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { ConversationReceivedDTOSchema, MessageReceivedDTOSchema } from '../src/lib/contracts/chat';
import {
  StatsApiErrorRateSchema,
  StatsDTOSchema,
  StatsSourceDTOSchema,
  type StatsDTO,
  type StatsNotificationBreakdownDTO,
  type StatsSource,
  type StatsSourceDTO,
} from '../src/lib/contracts/ops';
import { CHAT_NOTIFICATION_JOB_KEY } from '../src/lib/server/chat/notification-policy';
import { AppError } from '../src/lib/server/http/errors';
import { API_ROUTE_IDS } from '../src/lib/server/http/metrics';
import type { MailSendAdapter, OutboundMail, SendOutcome } from '../src/lib/server/mail/adapter';
import type { JobKey } from '../src/lib/contracts/ops';

const MAIL_QUEUE_KEY: JobKey = 'mail-queue';
import {
  computeApiErrorRate,
  createReliabilitySourceBundle,
  createReliabilitySourceReaders,
  HTTP_COVERAGE_SCOPE,
  NOTIFICATION_FRESHNESS_MS,
  preserveSourceSnapshotOnFailure,
  preserveStatsSnapshotOnFailure,
  RELIABILITY_SOURCES,
  type ReliabilityDb,
} from '../src/lib/server/ops/reliability-source';
import { toStatsSourceDTO } from '../src/lib/server/ops/source-dto';
import type {
  NonCoreSourceReadInput,
  StatsDb,
} from '../src/lib/server/ops/stats-service';

const ORIGIN = 'http://localhost:3000';
const REAL_PRODUCT_A = products[0].slug;
const REAL_PRODUCT_B = products[1].slug;

const SCOPE = {
  from: '2026-11-27',
  toExclusive: '2026-11-28',
  startUtc: '2026-11-27T00:00:00.000Z',
  endUtc: '2026-11-28T00:00:00.000Z',
  productSlug: undefined as string | undefined,
  timezone: 'UTC',
  timezoneRevision: 1,
};
const CONTEXT = { timezone: 'UTC', timezoneRevision: 1, queriedAt: '2026-11-27T12:00:00.000Z' };
const NOW = new Date('2026-11-27T12:00:00.000Z');

function readerInput(
  role: Role,
  overrides: Partial<NonCoreSourceReadInput> = {},
): NonCoreSourceReadInput {
  return {
    role,
    userId: `${role.toLowerCase()}-1`,
    scope: { ...SCOPE },
    context: { ...CONTEXT },
    now: NOW,
    connected: true,
    ...overrides,
  };
}

function findSource(dto: StatsDTO, source: StatsSource): StatsSourceDTO {
  const hit = dto.sources.find((item) => item.source === source);
  assert.ok(hit, `expected source ${source}`);
  return hit;
}

type FakeSqlCapture = {
  statements: string[];
  queries: string[];
};

function makeFakeReliabilityDb(options: {
  fail?: boolean;
  errorMessage?: string;
  apiSummary?: {
    requestCount: bigint;
    errorCount: bigint;
    rowCount: number;
    corrupt?: boolean;
    lastObservedAt: string | null;
  } | null;
  jobState?: {
    lastStatus: string;
    lastSucceededAt: string | null;
    lastFinishedAt: string | null;
  } | null;
  breakdown?: StatsNotificationBreakdownDTO;
} = {}): { db: ReliabilityDb; capture: FakeSqlCapture } {
  const capture: FakeSqlCapture = { statements: [], queries: [] };
  const tx = {
    async $executeRaw(strings: TemplateStringsArray) {
      capture.statements.push(strings.join('?'));
      if (options.fail) throw new Error(options.errorMessage ?? 'database unavailable');
      return 0;
    },
    async $queryRaw(strings: TemplateStringsArray | { strings?: readonly string[]; sql?: string }, ...values: unknown[]) {
      const renderSql = (part: unknown): string => {
        if (typeof part === 'string') return part;
        if (Array.isArray(part)) return part.map(renderSql).join('?');
        if (part && typeof part === 'object') {
          const obj = part as { sql?: unknown; strings?: readonly string[]; values?: readonly unknown[] };
          if (typeof obj.sql === 'string') return obj.sql;
          if (Array.isArray(obj.strings)) {
            return obj.strings.map((seg, i) => seg + (i < (obj.values?.length ?? 0) ? renderSql(obj.values![i]) : '')).join('');
          }
        }
        return '?';
      };
      const sqlText = Array.isArray(strings)
        ? strings.map((seg, i) => seg + (i < values.length ? renderSql(values[i]) : '')).join('')
        : renderSql(strings);
      capture.queries.push(sqlText);
      if (options.fail) throw new Error(options.errorMessage ?? 'database unavailable');
      if (sqlText.includes('"ApiDailyCounter"')) {
        if (options.apiSummary === null) return [];
        const item = options.apiSummary ?? {
          requestCount: 0n,
          errorCount: 0n,
          rowCount: 0,
          corrupt: false,
          lastObservedAt: null,
        };
        return [{ ...item, corrupt: item.corrupt ?? false }];
      }
      if (sqlText.includes('FROM "JobState"')) {
        return options.jobState ? [options.jobState] : [];
      }
      if (sqlText.includes('FROM "ChatNotification"') || sqlText.includes('FROM "MailMessage"')) {
        return [options.breakdown ?? { queued: 0, sending: 0, sent: 0, failed: 0, unknown: 0 }];
      }
      return [];
    },
  };
  const db = {
    async $transaction<T>(fn: (client: typeof tx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  } as unknown as ReliabilityDb;
  return { db, capture };
}

describe('M6-T5 reliability source adapters & pure contracts (no database)', () => {
  test('HTTP error rate & coverage scope strictly limit to instrumented routes, null without denominator, never full site-wide (AC1, E-64)', () => {
    // Schema rejects site-wide 'full' coverage or arbitrary scope labels
    assert.throws(() => StatsApiErrorRateSchema.parse({
      value: 0.1,
      coverage: 'full',
      scope: 'instrumented_routes',
    }));
    assert.throws(() => StatsApiErrorRateSchema.parse({
      value: 0.1,
      coverage: 'partial',
      scope: 'site_wide',
    }));
    assert.throws(() => StatsApiErrorRateSchema.parse({
      value: 0,
      coverage: 'unavailable',
      scope: 'instrumented_routes',
    }));

    const observed = new Date('2026-11-27T11:55:00.000Z');
    const reqOk = toStatsSourceDTO(CONTEXT, 'api_requests', {
      value: 20,
      coverage: 'partial',
      dataThrough: observed,
      lastSucceededAt: observed,
    });
    const errZero = toStatsSourceDTO(CONTEXT, 'api_errors', {
      value: 0,
      coverage: 'partial',
      dataThrough: observed,
      lastSucceededAt: observed,
    });
    const errFive = toStatsSourceDTO(CONTEXT, 'api_errors', {
      value: 5,
      coverage: 'partial',
      dataThrough: observed,
      lastSucceededAt: observed,
    });
    const reqNoData = toStatsSourceDTO(CONTEXT, 'api_requests');
    const errNoData = toStatsSourceDTO(CONTEXT, 'api_errors');
    const reqDisconnected = toStatsSourceDTO(CONTEXT, 'api_requests', { unavailableState: 'not_connected' });
    const errDisconnected = toStatsSourceDTO(CONTEXT, 'api_errors', { unavailableState: 'not_connected' });

    // Unpaired -> null
    assert.equal(computeApiErrorRate([reqOk]), null);
    assert.equal(computeApiErrorRate([errFive]), null);

    // Absent denominator / not_connected -> value: null, coverage: 'unavailable'
    assert.deepEqual(computeApiErrorRate([reqNoData, errNoData]), {
      value: null,
      coverage: 'unavailable',
      scope: HTTP_COVERAGE_SCOPE,
    });
    assert.deepEqual(computeApiErrorRate([reqDisconnected, errDisconnected]), {
      value: null,
      coverage: 'unavailable',
      scope: HTTP_COVERAGE_SCOPE,
    });

    // Real denominator with 0 5xx errors -> 0 (not null) and partial instrumented coverage
    assert.deepEqual(computeApiErrorRate([reqOk, errZero]), {
      value: 0,
      coverage: 'partial',
      scope: 'instrumented_routes',
    });

    // Real denominator with 5xx errors -> exact errorCount / requestCount
    assert.deepEqual(computeApiErrorRate([reqOk, errFive]), {
      value: 0.25,
      coverage: 'partial',
      scope: 'instrumented_routes',
    });
  });

  test('HTTP readers enforce ADMIN role, not_connected, productSlug/future no_data, READ ONLY tx, and exact 9-key StatsSourceDTO (AC1, E-64, E-66)', async () => {
    const { db: untouchedDb, capture: untouchedCapture } = makeFakeReliabilityDb();
    const guardReaders = createReliabilitySourceReaders({ db: untouchedDb });

    for (const role of ['SALES', 'EDITOR'] as const) {
      for (const source of ['api_requests', 'api_errors'] as const) {
        await assert.rejects(
          () => Promise.resolve(guardReaders[source](readerInput(role))),
          (err) => err instanceof AppError && err.code === 'forbidden',
        );
      }
    }
    assert.equal(untouchedCapture.queries.length, 0);

    // Disconnected HTTP producer -> not_connected
    const disconnectedReaders = createReliabilitySourceReaders({
      db: untouchedDb,
      httpConnected: () => false,
    });
    const discReq = await disconnectedReaders.api_requests(readerInput('ADMIN'));
    const discErr = await disconnectedReaders.api_errors(readerInput('ADMIN'));
    assert.deepEqual([discReq.state, discReq.value, discReq.coverage], ['not_connected', null, 'unavailable']);
    assert.deepEqual([discErr.state, discErr.value, discErr.coverage], ['not_connected', null, 'unavailable']);

    // Product dimension or future date window -> no_data with null value
    const prodDto = await guardReaders.api_requests(readerInput('ADMIN', {
      scope: { ...SCOPE, productSlug: REAL_PRODUCT_A },
    }));
    assert.deepEqual([prodDto.state, prodDto.value, prodDto.coverage], ['no_data', null, 'unavailable']);
    const futureDto = await guardReaders.api_errors(readerInput('ADMIN', {
      scope: {
        ...SCOPE,
        from: '2026-11-29',
        toExclusive: '2026-11-30',
        startUtc: '2026-11-29T00:00:00.000Z',
        endUtc: '2026-11-30T00:00:00.000Z',
      },
    }));
    assert.deepEqual([futureDto.state, futureDto.value, futureDto.coverage], ['no_data', null, 'unavailable']);

    // Zero counter rows -> no_data (absent denominator yields null, not fake 0)
    const emptyReq = await guardReaders.api_requests(readerInput('ADMIN'));
    const emptyErr = await guardReaders.api_errors(readerInput('ADMIN'));
    assert.deepEqual([emptyReq.state, emptyReq.value, emptyReq.lastSucceededAt], ['no_data', null, null]);
    assert.deepEqual([emptyErr.state, emptyErr.value, emptyErr.lastSucceededAt], ['no_data', null, null]);

    // Real observed counts -> partial coverage (instrumented routes only), READ ONLY tx, exact 9 keys
    const { db: activeDb, capture } = makeFakeReliabilityDb({
      apiSummary: {
        requestCount: 12n,
        errorCount: 3n,
        rowCount: 2,
        lastObservedAt: '2026-11-27T11:42:00.000Z',
      },
    });
    const activeReaders = createReliabilitySourceReaders({ db: activeDb });
    const reqDto = await activeReaders.api_requests(readerInput('ADMIN'));
    const errDto = await activeReaders.api_errors(readerInput('ADMIN'));
    assert.deepEqual([reqDto.state, reqDto.value, reqDto.coverage], ['ok', 12, 'partial']);
    assert.deepEqual([errDto.state, errDto.value, errDto.coverage], ['ok', 3, 'partial']);
    assert.equal(reqDto.lastSucceededAt, '2026-11-27T11:42:00.000Z');
    assert.equal(reqDto.dataThrough, '2026-11-27T11:42:00.000Z');
    assert.ok(capture.statements.every((stmt) => stmt.includes('SET TRANSACTION READ ONLY')));
    for (const dto of [reqDto, errDto]) {
      assert.deepEqual(StatsSourceDTOSchema.parse(dto), dto);
      assert.deepEqual(Object.keys(dto).sort(), [
        'coverage', 'dataThrough', 'lastSucceededAt', 'queriedAt', 'source', 'state', 'timezone', 'timezoneRevision', 'value',
      ]);
    }

    // Corrupt row (errorCount > requestCount) -> fails closed to query_failed
    const { db: corruptDb } = makeFakeReliabilityDb({
      apiSummary: {
        requestCount: 2n,
        errorCount: 5n,
        rowCount: 1,
        corrupt: true,
        lastObservedAt: '2026-11-27T11:42:00.000Z',
      },
    });
    const corruptDto = await createReliabilitySourceReaders({ db: corruptDb }).api_errors(readerInput('ADMIN'));
    assert.deepEqual([corruptDto.state, corruptDto.value], ['query_failed', null]);
  });

  test('mail and chat_notifications readers enforce role matrix, connection/JobState gates, and 5-minute freshness (AC2, E-64, E-66)', async () => {
    const { db: emptyDb, capture } = makeFakeReliabilityDb();
    const emptyReaders = createReliabilitySourceReaders({
      db: emptyDb,
      chatNotificationConfigured: () => true,
      mailConfigured: () => true,
    });

    // Role checks happen before DB queries
    await assert.rejects(
      () => Promise.resolve(emptyReaders.mail(readerInput('SALES'))),
      (err) => err instanceof AppError && err.code === 'forbidden',
    );
    await assert.rejects(
      () => Promise.resolve(emptyReaders.mail(readerInput('EDITOR'))),
      (err) => err instanceof AppError && err.code === 'forbidden',
    );
    await assert.rejects(
      () => Promise.resolve(emptyReaders.chat_notifications(readerInput('EDITOR'))),
      (err) => err instanceof AppError && err.code === 'forbidden',
    );
    assert.equal(capture.queries.length, 0);

    // Missing JobState or NEVER status -> not_connected even if env is configured
    assert.equal((await emptyReaders.chat_notifications(readerInput('SALES'))).state, 'not_connected');
    assert.equal((await emptyReaders.mail(readerInput('ADMIN'))).state, 'not_connected');

    // Job ran SUCCEEDED on empty config with 0 real attempts -> remains not_connected (no fake healthy 0)
    const { db: unconfiguredCronDb } = makeFakeReliabilityDb({
      jobState: {
        lastStatus: 'SUCCEEDED',
        lastSucceededAt: '2026-11-27T11:59:00.000Z',
        lastFinishedAt: '2026-11-27T11:59:00.000Z',
      },
      breakdown: { queued: 2, sending: 0, sent: 0, failed: 0, unknown: 0 },
    });
    const unconfiguredReaders = createReliabilitySourceReaders({
      db: unconfiguredCronDb,
      chatNotificationConfigured: () => false,
      mailConfigured: () => false,
    });
    assert.equal((await unconfiguredReaders.chat_notifications(readerInput('ADMIN'))).state, 'not_connected');
    assert.equal((await unconfiguredReaders.mail(readerInput('ADMIN'))).state, 'not_connected');

    // Job FAILED without any prior success -> query_failed with null value (E-52)
    const { db: neverSucceededFailDb } = makeFakeReliabilityDb({
      jobState: {
        lastStatus: 'FAILED',
        lastSucceededAt: null,
        lastFinishedAt: '2026-11-27T11:59:00.000Z',
      },
    });
    const failReaders = createReliabilitySourceReaders({
      db: neverSucceededFailDb,
      chatNotificationConfigured: () => true,
      mailConfigured: () => true,
    });
    const failedMail = await failReaders.mail(readerInput('ADMIN'));
    assert.deepEqual([failedMail.state, failedMail.value, failedMail.lastSucceededAt], ['query_failed', null, null]);

    // Fresh (<5m) vs stale (>=5m) vs subsequent FAILED run preserving original lastSucceededAt (E-51)
    const freshSuccess = '2026-11-27T11:56:00.000Z';
    const { db: freshDb } = makeFakeReliabilityDb({
      jobState: { lastStatus: 'SUCCEEDED', lastSucceededAt: freshSuccess, lastFinishedAt: freshSuccess },
      breakdown: { queued: 3, sending: 1, sent: 2, failed: 1, unknown: 1 },
    });
    const freshBundle = createReliabilitySourceBundle({
      db: freshDb,
      chatNotificationConfigured: () => true,
      mailConfigured: () => true,
    });
    const freshOut = await freshBundle.detailedReaders.chat_notifications(readerInput('SALES'));
    assert.deepEqual([freshOut.dto.state, freshOut.dto.value, freshOut.dto.coverage], ['ok', 2, 'full']);
    assert.equal(freshOut.dto.lastSucceededAt, freshSuccess);
    assert.deepEqual(freshOut.notificationBreakdown, { queued: 3, sending: 1, sent: 2, failed: 1, unknown: 1 });

    // Exactly at 5-minute threshold -> stale, keeping original lastSucceededAt
    const staleAtBoundary = new Date(NOW.getTime() - NOTIFICATION_FRESHNESS_MS).toISOString();
    const { db: staleDb } = makeFakeReliabilityDb({
      jobState: { lastStatus: 'SUCCEEDED', lastSucceededAt: staleAtBoundary, lastFinishedAt: staleAtBoundary },
      breakdown: { queued: 1, sending: 0, sent: 4, failed: 0, unknown: 0 },
    });
    const staleDto = await createReliabilitySourceReaders({
      db: staleDb,
      mailConfigured: () => true,
    }).mail(readerInput('ADMIN'));
    assert.deepEqual([staleDto.state, staleDto.value, staleDto.coverage], ['stale', 4, 'partial']);
    assert.equal(staleDto.lastSucceededAt, staleAtBoundary);
    assert.notEqual(staleDto.lastSucceededAt, CONTEXT.queriedAt);
  });

  test('mail and chat_notifications SQL filters count only real SMTP-accepted deliveries and real attempt outcomes, excluding queued/received (AC2, E-64)', async () => {
    const { db, capture } = makeFakeReliabilityDb({
      jobState: {
        lastStatus: 'SUCCEEDED',
        lastSucceededAt: '2026-11-27T11:59:00.000Z',
        lastFinishedAt: '2026-11-27T11:59:00.000Z',
      },
      breakdown: { queued: 5, sending: 2, sent: 0, failed: 3, unknown: 1 },
    });
    const bundle = createReliabilitySourceBundle({
      db,
      chatNotificationConfigured: () => true,
      mailConfigured: () => true,
    });

    const chatRes = await bundle.detailedReaders.chat_notifications(
      readerInput('ADMIN', { scope: { ...SCOPE, productSlug: REAL_PRODUCT_A } }),
    );
    const mailRes = await bundle.detailedReaders.mail(
      readerInput('ADMIN', { scope: { ...SCOPE, productSlug: REAL_PRODUCT_A } }),
    );

    // Queued (5), sending (2), failed (3), unknown (1) never inflate delivered value (0 -> state 'zero')
    assert.deepEqual([chatRes.dto.state, chatRes.dto.value], ['zero', 0]);
    assert.deepEqual([mailRes.dto.state, mailRes.dto.value], ['zero', 0]);

    const chatSql = capture.queries.find((q) => q.includes('FROM "ChatNotification"')) ?? '';
    assert.match(chatSql, /"status" = 'SENT'::"ChatNotificationStatus"/);
    assert.match(chatSql, /"attempts" > 0/);
    assert.match(chatSql, /"requestStartedAt" IS NOT NULL/);
    assert.match(chatSql, /INNER JOIN "ChatConversation"/);

    const mailSql = capture.queries.find((q) => q.includes('FROM "MailMessage"')) ?? '';
    assert.match(mailSql, /"direction" = 'OUTBOUND'::"MailDirection"/);
    assert.match(mailSql, /"errorCode" = 'unknown_delivery'/);
    assert.match(mailSql, /"errorCode" <> 'unknown_delivery'/);
    assert.match(mailSql, /EXISTS \(\s*SELECT 1 FROM "InquiryItem"/);
    // Must never select personal columns
    for (const forbiddenCol of ['fromAddr', 'toAddr', 'bodyText', 'bodyHtml', 'subject', 'stableMessageId']) {
      assert.equal(mailSql.includes(forbiddenCol), false);
      assert.equal(chatSql.includes(forbiddenCol), false);
    }
  });

  test('E-51 / E-52 / E-53 / E-67: query failure preserves prior value & lastSucceededAt when same-key snapshot exists, or sanitized null failure without snapshot, isolating healthy sources', async () => {
    const settingsDb = {
      async $transaction<T>(fn: (tx: { $queryRaw: () => Promise<unknown[]> }) => Promise<T>): Promise<T> {
        return fn({ $queryRaw: async () => [] });
      },
    } as unknown as StatsDb;

    let failMail = false;
    const t1 = new Date('2026-11-27T11:58:00.000Z');
    const t2 = new Date('2026-11-27T12:00:00.000Z');
    let currentNow = t1;

    const healthyHttpDb = makeFakeReliabilityDb({
      apiSummary: {
        requestCount: 10n,
        errorCount: 1n,
        rowCount: 1,
        lastObservedAt: '2026-11-27T11:57:00.000Z',
      },
    }).db;
    const healthyChatDb = makeFakeReliabilityDb({
      jobState: {
        lastStatus: 'SUCCEEDED',
        lastSucceededAt: '2026-11-27T11:57:30.000Z',
        lastFinishedAt: '2026-11-27T11:57:30.000Z',
      },
      breakdown: { queued: 0, sending: 0, sent: 3, failed: 1, unknown: 0 },
    }).db;

    const healthyMailDb = makeFakeReliabilityDb({
      jobState: {
        lastStatus: 'SUCCEEDED',
        lastSucceededAt: '2026-11-27T11:57:00.000Z',
        lastFinishedAt: '2026-11-27T11:57:00.000Z',
      },
      breakdown: { queued: 1, sending: 0, sent: 2, failed: 1, unknown: 1 },
    }).db;
    const failingMailDb = makeFakeReliabilityDb({
      fail: true,
      errorMessage: 'FATAL: password authentication failed for postgresql://ops:super-secret-pw@10.9.8.7:5432/prod',
    }).db;
    const dynamicMailDb = new Proxy(healthyMailDb, {
      get(_target, prop, receiver) {
        const active = failMail ? failingMailDb : healthyMailDb;
        return Reflect.get(active, prop, receiver);
      },
    });

    const httpBundle = createReliabilitySourceBundle({ db: healthyHttpDb });
    const chatBundle = createReliabilitySourceBundle({ db: healthyChatDb, chatNotificationConfigured: () => true });
    const mailBundle = createReliabilitySourceBundle({ db: dynamicMailDb, mailConfigured: () => true });

    const { createStatsService } = await import('../src/lib/server/ops/stats-service');
    const service = createStatsService({
      db: settingsDb,
      clock: () => currentNow,
      nonCoreReaders: {
        api_requests: httpBundle.readers.api_requests,
        api_errors: httpBundle.readers.api_errors,
        chat_notifications: chatBundle.readers.chat_notifications,
        mail: mailBundle.readers.mail,
      },
      detailedNonCoreReaders: {
        api_requests: httpBundle.detailedReaders.api_requests,
        api_errors: httpBundle.detailedReaders.api_errors,
        chat_notifications: chatBundle.detailedReaders.chat_notifications,
        mail: mailBundle.detailedReaders.mail,
      },
    });

    const query = { from: '2026-11-27', to: '2026-11-27', sources: [...RELIABILITY_SOURCES] };
    const first = await service.query({ role: 'ADMIN', userId: 'admin-1', query });
    assert.equal(findSource(first.dto, 'mail').state, 'ok');
    assert.equal(findSource(first.dto, 'mail').value, 2);
    assert.equal(findSource(first.dto, 'mail').lastSucceededAt, '2026-11-27T11:57:00.000Z');

    // E-52: Mail fails WITHOUT prior snapshot -> value=null, no leaked credentials, other sources succeed
    failMail = true;
    currentNow = t2;
    const failedNoSnap = await service.query({ role: 'ADMIN', userId: 'admin-1', query });
    const mailNoSnap = findSource(failedNoSnap.dto, 'mail');
    assert.deepEqual(
      [mailNoSnap.state, mailNoSnap.value, mailNoSnap.lastSucceededAt, mailNoSnap.coverage],
      ['query_failed', null, null, 'unavailable'],
    );
    assert.equal(failedNoSnap.dto.notificationCounts?.mail, null);
    assert.equal(JSON.stringify(failedNoSnap.dto).includes('super-secret-pw'), false);
    assert.equal(JSON.stringify(failedNoSnap.dto).includes('10.9.8.7'), false);
    // Sibling sources remain healthy with their own independent timestamps (E-53, E-67)
    assert.equal(findSource(failedNoSnap.dto, 'api_requests').value, 10);
    assert.equal(findSource(failedNoSnap.dto, 'chat_notifications').value, 3);
    assert.deepEqual(failedNoSnap.dto.apiErrorRate, { value: 0.1, coverage: 'partial', scope: 'instrumented_routes' });

    // E-51: Mail fails WITH same-query-key prior snapshot -> retains prior value (2) & original lastSucceededAt
    const failedWithSnap = await service.query({
      role: 'ADMIN',
      userId: 'admin-1',
      query,
      previousSnapshot: { dto: first.dto, query },
    });
    const mailWithSnap = findSource(failedWithSnap.dto, 'mail');
    assert.deepEqual(
      [mailWithSnap.state, mailWithSnap.value, mailWithSnap.lastSucceededAt, mailWithSnap.coverage],
      ['query_failed', 2, '2026-11-27T11:57:00.000Z', 'partial'],
    );
    assert.equal(mailWithSnap.queriedAt, t2.toISOString());
    assert.notEqual(mailWithSnap.lastSucceededAt, mailWithSnap.queriedAt);
    assert.deepEqual(failedWithSnap.dto.notificationCounts?.mail, {
      queued: 1,
      sending: 0,
      sent: 2,
      failed: 1,
      unknown: 1,
    });

    // Different query scope must NOT reuse stale snapshot from another date range
    const differentScope = await service.query({
      role: 'ADMIN',
      userId: 'admin-1',
      query: { from: '2026-11-26', to: '2026-11-26', sources: [...RELIABILITY_SOURCES] },
      previousSnapshot: { dto: first.dto, query },
    });
    assert.equal(findSource(differentScope.dto, 'mail').value, null);

    // Pure helper also preserves a legitimate zero snapshot on failure
    const zeroSnap = toStatsSourceDTO(CONTEXT, 'mail', {
      value: 0,
      coverage: 'full',
      dataThrough: t1,
      lastSucceededAt: t1,
    });
    const rawFailed = toStatsSourceDTO({ ...CONTEXT, queriedAt: t2.toISOString() }, 'mail', {
      unavailableState: 'query_failed',
    });
    const mergedZero = preserveSourceSnapshotOnFailure(rawFailed, zeroSnap);
    assert.deepEqual([mergedZero.state, mergedZero.value, mergedZero.lastSucceededAt], ['query_failed', 0, t1.toISOString()]);
    const mergedFullDto = preserveStatsSnapshotOnFailure(failedNoSnap.dto, first.dto, { sameQueryKey: true });
    assert.equal(findSource(mergedFullDto, 'mail').value, 2);
  });

  test('StatsDTOSchema backward compatibility and strict RBAC source pairing for apiErrorRate and notificationCounts', () => {
    const visitor = toStatsSourceDTO(CONTEXT, 'visitors', {
      value: 4,
      coverage: 'full',
      dataThrough: NOW,
      lastSucceededAt: NOW,
    });
    // Legacy { sources } payload remains valid
    const legacy = StatsDTOSchema.parse({ sources: [visitor] });
    assert.equal('apiErrorRate' in legacy, false);
    assert.equal('notificationCounts' in legacy, false);

    // Non-null apiErrorRate without paired api_requests + api_errors is rejected
    assert.throws(() => StatsDTOSchema.parse({
      sources: [visitor],
      apiErrorRate: { value: 0.1, coverage: 'partial', scope: 'instrumented_routes' },
    }));

    // Null apiErrorRate when both api_requests and api_errors are present is rejected
    const apiReq = toStatsSourceDTO(CONTEXT, 'api_requests');
    const apiErr = toStatsSourceDTO(CONTEXT, 'api_errors');
    assert.throws(() => StatsDTOSchema.parse({
      sources: [apiReq, apiErr],
      apiErrorRate: null,
    }));

    // Hidden mail breakdown when mail is not in sources (e.g. SALES) is rejected
    const chatNotif = toStatsSourceDTO(CONTEXT, 'chat_notifications');
    assert.throws(() => StatsDTOSchema.parse({
      sources: [chatNotif],
      notificationCounts: {
        chat_notifications: null,
        mail: { queued: 0, sending: 0, sent: 0, failed: 0, unknown: 0 },
      },
    }));
  });

  test('one-way module boundary: M3 http/admin, M4 chat/mail, and M5 analytics/jobs never import M6 ops', () => {
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

    const producerFiles = [
      ...collectTsFiles('src/lib/server/http'),
      ...collectTsFiles('src/lib/server/admin'),
      ...collectTsFiles('src/lib/server/chat'),
      ...collectTsFiles('src/lib/server/mail'),
      ...collectTsFiles('src/lib/server/analytics'),
      ...collectTsFiles('src/lib/server/jobs'),
    ];
    assert.ok(producerFiles.length > 0);
    assert.equal(API_ROUTE_IDS.includes('GET /api/admin/stats'), true);

    const m6Roots = [
      path.resolve(process.cwd(), 'src/lib/server/ops'),
      path.resolve(process.cwd(), 'src/lib/client/ops'),
      path.resolve(process.cwd(), 'src/components/admin/stats'),
      path.resolve(process.cwd(), 'src/app/admin/stats'),
      path.resolve(process.cwd(), 'src/app/api/admin/stats'),
    ];
    for (const file of producerFiles) {
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

  test('CI workflow registers m6t5_reliability_test dedicated DB, exact 14-test gate, and 263/232 E2E collection check', () => {
    const workflow = readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    assert.ok(workflow.includes('CREATE DATABASE "m6t5_reliability_test"'), 'CI must provision dedicated m6t5_reliability_test DB');
    assert.match(workflow, /M6T5_TEST_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@localhost:5432\/m6t5_reliability_test\s/);
    assert.match(workflow, /M6T5_REQUIRE_DATABASE:\s*'true'/);
    assert.ok(
      workflow.includes("tests/stats-reliability.test.ts\\tpass=14\\tfail=0\\tskip=0\\ttodo=0\\tcancelled=0"),
      'CI must enforce exact pass=14 gate for tests/stats-reliability.test.ts',
    );
    assert.ok(workflow.includes('stats-reliability-api.spec.ts'), 'CI must verify stats-reliability-api.spec.ts in A3 main collection');
    assert.ok(workflow.includes('{ all: 263, main: 232, model: 14, consent: 14, errors: 2, flow: 1 }'));
  });
});

const databaseUrl = process.env.M6T5_TEST_DATABASE_URL ? new URL(process.env.M6T5_TEST_DATABASE_URL) : null;
if (
  databaseUrl
  && (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname))
) {
  throw new Error('M6T5_TEST_DATABASE_URL must point to a dedicated loopback PostgreSQL database');
}
if (!databaseUrl && process.env.M6T5_REQUIRE_DATABASE === 'true') {
  throw new Error('M6T5_TEST_DATABASE_URL is required when M6T5_REQUIRE_DATABASE=true');
}

describe('M6-T5 reliability sources over real HTTP routes & notification jobs (PostgreSQL + Auth.js)', {
  concurrency: false,
  skip: !databaseUrl && 'no dedicated M6T5_TEST_DATABASE_URL',
  timeout: 300_000,
}, () => {
  const schema = `m6t5_${randomBytes(6).toString('hex')}`;
  const savedEnv: Record<string, string | undefined> = {};
  let owner: PrismaClient;
  let db: PrismaClient;
  let appDb: PrismaClient;
  let schemaCreated = false;

  let authRoute: typeof import('../src/app/api/auth/[...nextauth]/route');
  let statsRoute: typeof import('../src/app/api/admin/stats/route');
  let settingsRoute: typeof import('../src/app/api/admin/settings/analytics/route');
  let submitInquiry: typeof import('../src/app/api/inquiries/route').POST;
  let startVisitor: typeof import('../src/app/api/chat/session/route').POST;
  let createConversation: typeof import('../src/app/api/chat/conversations/route').POST;
  let appendMessage: typeof import('../src/app/api/chat/conversations/[id]/messages/route').POST;
  let mailQueueRoute: typeof import('../src/app/api/admin/cron/mail-queue/route');
  let composition: typeof import('../src/lib/server/composition');
  let statsMod: typeof import('../src/lib/server/ops/stats-service');
  let createOperationsHandler: typeof import('../src/lib/server/jobs/registry').createOperationsHandler;
  let reserveAndStart: typeof import('../src/lib/server/mail/send').reserveAndStart;
  let setStore: (store: unknown) => void;
  let MemoryStoreCtor: new () => unknown;
  let hashSecret: typeof import('../src/lib/server/admin/crypto').hashSecret;
  let encrypt: typeof import('../src/lib/server/admin/crypto').encrypt;

  type Operator = { userId: string; cookie: string };
  let admin: Operator;
  let sales: Operator;
  let editor: Operator;

  const CRON_SECRET = 'm6t5-test-cron-secret-0123456789abcdef-isolated';
  const ENV: Record<string, string> = {
    AUTH_SECRET: 'm6t5-test-auth-secret-0123456789abcdef',
    EDGE_AUTH_SECRET: 'm6t5-test-edge-secret-0123456789abcdef',
    ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'),
    PRIVACY_HASH_SECRET: 'm6t5-test-privacy-hash-secret-0123456789abcdef',
    CRON_SECRET,
    NEXT_PUBLIC_SITE_URL: 'https://packjoyu-m6t5.example.test',
    AUTH_URL: ORIGIN,
    APP_ORIGIN: ORIGIN,
    RATE_LIMIT_STORE: 'memory',
    APP_ENV: 'test',
    SMTP_HOST: 'smtp.m6t5.example.test',
    SMTP_PORT: '465',
    SMTP_USER: 'mailer@m6t5.example.test',
    SMTP_PASS: 'm6t5-synthetic-smtp-pass',
    MAIL_FROM: 'PackJoyU <mailer@m6t5.example.test>',
    REPLY_DOMAIN: 'reply.m6t5.example.test',
    CHAT_NOTIFICATION_TO: 'ops-notify@m6t5.example.test',
    NEXT_PUBLIC_ADMIN_MAIL: 'http',
  };
  const CLEAR_ENV = ['INQUIRY_NOTIFY_EMAIL', 'TURNSTILE_SECRET_KEY', 'ADMIN_ALERT_EMAIL', 'MAIL_SEND_ADAPTER'];

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

  function makeRequest(
    urlPath: string,
    init: { cookie?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {},
  ) {
    return new Request(ORIGIN + urlPath, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        cookie: init.cookie ?? '',
        origin: ORIGIN,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async function seedOperator(role: Role): Promise<Operator> {
    const password = 'm6t5-isolated-operator-password!';
    const secret = authenticator.generateSecret();
    const user = await db.user.create({
      data: {
        email: `m6t5-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@example.test`,
        name: `M6T5 ${role}`,
        role,
        passwordHash: await hashSecret(password),
        totpEnabled: true,
        totpSecret: encrypt(secret),
      },
    });
    const csrf = await authRoute.GET(makeRequest('/api/auth/csrf'));
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const jar = cookies(csrf);
    const login = await authRoute.POST(new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { cookie: jar, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: user.email,
        password,
        csrfToken,
        totp: authenticator.generate(secret),
      }),
    }));
    const cookie = cookies(login, jar);
    assert.match(cookie, /authjs\.session-token=[^;]+/);
    return { userId: user.id, cookie };
  }

  async function newVisitorCookie(): Promise<string> {
    const res = await startVisitor(makeRequest('/api/chat/session', { body: { locale: 'en' } }));
    assert.equal(res.status, 200);
    const jar = cookies(res);
    assert.match(jar, /pj_chat=[^;]+/);
    return jar;
  }

  before(async () => {
    const targetUrl = new URL(databaseUrl!.toString());
    targetUrl.searchParams.set('schema', schema);

    for (const key of [...Object.keys(ENV), ...CLEAR_ENV, 'DATABASE_URL']) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, ENV, { DATABASE_URL: targetUrl.toString() });
    for (const key of CLEAR_ENV) delete process.env[key];

    owner = new PrismaClient({ datasources: { db: { url: databaseUrl!.toString() } } });
    await owner.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    schemaCreated = true;

    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: targetUrl.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    db = new PrismaClient({ datasources: { db: { url: targetUrl.toString() } } });
    appDb = new PrismaClient({ datasources: { db: { url: targetUrl.toString() } } });
    (globalThis as unknown as { prisma?: PrismaClient }).prisma = appDb;
    await import('../src/lib/server/db');

    const rlMod = await import('../src/lib/server/ratelimit');
    setStore = rlMod.setRateLimitStore as (store: unknown) => void;
    MemoryStoreCtor = rlMod.MemoryStore as new () => unknown;
    setStore(new MemoryStoreCtor());

    const cryptoMod = await import('../src/lib/server/admin/crypto');
    hashSecret = cryptoMod.hashSecret;
    encrypt = cryptoMod.encrypt;

    authRoute = await import('../src/app/api/auth/[...nextauth]/route');
    statsRoute = await import('../src/app/api/admin/stats/route');
    settingsRoute = await import('../src/app/api/admin/settings/analytics/route');
    submitInquiry = (await import('../src/app/api/inquiries/route')).POST;
    startVisitor = (await import('../src/app/api/chat/session/route')).POST;
    createConversation = (await import('../src/app/api/chat/conversations/route')).POST;
    appendMessage = (await import('../src/app/api/chat/conversations/[id]/messages/route')).POST;
    mailQueueRoute = await import('../src/app/api/admin/cron/mail-queue/route');
    composition = await import('../src/lib/server/composition');
    statsMod = await import('../src/lib/server/ops/stats-service');
    ({ createOperationsHandler } = await import('../src/lib/server/jobs/registry'));
    reserveAndStart = (await import('../src/lib/server/mail/send')).reserveAndStart;
  });

  beforeEach(async () => {
    setStore(new MemoryStoreCtor());
    Object.assign(process.env, ENV);
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE
        "ChatNotification",
        "ChatReadCursor",
        "ChatMessage",
        "ChatConversation",
        "ChatVisitorSession",
        "MailMessage",
        "InquiryItem",
        "Inquiry",
        "Contact",
        "ApiDailyCounter",
        "OpsSourceSnapshot",
        "AnalyticsDaily",
        "AnalyticsAggregateDayState",
        "AnalyticsDayChange",
        "AnalyticsEvent",
        "JobState",
        "SiteSetting",
        "AuditLog",
        "AdminActionGrant",
        "AdminRecoveryPermit",
        "AdminRecoverySession",
        "AdminDeviceSession",
        "User"
      RESTART IDENTITY CASCADE
    `);
    admin = await seedOperator('ADMIN');
    sales = await seedOperator('SALES');
    editor = await seedOperator('EDITOR');
  });

  after(async () => {
    await db?.$disconnect();
    await appDb?.$disconnect();
    if (schemaCreated) {
      await owner?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await owner?.$disconnect();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('AC1 / E-64: real instrumented 2xx, 4xx, and 5xx HTTP responses populate ApiDailyCounter; uninstrumented routes excluded; 0 denominator yields null; disconnected yields not_connected', async () => {
    const today = siteLocalDate(new Date(), 'UTC');
    const yesterday = shiftLocalDate(today, -1);

    // 1. Day with zero instrumented requests -> no_data (value: null) and apiErrorRate.value === null
    const emptyDayRes = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${yesterday}&to=${yesterday}&sources=api_requests,api_errors`, {
        cookie: admin.cookie,
      }),
    );
    assert.equal(emptyDayRes.status, 200);
    const emptyDayDto = StatsDTOSchema.parse(await emptyDayRes.json());
    assert.deepEqual(findSource(emptyDayDto, 'api_requests').value, null);
    assert.equal(findSource(emptyDayDto, 'api_requests').state, 'no_data');
    assert.equal(findSource(emptyDayDto, 'api_errors').value, null);
    assert.equal(findSource(emptyDayDto, 'api_errors').state, 'no_data');
    assert.deepEqual(emptyDayDto.apiErrorRate, {
      value: null,
      coverage: 'unavailable',
      scope: 'instrumented_routes',
    });

    // 2. Disconnected HTTP producer -> not_connected
    const discBundle = createReliabilitySourceBundle({ db: appDb, httpConnected: () => false });
    const discStats = statsMod.createStatsService({
      db: appDb,
      nonCoreReaders: discBundle.readers,
      detailedNonCoreReaders: discBundle.detailedReaders,
    });
    const httpServices = composition.createHttpServices({ db: appDb });
    const discRes = await statsMod.handleGetStats(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=api_requests,api_errors`),
      { user: { id: admin.userId, role: 'ADMIN' } },
      { stats: discStats, apiCounter: httpServices.apiCounter },
    );
    const discDto = StatsDTOSchema.parse(await discRes.json());
    assert.equal(findSource(discDto, 'api_requests').state, 'not_connected');
    assert.equal(findSource(discDto, 'api_errors').state, 'not_connected');
    assert.deepEqual(discDto.apiErrorRate, {
      value: null,
      coverage: 'unavailable',
      scope: 'instrumented_routes',
    });

    // Clear counters so we measure an exact known sequence of real instrumented vs uninstrumented calls
    await db.apiDailyCounter.deleteMany();

    // 3. Instrumented 2xx calls: settings GET (1), chat session POST (2), chat conversation POST (3)
    assert.equal((await settingsRoute.GET(makeRequest('/api/admin/settings/analytics', { cookie: admin.cookie }))).status, 200);
    const visitorCookie = await newVisitorCookie();
    const convRes = await createConversation(makeRequest('/api/chat/conversations', {
      cookie: visitorCookie,
      body: {
        clientConversationId: randomUUID(),
        clientMessageId: randomUUID(),
        locale: 'en',
        bodyText: 'Instrumented 2xx check',
      },
    }));
    assert.equal(convRes.status, 200);

    // 4. Instrumented 4xx call: invalid query on GET /api/admin/stats -> 400 (increments requestCount, NOT errorCount)
    const badStats = await statsRoute.GET(makeRequest('/api/admin/stats?unknownParam=1', { cookie: admin.cookie }));
    assert.equal(badStats.status, 400);

    // 5. Uninstrumented legacy route: POST /api/inquiries -> 201 (must NOT enter ApiDailyCounter)
    const uninstrumentedInq = await submitInquiry(makeRequest('/api/inquiries', {
      body: {
        source: 'FORM',
        locale: 'en',
        message: 'Legacy uninstrumented route',
        contact: { name: 'Buyer', email: 'buyer@m6t5.example.test', region: 'DE' },
      },
    }));
    assert.equal(uninstrumentedInq.status, 201);

    // Verify 4 instrumented requests & 0 5xx errors before any 5xx occurs
    const zeroErrRes = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=api_requests,api_errors`, {
        cookie: admin.cookie,
      }),
    );
    assert.equal(zeroErrRes.status, 200);
    const zeroErrDto = StatsDTOSchema.parse(await zeroErrRes.json());
    assert.deepEqual(
      [findSource(zeroErrDto, 'api_requests').state, findSource(zeroErrDto, 'api_requests').value, findSource(zeroErrDto, 'api_requests').coverage],
      ['ok', 4, 'partial'],
    );
    assert.deepEqual(
      [findSource(zeroErrDto, 'api_errors').state, findSource(zeroErrDto, 'api_errors').value, findSource(zeroErrDto, 'api_errors').coverage],
      ['zero', 0, 'partial'],
    );
    assert.deepEqual(zeroErrDto.apiErrorRate, {
      value: 0,
      coverage: 'partial',
      scope: 'instrumented_routes',
    });

    // Note: zeroErrRes itself recorded as the 5th instrumented request after reading!
    // 6. Real 500 and 503 responses through the instrumented stats HTTP handler & real apiCounter
    const failing500 = await statsMod.handleGetStats(
      makeRequest('/api/admin/stats?sources=visitors'),
      { user: { id: admin.userId, role: 'ADMIN' } },
      {
        stats: { async query() { throw new Error('unexpected internal failure'); } },
        apiCounter: httpServices.apiCounter,
      },
      { log: () => {} },
    );
    assert.equal(failing500.status, 500);

    const failing503 = await statsMod.handleGetStats(
      makeRequest('/api/admin/stats?sources=visitors'),
      { user: { id: admin.userId, role: 'ADMIN' } },
      {
        stats: { async query() { throw new AppError('service_unavailable'); } },
        apiCounter: httpServices.apiCounter,
      },
    );
    assert.equal(failing503.status, 503);

    // Total instrumented requests recorded so far = 5 (2xx/4xx) + 2 (500 + 503) = 7; 5xx errors = 2
    const after5xxRes = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=api_requests,api_errors`, {
        cookie: admin.cookie,
      }),
    );
    assert.equal(after5xxRes.status, 200);
    const after5xxDto = StatsDTOSchema.parse(await after5xxRes.json());
    assert.equal(findSource(after5xxDto, 'api_requests').value, 7);
    assert.equal(findSource(after5xxDto, 'api_requests').coverage, 'partial');
    assert.equal(findSource(after5xxDto, 'api_errors').value, 2);
    assert.equal(findSource(after5xxDto, 'api_errors').coverage, 'partial');
    assert.equal(after5xxDto.apiErrorRate?.scope, 'instrumented_routes');
    assert.equal(after5xxDto.apiErrorRate?.coverage, 'partial');
    assert.ok(Math.abs((after5xxDto.apiErrorRate?.value ?? -1) - 2 / 7) < 1e-9);
  });

  test('AC2 / E-64: real chat-notifications job produces queued, sending, sent, failed, unknown; consultation received and queued are never counted as delivered', async () => {
    const now = new Date();
    const today = siteLocalDate(now, 'UTC');
    const visitorCookie = await newVisitorCookie();

    // Create 5 real visitor messages (1 conversation + 4 appended messages) -> 5 received receipts + 5 QUEUED notifications
    const secretEmail = 'visitor-pii-m6t5@example.test';
    const secretBody = 'Confidential packaging dimensions 420x300mm';
    const firstConv = ConversationReceivedDTOSchema.parse(await (await createConversation(
      makeRequest('/api/chat/conversations', {
        cookie: visitorCookie,
        body: {
          clientConversationId: randomUUID(),
          clientMessageId: randomUUID(),
          locale: 'en',
          email: secretEmail,
          productSlug: REAL_PRODUCT_A,
          bodyText: `${secretBody} #1`,
        },
      }),
    )).json());

    const messageIds = [firstConv.message.id];
    for (let idx = 2; idx <= 5; idx += 1) {
      const appended = MessageReceivedDTOSchema.parse(await (await appendMessage(
        makeRequest(`/api/chat/conversations/${firstConv.conversationId}/messages`, {
          cookie: visitorCookie,
          body: { clientMessageId: randomUUID(), bodyText: `${secretBody} #${idx}` },
        }),
        { params: Promise.resolve({ id: firstConv.conversationId }) },
      )).json());
      messageIds.push(appended.message.id);
    }

    // Defer the 5th notification into the future so it stays QUEUED during the job run;
    // claim the 4th notification with an active SENDING lease so the job processes the remaining 3 into SENT / FAILED / UNKNOWN.
    const notifications = await db.chatNotification.findMany({ orderBy: { createdAt: 'asc' } });
    assert.equal(notifications.length, 5);
    await db.chatNotification.update({
      where: { id: notifications[4].id },
      data: { availableAt: new Date(Date.now() + 600_000) },
    });

    let callIndex = 0;
    const outcomes = [
      { kind: 'sent' as const },
      { kind: 'failed' as const, code: 'CHAT_SMTP_RECIPIENT' as const },
      { kind: 'unknown' as const, code: 'CHAT_SMTP_DEADLINE' as const },
    ];
    const jobServices = composition.createJobServices({
      db: appDb,
      chat: {
        env: ENV,
        limit: 3,
        getMailer: async () => ({
          async send() {
            const next = outcomes[callIndex] ?? { kind: 'unknown' as const, code: 'CHAT_SMTP_UNKNOWN' as const };
            callIndex += 1;
            return next;
          },
        }),
      },
    });
    const runOps = createOperationsHandler({
      services: jobServices.jobs,
      secret: CRON_SECRET,
    });

    // Claim one row into active SENDING lease right before running the job on the other 3 due rows
    await db.chatNotification.update({
      where: { id: notifications[3].id },
      data: {
        status: 'SENDING',
        leaseOwner: 'active-worker:m6t5',
        leaseVersion: 1,
        lockedUntil: new Date(Date.now() + 35_000),
        updatedAt: new Date(),
      },
    });

    const jobRes = await runOps(makeRequest('/api/admin/cron/operations', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      body: { jobKey: CHAT_NOTIFICATION_JOB_KEY },
    }));
    assert.equal(jobRes.status, 200);
    assert.equal(callIndex, 3);
    void repo;

    // Query stats as ADMIN and SALES: only the 1 real SMTP-accepted SENT row counts as delivered!
    for (const actor of [admin, sales]) {
      const res = await statsRoute.GET(
        makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=chat_notifications`, {
          cookie: actor.cookie,
        }),
      );
      assert.equal(res.status, 200);
      const rawText = await res.text();
      const dto = StatsDTOSchema.parse(JSON.parse(rawText));
      const item = findSource(dto, 'chat_notifications');
      assert.deepEqual([item.state, item.value, item.coverage], ['ok', 1, 'full']);
      assert.deepEqual(dto.notificationCounts?.chat_notifications, {
        queued: 1,
        sending: 1,
        sent: 1,
        failed: 1,
        unknown: 1,
      });
      for (const secret of [secretEmail, ENV.CHAT_NOTIFICATION_TO, secretBody, firstConv.conversationId, ...messageIds]) {
        assert.equal(rawText.includes(secret), false, `stats response leaked ${secret}`);
      }
    }

    // Product filter narrows to REAL_PRODUCT_A vs empty REAL_PRODUCT_B
    const prodARes = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&productSlug=${REAL_PRODUCT_A}&sources=chat_notifications`, {
        cookie: admin.cookie,
      }),
    );
    const prodADto = StatsDTOSchema.parse(await prodARes.json());
    assert.equal(findSource(prodADto, 'chat_notifications').value, 1);

    const prodBRes = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&productSlug=${REAL_PRODUCT_B}&sources=chat_notifications`, {
        cookie: admin.cookie,
      }),
    );
    const prodBDto = StatsDTOSchema.parse(await prodBRes.json());
    assert.deepEqual(
      [findSource(prodBDto, 'chat_notifications').state, findSource(prodBDto, 'chat_notifications').value],
      ['zero', 0],
    );
    assert.deepEqual(prodBDto.notificationCounts?.chat_notifications, {
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      unknown: 0,
    });
  });

  test('AC2 / E-64: real mail-queue job produces queued, sending, sent, failed, unknown; inbound inquiry RECEIVED and outbound queued/sending are never counted as delivered', async () => {
    const now = new Date();
    const today = siteLocalDate(now, 'UTC');

    const contact = await db.contact.create({
      data: { region: 'DE', name: 'Mail Buyer', email: 'mail-buyer-pii@example.test' },
    });
    const inquiry = await db.inquiry.create({
      data: {
        ref: 'PJ-M6T5-MAIL-1',
        replyToken: 'm6t5replytoken001',
        contactId: contact.id,
        locale: 'en',
        source: 'FORM',
        retainUntil: new Date(now.getTime() + 30 * 86_400_000),
        items: {
          // Two items with the same productSlug verify EXISTS deduplication (no double count)
          create: [
            { productSlug: REAL_PRODUCT_A, quantity: 100 },
            { productSlug: REAL_PRODUCT_A, quantity: 200 },
          ],
        },
      },
    });

    // Inbound inquiry emails (RECEIVED & UNASSIGNED) must NEVER count in mail reliability
    await db.mailMessage.createMany({
      data: [
        {
          direction: 'INBOUND',
          status: 'RECEIVED',
          inquiryId: inquiry.id,
          remoteMailId: 'inbound-1',
          fromAddr: 'customer-inbound@example.test',
          toAddr: 'reply@reply.m6t5.example.test',
          subject: 'Inbound subject PII',
          bodyHtml: '<p>Inbound</p>',
          bodyText: 'Inbound secret text',
          receivedAt: now,
        },
        {
          direction: 'INBOUND',
          status: 'UNASSIGNED',
          remoteMailId: 'inbound-2',
          fromAddr: 'stranger@example.test',
          toAddr: 'info@reply.m6t5.example.test',
          subject: 'Unassigned',
          bodyHtml: '<p>Unassigned</p>',
          bodyText: 'Unassigned',
          receivedAt: now,
        },
      ],
    });

    // Seed 3 due outbound QUEUED rows (to become SENT, FAILED, and unknown_delivery via real mail-queue job),
    // 1 future-deferred QUEUED row, and 1 active SENDING row.
    const duePast = new Date(now.getTime() - 60_000);
    const dueRows = [];
    for (let idx = 1; idx <= 3; idx += 1) {
      dueRows.push(await db.mailMessage.create({
        data: {
          direction: 'OUTBOUND',
          status: 'QUEUED',
          inquiryId: inquiry.id,
          sendKey: `m6t5sendkey00000000000${idx}`,
          messageId: `<m6t5-${idx}@reply.m6t5.example.test>`,
          fromAddr: ENV.MAIL_FROM,
          toAddr: 'mail-buyer-pii@example.test',
          subject: `Outbound quote #${idx}`,
          bodyHtml: '<p>Quote secret</p>',
          bodyText: 'Quote secret body',
          errorCode: 'daily_cap_deferred',
          deferredUntil: duePast,
        },
      }));
    }

    // 4th outbound row: deferred in the future -> stays QUEUED (attempts=0)
    await db.mailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'QUEUED',
        inquiryId: inquiry.id,
        sendKey: 'm6t5sendkey000000000004',
        messageId: '<m6t5-4@reply.m6t5.example.test>',
        fromAddr: ENV.MAIL_FROM,
        toAddr: 'mail-buyer-pii@example.test',
        subject: 'Deferred quote',
        bodyHtml: '<p>Deferred</p>',
        bodyText: 'Deferred',
        errorCode: 'daily_cap_deferred',
        deferredUntil: new Date(now.getTime() + 3_600_000),
      },
    });

    // 5th outbound row: reserve into active SENDING lease (attempts=1, not yet accepted by SMTP)
    const sendingSeed = await db.mailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'QUEUED',
        inquiryId: inquiry.id,
        sendKey: 'm6t5sendkey000000000005',
        messageId: '<m6t5-5@reply.m6t5.example.test>',
        fromAddr: ENV.MAIL_FROM,
        toAddr: 'mail-buyer-pii@example.test',
        subject: 'Sending quote',
        bodyHtml: '<p>Sending</p>',
        bodyText: 'Sending',
        errorCode: 'daily_cap_deferred',
        deferredUntil: duePast,
      },
    });
    const reserved = await reserveAndStart(appDb, sendingSeed.id, ['QUEUED'], { now: new Date(), env: ENV });
    assert.equal(reserved.kind, 'started');

    // Run real mail-queue job through createJobServices -> executeJobRequest with controlled SMTP outcomes
    let smtpIndex = 0;
    const mailOutcomes: SendOutcome[] = [
      { ok: true, messageId: '<accepted@smtp.m6t5.example.test>' },
      { ok: false, reason: 'recipient_rejected', retryable: false, code: '550', alert: false },
      { ok: false, reason: 'unknown_delivery', retryable: false, code: null, alert: false },
    ];
    const adapter: MailSendAdapter = {
      kind: 'smtp',
      async send(_mail: OutboundMail) {
        const out = mailOutcomes[smtpIndex] ?? { ok: false, reason: 'unknown_delivery', retryable: false, code: null, alert: false };
        smtpIndex += 1;
        return out;
      },
    };
    const jobs = composition.createJobServices({
      db: appDb,
      mail: { getAdapter: async () => adapter, alert: async () => 'skipped' },
    }).jobs;
    const runOps = createOperationsHandler({
      services: jobs,
      secret: CRON_SECRET,
    });
    const cronRes = await runOps(makeRequest('/api/admin/cron/operations', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      body: { jobKey: MAIL_QUEUE_KEY },
    }));
    assert.equal(cronRes.status, 200);
    assert.equal(smtpIndex, 3);
    void mailQueueRoute;

    // Query GET /api/admin/stats?sources=mail (both site-wide and filtered by REAL_PRODUCT_A)
    for (const qs of [`?from=${today}&to=${today}&sources=mail`, `?from=${today}&to=${today}&productSlug=${REAL_PRODUCT_A}&sources=mail`]) {
      const res = await statsRoute.GET(makeRequest(`/api/admin/stats${qs}`, { cookie: admin.cookie }));
      assert.equal(res.status, 200);
      const text = await res.text();
      const dto = StatsDTOSchema.parse(JSON.parse(text));
      const mailSource = findSource(dto, 'mail');
      // Only the 1 SMTP-accepted outbound message counts in value; inbound RECEIVED, queued, sending, failed, unknown are excluded!
      assert.deepEqual([mailSource.state, mailSource.value, mailSource.coverage], ['ok', 1, 'full']);
      assert.deepEqual(dto.notificationCounts?.mail, {
        queued: 1,
        sending: 1,
        sent: 1,
        failed: 1,
        unknown: 1,
      });
      for (const secret of ['mail-buyer-pii@example.test', 'customer-inbound@example.test', 'Quote secret', 'Inbound secret', 'm6t5sendkey']) {
        assert.equal(text.includes(secret), false, `mail stats leaked ${secret}`);
      }
    }
  });

  test('E-51 / E-52 / E-53 / E-67: partial source outage & stale job watermarks preserve original lastSucceededAt/value or report sanitized no-snapshot failure while sibling sources succeed', async () => {
    const tJobSuccess = new Date('2026-11-27T10:00:00.000Z');
    const today = '2026-11-27';
    const bounds = siteDayUtcBounds(today, 'UTC');
    const insideWindow = new Date(Date.parse(bounds.startUtc) + 3_600_000);

    // Seed real ApiDailyCounter, ChatNotification + JobState, and MailMessage + JobState at tJobSuccess
    await db.apiDailyCounter.create({
      data: {
        localDate: today,
        timezoneRevision: 1,
        routeId: 'GET /api/admin/account',
        requestCount: 8,
        errorCount: 1,
        lastObservedAt: tJobSuccess,
      },
    });
    await db.jobState.createMany({
      data: [
        {
          key: CHAT_NOTIFICATION_JOB_KEY,
          generation: 1,
          lastStatus: 'SUCCEEDED',
          lastStartedAt: tJobSuccess,
          lastSucceededAt: tJobSuccess,
          lastFinishedAt: tJobSuccess,
        },
        {
          key: MAIL_QUEUE_KEY,
          generation: 1,
          lastStatus: 'SUCCEEDED',
          lastStartedAt: tJobSuccess,
          lastSucceededAt: tJobSuccess,
          lastFinishedAt: tJobSuccess,
        },
      ],
    });
    await db.mailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        attempts: 1,
        sentAt: insideWindow,
        updatedAt: insideWindow,
        createdAt: insideWindow,
        sendKey: 'm6t5stalekey000000000001',
        messageId: '<stale-1@reply.m6t5.example.test>',
        fromAddr: ENV.MAIL_FROM,
        toAddr: 'target@example.test',
        subject: 'Sent',
        bodyHtml: '<p>Sent</p>',
        bodyText: 'Sent',
      },
    });

    // 1. Fresh query at tJobSuccess + 1m -> state='ok', lastSucceededAt = tJobSuccess
    const tFresh = new Date(tJobSuccess.getTime() + 60_000);
    const freshAdminServices = composition.createAdminServices({ db: appDb, clock: () => tFresh });
    const query = {
      from: today,
      to: today,
      sources: ['inquiries', 'api_requests', 'api_errors', 'chat_notifications', 'mail'] as StatsSource[],
    };
    const freshResult = await freshAdminServices.stats.query({ role: 'ADMIN', userId: admin.userId, query });
    assert.deepEqual(
      [findSource(freshResult.dto, 'mail').state, findSource(freshResult.dto, 'mail').value, findSource(freshResult.dto, 'mail').lastSucceededAt],
      ['ok', 1, tJobSuccess.toISOString()],
    );

    // 2. Subsequent mail-queue run FAILS at tJobSuccess + 2m, then stats queried at tJobSuccess + 7m (>5m freshness)
    const tFailedJob = new Date(tJobSuccess.getTime() + 2 * 60_000);
    await db.jobState.update({
      where: { key: MAIL_QUEUE_KEY },
      data: { lastStatus: 'FAILED', lastFinishedAt: tFailedJob, lastErrorCode: 'internal_error' },
    });
    const tStaleQuery = new Date(tJobSuccess.getTime() + 7 * 60_000);
    const staleAdminServices = composition.createAdminServices({ db: appDb, clock: () => tStaleQuery });
    const staleResult = await staleAdminServices.stats.query({ role: 'ADMIN', userId: admin.userId, query });
    const staleMail = findSource(staleResult.dto, 'mail');
    assert.deepEqual(
      [staleMail.state, staleMail.value, staleMail.lastSucceededAt, staleMail.coverage],
      ['stale', 1, tJobSuccess.toISOString(), 'partial'],
    );
    assert.equal(staleMail.queriedAt, tStaleQuery.toISOString());
    assert.notEqual(staleMail.lastSucceededAt, staleMail.queriedAt);

    // 3. Inject database outage ONLY on MailMessage queries while keeping all other tables operational
    const faultDb = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => target.$transaction(async (tx) => fn(
          new Proxy(tx as object, {
            get(txTarget, txProp, txReceiver) {
              if (txProp === '$queryRaw') {
                return (strings: unknown, ...values: unknown[]) => {
                  const sqlText = Array.isArray(strings)
                    ? strings.join('?')
                    : typeof (strings as { sql?: string })?.sql === 'string'
                      ? (strings as { sql: string }).sql
                      : String(strings);
                  if (sqlText.includes('FROM "MailMessage"')) {
                    throw new Error('db outage postgresql://admin:secret-db-pass@10.20.30.40:5432/packjoyu');
                  }
                  return (Reflect.get(txTarget, txProp, txReceiver) as (...a: unknown[]) => unknown).call(
                    txTarget,
                    strings,
                    ...values,
                  );
                };
              }
              return Reflect.get(txTarget, txProp, txReceiver);
            },
          }),
        ), opts as never);
      },
    }) as PrismaClient;

    const faultServices = composition.createAdminServices({ db: faultDb, clock: () => tStaleQuery });

    // 3a. Without prior snapshot -> mail is query_failed with value=null (no fake 0), secrets scrubbed, other 4 sources succeed!
    const noSnapHttpRes = await statsMod.handleGetStats(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=inquiries,api_requests,api_errors,chat_notifications,mail`),
      { user: { id: admin.userId, role: 'ADMIN' } },
      faultServices,
    );
    assert.equal(noSnapHttpRes.status, 200);
    const noSnapText = await noSnapHttpRes.text();
    assert.equal(noSnapText.includes('secret-db-pass'), false);
    assert.equal(noSnapText.includes('10.20.30.40'), false);
    const noSnapDto = StatsDTOSchema.parse(JSON.parse(noSnapText));
    assert.deepEqual(
      [findSource(noSnapDto, 'mail').state, findSource(noSnapDto, 'mail').value, findSource(noSnapDto, 'mail').lastSucceededAt],
      ['query_failed', null, null],
    );
    assert.equal(findSource(noSnapDto, 'inquiries').state, 'zero');
    assert.equal(findSource(noSnapDto, 'api_requests').value, 8);
    assert.equal(findSource(noSnapDto, 'api_errors').value, 1);
    assert.equal(findSource(noSnapDto, 'chat_notifications').value, 0);

    // 3b. With same-query-key prior snapshot -> mail retains value=1 & original tJobSuccess while marked query_failed
    const withSnapResult = await faultServices.stats.query({
      role: 'ADMIN',
      userId: admin.userId,
      query,
      previousSnapshot: { dto: freshResult.dto, query },
    });
    const preservedMail = findSource(withSnapResult.dto, 'mail');
    assert.deepEqual(
      [preservedMail.state, preservedMail.value, preservedMail.lastSucceededAt, preservedMail.coverage],
      ['query_failed', 1, tJobSuccess.toISOString(), 'partial'],
    );
    assert.equal(preservedMail.queriedAt, tStaleQuery.toISOString());
    // Prior handleGetStats(200) recorded +1 instrumented request (8 -> 9)
    assert.equal(findSource(withSnapResult.dto, 'api_requests').value, 9);
  });

  test('E-66: RBAC matrix over real Auth.js sessions (unauthenticated 401; ADMIN all; SALES chat_notifications only, 403 on api_*/mail; EDITOR 403 on all reliability sources & pre-query trimming)', async () => {
    const today = siteLocalDate(new Date(), 'UTC');
    await db.jobState.createMany({
      data: [
        {
          key: CHAT_NOTIFICATION_JOB_KEY,
          generation: 1,
          lastStatus: 'SUCCEEDED',
          lastSucceededAt: new Date(),
          lastFinishedAt: new Date(),
        },
        {
          key: MAIL_QUEUE_KEY,
          generation: 1,
          lastStatus: 'SUCCEEDED',
          lastSucceededAt: new Date(),
          lastFinishedAt: new Date(),
        },
      ],
    });

    // Unauthenticated -> 401
    const anonRes = await statsRoute.GET(makeRequest('/api/admin/stats?sources=api_requests'));
    assert.equal(anonRes.status, 401);

    // SALES default query includes chat_notifications, excludes api_requests / api_errors / mail
    const salesDefaultRes = await statsRoute.GET(makeRequest(`/api/admin/stats?from=${today}&to=${today}`, { cookie: sales.cookie }));
    assert.equal(salesDefaultRes.status, 200);
    const salesDefaultText = await salesDefaultRes.text();
    const salesDefaultDto = StatsDTOSchema.parse(JSON.parse(salesDefaultText));
    const salesSources = new Set(salesDefaultDto.sources.map((s) => s.source));
    assert.equal(salesSources.has('chat_notifications'), true);
    for (const forbidden of ['api_requests', 'api_errors', 'mail'] as const) {
      assert.equal(salesSources.has(forbidden), false);
      const direct = await statsRoute.GET(makeRequest(`/api/admin/stats?sources=${forbidden}`, { cookie: sales.cookie }));
      assert.equal(direct.status, 403);
    }
    assert.equal(salesDefaultDto.apiErrorRate, null);
    assert.equal('mail' in (salesDefaultDto.notificationCounts ?? {}), false);

    // SALES mixed query trims unauthorized sources before querying
    const salesMixed = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=chat_notifications,api_requests,mail`, { cookie: sales.cookie }),
    );
    assert.equal(salesMixed.status, 200);
    const salesMixedDto = StatsDTOSchema.parse(await salesMixed.json());
    assert.deepEqual(salesMixedDto.sources.map((s) => s.source), ['chat_notifications']);

    // EDITOR direct requests for all 4 reliability sources -> 403; mixed query keeps only visitors
    for (const source of RELIABILITY_SOURCES) {
      const direct = await statsRoute.GET(makeRequest(`/api/admin/stats?sources=${source}`, { cookie: editor.cookie }));
      assert.equal(direct.status, 403);
    }
    const editorMixed = await statsRoute.GET(
      makeRequest(`/api/admin/stats?from=${today}&to=${today}&sources=visitors,api_requests,api_errors,chat_notifications,mail`, {
        cookie: editor.cookie,
      }),
    );
    assert.equal(editorMixed.status, 200);
    const editorMixedText = await editorMixed.text();
    const editorMixedDto = StatsDTOSchema.parse(JSON.parse(editorMixedText));
    assert.deepEqual(editorMixedDto.sources.map((s) => s.source), ['visitors']);
    assert.equal(editorMixedDto.apiErrorRate, null);
    assert.equal(editorMixedDto.notificationCounts, null);
    for (const hidden of RELIABILITY_SOURCES) {
      assert.equal(editorMixedText.includes(hidden), false);
    }
  });

  test('non-UTC PostgreSQL session timezone (Asia/Shanghai) preserves exact UTC instants and boundaries across all four reliability sources', async () => {
    const fixedInstant = new Date('2026-11-27T16:30:00.000Z'); // Next calendar day in Asia/Shanghai (+08:00), still 2026-11-27 in UTC!
    await db.apiDailyCounter.create({
      data: {
        localDate: '2026-11-27',
        timezoneRevision: 1,
        routeId: 'GET /api/admin/stats',
        requestCount: 4,
        errorCount: 1,
        lastObservedAt: fixedInstant,
      },
    });
    await db.jobState.createMany({
      data: [
        {
          key: CHAT_NOTIFICATION_JOB_KEY,
          generation: 1,
          lastStatus: 'SUCCEEDED',
          lastSucceededAt: fixedInstant,
          lastFinishedAt: fixedInstant,
        },
        {
          key: MAIL_QUEUE_KEY,
          generation: 1,
          lastStatus: 'SUCCEEDED',
          lastSucceededAt: fixedInstant,
          lastFinishedAt: fixedInstant,
        },
      ],
    });
    await db.mailMessage.create({
      data: {
        direction: 'OUTBOUND',
        status: 'SENT',
        attempts: 1,
        sentAt: fixedInstant,
        updatedAt: fixedInstant,
        createdAt: fixedInstant,
        sendKey: 'm6t5tzkey000000000000001',
        messageId: '<tz-1@reply.m6t5.example.test>',
        fromAddr: ENV.MAIL_FROM,
        toAddr: 'tz@example.test',
        subject: 'TZ',
        bodyHtml: '<p>TZ</p>',
        bodyText: 'TZ',
      },
    });

    const shanghaiClient = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    try {
      await shanghaiClient.$executeRawUnsafe(`SET TIME ZONE 'Asia/Shanghai'`);
      const services = composition.createAdminServices({
        db: shanghaiClient,
        clock: () => new Date('2026-11-27T16:32:00.000Z'),
      });
      const out = await services.stats.query({
        role: 'ADMIN',
        userId: admin.userId,
        query: { from: '2026-11-27', to: '2026-11-27', sources: [...RELIABILITY_SOURCES] },
      });
      assert.equal(findSource(out.dto, 'api_requests').lastSucceededAt, fixedInstant.toISOString());
      assert.equal(findSource(out.dto, 'mail').value, 1);
      assert.equal(findSource(out.dto, 'mail').lastSucceededAt, fixedInstant.toISOString());
      assert.equal(findSource(out.dto, 'chat_notifications').lastSucceededAt, fixedInstant.toISOString());
    } finally {
      await shanghaiClient.$disconnect();
    }
  });
});
