// 真实 TCP 上的 POST /api/analytics/consent。限流存储是进程全局的，整组串行，每条用例前换一块新的内存存储。
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as consentRoute from '../src/app/api/analytics/consent/route';
import { createConsentPost } from '../src/app/api/analytics/consent/post';
import { ConsentDTOSchema } from '../src/lib/contracts/analytics';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { CONSENT_MAX_AGE_MS, CONSENT_VERSION } from '../src/lib/consent';
import {
  ANALYTICS_COOKIE_MAX_LENGTH,
  CONSENT_BODY_MAX_BYTES,
  CONSENT_COOKIE_RATE_LIMIT,
  CONSENT_IP_RATE_LIMIT,
  createAnalyticsConsentService,
} from '../src/lib/server/analytics/consent';
import { analyticsConsentSecret, loadServerConfig } from '../src/lib/server/config';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const PLANTED_EMAIL = 'planted-m5t2@example.com';
const PLANTED_IP = '203.0.113.44';
const LEAKTOKEN = 'db-credential-LEAKTOKEN';
const SECRET = Buffer.from('a'.repeat(32));
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const config = loadServerConfig({ APP_ENV: 'test' });

type HttpResult = {
  status: number;
  text: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  cookies: string[];
};

const writes: unknown[] = [];
const db = {
  siteSetting: { findUnique: async () => null },
  $executeRaw: async (query: unknown) => {
    writes.push(query);
    return 1;
  },
};

let now = new Date('2026-06-01T00:00:00.000Z');
let port = 0;
let server: http.Server | undefined;
let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 500 });

class CountingStore extends MemoryStore {
  readonly seen: string[] = [];
  override async hit(key: string, limit: number, windowMs: number) {
    this.seen.push(key);
    return super.hit(key, limit, windowMs);
  }
}

function makePost(extra: Parameters<typeof createConsentPost>[0] = {}) {
  return createConsentPost({
    db,
    config,
    clock: () => now,
    env: { APP_ENV: 'test' },
    secret: SECRET,
    ...extra,
  });
}

function service(extra: Parameters<typeof createAnalyticsConsentService>[0] = {}) {
  return createAnalyticsConsentService({ secret: SECRET, clock: () => now, ...extra });
}

function consentBody(analytics: boolean, consentVersion = CONSENT_VERSION) {
  return { analytics, consentVersion };
}

function assertNoPlanted(result: HttpResult) {
  assert.equal(result.text.includes(PLANTED_EMAIL), false);
  assert.equal(result.text.includes(PLANTED_IP), false);
  const headers = JSON.stringify(result.headers);
  assert.equal(headers.includes(PLANTED_EMAIL), false);
  assert.equal(headers.includes(PLANTED_IP), false);
}

function tokenOf(setCookie: string | undefined): string {
  assert.ok(setCookie);
  assert.equal(setCookie.startsWith('pj_analytics='), true);
  return setCookie.split(';', 1)[0].slice('pj_analytics='.length);
}

function browserIdOf(token: string): string {
  return token.split('.')[1] ?? '';
}

function maxAgeOf(cookie: string): number {
  const match = /Max-Age=(\d+)/.exec(cookie);
  assert.ok(match);
  return Number(match[1]);
}

function httpPost(options: {
  origin?: string | null;
  cookie?: string;
  json?: unknown;
  raw?: string | Buffer;
  headers?: Record<string, string>;
} = {}): Promise<HttpResult> {
  const payload = options.raw !== undefined
    ? (Buffer.isBuffer(options.raw) ? options.raw : Buffer.from(options.raw))
    : Buffer.from(JSON.stringify(options.json ?? consentBody(true)));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'x-planted-email': PLANTED_EMAIL,
    'x-forwarded-for': PLANTED_IP,
    ...(options.headers ?? {}),
  };
  if (options.origin !== null) headers.origin = options.origin ?? `http://127.0.0.1:${port}`;
  if (options.cookie) headers.cookie = options.cookie;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/analytics/consent',
      method: 'POST',
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        const rawCookies = res.headers['set-cookie'] ?? [];
        resolve({
          status: res.statusCode ?? 0,
          text,
          body,
          headers: res.headers,
          cookies: Array.isArray(rawCookies) ? rawCookies : [rawCookies],
        });
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error('consent http timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function fromResponse(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const headers: http.IncomingHttpHeaders = {};
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  return { status: response.status, text, body, headers, cookies: response.headers.getSetCookie() };
}

describe('POST /api/analytics/consent', { concurrency: false }, () => {
  before(async () => {
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
        const cookies = response.headers.getSetCookie();
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') res.setHeader(key, value);
        });
        if (cookies.length > 0) res.setHeader('set-cookie', cookies);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.statusCode = 500;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address() as AddressInfo | null;
        port = address?.port ?? 0;
        resolve();
      });
    });
  });

  beforeEach(() => {
    now = new Date('2026-06-01T00:00:00.000Z');
    writes.length = 0;
    setRateLimitStore(new MemoryStore());
    handler = makePost();
  });

  after(async () => {
    setRateLimitStore(undefined);
    await new Promise<void>((resolve) => {
      if (!server) { resolve(); return; }
      server.close(() => resolve());
    });
  });

  test('route registers only POST', () => {
    assert.equal(typeof consentRoute.POST, 'function');
    assert.equal(consentRoute.runtime, 'nodejs');
    assert.equal('GET' in consentRoute, false);
    assert.equal('createConsentPost' in consentRoute, false);
  });

  test('first true keeps the original id and expiry', async () => {
    let minted = 0;
    handler = makePost({
      randomId: () => {
        minted += 1;
        return minted === 1 ? ID_A : ID_B;
      },
    });
    const first = await httpPost();
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    const dto = ConsentDTOSchema.parse(first.body);
    assert.equal(dto.analytics, true);
    assert.deepEqual(Object.keys(first.body as object).sort(), ['analytics', 'expiresAt']);
    assertNoPlanted(first);
    const cookie = first.cookies[0];
    assert.ok(cookie);
    assert.match(cookie, /^pj_analytics=[^;]+; Path=\/api\/analytics; HttpOnly; SameSite=Lax; Max-Age=\d+; Expires=/);
    assert.equal(cookie.includes('Secure'), false);
    assert.equal(cookie.includes('Domain='), false);
    assert.equal(maxAgeOf(cookie), CONSENT_MAX_AGE_MS / 1000);
    assert.equal(cookie.includes(`Expires=${new Date(dto.expiresAt).toUTCString()}`), true);
    const token = tokenOf(cookie);
    assert.equal(browserIdOf(token), ID_A);
    assert.equal(first.text.includes(ID_A), false);
    const verified = service().verifyValue(token);
    assert.ok(verified);
    assert.equal(verified.browserId, ID_A);
    assert.equal(first.text.includes(verified.browserHash), false);
    assert.equal(minted, 1);

    now = new Date(now.getTime() + 60 * 60 * 1000);
    const second = await httpPost({ cookie: `pj_analytics=${token}` });
    const again = ConsentDTOSchema.parse(second.body);
    assert.equal(again.expiresAt, dto.expiresAt);
    assert.equal(tokenOf(second.cookies[0]), token);
    assert.equal(maxAgeOf(second.cookies[0] ?? ''), CONSENT_MAX_AGE_MS / 1000 - 3600);
    assert.equal(minted, 1);
    assert.equal(writes.length, 2);
  });

  test('false and a repeated false clear the cookie without an identity', async () => {
    let minted = 0;
    handler = makePost({
      randomId: () => {
        minted += 1;
        return minted === 1 ? ID_A : ID_B;
      },
    });
    const first = await httpPost();
    const token = tokenOf(first.cookies[0]);
    const cleared = await httpPost({ json: consentBody(false), cookie: `pj_analytics=${token}` });
    assert.deepEqual(ConsentDTOSchema.parse(cleared.body), { analytics: false, expiresAt: null });
    assert.match(cleared.cookies[0] ?? '', /^pj_analytics=; Path=\/api\/analytics; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);
    assert.equal(minted, 1);
    assert.ok(service().verifyValue(token));
    const repeated = await httpPost({ json: consentBody(false) });
    assert.equal(repeated.status, 200);
    assert.match(repeated.cookies[0] ?? '', /^pj_analytics=;/);
    const replayed = await httpPost({ json: consentBody(false), cookie: `pj_analytics=${token}` });
    assert.equal(replayed.status, 200);
    assert.equal(minted, 1);
    const renewed = await httpPost();
    assert.equal(browserIdOf(tokenOf(renewed.cookies[0])), ID_B);
    assert.notEqual(tokenOf(renewed.cookies[0]), token);
    assert.equal(minted, 2);
  });

  test('a forged or missing cookie cannot verify', async () => {
    let minted = 0;
    handler = makePost({
      randomId: () => {
        minted += 1;
        return minted === 1 ? ID_A : ID_B;
      },
    });
    const first = await httpPost();
    const token = tokenOf(first.cookies[0]);
    const forged = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    assert.equal(service().verifyValue(forged), null);
    assert.equal(service().verifyValue(''), null);
    assert.equal(service().verifyHeader(null), null);
    const replaced = await httpPost({ cookie: `pj_analytics=${forged}` });
    assert.equal(browserIdOf(tokenOf(replaced.cookies[0])), ID_B);
    assert.equal(service().verifyHeader('pj_analytics=one; pj_analytics=two'), null);
    const ambiguous = await httpPost({ cookie: 'pj_analytics=one; pj_analytics=two' });
    assert.equal(ambiguous.cookies.length, 1);
    assert.equal(browserIdOf(tokenOf(ambiguous.cookies[0])), ID_B);
  });

  test('expiry rejects the equal instant and allows sixty seconds of future skew', async () => {
    const issuedAt = now.getTime();
    handler = makePost({ randomId: () => ID_A });
    const first = await httpPost();
    const token = tokenOf(first.cookies[0]);
    const expiresAt = Date.parse(ConsentDTOSchema.parse(first.body).expiresAt);
    now = new Date(expiresAt - 1);
    assert.ok(service().verifyValue(token));
    const kept = await httpPost({ cookie: `pj_analytics=${token}` });
    assert.equal(tokenOf(kept.cookies[0]), token);

    now = new Date(expiresAt);
    assert.equal(service().verifyValue(token), null);
    handler = makePost({ randomId: () => ID_B });
    const replaced = await httpPost({ cookie: `pj_analytics=${token}` });
    assert.equal(browserIdOf(tokenOf(replaced.cookies[0])), ID_B);

    now = new Date(issuedAt);
    handler = makePost({ randomId: () => ID_A });
    const fresh = tokenOf((await httpPost()).cookies[0]);
    now = new Date(issuedAt - 61_000);
    assert.equal(service().verifyValue(fresh), null);
    now = new Date(issuedAt - 60_000);
    assert.ok(service().verifyValue(fresh));
  });

  test('origin must match exactly and a rejection does not spend the ip budget', async () => {
    const origins: Array<string | null> = [
      null,
      'null',
      `http://127.0.0.1:${port}/en`,
      `http://127.0.0.1:${port}.evil.example`,
      'https://evil.example',
    ];
    for (const origin of origins) {
      const denied = await httpPost({ origin });
      assert.equal(denied.status, 403);
      const body = AppErrorDTOSchema.parse(denied.body);
      assert.equal(body.error, 'forbidden_origin');
      assert.equal(denied.cookies.length, 0);
      assert.equal(denied.headers['cache-control'], 'private, no-store');
      assertNoPlanted(denied);
    }
    const referer = await httpPost({ origin: null, headers: { referer: `http://127.0.0.1:${port}/en` } });
    assert.equal(referer.status, 403);
    for (let i = 0; i < CONSENT_IP_RATE_LIMIT; i += 1) {
      assert.equal((await httpPost({ json: consentBody(false) })).status, 200);
    }
  });

  test('strict boolean parsing rejects the body without echoing it', async () => {
    const asText = await httpPost({ json: { analytics: 'true', consentVersion: CONSENT_VERSION } });
    assert.equal(asText.status, 400);
    assert.equal(AppErrorDTOSchema.parse(asText.body).fieldErrors?.analytics, 'Must be a boolean.');
    assert.equal(asText.cookies.length, 0);

    const zero = await httpPost({ json: { analytics: true, consentVersion: 0 } });
    assert.equal(AppErrorDTOSchema.parse(zero.body).fieldErrors?.consentVersion, 'Must be a positive integer.');

    const extra = await httpPost({
      json: { analytics: true, consentVersion: CONSENT_VERSION, email: PLANTED_EMAIL, ip: PLANTED_IP },
    });
    assert.equal(extra.status, 400);
    assert.equal(AppErrorDTOSchema.parse(extra.body).fieldErrors, undefined);
    assertNoPlanted(extra);
    assert.equal(extra.cookies.length, 0);

    const broken = await httpPost({ raw: `{"email":"${PLANTED_EMAIL}"` });
    assert.equal(broken.status, 400);
    assert.equal(AppErrorDTOSchema.parse(broken.body).fieldErrors, undefined);
    assertNoPlanted(broken);

    for (const raw of ['', 'null', '[]']) {
      const denied = await httpPost({ raw });
      assert.equal(denied.status, 400, raw);
      assertNoPlanted(denied);
    }

    const marker = 'BODYMARKER-m5t2';
    const tooBig = await httpPost({ raw: Buffer.concat([Buffer.from(marker), Buffer.alloc(CONSENT_BODY_MAX_BYTES, 0x62)]) });
    assert.equal(tooBig.status, 413);
    assert.equal(AppErrorDTOSchema.parse(tooBig.body).error, 'too_large');
    assert.equal(tooBig.text.includes(marker), false);
    assert.equal(tooBig.cookies.length, 0);
  });

  test('a different consent version writes no cookie', async () => {
    const issued = await httpPost();
    const cookie = `pj_analytics=${tokenOf(issued.cookies[0])}`;
    const wrong = await httpPost({ cookie, json: { analytics: false, consentVersion: CONSENT_VERSION + 1 } });
    assert.equal(wrong.status, 400);
    assert.equal(AppErrorDTOSchema.parse(wrong.body).fieldErrors?.consentVersion, 'Must be the current consent version.');
    assert.equal(wrong.cookies.length, 0);
  });

  test('the ip bucket stops the 21st request before consent is granted', async () => {
    let minted = 0;
    handler = makePost({
      randomId: () => {
        minted += 1;
        return ID_A;
      },
    });
    for (let i = 0; i < CONSENT_IP_RATE_LIMIT; i += 1) {
      assert.equal((await httpPost({ json: consentBody(false) })).status, 200);
    }
    const blocked = await httpPost({
      json: { analytics: true, consentVersion: CONSENT_VERSION, email: PLANTED_EMAIL },
    });
    assert.equal(blocked.status, 429);
    const body = AppErrorDTOSchema.parse(blocked.body);
    assert.equal(body.error, 'rate_limited');
    assert.equal(body.fieldErrors, undefined);
    assert.equal(blocked.headers['retry-after'], '600');
    assert.equal(blocked.cookies.length, 0);
    assert.equal(minted, 0);
    assertNoPlanted(blocked);
  });

  test('one presented cookie has its own bucket and does not burn the ip bucket when denied', async () => {
    const store = new CountingStore();
    setRateLimitStore(store);
    const cookie = 'pj_analytics=same-token';
    for (let i = 0; i < CONSENT_COOKIE_RATE_LIMIT; i += 1) {
      assert.equal((await httpPost({ cookie, json: consentBody(false) })).status, 200);
    }
    const blocked = await httpPost({ cookie, json: consentBody(false) });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '600');
    assert.equal(blocked.cookies.length, 0);
    assert.equal(store.seen.filter((key) => key.includes('analytics:consent:cookie:')).length, CONSENT_COOKIE_RATE_LIMIT + 1);
    assert.equal(store.seen.filter((key) => key.includes('analytics:consent:ip:')).length, CONSENT_COOKIE_RATE_LIMIT);
    assert.equal((await httpPost({ cookie: 'pj_analytics=other-token', json: consentBody(false) })).status, 200);
  });

  test('an overlong cookie is not a rate-limit key', async () => {
    const store = new CountingStore();
    setRateLimitStore(store);
    const value = 'v'.repeat(ANALYTICS_COOKIE_MAX_LENGTH + 1);
    assert.equal(service().verifyValue(value), null);
    handler = makePost({ randomId: () => ID_A });
    const minted = await httpPost({ cookie: `pj_analytics=${value}` });
    assert.equal(minted.status, 200);
    assert.equal(browserIdOf(tokenOf(minted.cookies[0])), ID_A);
    assert.equal(store.seen.some((key) => key.includes('analytics:consent:cookie:')), false);
    assert.equal(store.seen.some((key) => key.includes('analytics:consent:ip:')), true);
  });

  test('a failing rate-limit store rejects without the store error text', async () => {
    setRateLimitStore({
      async hit() { throw new Error(LEAKTOKEN); },
      async refund() { return undefined; },
    });
    const blocked = await httpPost({ json: consentBody(false) });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.text.includes(LEAKTOKEN), false);
    assert.equal(JSON.stringify(blocked.headers).includes(LEAKTOKEN), false);
    assert.equal(blocked.cookies.length, 0);
  });

  test('a missing signing key refuses true and still clears false', async () => {
    let minted = 0;
    handler = makePost({
      secret: null,
      randomId: () => {
        minted += 1;
        return ID_A;
      },
    });
    const denied = await httpPost({ cookie: 'pj_analytics=already-there' });
    assert.equal(denied.status, 503);
    assert.equal(AppErrorDTOSchema.parse(denied.body).error, 'service_unavailable');
    assert.equal(denied.cookies.length, 0);
    assert.equal(minted, 0);
    const cleared = await httpPost({ json: consentBody(false) });
    assert.deepEqual(ConsentDTOSchema.parse(cleared.body), { analytics: false, expiresAt: null });
    assert.match(cleared.cookies[0] ?? '', /Max-Age=0/);
    assert.match(cleared.cookies[0] ?? '', /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    assert.equal(minted, 0);
  });

  test('a non-uuid identity is rejected without echoing the value', async () => {
    handler = makePost({ randomId: () => 'not-a-uuid' });
    const response = await httpPost();
    assert.equal(response.status, 500);
    assert.equal(AppErrorDTOSchema.parse(response.body).error, 'internal_error');
    assert.equal(response.text.includes('not-a-uuid'), false);
    assert.equal(response.cookies.length, 0);
  });

  test('the signing root is the existing privacy secret and is not copied into config', () => {
    const raw = 'c'.repeat(32);
    assert.equal(analyticsConsentSecret({}), null);
    assert.equal(analyticsConsentSecret({ PRIVACY_HASH_SECRET: 'c'.repeat(31) }), null);
    const loaded = analyticsConsentSecret({ PRIVACY_HASH_SECRET: raw });
    assert.equal(loaded?.length, raw.length);
    assert.equal(JSON.stringify(loadServerConfig({ APP_ENV: 'test', PRIVACY_HASH_SECRET: raw })).includes(raw), false);
    const clock = () => new Date('2026-06-01T00:00:00.000Z');
    const randomId = () => ID_A;
    const first = createAnalyticsConsentService({ secret: Buffer.from(raw), clock, randomId }).apply({
      analytics: true, consentVersion: CONSENT_VERSION, secure: false,
    });
    const second = createAnalyticsConsentService({ secret: Buffer.from('d'.repeat(32)), clock, randomId }).apply({
      analytics: true, consentVersion: CONSENT_VERSION, secure: false,
    });
    assert.equal(first.ok && second.ok, true);
    if (first.ok && second.ok) assert.notEqual(first.setCookie, second.setCookie);
    const again = createAnalyticsConsentService({ secret: Buffer.from(raw), clock, randomId }).apply({
      analytics: true, consentVersion: CONSENT_VERSION, secure: false,
    });
    assert.equal(first.ok && again.ok && again.setCookie, first.ok ? first.setCookie : '');
    assert.deepEqual(createAnalyticsConsentService({ clock }).apply({
      analytics: true, consentVersion: CONSENT_VERSION, secure: false,
    }), { ok: false, code: 'service_unavailable' });
    assert.deepEqual(createAnalyticsConsentService({ env: {}, clock }).apply({
      analytics: true, consentVersion: CONSENT_VERSION, secure: false,
    }), { ok: false, code: 'service_unavailable' });
  });

  test('production sets Secure and ignores the request host', async () => {
    handler = makePost({ env: { APP_ENV: 'production', APP_ORIGIN: `http://127.0.0.1:${port}` } });
    const ok = await httpPost();
    assert.equal(ok.status, 200);
    assert.equal(ok.cookies[0]?.includes('Secure'), true);
    const denied = await httpPost({ origin: 'https://evil.example' });
    assert.equal(denied.status, 403);

    const post = makePost({ env: { APP_ENV: 'production', APP_ORIGIN: 'https://packjoyu.example' } });
    const wrongHost = await fromResponse(await post(new Request('http://127.0.0.1:3000/api/analytics/consent', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: JSON.stringify(consentBody(true)),
    })));
    assert.equal(wrongHost.status, 403);
    const allowed = await fromResponse(await post(new Request('http://127.0.0.1:3000/api/analytics/consent', {
      method: 'POST',
      headers: { origin: 'https://packjoyu.example', 'content-type': 'application/json' },
      body: JSON.stringify(consentBody(true)),
    })));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.cookies[0]?.includes('Secure'), true);

    const preview = makePost();
    const previewResponse = await fromResponse(await preview(new Request('http://preview.example/api/analytics/consent', {
      method: 'POST',
      headers: { origin: 'http://preview.example', 'content-type': 'application/json' },
      body: JSON.stringify(consentBody(true)),
    })));
    assert.equal(previewResponse.cookies[0]?.includes('Secure'), true);
    const local = await fromResponse(await preview(new Request('http://localhost/api/analytics/consent', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify(consentBody(true)),
    })));
    assert.equal(local.status, 200);
    assert.equal(local.cookies[0]?.includes('Secure'), false);
    const loopback = await fromResponse(await preview(new Request('http://[::1]/api/analytics/consent', {
      method: 'POST',
      headers: { origin: 'http://[::1]', 'content-type': 'application/json' },
      body: JSON.stringify(consentBody(true)),
    })));
    assert.equal(loopback.status, 200);
    assert.equal(loopback.cookies[0]?.includes('Secure'), false);
  });

  test('the final response counter records this route and a write failure keeps the body', async () => {
    const ok = await httpPost();
    assert.equal(ok.status, 200);
    assert.equal(writes.length, 1);
    const encoded = JSON.stringify(writes[0]);
    assert.match(encoded, /POST \/api\/analytics\/consent/);
    assert.equal(encoded.includes(browserIdOf(tokenOf(ok.cookies[0]))), false);
    assert.equal(encoded.includes(PLANTED_EMAIL), false);

    let calls = 0;
    handler = makePost({
      db: {
        siteSetting: { findUnique: async () => null },
        $executeRaw: async () => {
          calls += 1;
          throw new Error(LEAKTOKEN);
        },
      },
    });
    const kept = await httpPost();
    assert.equal(kept.status, 200);
    ConsentDTOSchema.parse(kept.body);
    assert.equal(kept.text.includes(LEAKTOKEN), false);
    assert.equal(calls, 1);
  });
});
