// 分析事件白名单、并发重复和不可用响应。不连接数据库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createEventsPost } from '../src/app/api/analytics/events/post';
import { products } from '../src/data/products';
import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { CONSENT_VERSION } from '../src/lib/consent';
import { createAnalyticsConsentService } from '../src/lib/server/analytics/consent';
import {
  AnalyticsPayloadConflict,
  createAnalyticsEventRepo,
  type AnalyticsEventRepo,
  type NewAnalyticsEvent,
} from '../src/lib/server/analytics/event-repo';
import { CATALOG_PRODUCT_SLUGS, createAnalyticsIngestService } from '../src/lib/server/analytics/ingest';
import type { AnalyticsIngestServices } from '../src/lib/server/composition';
import { loadServerConfig } from '../src/lib/server/config';
import { AppError } from '../src/lib/server/http/errors';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const NOW = '2026-06-15T12:00:00.000Z';
const SECRET = Buffer.from('c'.repeat(32));
const HASH = 'b'.repeat(43);
const LEAK = 'planted-db-secret-m5t6';
const SAME_HASH = 'a'.repeat(43);
const OTHER_HASH = 'd'.repeat(43);

type Identity = { eventId: string; semanticKey: string; payloadHash: string; browserHash: string };

function productView(extra: Record<string, unknown> = {}) {
  return {
    kind: 'product_view',
    eventId: randomUUID(),
    navigationId: randomUUID(),
    occurredAt: NOW,
    locale: 'en',
    productSlug: 'gift-cards',
    path: '/en/products/custom-greeting-cards',
    ...extra,
  };
}

function pageView(extra: Record<string, unknown> = {}) {
  return {
    kind: 'page_view',
    eventId: randomUUID(),
    navigationId: randomUUID(),
    occurredAt: NOW,
    locale: 'en',
    path: '/en',
    ...extra,
  };
}

function service(repo: AnalyticsEventRepo) {
  return createAnalyticsIngestService({
    repo,
    secret: SECRET,
    clock: () => new Date(NOW),
  });
}

function recordingRepo(published: ReadonlySet<string> = new Set()) {
  const batches: NewAnalyticsEvent[][] = [];
  const asked: string[][] = [];
  const repo: AnalyticsEventRepo = {
    async publishedSlugs(slugs) {
      asked.push([...slugs]);
      const found = new Set<string>();
      for (const slug of slugs) if (published.has(slug)) found.add(slug);
      return found;
    },
    async saveAll(rows) {
      batches.push(rows.map((row) => ({ ...row })));
      return rows.map(() => 'created' as const);
    },
  };
  return { repo, batches, asked };
}

function row(extra: Partial<NewAnalyticsEvent> = {}): NewAnalyticsEvent {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    semanticKey: 'sem-1',
    payloadHash: SAME_HASH,
    browserHash: HASH,
    kind: 'product_view',
    occurredAt: new Date(NOW),
    receivedAt: new Date(NOW),
    locale: 'en',
    path: '/en/products/custom-greeting-cards',
    productSlug: 'gift-cards',
    navigationId: '22222222-2222-4222-8222-222222222222',
    viewId: null,
    durationMs: null,
    failureReason: null,
    ...extra,
  };
}

function isSql(value: unknown): value is { strings: string[]; values: unknown[] } {
  if (!value || typeof value !== 'object') return false;
  const sql = value as { strings?: unknown; values?: unknown };
  return Array.isArray(sql.strings) && Array.isArray(sql.values);
}

function sqlParts(query: unknown): { text: string; values: unknown[] } {
  if (!isSql(query)) throw new Error('expected Prisma.sql');
  const values: unknown[] = [];
  const text = query.strings.reduce((acc, part, index) => {
    let next = acc + part;
    if (index < query.values.length) {
      const value = query.values[index];
      if (isSql(value)) {
        const inner = sqlParts(value);
        next += inner.text;
        values.push(...inner.values);
      } else {
        values.push(value);
        next += '?';
      }
    }
    return next;
  }, '');
  return { text, values };
}

function fakeDb(options: { before: Identity | null; after: Identity | null; inserted: number }) {
  const queries: unknown[] = [];
  let reads = 0;
  const tx = {
    analyticsEvent: {
      findUnique: async () => {
        reads += 1;
        return reads <= 2 ? options.before : options.after;
      },
      create: async () => {
        throw new Error('create aborts the transaction');
      },
    },
    $executeRaw: async (query: unknown) => {
      queries.push(query);
      return options.inserted;
    },
  };
  const db = {
    $transaction: async (fn: (client: typeof tx) => Promise<void>) => fn(tx),
  };
  return { db: db as unknown as PrismaClient, queries };
}

function down(code = 'P1001') {
  return Object.assign(new Error(`connect ${LEAK}`), { name: 'PrismaClientKnownRequestError', code });
}

async function rejectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(String(error).includes(LEAK), false);
    assert.equal(error.message.includes(LEAK), false);
    return true;
  });
}

test('whitelist is products.ts internal keys, not localized URL slugs', () => {
  assert.equal(CATALOG_PRODUCT_SLUGS.size, products.length);
  for (const product of products) assert.equal(CATALOG_PRODUCT_SLUGS.has(product.slug), true, product.slug);
  for (const category of categoryMeta) {
    if (category.en.slug !== category.key) assert.equal(CATALOG_PRODUCT_SLUGS.has(category.en.slug), false, category.en.slug);
    if (category.ru.slug !== category.key) assert.equal(CATALOG_PRODUCT_SLUGS.has(category.ru.slug), false, category.ru.slug);
  }
  assert.equal(CATALOG_PRODUCT_SLUGS.has('gift-cards'), true);
  assert.equal(CATALOG_PRODUCT_SLUGS.has('custom-greeting-cards'), false);
  assert.equal(CATALOG_PRODUCT_SLUGS.has('otkrytki-na-zakaz'), false);
  assert.equal(CATALOG_PRODUCT_SLUGS.has('custom-gift-cards'), false);
});

test('a catalog slug missing from Model3D is stored with the internal key', async () => {
  const { repo, batches, asked } = recordingRepo();
  const event = productView();
  const receipt = await service(repo).accept({ events: [event] }, HASH);
  assert.deepEqual(receipt.acceptedIds, [event.eventId]);
  assert.deepEqual(receipt.duplicateIds, []);
  assert.equal(asked.length, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].productSlug, 'gift-cards');
  assert.equal(batches[0][0].kind, 'product_view');
});

test('en and ru paths store the same internal productSlug', async () => {
  const { repo, batches } = recordingRepo();
  const en = productView({ locale: 'en', path: '/en/products/custom-greeting-cards' });
  const ru = productView({ locale: 'ru', path: '/ru/products/otkrytki-na-zakaz' });
  const receipt = await service(repo).accept({ events: [en, ru] }, HASH);
  assert.deepEqual([...receipt.acceptedIds].sort(), [en.eventId, ru.eventId].sort());
  assert.deepEqual(batches[0].map((item) => item.productSlug), ['gift-cards', 'gift-cards']);
  assert.deepEqual(batches[0].map((item) => item.path), ['/en/products/custom-greeting-cards', '/ru/products/otkrytki-na-zakaz']);
  assert.deepEqual(batches[0].map((item) => item.locale), ['en', 'ru']);
});

test('an unknown productSlug invalidates the whole batch', async () => {
  const { repo, batches } = recordingRepo();
  const page = pageView();
  const known = productView();
  const cases = [
    [page, known, productView({ productSlug: 'not-a-product' })],
    [known, productView({ productSlug: 'custom-greeting-cards' })],
    [productView({ productSlug: 'otkrytki-na-zakaz' })],
  ];
  for (const events of cases) {
    await assert.rejects(
      () => service(repo).accept({ events }, HASH),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'invalid');
        assert.equal(error.fieldErrors?.productSlug, 'Must be a published product.');
        return true;
      },
    );
  }
  assert.equal(batches.length, 0);
});

test('a published READY Model3D slug outside the catalog is still stored', async () => {
  const { repo, batches, asked } = recordingRepo(new Set(['ready-only-model']));
  const event = productView({ productSlug: 'ready-only-model', path: '/en/products' });
  const receipt = await service(repo).accept({ events: [event] }, HASH);
  assert.deepEqual(receipt.acceptedIds, [event.eventId]);
  assert.deepEqual(asked, [['ready-only-model']]);
  assert.equal(batches[0][0].productSlug, 'ready-only-model');
});

test('saveAll inserts with ON CONFLICT DO NOTHING and UTC timestamps', async () => {
  const { db, queries } = fakeDb({ before: null, after: null, inserted: 1 });
  const outcome = await createAnalyticsEventRepo(db).saveAll([row()]);
  assert.deepEqual(outcome, ['created']);
  assert.equal(queries.length, 1);
  const sql = sqlParts(queries[0]);
  assert.match(sql.text, /INSERT INTO "AnalyticsEvent"/);
  assert.match(sql.text, /ON CONFLICT DO NOTHING/);
  assert.match(sql.text, /::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(sql.text, /::"AnalyticsEventKind"/);
  assert.equal(sql.values.includes(NOW), true);
  assert.equal(sql.values.some((value) => value instanceof Date), false);
  assert.equal(sql.values.includes('gift-cards'), true);
});

test('a raced unique conflict returns duplicate without using create', async () => {
  const sample = row();
  const existing: Identity = {
    eventId: sample.eventId,
    semanticKey: sample.semanticKey,
    payloadHash: SAME_HASH,
    browserHash: HASH,
  };
  const { db, queries } = fakeDb({ before: null, after: existing, inserted: 0 });
  const outcome = await createAnalyticsEventRepo(db).saveAll([sample]);
  assert.deepEqual(outcome, ['duplicate']);
  assert.equal(queries.length, 1);
  assert.match(sqlParts(queries[0]).text, /ON CONFLICT DO NOTHING/);
});

test('a raced row with a different payload is a conflict', async () => {
  const sample = row();
  const existing: Identity = {
    eventId: sample.eventId,
    semanticKey: sample.semanticKey,
    payloadHash: OTHER_HASH,
    browserHash: HASH,
  };
  const { db } = fakeDb({ before: null, after: existing, inserted: 0 });
  await assert.rejects(
    () => createAnalyticsEventRepo(db).saveAll([sample]),
    (error: unknown) => error instanceof AnalyticsPayloadConflict,
  );
});

test('database unavailable while checking or saving becomes service_unavailable', async () => {
  const checking: AnalyticsEventRepo = {
    async publishedSlugs() {
      throw down();
    },
    async saveAll() {
      throw new Error('save should not run');
    },
  };
  await rejectCode(
    () => service(checking).accept({ events: [productView({ productSlug: 'not-a-product' })] }, HASH),
    'service_unavailable',
  );
  const saving: AnalyticsEventRepo = {
    async publishedSlugs() {
      return new Set();
    },
    async saveAll() {
      throw down('P1001');
    },
  };
  await rejectCode(() => service(saving).accept({ events: [productView()] }, HASH), 'service_unavailable');
  const other: AnalyticsEventRepo = {
    async publishedSlugs() {
      return new Set();
    },
    async saveAll() {
      throw new Error(`constraint ${LEAK}`);
    },
  };
  await assert.rejects(
    () => service(other).accept({ events: [productView()] }, HASH),
    (error: unknown) => error instanceof Error && !(error instanceof AppError) && error.message.includes(LEAK),
  );
});

test('POST /api/analytics/events maps database unavailable to 503 without driver text', async () => {
  setRateLimitStore(new MemoryStore());
  try {
    const now = new Date(NOW);
    const consent = createAnalyticsConsentService({ secret: SECRET, clock: () => now });
    const granted = consent.apply({ analytics: true, consentVersion: CONSENT_VERSION, secure: false });
    assert.equal(granted.ok, true);
    if (!granted.ok) return;
    const failure = Object.assign(new Error(`connect ${LEAK}`), { name: 'PrismaClientInitializationError' });
    const db = {
      model3D: { findMany: async () => { throw failure; } },
      $transaction: async () => { throw failure; },
      siteSetting: { findUnique: async () => null },
      $executeRaw: async () => 1,
    } as unknown as PrismaClient;
    const POST = createEventsPost({
      db,
      config: loadServerConfig({ APP_ENV: 'test' }),
      clock: () => now,
      env: { APP_ENV: 'test' },
      secret: SECRET,
    });
    const response = await POST(new Request('http://127.0.0.1/api/analytics/events', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1',
        cookie: granted.setCookie.split(';', 1)[0],
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: [productView()] }),
    }));
    const text = await response.text();
    assert.equal(response.status, 503, text);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = AppErrorDTOSchema.parse(JSON.parse(text));
    assert.equal(body.error, 'service_unavailable');
    assert.equal(text.includes(LEAK), false);
    assert.equal(text.includes('Prisma'), false);
  } finally {
    setRateLimitStore(undefined);
  }
});

test('legacy-response keeps status and body and sets private no-store', async () => {
  const body = JSON.stringify({ error: 'legacy_kept' });
  const POST = createEventsPost({
    env: { APP_ENV: 'test' },
    services: {
      consent: {
        verifyValue() {
          throw new Response(body, {
            status: 409,
            statusText: 'Conflict',
            headers: {
              'content-type': 'application/json',
              'cache-control': 'public, max-age=60',
              'x-kept': 'yes',
            },
          });
        },
      },
      ingest: { accept: async () => { throw new Error('ingest should not run'); } },
      apiCounter: { recordFinalResponse: async () => { throw new Error('counter should not run'); } },
    } as unknown as AnalyticsIngestServices,
  });
  const response = await POST(new Request('http://127.0.0.1/api/analytics/events', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1', cookie: 'pj_analytics=present', 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.equal(response.status, 409);
  assert.equal(response.statusText, 'Conflict');
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-kept'), 'yes');
  assert.equal(response.headers.get('content-type'), 'application/json');
});
