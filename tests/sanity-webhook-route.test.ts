import { test, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { signPayload } from '../src/lib/server/sanity-webhook';

// Public fixtures generated and cross-validated with @sanity/webhook 4.0.4.
const vectors = JSON.parse(readFileSync('tests/fixtures/sanity-webhook-vectors.json', 'utf8')) as Array<{
  body: string; secret: string; timestamp: number; signature: string;
}>;
const vector = vectors[2];
const tags: string[] = [];
const queued: Array<() => unknown> = [];
const submitted: string[][] = [];
const req = createRequire(path.resolve('src/app/api/sanity/revalidate/route.ts'));

function override(specifier: string, exports: Record<string, unknown>) {
  const file = req.resolve(specifier);
  const mod = new Module(file); mod.filename = file; mod.loaded = true; mod.exports = exports;
  (req.cache as Record<string, unknown>)[file] = mod;
}

// Next's cache and after require a server request context; retain the real NextResponse.
override('next/cache', { ...req('next/cache'), revalidateTag: (tag: string) => tags.push(tag) });
override('next/server', { ...req('next/server'), after: (fn: () => unknown) => queued.push(fn) });
const indexnowFile = path.resolve('src/lib/seo/indexnow.ts');
const indexnow = req(indexnowFile) as typeof import('../src/lib/seo/indexnow');
override(indexnowFile, {
  ...indexnow,
  submitIndexNow: async (paths: string[]) => { submitted.push([...paths]); return 0; },
});

let POST: (request: Request) => Promise<Response>;
before(async () => { POST = (await import('../src/app/api/sanity/revalidate/route')).POST; });
beforeEach(() => {
  tags.length = 0; queued.length = 0; submitted.length = 0;
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'production'; env.SANITY_WEBHOOK_SECRET = vector.secret;
  delete env.SANITY_REVALIDATE_SECRET;
  indexnow.INDEXNOW_LIVE_TYPES.article.live = false;
  mock.method(Date, 'now', () => vector.timestamp);
  mock.method(console, 'warn', () => {});
});
afterEach(() => { indexnow.INDEXNOW_LIVE_TYPES.article.live = false; mock.restoreAll(); });

const request = (body = vector.body, signature: string | null = vector.signature, authorization?: string) => new Request('https://app.example/api/sanity/revalidate', {
  method: 'POST', body,
  headers: { 'content-type': 'application/json', ...(signature ? { 'sanity-webhook-signature': signature } : {}), ...(authorization ? { authorization } : {}) },
});

test('route: official signature revalidates before deferred IndexNow submission', async () => {
  indexnow.INDEXNOW_LIVE_TYPES.article.live = true;
  const response = await POST(request());
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { revalidated: 'sanity:article' });
  assert.deepEqual(tags, ['sanity:article']);
  assert.equal(queued.length, 1); assert.deepEqual(submitted, []);
  await queued[0]();
  assert.deepEqual(submitted, [['/en/articles/gift-guide', '/ru/articles/podarki']]);
});

test('route: current not-live types revalidate without scheduling IndexNow', async () => {
  assert.equal((await POST(request())).status, 200);
  assert.deepEqual(tags, ['sanity:article']); assert.equal(queued.length, 0);
});

test('route: signed noindex documents revalidate without IndexNow submission', async () => {
  indexnow.INDEXNOW_LIVE_TYPES.article.live = true;
  const document = JSON.parse(vector.body);
  document.seo.noindex = true;
  const body = JSON.stringify(document);
  assert.equal((await POST(request(body, signPayload(body, vector.secret, vector.timestamp)))).status, 200);
  assert.deepEqual(tags, ['sanity:article']); assert.equal(queued.length, 0);
});

test('route: raw whitespace and Unicode match an official toolkit signature', async () => {
  const v = vectors[1];
  process.env.SANITY_WEBHOOK_SECRET = v.secret;
  assert.equal((await POST(request(v.body, v.signature))).status, 200);
  assert.deepEqual(tags, ['sanity:product']);
});

test('route: tampering, absent signatures and Bearer-only requests have no side effects', async () => {
  process.env.SANITY_REVALIDATE_SECRET = 'legacy-test-secret';
  for (const r of [request(vector.body + ' '), request(vector.body, null), request(vector.body, null, 'Bearer legacy-test-secret')]) {
    const response = await POST(r);
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(tags, []); assert.equal(queued.length, 0);
});

test('route: signed malformed or unrecognized payloads and oversized bodies are rejected', async () => {
  for (const body of ['not json', '{"_type":"unknown"}', '{"_type":"../x"}']) {
    const r = await POST(request(body, signPayload(body, vector.secret, vector.timestamp)));
    assert.equal(r.status, 400);
  }
  const body = '界'.repeat(2_667); // 8,001 UTF-8 bytes, fewer than 8,000 characters.
  assert.equal((await POST(request(body, signPayload(body, vector.secret, vector.timestamp)))).status, 413);
  assert.deepEqual(tags, []); assert.equal(queued.length, 0);
});

test('route: missing configuration fails closed before consuming the body', async () => {
  delete process.env.SANITY_WEBHOOK_SECRET;
  const r = request();
  assert.equal((await POST(r)).status, 503); assert.equal(r.bodyUsed, false);
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'development';
  assert.equal((await POST(request())).status, 401);
  assert.deepEqual(tags, []); assert.equal(queued.length, 0);
});
