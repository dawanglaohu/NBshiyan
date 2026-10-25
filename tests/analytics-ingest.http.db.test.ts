// POST /api/analytics/events 在隔离 schema 的真实 PostgreSQL 上验收。
// 没有 DATABASE_URL 时只跑契约形状检查，HTTP 用例跳过，避免连上别的库。
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as eventsRoute from '../src/app/api/analytics/events/route';
import { createEventsPost } from '../src/app/api/analytics/events/post';
import { AnalyticsReceiptDTOSchema } from '../src/lib/contracts/analytics';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { CONSENT_VERSION } from '../src/lib/consent';
import { createAnalyticsConsentService } from '../src/lib/server/analytics/consent';
import {
  ANALYTICS_EVENTS_COOKIE_LIMIT,
  ANALYTICS_EVENTS_IP_LIMIT,
  ANALYTICS_EVENTS_MAX_BYTES,
  ANALYTICS_EVENTS_RETRY_AFTER_SECONDS,
} from '../src/lib/server/analytics/ingest';
import { loadServerConfig } from '../src/lib/server/config';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const PLANTED_EMAIL = 'planted-m5t6@example.com';
const PLANTED_IP = '203.0.113.44';
const PLANTED_BODY = 'planted chat body should never be stored';
const PLANTED_FINGERPRINT = 'cross-site-fingerprint-m5t6';
const PLANTED_TOKEN = 'sensitive-query-token-m5t6';
const SECRET = Buffer.from('b'.repeat(32));
const EDGE = 'e'.repeat(32);
const PUBLISHED = 'corrugated-boxes';
const OTHER = 'gift-boxes';
const DRAFT = 'draft-boxes';
const PROCESSING = 'processing-boxes';
const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const PAST_MS = 48 * 60 * 60 * 1000;
const FUTURE_MS = 5 * 60 * 1000;
const base = process.env.DATABASE_URL;
const SCHEMA = `m5t6_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';
const config = loadServerConfig({ APP_ENV: 'test' });
const testEnv = { APP_ENV: 'test', EDGE_AUTH_SECRET: EDGE };

test('AnalyticsEvent 进入 schema，并由 deploy.sh 现有 db push 消费', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const deploy = readFileSync('deploy/deploy.sh', 'utf8');
  assert.match(schema, /enum AnalyticsEventKind \{[^}]*page_view[^}]*product_view[^}]*model_view_start[^}]*model_load_success[^}]*model_load_failure[^}]*chat_start/s);
  assert.match(schema, /model AnalyticsEvent \{[^}]*eventId\s+String\s+@id[^}]*semanticKey\s+String\s+@unique[^}]*payloadHash[^}]*browserHash[^}]*occurredAt[^}]*receivedAt[^}]*@@index\(\[productSlug, occurredAt\]\)[^}]*@@index\(\[viewId\]\)/s);
  assert.doesNotMatch(schema.slice(schema.indexOf('model AnalyticsEvent')), /email|userAgent|fingerprint|bodyText|\bip\b/i);
  const push = deploy.split(/\r?\n/).find((line) => line.includes('migrate db push'));
  assert.ok(push);
  assert.match(push, /db push --skip-generate --schema prisma\/schema\.prisma/);
  assert.doesNotMatch(push, /accept-data-loss/);
  const repo = readFileSync('src/lib/server/analytics/event-repo.ts', 'utf8');
  const ingest = readFileSync('src/lib/server/analytics/ingest.ts', 'utf8');
  assert.match(repo, /ON CONFLICT DO NOTHING/);
  assert.match(repo, /::timestamptz AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(repo, /queryRawUnsafe|NextResponse|process\.env|clientIp/);
  assert.doesNotMatch(ingest, /queryRawUnsafe|NextResponse|process\.env|clientIp/);
  assert.equal(ANALYTICS_EVENTS_COOKIE_LIMIT, 120);
  assert.equal(ANALYTICS_EVENTS_IP_LIMIT, 300);
  assert.equal(ANALYTICS_EVENTS_RETRY_AFTER_SECONDS, 60);
});

type HttpResult = { status: number; text: string; body: unknown; headers: http.IncomingHttpHeaders };

let now = new Date(NOW);
let port = 0;
let server: http.Server | undefined;
let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 500 });
let consentCookie = '';

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makePost() {
  assert.ok(db);
  return createEventsPost({ db, config, clock: () => now, env: testEnv, secret: SECRET });
}

function grantCookie(): string {
  const outcome = createAnalyticsConsentService({ secret: SECRET, clock: () => now }).apply({
    analytics: true,
    consentVersion: CONSENT_VERSION,
    secure: false,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error('consent');
  return outcome.setCookie.split(';', 1)[0];
}

function cookieValue(cookie: string): string {
  return cookie.slice('pj_analytics='.length);
}

function page(extra: Record<string, unknown> = {}, navigationId: string = randomUUID(), eventId: string = randomUUID()) {
  return { kind: 'page_view', eventId, navigationId, occurredAt: iso(0), locale: 'en', path: '/en', ...extra };
}

function product(extra: Record<string, unknown> = {}, navigationId: string = randomUUID(), eventId: string = randomUUID()) {
  return { kind: 'product_view', eventId, navigationId, occurredAt: iso(0), locale: 'en', productSlug: PUBLISHED, path: '/en/products', ...extra };
}

function start(extra: Record<string, unknown> = {}, viewId: string = randomUUID(), eventId: string = randomUUID()) {
  return {
    kind: 'model_view_start', eventId, navigationId: randomUUID(), viewId, occurredAt: iso(0),
    locale: 'en', productSlug: PUBLISHED, path: '/en/products', ...extra,
  };
}

function success(viewId: string, extra: Record<string, unknown> = {}, eventId: string = randomUUID()) {
  return {
    kind: 'model_load_success', eventId, navigationId: randomUUID(), viewId, occurredAt: iso(0),
    locale: 'en', productSlug: PUBLISHED, durationMs: 40, ...extra,
  };
}

function failure(viewId: string, extra: Record<string, unknown> = {}, eventId: string = randomUUID()) {
  return {
    kind: 'model_load_failure', eventId, navigationId: randomUUID(), viewId, occurredAt: iso(0),
    locale: 'en', productSlug: PUBLISHED, durationMs: 40, failureReason: 'LOAD_ERROR', ...extra,
  };
}

function chat(extra: Record<string, unknown> = {}, navigationId: string = randomUUID(), eventId: string = randomUUID()) {
  return { kind: 'chat_start', eventId, navigationId, occurredAt: iso(0), locale: 'ru', path: '/ru/contact', ...extra };
}

function httpPost(options: { json?: unknown; raw?: string | Buffer; cookie?: string | null; origin?: string | null } = {}): Promise<HttpResult> {
  const payload = options.raw !== undefined
    ? (Buffer.isBuffer(options.raw) ? options.raw : Buffer.from(options.raw))
    : Buffer.from(JSON.stringify(options.json ?? { events: [page()] }));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'x-edge-auth': EDGE,
    'cf-connecting-ip': PLANTED_IP,
    'x-forwarded-for': PLANTED_IP,
    'x-planted-email': PLANTED_EMAIL,
    'x-fingerprint': PLANTED_FINGERPRINT,
  };
  if (options.origin !== null) headers.origin = options.origin ?? `http://127.0.0.1:${port}`;
  if (options.cookie) headers.cookie = options.cookie;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/analytics/events', method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        resolve({ status: res.statusCode ?? 0, text, body, headers: res.headers });
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('events http timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

function assertNoPlanted(result: HttpResult) {
  for (const secret of [PLANTED_EMAIL, PLANTED_IP, PLANTED_BODY, PLANTED_FINGERPRINT, PLANTED_TOKEN, EDGE]) {
    assert.equal(result.text.includes(secret), false, secret);
    assert.equal(JSON.stringify(result.headers).includes(secret), false, secret);
  }
}

async function countEvents(): Promise<number> {
  assert.ok(db);
  return db.analyticsEvent.count();
}

async function expectCode(json: unknown, status: number, code: string, cookie: string | null = consentCookie) {
  const beforeCount = await countEvents();
  const result = await httpPost({ json, cookie });
  assert.equal(result.status, status, result.text);
  const body = AppErrorDTOSchema.parse(result.body);
  assert.equal(body.error, code);
  assert.equal(await countEvents(), beforeCount);
  assertNoPlanted(result);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  return body;
}

async function accept(events: unknown[], cookie = consentCookie) {
  const result = await httpPost({ json: { events }, cookie });
  assert.equal(result.status, 200, result.text);
  const receipt = AnalyticsReceiptDTOSchema.parse(result.body);
  assertNoPlanted(result);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  return receipt;
}

describe('POST /api/analytics/events', { concurrency: false, skip }, () => {
  before(async () => {
    assert.ok(db);
    const ddl = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/dummy', PRISMA_HIDE_UPDATE_MESSAGE: '1' } as unknown as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    const detail = `${ddl.stderr ?? ''}`.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted');
    assert.equal(ddl.status, 0, detail.slice(0, 500));
    assert.match(SCHEMA, /^m5t6_\d+$/);
    await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    const statements = ddl.stdout.split(/;\s*$/m).map((statement) => statement.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    for (const statement of statements) await db.$executeRawUnsafe(statement);
    server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else headers.set(key, value);
        }
        const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
          method: req.method,
          headers,
          body: body.length > 0 ? body : undefined,
        });
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') res.setHeader(key, value);
        });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.statusCode = 500;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        port = (server?.address() as AddressInfo | null)?.port ?? 0;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    assert.ok(db);
    now = new Date(NOW);
    setRateLimitStore(new MemoryStore());
    handler = makePost();
    consentCookie = grantCookie();
    await db.analyticsEvent.deleteMany();
    await db.apiDailyCounter.deleteMany();
    await db.model3D.deleteMany();
    await db.model3D.createMany({
      data: [
        { id: 'ready-published', productSlug: PUBLISHED, category: PUBLISHED, sourceKey: 'src-a', status: 'READY', published: true },
        { id: 'ready-other', productSlug: OTHER, category: OTHER, sourceKey: 'src-b', status: 'READY', published: true },
        { id: 'ready-draft', productSlug: DRAFT, category: DRAFT, sourceKey: 'src-c', status: 'READY', published: false },
        { id: 'processing-published', productSlug: PROCESSING, category: PROCESSING, sourceKey: 'src-d', status: 'PROCESSING', published: true },
      ],
    });
  });

  after(async () => {
    setRateLimitStore(undefined);
    await new Promise<void>((resolve) => {
      if (!server) { resolve(); return; }
      server.close(() => resolve());
    });
    if (!db) return;
    assert.match(SCHEMA, /^m5t6_\d+$/);
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await db.$disconnect();
  });

  test('route registers only POST', () => {
    assert.equal(typeof eventsRoute.POST, 'function');
    assert.equal(eventsRoute.runtime, 'nodejs');
    assert.equal('GET' in eventsRoute, false);
    assert.equal('createEventsPost' in eventsRoute, false);
  });

  test('six kinds persist required fields and leave private fields out of the row', async () => {
    assert.ok(db);
    const viewId = randomUUID();
    const events = [page(), product(), start(), success(viewId), failure(randomUUID()), chat({ productSlug: OTHER })];
    for (const event of events) {
      const receipt = await accept([event]);
      assert.deepEqual(receipt.acceptedIds, [event.eventId]);
      assert.deepEqual(receipt.duplicateIds, []);
      now = new Date(now.getTime() + 1);
    }
    assert.equal(await countEvents(), 6);
    const rows = await db.analyticsEvent.findMany();
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    assert.deepEqual([...byKind.keys()].sort(), [
      'chat_start', 'model_load_failure', 'model_load_success', 'model_view_start', 'page_view', 'product_view',
    ]);
    assert.equal(byKind.get('product_view')?.productSlug, PUBLISHED);
    assert.equal(byKind.get('model_load_success')?.viewId, viewId);
    assert.equal(byKind.get('model_load_success')?.durationMs, 40);
    assert.equal(byKind.get('model_load_success')?.failureReason, null);
    assert.equal(byKind.get('model_load_failure')?.failureReason, 'LOAD_ERROR');
    assert.equal(byKind.get('model_load_failure')?.kind, 'model_load_failure');
    assert.equal(byKind.get('chat_start')?.productSlug, OTHER);
    assert.equal(byKind.get('chat_start')?.locale, 'ru');
    const verified = createAnalyticsConsentService({ secret: SECRET, clock: () => now }).verifyValue(cookieValue(consentCookie));
    assert.ok(verified);
    for (const row of rows) {
      assert.equal(row.browserHash, verified?.browserHash);
      assert.equal(row.navigationId?.length, 36);
    }
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'AnalyticsEvent'
    `;
    const names = columns.map((column) => column.column_name).sort();
    assert.deepEqual(names, [
      'browserHash', 'durationMs', 'eventId', 'failureReason', 'kind', 'locale', 'navigationId',
      'occurredAt', 'path', 'payloadHash', 'productSlug', 'receivedAt', 'semanticKey', 'viewId',
    ]);
    const stored = JSON.stringify(rows);
    for (const secret of [PLANTED_EMAIL, PLANTED_IP, PLANTED_BODY, PLANTED_FINGERPRINT, PLANTED_TOKEN, cookieValue(consentCookie)]) {
      assert.equal(stored.includes(secret), false, secret);
    }
  });

  test('a catalog internal key is stored without a Model3D row, and en/ru paths keep that key', async () => {
    assert.ok(db);
    assert.equal(await db.model3D.count({ where: { productSlug: 'gift-cards' } }), 0);
    const en = product({ productSlug: 'gift-cards', locale: 'en', path: '/en/products/custom-greeting-cards' });
    const ru = product({ productSlug: 'gift-cards', locale: 'ru', path: '/ru/products/otkrytki-na-zakaz' });
    const receipt = await accept([en, ru]);
    assert.deepEqual([...receipt.acceptedIds].sort(), [en.eventId, ru.eventId].sort());
    const rows = await db.analyticsEvent.findMany({ where: { productSlug: 'gift-cards' } });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.productSlug), ['gift-cards', 'gift-cards']);
    assert.deepEqual(new Set(rows.map((row) => row.path)), new Set(['/en/products/custom-greeting-cards', '/ru/products/otkrytki-na-zakaz']));
    assert.deepEqual(new Set(rows.map((row) => row.locale)), new Set(['en', 'ru']));
    await expectCode({ events: [page(), product({ productSlug: 'custom-greeting-cards' })] }, 400, 'invalid');
    await expectCode({ events: [page(), product({ productSlug: 'not-a-product' })] }, 400, 'invalid');
  });

  test('missing required fields, unknown kinds, overlong values, unpublished products and sensitive URLs do not insert', async () => {
    const viewId = randomUUID();
    const path200 = `/en/${'a'.repeat(196)}`;
    const slug120 = 'b'.repeat(120);
    assert.equal(path200.length, 200);
    assert.ok(db);
    await db.model3D.create({
      data: { id: 'slug-120', productSlug: slug120, category: slug120, sourceKey: 'src-long', status: 'READY', published: true },
    });
    const receipt = await accept([
      page({ path: path200 }),
      product({ productSlug: slug120 }),
      success(viewId, { durationMs: 0 }),
      failure(randomUUID(), { durationMs: 600_000, failureReason: 'TIMEOUT' }),
    ]);
    assert.equal(receipt.acceptedIds.length, 4);
    const cases: unknown[] = [
      { events: [page({ navigationId: undefined })] },
      { events: [page({ path: undefined })] },
      { events: [product({ navigationId: undefined })] },
      { events: [product({ productSlug: undefined })] },
      { events: [start({ viewId: undefined })] },
      { events: [start({ productSlug: undefined })] },
      { events: [start({ navigationId: undefined })] },
      { events: [success(viewId, { viewId: undefined })] },
      { events: [success(viewId, { productSlug: undefined })] },
      { events: [success(viewId, { durationMs: undefined })] },
      { events: [failure(viewId, { failureReason: undefined })] },
      { events: [failure(viewId, { durationMs: undefined })] },
      { events: [chat({ navigationId: undefined })] },
      { events: [page({ kind: 'click' })] },
      { events: [page({ path: `/en/${'a'.repeat(197)}` })] },
      { events: [product({ productSlug: 'c'.repeat(121) })] },
      { events: [success(randomUUID(), { durationMs: 600_001 })] },
      { events: [success(randomUUID(), { durationMs: -1 })] },
      { events: [] },
      { events: Array.from({ length: 21 }, () => page()) },
      { events: [product({ productSlug: 'not-a-product' })] },
      { events: [product({ productSlug: DRAFT })] },
      { events: [start({ productSlug: PROCESSING })] },
      { events: [chat({ productSlug: DRAFT })] },
      { events: [page({ path: `https://example.com/en?email=${PLANTED_EMAIL}&token=${PLANTED_TOKEN}` })] },
      { events: [page({ path: `/en?email=${PLANTED_EMAIL}` })] },
      { events: [page({ email: PLANTED_EMAIL })] },
      { events: [page({ bodyText: PLANTED_BODY })] },
      { events: [page({ fingerprint: PLANTED_FINGERPRINT })] },
      { events: [page({ ip: PLANTED_IP })] },
      { events: [chat({ conversationId: randomUUID(), bodyText: PLANTED_BODY })] },
      { events: [page(), page({ kind: 'click' })] },
    ];
    for (const body of cases) await expectCode(body, 400, 'invalid');
    const timed = [
      page({ occurredAt: iso(-PAST_MS - 1) }),
      page({ occurredAt: iso(FUTURE_MS + 1) }),
    ];
    for (const event of timed) await expectCode({ events: [event] }, 400, 'event_time_out_of_range');
    const edges = await accept([
      page({ occurredAt: iso(-PAST_MS) }),
      page({ occurredAt: iso(FUTURE_MS) }),
    ]);
    assert.equal(edges.acceptedIds.length, 2);
    const forged = await expectCode({ events: [product({ productSlug: 'not-a-product' })] }, 400, 'invalid');
    assert.equal(forged.fieldErrors?.productSlug, 'Must be a published product.');
    assert.equal(await countEvents(), 6);
  });

  test('same payload is one row, a different payload conflicts, and terminals share one outcome', async () => {
    assert.ok(db);
    const first = page();
    const again = await accept([first]);
    const retry = await accept([first]);
    assert.deepEqual(again.acceptedIds, [first.eventId]);
    assert.deepEqual(retry.duplicateIds, [first.eventId]);
    assert.deepEqual(retry.acceptedIds, []);
    const sameSemantic = page({ path: first.path, occurredAt: first.occurredAt, locale: 'en' }, first.navigationId as string);
    const duplicateSemantic = await accept([sameSemantic]);
    assert.deepEqual(duplicateSemantic.duplicateIds, [sameSemantic.eventId]);
    assert.equal(await countEvents(), 1);
    await expectCode({ events: [page({ path: '/ru' }, first.navigationId as string)] }, 409, 'idempotency_conflict');
    await expectCode({ events: [{ ...first, path: '/ru/about' }] }, 409, 'idempotency_conflict');
    const fresh = page();
    await expectCode({ events: [fresh, page({ path: '/ru' }, first.navigationId as string)] }, 409, 'idempotency_conflict');
    assert.equal(await db.analyticsEvent.count({ where: { eventId: fresh.eventId as string } }), 0);
    const navigationId = randomUUID();
    await accept([product({}, navigationId), start({ navigationId })]);
    assert.equal(await countEvents(), 3);
    const won = randomUUID();
    await accept([success(won)]);
    await expectCode({ events: [failure(won)] }, 409, 'idempotency_conflict');
    const failed = await db.analyticsEvent.findFirst({ where: { viewId: won } });
    assert.equal(failed?.kind, 'model_load_success');
    assert.equal(failed?.failureReason, null);
    const lost = randomUUID();
    await accept([failure(lost, { failureReason: 'WEBGL_UNAVAILABLE' })]);
    await expectCode({ events: [success(lost)] }, 409, 'idempotency_conflict');
    const kept = await db.analyticsEvent.findFirst({ where: { viewId: lost } });
    assert.equal(kept?.kind, 'model_load_failure');
    assert.equal(kept?.failureReason, 'WEBGL_UNAVAILABLE');
    const chatNavigation = randomUUID();
    await accept([chat({}, chatNavigation)]);
    await expectCode({ events: [chat({ productSlug: OTHER }, chatNavigation)] }, 409, 'idempotency_conflict');
    const chatRow = await db.analyticsEvent.findFirst({ where: { navigationId: chatNavigation, kind: 'chat_start' } });
    assert.equal(chatRow?.productSlug, null);
    assert.equal(await countEvents(), 6);
  });

  test('a concurrent duplicate insert is duplicate, not 500', async () => {
    const event = page();
    const [left, right] = await Promise.all([
      httpPost({ json: { events: [event] }, cookie: consentCookie }),
      httpPost({ json: { events: [event] }, cookie: consentCookie }),
    ]);
    assert.equal(left.status, 200, left.text);
    assert.equal(right.status, 200, right.text);
    assert.equal(left.headers['cache-control'], 'private, no-store');
    assert.equal(right.headers['cache-control'], 'private, no-store');
    const receipts = [AnalyticsReceiptDTOSchema.parse(left.body), AnalyticsReceiptDTOSchema.parse(right.body)];
    const accepted = receipts.reduce((count, receipt) => count + receipt.acceptedIds.length, 0);
    const duplicated = receipts.reduce((count, receipt) => count + receipt.duplicateIds.length, 0);
    assert.equal(accepted, 1);
    assert.equal(duplicated, 1);
    assert.equal(await countEvents(), 1);
    assertNoPlanted(left);
    assertNoPlanted(right);
  });

  test('cookie 121 and IP-HMAC 301 are rejected with Retry-After and are not stored', async () => {
    async function fill(cookie: string, total: number) {
      let left = total;
      while (left > 0) {
        const batch = Math.min(20, left);
        const receipt = await accept(Array.from({ length: batch }, () => page()), cookie);
        assert.equal(receipt.acceptedIds.length, batch);
        left -= batch;
      }
    }
    await fill(consentCookie, ANALYTICS_EVENTS_COOKIE_LIMIT);
    assert.equal(await countEvents(), 120);
    const limited = await httpPost({ json: { events: [page()] }, cookie: consentCookie });
    assert.equal(limited.status, 429, limited.text);
    assert.equal(limited.headers['retry-after'], String(ANALYTICS_EVENTS_RETRY_AFTER_SECONDS));
    assert.equal(AppErrorDTOSchema.parse(limited.body).error, 'rate_limited');
    assertNoPlanted(limited);
    assert.equal(await countEvents(), 120);
    setRateLimitStore(new MemoryStore());
    await db?.analyticsEvent.deleteMany();
    const cookies = [consentCookie, grantCookie(), grantCookie()];
    await fill(cookies[0], 120);
    await fill(cookies[1], 120);
    await fill(cookies[2], 60);
    assert.equal(await countEvents(), 300);
    const ipLimited = await httpPost({ json: { events: [page()] }, cookie: cookies[2] });
    assert.equal(ipLimited.status, 429, ipLimited.text);
    assert.equal(ipLimited.headers['retry-after'], '60');
    assert.equal(await countEvents(), 300);
  });

  test('a withdrawn cookie is forbidden and does not change the row count', async () => {
    await accept([page()]);
    assert.equal(await countEvents(), 1);
    await expectCode({ events: [page()] }, 403, 'analytics_consent_required', null);
    await expectCode({ events: [page()] }, 403, 'analytics_consent_required', 'pj_analytics=');
    await expectCode({ events: [page()] }, 403, 'analytics_consent_required', 'pj_analytics=not-a-signed-cookie');
    const cleared = createAnalyticsConsentService({ secret: SECRET, clock: () => now }).apply({
      analytics: false, consentVersion: CONSENT_VERSION, secure: false,
    });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    await expectCode({ events: [page()] }, 403, 'analytics_consent_required', cleared.setCookie.split(';', 1)[0]);
    const missing = await httpPost({ json: { events: [page()] }, cookie: consentCookie, origin: null });
    assert.equal(missing.status, 403);
    assert.equal(AppErrorDTOSchema.parse(missing.body).error, 'forbidden_origin');
    const evil = await httpPost({ json: { events: [page()] }, cookie: consentCookie, origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(AppErrorDTOSchema.parse(evil.body).error, 'forbidden_origin');
    const huge = await httpPost({ raw: 'x'.repeat(ANALYTICS_EVENTS_MAX_BYTES + 1), cookie: consentCookie });
    assert.equal(huge.status, 413);
    assert.equal(AppErrorDTOSchema.parse(huge.body).error, 'too_large');
    assert.equal(await countEvents(), 1);
  });
});
