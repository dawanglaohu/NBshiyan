import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexNowDedupeStore, activeIndexNowKey, pathsForSanityDoc, pathsForModelPublish, submitIndexNow, INDEXNOW_ENDPOINT } from '../src/lib/seo/indexnow';
import { MemoryStore } from '../src/lib/server/ratelimit';

const KEY = 'abcDEF12-3456';
const PROD = { VERCEL_ENV: 'production', INDEXNOW_KEY: KEY, NEXT_PUBLIC_SITE_URL: 'https://packjoyu.example' };
const LIVE = { product: { live: true, prefix: 'products' }, article: { live: false, prefix: 'articles' } };

test('key: only in production with valid format', () => {
  assert.equal(activeIndexNowKey(PROD), KEY);
  assert.equal(activeIndexNowKey({ ...PROD, VERCEL_ENV: 'preview' }), null);
  assert.equal(activeIndexNowKey({ ...PROD, INDEXNOW_KEY: undefined }), null);
  for (const bad of ['short', 'has space 12345', 'a'.repeat(129), 'bad_underscore1', '../etc/passwd'])
    assert.equal(activeIndexNowKey({ ...PROD, INDEXNOW_KEY: bad }), null, bad);
});

test('paths: both locales, skips noindex / not-live / bad slug', () => {
  const doc = { _type: 'product', slug: { en: { current: 'custom-gift-boxes' }, ru: { current: 'podarochnye-korobki' } } };
  assert.deepEqual(pathsForSanityDoc(doc, LIVE), ['/en/products/custom-gift-boxes', '/ru/products/podarochnye-korobki']);
  assert.deepEqual(pathsForSanityDoc({ ...doc, seo: { noindex: true } }, LIVE), []);
  assert.deepEqual(pathsForSanityDoc({ ...doc, _type: 'article' }, LIVE), []);
  assert.deepEqual(pathsForSanityDoc({ ...doc, _type: 'unknown' }, LIVE), []);
  assert.deepEqual(pathsForSanityDoc({ _type: 'product', slug: { en: { current: 'Bad Slug/../x' } } }, LIVE), []);
  assert.deepEqual(pathsForSanityDoc(doc), []); // 默认全部未上线
  assert.deepEqual(pathsForModelPublish(), ['/en/products', '/ru/products']);
});

function fakeFetch(status = 200) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status }); }) as unknown as typeof fetch;
  return { f, calls };
}

test('submit: one batched POST, dedupe within window', async () => {
  const { f, calls } = fakeFetch();
  const store = new MemoryStore();
  const n = await submitIndexNow(['/en/products/a', '/ru/products/b', '/en/products/a'], { env: PROD, store, fetchImpl: f, log: () => {} });
  assert.equal(n, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, INDEXNOW_ENDPOINT);
  assert.deepEqual(calls[0].body, { host: 'packjoyu.example', key: KEY, keyLocation: `https://packjoyu.example/${KEY}.txt`, urlList: ['https://packjoyu.example/en/products/a', 'https://packjoyu.example/ru/products/b'] });
  assert.equal(await submitIndexNow(['/en/products/a'], { env: PROD, store, fetchImpl: f, log: () => {} }), 0);
  assert.equal(calls.length, 1);
});

test('submit: off outside production, non-https site or junk paths', async () => {
  const { f, calls } = fakeFetch();
  const d = { store: new MemoryStore(), fetchImpl: f, log: () => {} };
  assert.equal(await submitIndexNow(['/en/x'], { ...d, env: { ...PROD, VERCEL_ENV: 'preview' } }), 0);
  assert.equal(await submitIndexNow(['/en/x'], { ...d, env: { ...PROD, NEXT_PUBLIC_SITE_URL: 'http://a.example' } }), 0);
  assert.equal(await submitIndexNow(['https://evil.example/x', '/de/x', '/en/../admin'], { ...d, env: PROD }), 0);
  assert.equal(calls.length, 0);
});

test('submit: never throws, logs only error type without secrets', async () => {
  const logs: string[] = [];
  const boom = (async () => { throw Object.assign(new Error(`secret ${KEY}`), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
  assert.equal(await submitIndexNow(['/en/a'], { env: PROD, store: new MemoryStore(), fetchImpl: boom, log: (m) => logs.push(m) }), 0);
  const { f } = fakeFetch(429);
  assert.equal(await submitIndexNow(['/en/b'], { env: PROD, store: new MemoryStore(), fetchImpl: f, log: (m) => logs.push(m) }), 0);
  assert.deepEqual(logs, ['[indexnow] errorSummary=TimeoutError', '[indexnow] errorSummary=http_429']);
  assert.ok(logs.every((l) => !l.includes(KEY)));
});

test('dedupe store: Upstash only; off without it; upstash failure = no push', async () => {
  assert.equal(indexNowDedupeStore({ RATE_LIMIT_STORE: 'memory' }), null);
  assert.equal(indexNowDedupeStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't' }), null);
  const { f, calls } = fakeFetch();
  // 没有 Upstash 时整个功能关闭
  assert.equal(await submitIndexNow(['/en/a'], { env: { ...PROD, RATE_LIMIT_STORE: 'memory' }, fetchImpl: f, log: () => {} }), 0);
  assert.equal(calls.length, 0);
  const st = indexNowDedupeStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://127.0.0.1:1', UPSTASH_REDIS_REST_TOKEN: 't' })!;
  const err = console.error; console.error = () => {};
  try { assert.equal(await st.hit('https://packjoyu.example/en/a', 1, 1000), false); } finally { console.error = err; }
});

test('urls only from NEXT_PUBLIC_SITE_URL, endpoint fixed', async () => {
  const { f, calls } = fakeFetch();
  const doc = { _type: 'product', slug: { en: { current: 'x-evil-example' } }, host: 'evil.example', url: 'https://evil.example/' } as any;
  await submitIndexNow(pathsForSanityDoc(doc, LIVE), { env: PROD, store: new MemoryStore(), fetchImpl: f, log: () => {} });
  assert.equal(calls[0].url, 'https://api.indexnow.org/indexnow');
  assert.equal(calls[0].body.host, 'packjoyu.example');
  assert.ok(calls[0].body.urlList.every((u: string) => u.startsWith('https://packjoyu.example/en/')));
});

test('submit: hanging endpoint is aborted by timeout, logged without secrets, never throws', async () => {
  const logs: string[] = [];
  let sawSignal = false;
  const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
    sawSignal = init.signal instanceof AbortSignal;
    init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
  })) as unknown as typeof fetch;
  const n = await submitIndexNow(['/en/a'], { env: PROD, store: new MemoryStore(), fetchImpl: hang, log: (m) => logs.push(m), timeoutMs: 50 });
  assert.equal(n, 0);
  assert.ok(sawSignal);
  assert.deepEqual(logs, ['[indexnow] errorSummary=TimeoutError']);
  assert.ok(logs.every((l) => !l.includes(KEY)));
});

test('submit: 5xx and network errors return 0; protocol-relative / backslash paths never pushed', async () => {
  const logs: string[] = [];
  const { f, calls } = fakeFetch(503);
  assert.equal(await submitIndexNow(['/en/a'], { env: PROD, store: new MemoryStore(), fetchImpl: f, log: (m) => logs.push(m) }), 0);
  const net = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  await assert.doesNotReject(submitIndexNow(['/en/b'], { env: PROD, store: new MemoryStore(), fetchImpl: net, log: (m) => logs.push(m) }));
  assert.deepEqual(logs, ['[indexnow] errorSummary=http_503', '[indexnow] errorSummary=TypeError']);
  const before = calls.length;
  assert.equal(await submitIndexNow(['//evil.com/x', '/\\evil.com/x', '/en//evil.com'], { env: PROD, store: new MemoryStore(), fetchImpl: f, log: () => {} }), 0);
  assert.equal(calls.length, before);
});
