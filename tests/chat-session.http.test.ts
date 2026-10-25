// 真实 TCP 上的 POST /api/chat/session。限流存储是进程全局的，整组串行，每条用例前换一块新的内存存储。
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import * as chatRoute from '../src/app/api/chat/session/route';
import { createChatSessionPost } from '../src/app/api/chat/session/post';
import { ChatSessionDTOSchema } from '../src/lib/contracts/chat';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import middleware from '../src/middleware';
import {
  CHAT_SESSION_BODY_MAX_BYTES,
  CHAT_SESSION_COOKIE_LIMIT,
  CHAT_SESSION_COOKIE_RATE_PREFIX,
  CHAT_SESSION_IP_LIMIT,
  CHAT_SESSION_IP_RATE_PREFIX,
  CHAT_SESSION_RATE_WINDOW_MS,
  CHAT_VISITOR_COOKIE,
  hashChatToken,
  type ChatVisitorSessionRow,
  createVisitorSessionService,
} from '../src/lib/server/chat/visitor-session';
import { DuplicateChatTokenError, createVisitorSessionRepo, type VisitorSessionStore } from '../src/lib/server/chat/visitor-session-repo';
import { CHAT_VISITOR_POLICY, loadServerConfig } from '../src/lib/server/config';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const PLANTED_EMAIL = 'visitor-m4t8@example.com';
const PLANTED_IP = '203.0.113.44';
const LEAKTOKEN = 'db-credential-LEAKTOKEN';
const EDGE_SECRET = 'e'.repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const config = loadServerConfig({ APP_ENV: 'test' });

type HttpResult = {
  status: number;
  text: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  cookies: string[];
};

type TouchCall = { sql: string; values: unknown[] };

const rows = new Map<string, ChatVisitorSessionRow>();
const creates: ChatVisitorSessionRow[] = [];
const touches: TouchCall[] = [];
const writes: unknown[] = [];
let createAttempts = 0;
let failCreates = 0;
let fault: unknown = null;
let executeFault: unknown = null;

function cloneRow(row: ChatVisitorSessionRow): ChatVisitorSessionRow {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    createdAt: new Date(row.createdAt),
    lastActivityAt: new Date(row.lastActivityAt),
    absoluteExpiresAt: new Date(row.absoluteExpiresAt),
    revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
  };
}

function failIfFault(): void {
  if (fault) throw fault;
}

const db = {
  siteSetting: { findUnique: async () => null },
  $executeRaw: async (query: unknown) => {
    writes.push(query);
    if (executeFault) throw executeFault;
    return 1;
  },
  chatVisitorSession: {
    async create(args: { data: ChatVisitorSessionRow }) {
      failIfFault();
      createAttempts += 1;
      if (failCreates > 0) {
        failCreates -= 1;
        throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '0.0.0' });
      }
      if (rows.has(args.data.tokenHash)) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '0.0.0' });
      }
      const stored = cloneRow(args.data);
      rows.set(stored.tokenHash, stored);
      creates.push(cloneRow(stored));
      return cloneRow(stored);
    },
    async findUnique(args: { where: { tokenHash: string } }) {
      failIfFault();
      const row = rows.get(args.where.tokenHash);
      return row ? cloneRow(row) : null;
    },
  },
  async $queryRaw(query: { strings: readonly string[]; values: readonly unknown[] }) {
    failIfFault();
    const values = [...query.values];
    touches.push({ sql: query.strings.join(''), values });
    const now = values[0];
    const tokenHash = values[1];
    const nowAgain = values[2];
    const cutoff = values[3];
    if (!(now instanceof Date) || !(nowAgain instanceof Date) || typeof tokenHash !== 'string' || !(cutoff instanceof Date)) {
      throw new Error('touch sql shape');
    }
    const row = rows.get(tokenHash);
    if (!row || row.revokedAt !== null) return [];
    if (row.absoluteExpiresAt.getTime() <= now.getTime()) return [];
    if (row.lastActivityAt.getTime() <= cutoff.getTime()) return [];
    row.lastActivityAt = new Date(now.getTime());
    return [cloneRow(row)];
  },
};

let now = new Date('2026-06-01T00:00:00.000Z');
let port = 0;
let server: http.Server | undefined;
let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 500 });

class CountingStore extends MemoryStore {
  readonly seen: string[] = [];
  readonly windows: number[] = [];
  readonly limits: number[] = [];
  override async hit(key: string, limit: number, windowMs: number) {
    this.seen.push(key);
    this.windows.push(windowMs);
    this.limits.push(limit);
    return super.hit(key, limit, windowMs);
  }
}

function resetStore() {
  rows.clear();
  creates.length = 0;
  touches.length = 0;
  writes.length = 0;
  createAttempts = 0;
  failCreates = 0;
  fault = null;
  executeFault = null;
}

function makePost(extra: Parameters<typeof createChatSessionPost>[0] = {}) {
  return createChatSessionPost({
    db: db as unknown as NonNullable<Parameters<typeof createChatSessionPost>[0]>['db'],
    config,
    clock: () => now,
    env: { APP_ENV: 'test' },
    ...extra,
  });
}

function assertNoPlanted(result: HttpResult) {
  assert.equal(result.text.includes(PLANTED_EMAIL), false);
  assert.equal(result.text.includes(PLANTED_IP), false);
  const headers = JSON.stringify(result.headers);
  assert.equal(headers.includes(PLANTED_EMAIL), false);
  assert.equal(headers.includes(PLANTED_IP), false);
  assert.equal(result.cookies.join('\n').includes(PLANTED_EMAIL), false);
}

function tokenOf(setCookie: string | undefined): string {
  assert.ok(setCookie);
  assert.equal(setCookie.startsWith(`${CHAT_VISITOR_COOKIE}=`), true);
  return setCookie.split(';', 1)[0].slice(`${CHAT_VISITOR_COOKIE}=`.length);
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
    : Buffer.from(JSON.stringify(options.json ?? { locale: 'en' }));
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
      path: '/api/chat/session',
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
    req.setTimeout(5_000, () => req.destroy(new Error('chat session http timeout')));
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

function loopbackDatabaseUrl(): string | null {
  const raw = process.env.CHAT_SESSION_TEST_DATABASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
    return raw;
  } catch {
    return null;
  }
}

describe('POST /api/chat/session', { concurrency: false }, () => {
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
    resetStore();
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

  test('route registers POST through the chat service and ordinary page GET does not set pj_chat', async () => {
    assert.equal(typeof chatRoute.POST, 'function');
    assert.equal(chatRoute.runtime, 'nodejs');
    assert.equal('GET' in chatRoute, false);
    assert.equal('createChatSessionPost' in chatRoute, false);
    const routeSource = readFileSync('src/app/api/chat/session/route.ts', 'utf8');
    assert.match(routeSource, /createChatSessionPost\(\)/);
    const postSource = readFileSync('src/app/api/chat/session/post.ts', 'utf8');
    assert.match(postSource, /createChatServices\(/);
    for (const file of [
      'src/app/api/chat/session/route.ts',
      'src/app/api/chat/session/post.ts',
      'src/lib/server/chat/visitor-session.ts',
      'src/lib/server/chat/visitor-session-repo.ts',
    ]) {
      const text = readFileSync(file, 'utf8');
      assert.equal(text.includes('analytics/'), false, file);
      assert.equal(text.includes('pj_analytics'), false, file);
    }
    for (const path of ['/en', '/ru', '/en/contact']) {
      const response = await middleware(new NextRequest(new URL(path, 'http://127.0.0.1:3000')));
      const cookies = response.headers.getSetCookie();
      assert.equal(cookies.some((cookie) => cookie.includes('pj_chat')), false, path);
      assert.equal((response.headers.get('set-cookie') ?? '').includes('pj_chat'), false, path);
    }
  });

  test('schema stores a hash, indexes expiry, and has no email column', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const block = schema.slice(schema.indexOf('model ChatVisitorSession'));
    assert.match(block, /tokenHash\s+String\s+@unique/);
    assert.match(block, /@@index\(\[absoluteExpiresAt\]\)/);
    assert.match(block, /@@index\(\[lastActivityAt\]\)/);
    assert.equal(/\bemail\b/i.test(block), false);
    assert.equal(block.includes('accept-data-loss'), false);
    assert.equal(CHAT_VISITOR_POLICY.idleMs, 7 * DAY_MS);
    assert.equal(CHAT_VISITOR_POLICY.absoluteMs, 30 * DAY_MS);
    assert.equal(CHAT_SESSION_COOKIE_RATE_PREFIX, 'chat:session:cookie:');
    assert.equal(CHAT_SESSION_IP_RATE_PREFIX, 'chat:session:ip:');
    assert.equal(CHAT_SESSION_COOKIE_LIMIT, 10);
    assert.equal(CHAT_SESSION_IP_LIMIT, 20);
    assert.equal(CHAT_SESSION_RATE_WINDOW_MS, 10 * 60 * 1000);
  });

  test('active contact issues a 256-bit token, stores only the hash, and sets the necessary cookie', async () => {
    const issued = await httpPost({ json: { locale: 'ru' } });
    assert.equal(issued.status, 200);
    assert.equal(issued.headers['cache-control'], 'private, no-store');
    assert.equal(issued.headers['access-control-allow-origin'], undefined);
    const dto = ChatSessionDTOSchema.parse(issued.body);
    assert.equal(dto.available, true);
    assert.equal(dto.expiresAt, new Date(now.getTime() + CHAT_VISITOR_POLICY.idleMs).toISOString());
    assert.deepEqual(Object.keys(issued.body as object).sort(), ['available', 'expiresAt']);
    assertNoPlanted(issued);
    assert.equal(issued.cookies.length, 1);
    const cookie = issued.cookies[0];
    assert.match(cookie, /^pj_chat=[A-Za-z0-9_-]{43}; Path=\/api\/chat; HttpOnly; SameSite=Lax; Max-Age=\d+; Expires=/);
    assert.equal(cookie.includes('Secure'), false);
    assert.equal(cookie.includes('Domain='), false);
    assert.equal(maxAgeOf(cookie), CHAT_VISITOR_POLICY.idleMs / 1000);
    assert.equal(cookie.includes(`Expires=${new Date(dto.expiresAt).toUTCString()}`), true);
    const token = tokenOf(cookie);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(issued.text.includes(token), false);
    const row = rows.get(hashChatToken(token));
    assert.ok(row);
    assert.equal(row.tokenHash, hashChatToken(token));
    assert.equal(row.tokenHash.includes(token), false);
    assert.equal(Object.hasOwn(row, 'email'), false);
    assert.equal(row.id === token, false);
    assert.equal(row.revokedAt, null);
    assert.equal(row.createdAt.toISOString(), now.toISOString());
    assert.equal(row.absoluteExpiresAt.toISOString(), new Date(now.getTime() + CHAT_VISITOR_POLICY.absoluteMs).toISOString());
    assert.equal(creates.length, 1);
    assert.equal(createAttempts, 1);
    assert.equal(writes.length, 1);
    assert.match(JSON.stringify(writes[0]), /POST \/api\/chat\/session/);
    assert.equal(JSON.stringify(writes[0]).includes(token), false);
  });

  test('a valid cookie is reused once and a missing cookie does not look up an old row', async () => {
    const first = await httpPost();
    const token = tokenOf(first.cookies[0]);
    const hash = hashChatToken(token);
    const created = rows.get(hash)?.createdAt.getTime();
    const absolute = rows.get(hash)?.absoluteExpiresAt.getTime();
    now = new Date(now.getTime() + 60_000);
    const second = await httpPost({ cookie: `pj_chat=${token}` });
    assert.equal(second.status, 200);
    assert.equal(tokenOf(second.cookies[0]), token);
    assert.equal(second.text.includes(token), false);
    assert.equal(rows.size, 1);
    assert.equal(creates.length, 1);
    assert.equal(rows.get(hash)?.createdAt.getTime(), created);
    assert.equal(rows.get(hash)?.absoluteExpiresAt.getTime(), absolute);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), now.getTime());
    assert.equal(ChatSessionDTOSchema.parse(second.body).expiresAt, new Date(now.getTime() + CHAT_VISITOR_POLICY.idleMs).toISOString());
    assert.equal(touches.length, 1);
    assert.match(touches[0].sql, /"revokedAt" IS NULL/);
    assert.match(touches[0].sql, /"absoluteExpiresAt" >/);
    assert.match(touches[0].sql, /"lastActivityAt" >/);
    assert.doesNotMatch(touches[0].sql, />=/);
    assert.equal(touches[0].values[1], hash);
    assert.equal((touches[0].values[0] as Date).getTime(), now.getTime());
    assert.equal((touches[0].values[2] as Date).getTime(), now.getTime());
    assert.equal((touches[0].values[3] as Date).getTime(), now.getTime() - CHAT_VISITOR_POLICY.idleMs);
    const third = await httpPost();
    assert.equal(third.status, 200);
    assert.notEqual(tokenOf(third.cookies[0]), token);
    assert.equal(rows.size, 2);
  });

  test('one unique conflict retries a new token and a second conflict does not loop', async () => {
    failCreates = 1;
    const issued = await httpPost();
    assert.equal(issued.status, 200);
    assert.equal(createAttempts, 2);
    assert.equal(rows.size, 1);
    assert.equal(rows.get(hashChatToken(tokenOf(issued.cookies[0])))?.tokenHash, hashChatToken(tokenOf(issued.cookies[0])));

    resetStore();
    let attempts = 0;
    const repo = {
      async insert() {
        attempts += 1;
        throw new DuplicateChatTokenError();
      },
      async findByTokenHash() { return null; },
      async touchIfValid() { return null; },
    };
    const service = createVisitorSessionService({ repo, clock: () => now });
    await assert.rejects(() => service.establish(null), (error: unknown) => error instanceof DuplicateChatTokenError);
    assert.equal(attempts, 2);
  });

  test('the same email is not a lookup, and analytics cookies do not block or get rewritten', async () => {
    const issued = await httpPost();
    const token = tokenOf(issued.cookies[0]);
    const hash = hashChatToken(token);
    const before = rows.get(hash)?.lastActivityAt.getTime();
    const denied = await httpPost({ json: { locale: 'en', email: PLANTED_EMAIL } });
    assert.equal(denied.status, 400);
    const body = AppErrorDTOSchema.parse(denied.body);
    assert.equal(body.error, 'invalid');
    assert.equal(body.fieldErrors?.email, 'Email is not accepted on this request.');
    assert.equal(denied.text.includes(PLANTED_EMAIL), false);
    assert.equal(denied.cookies.length, 0);
    assert.equal(rows.size, 1);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), before);

    resetStore();
    const withAnalytics = await httpPost({ cookie: 'pj_analytics=not-a-chat-cookie' });
    assert.equal(withAnalytics.status, 200);
    assert.equal(withAnalytics.cookies.length, 1);
    assert.equal(withAnalytics.cookies[0].startsWith('pj_chat='), true);
    assert.equal(withAnalytics.cookies.some((cookie) => cookie.includes('pj_analytics')), false);
  });

  test('bad locale, bad JSON, and an oversized body do not issue or touch', async () => {
    const missing = await httpPost({ json: {} });
    assert.equal(missing.status, 400);
    assert.equal(AppErrorDTOSchema.parse(missing.body).fieldErrors?.locale, 'Must be en or ru.');
    assert.equal(missing.cookies.length, 0);
    const other = await httpPost({ json: { locale: 'es' } });
    assert.equal(other.status, 400);
    assert.equal(AppErrorDTOSchema.parse(other.body).fieldErrors?.locale, 'Must be en or ru.');
    const broken = await httpPost({ raw: '{' });
    assert.equal(broken.status, 400);
    assert.equal(AppErrorDTOSchema.parse(broken.body).error, 'invalid');
    const full = await httpPost({ raw: Buffer.alloc(CHAT_SESSION_BODY_MAX_BYTES, 0x78) });
    assert.equal(full.status, 400);
    const over = await httpPost({ raw: Buffer.alloc(CHAT_SESSION_BODY_MAX_BYTES + 1, 0x78) });
    assert.equal(over.status, 413);
    assert.equal(AppErrorDTOSchema.parse(over.body).error, 'too_large');
    assert.equal(rows.size, 0);

    const issued = await httpPost();
    const token = tokenOf(issued.cookies[0]);
    const hash = hashChatToken(token);
    const before = rows.get(hash)?.lastActivityAt.getTime();
    now = new Date(now.getTime() + 1000);
    const kept = await httpPost({ cookie: `pj_chat=${token}`, raw: '{' });
    assert.equal(kept.status, 400);
    assert.equal(kept.cookies.length, 0);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), before);
    assert.equal(touches.length, 0);
  });

  test('origin must match exactly and a rejection writes no cookie', async () => {
    const missing = await httpPost({ origin: null, headers: { referer: `http://127.0.0.1:${port}/en` } });
    assert.equal(missing.status, 403);
    assert.equal(AppErrorDTOSchema.parse(missing.body).error, 'forbidden_origin');
    assert.equal(missing.cookies.length, 0);
    const literalNull = await httpPost({ origin: 'null' });
    assert.equal(literalNull.status, 403);
    assert.equal(literalNull.cookies.length, 0);
    const evil = await httpPost({ origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const slashed = await httpPost({ origin: `http://127.0.0.1:${port}/` });
    assert.equal(slashed.status, 403);
    const upper = await httpPost({ origin: `HTTP://127.0.0.1:${port}` });
    assert.equal(upper.status, 403);
    const prefixed = await httpPost({ origin: `http://127.0.0.1.evil.example` });
    assert.equal(prefixed.status, 403);
    assert.equal(rows.size, 0);
    assert.equal(creates.length, 0);
  });

  test('production sets Secure, ignores the listen host, and localhost may omit Secure', async () => {
    handler = makePost({ env: { APP_ENV: 'production', APP_ORIGIN: `http://127.0.0.1:${port}` } });
    const ok = await httpPost();
    assert.equal(ok.status, 200);
    assert.equal(ok.cookies[0]?.includes('Secure'), true);
    const denied = await httpPost({ origin: 'https://evil.example' });
    assert.equal(denied.status, 403);
    assert.equal(denied.cookies.length, 0);

    const post = makePost({ env: { APP_ENV: 'production', APP_ORIGIN: 'https://app.example' } });
    const wrongHost = await fromResponse(await post(new Request('http://127.0.0.1:3000/api/chat/session', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    })));
    assert.equal(wrongHost.status, 403);
    assert.equal(wrongHost.cookies.length, 0);
    const allowed = await fromResponse(await post(new Request('http://127.0.0.1:3000/api/chat/session', {
      method: 'POST',
      headers: { origin: 'https://app.example', 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    })));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.cookies[0]?.includes('Secure'), true);
    const cleared = await fromResponse(await post(new Request('http://preview.example/api/chat/session', {
      method: 'POST',
      headers: { origin: 'https://app.example', 'content-type': 'application/json', cookie: 'pj_chat=short' },
      body: JSON.stringify({ locale: 'en' }),
    })));
    assert.equal(cleared.status, 401);
    assert.match(cleared.cookies[0] ?? '', /Max-Age=0/);
    assert.match(cleared.cookies[0] ?? '', /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    assert.equal(cleared.cookies[0]?.includes('Secure'), true);
    assert.equal(cleared.cookies[0]?.includes('Domain='), false);

    const preview = makePost();
    const previewResponse = await fromResponse(await preview(new Request('http://preview.example/api/chat/session', {
      method: 'POST',
      headers: { origin: 'http://preview.example', 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    })));
    assert.equal(previewResponse.cookies[0]?.includes('Secure'), true);
    const local = await fromResponse(await preview(new Request('http://localhost/api/chat/session', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    })));
    assert.equal(local.status, 200);
    assert.equal(local.cookies[0]?.includes('Secure'), false);
    const loopback = await fromResponse(await preview(new Request('http://[::1]/api/chat/session', {
      method: 'POST',
      headers: { origin: 'http://[::1]', 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    })));
    assert.equal(loopback.status, 200);
    assert.equal(loopback.cookies[0]?.includes('Secure'), false);
  });

  test('idle and absolute equality or revocation reject before touch, and a later contact can start over', async () => {
    const start = now.getTime();
    const issued = await httpPost();
    const token = tokenOf(issued.cookies[0]);
    const hash = hashChatToken(token);
    const cookie = `pj_chat=${token}`;

    now = new Date(start + CHAT_VISITOR_POLICY.idleMs - 1);
    const justInside = await httpPost({ cookie });
    assert.equal(justInside.status, 200);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), now.getTime());
    assert.equal(touches.length, 1);

    resetStore();
    now = new Date(start);
    handler = makePost();
    const again = await httpPost();
    const againToken = tokenOf(again.cookies[0]);
    const againHash = hashChatToken(againToken);
    now = new Date(start + CHAT_VISITOR_POLICY.idleMs);
    const idle = await httpPost({ cookie: `pj_chat=${againToken}` });
    assert.equal(idle.status, 401);
    assert.equal(AppErrorDTOSchema.parse(idle.body).error, 'unauthorized');
    assert.match(idle.cookies[0] ?? '', /pj_chat=; Path=\/api\/chat; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    assert.equal(rows.get(againHash)?.lastActivityAt.getTime(), start);
    assert.equal(touches.length, 0);
    const repo = createVisitorSessionRepo(db as unknown as VisitorSessionStore);
    assert.equal(await repo.touchIfValid(againHash, now, CHAT_VISITOR_POLICY.idleMs), null);
    assert.equal(rows.get(againHash)?.lastActivityAt.getTime(), start);
    assert.equal(touches.length, 1);
    assert.match(touches[0].sql, /"lastActivityAt" >/);

    const fresh = await httpPost();
    assert.equal(fresh.status, 200);
    assert.notEqual(tokenOf(fresh.cookies[0]), againToken);
    assert.equal(rows.size, 2);
  });

  test('a touch inside the idle window keeps the original boundary valid and cannot pass the absolute cap', async () => {
    const start = now.getTime();
    const issued = await httpPost();
    const token = tokenOf(issued.cookies[0]);
    const cookie = `pj_chat=${token}`;
    const hash = hashChatToken(token);

    now = new Date(start + 6 * DAY_MS);
    const extended = await httpPost({ cookie });
    assert.equal(extended.status, 200);
    now = new Date(start + 7 * DAY_MS);
    const still = await httpPost({ cookie });
    assert.equal(still.status, 200);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), now.getTime());

    let cursor = start + 7 * DAY_MS;
    while (cursor + 6 * DAY_MS < start + 29 * DAY_MS) {
      cursor += 6 * DAY_MS;
      now = new Date(cursor);
      const step = await httpPost({ cookie });
      assert.equal(step.status, 200);
    }
    now = new Date(start + 29 * DAY_MS);
    const capped = await httpPost({ cookie });
    assert.equal(capped.status, 200);
    assert.equal(ChatSessionDTOSchema.parse(capped.body).expiresAt, new Date(start + CHAT_VISITOR_POLICY.absoluteMs).toISOString());
    assert.equal(maxAgeOf(capped.cookies[0]), DAY_MS / 1000);
    assert.equal(tokenOf(capped.cookies[0]), token);

    now = new Date(start + CHAT_VISITOR_POLICY.absoluteMs);
    const activity = rows.get(hash)?.lastActivityAt.getTime();
    const expired = await httpPost({ cookie });
    assert.equal(expired.status, 401);
    assert.match(expired.cookies[0] ?? '', /Max-Age=0/);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), activity);
    assert.equal(await createVisitorSessionRepo(db as unknown as VisitorSessionStore).touchIfValid(hash, now, CHAT_VISITOR_POLICY.idleMs), null);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), activity);
  });

  test('a revoked, malformed, ambiguous, or unknown cookie is cleared and does not mint a replacement', async () => {
    const issued = await httpPost();
    const token = tokenOf(issued.cookies[0]);
    const hash = hashChatToken(token);
    const row = rows.get(hash);
    assert.ok(row);
    row.revokedAt = new Date(now.getTime());
    const revoked = await httpPost({ cookie: `pj_chat=${token}` });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.cookies.length, 1);
    assert.match(revoked.cookies[0], /Max-Age=0/);
    assert.equal(rows.get(hash)?.lastActivityAt.getTime(), now.getTime());
    assert.equal(rows.size, 1);
    assert.equal(creates.length, 1);

    const malformed = await httpPost({ cookie: 'pj_chat=short' });
    assert.equal(malformed.status, 401);
    assert.match(malformed.cookies[0] ?? '', /Max-Age=0/);
    assert.equal(rows.size, 1);
    const unknown = randomBytes(32).toString('base64url');
    const missing = await httpPost({ cookie: `pj_chat=${unknown}` });
    assert.equal(missing.status, 401);
    assert.equal(missing.text.includes(unknown), false);
    assert.equal(rows.size, 1);
    const ambiguous = await httpPost({ cookie: `pj_chat=${'A'.repeat(43)}; pj_chat=${'B'.repeat(43)}` });
    assert.equal(ambiguous.status, 401);
    assert.equal(rows.size, 1);

    const started = await httpPost();
    assert.equal(started.status, 200);
    assert.equal(rows.size, 2);
    assert.notEqual(tokenOf(started.cookies[0]), token);
  });

  test('cookie and IP limits use new prefixes, and a cookie rejection does not spend the IP bucket', async () => {
    const store = new CountingStore();
    setRateLimitStore(store);
    handler = makePost({ env: { APP_ENV: 'test', EDGE_AUTH_SECRET: EDGE_SECRET } });
    const issued = await httpPost({ headers: { 'x-edge-auth': EDGE_SECRET, 'cf-connecting-ip': PLANTED_IP } });
    const token = tokenOf(issued.cookies[0]);
    await httpPost({
      cookie: `pj_chat=${token}`,
      headers: { 'x-edge-auth': EDGE_SECRET, 'cf-connecting-ip': PLANTED_IP, 'x-forwarded-for': '198.51.100.10' },
    });
    const joined = store.seen.join('\n');
    assert.equal(joined.includes(CHAT_SESSION_COOKIE_RATE_PREFIX), true);
    assert.equal(joined.includes(CHAT_SESSION_IP_RATE_PREFIX), true);
    assert.equal(joined.includes(token), false);
    assert.equal(joined.includes(hashChatToken(token)), false);
    assert.equal(joined.includes(PLANTED_IP), false);
    assert.equal(joined.includes(EDGE_SECRET), false);
    assert.equal(store.windows.every((windowMs) => windowMs === CHAT_SESSION_RATE_WINDOW_MS), true);
    assert.equal(store.limits.includes(CHAT_SESSION_COOKIE_LIMIT), true);
    assert.equal(store.limits.includes(CHAT_SESSION_IP_LIMIT), true);

    const forwarded = new CountingStore();
    setRateLimitStore(forwarded);
    await httpPost({ headers: { 'x-forwarded-for': '198.51.100.10' } });
    await httpPost({ headers: { 'x-forwarded-for': '198.51.100.11' } });
    const forwardedIp = forwarded.seen.filter((key) => key.includes(CHAT_SESSION_IP_RATE_PREFIX));
    assert.equal(forwardedIp.length, 2);
    assert.equal(forwardedIp[0], forwardedIp[1]);
    assert.equal(forwardedIp[0]?.includes('198.51.100'), false);
  });

  test('the 11th cookie request is limited without burning the IP bucket, and the 21st IP request is limited', async () => {
    const first = await httpPost();
    const cookie = `pj_chat=${tokenOf(first.cookies[0])}`;
    for (let i = 0; i < 10; i += 1) {
      const reused = await httpPost({ cookie });
      assert.equal(reused.status, 200);
    }
    const touchesBefore = touches.length;
    const limited = await httpPost({ cookie });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '600');
    assert.equal(AppErrorDTOSchema.parse(limited.body).error, 'rate_limited');
    assert.equal(limited.cookies.length, 0);
    assert.equal(touches.length, touchesBefore);
    for (let i = 0; i < 9; i += 1) {
      const next = await httpPost();
      assert.equal(next.status, 200);
    }
    const ipLimited = await httpPost();
    assert.equal(ipLimited.status, 429);
    assert.equal(ipLimited.headers['retry-after'], '600');
    assert.equal(ipLimited.cookies.length, 0);

    resetStore();
    setRateLimitStore(new MemoryStore());
    for (let i = 0; i < 20; i += 1) {
      const allowed = await httpPost();
      assert.equal(allowed.status, 200);
    }
    const twentyFirst = await httpPost();
    assert.equal(twentyFirst.status, 429);
    assert.equal(twentyFirst.headers['retry-after'], '600');
    assert.equal(twentyFirst.cookies.length, 0);
  });

  test('a closed rate-limit store, a down database, and a counter failure stay inside the error envelope', async () => {
    setRateLimitStore({
      async hit() { throw new Error(`store ${LEAKTOKEN}`); },
      async refund() { /* unused */ },
    });
    const closed = await httpPost();
    assert.equal(closed.status, 429);
    assert.equal(closed.text.includes(LEAKTOKEN), false);
    assert.equal(rows.size, 0);

    setRateLimitStore(new MemoryStore());
    fault = new Prisma.PrismaClientInitializationError(`down ${LEAKTOKEN}`, '0.0.0');
    const unavailable = await httpPost();
    assert.equal(unavailable.status, 503);
    assert.equal(AppErrorDTOSchema.parse(unavailable.body).error, 'service_unavailable');
    assert.equal(unavailable.text.includes(LEAKTOKEN), false);
    assert.equal(unavailable.cookies.length, 0);
    assert.equal(rows.size, 0);

    fault = new Prisma.PrismaClientKnownRequestError(`net ${LEAKTOKEN}`, { code: 'P1001', clientVersion: '0.0.0' });
    const network = await httpPost();
    assert.equal(network.status, 503);
    assert.equal(network.text.includes(LEAKTOKEN), false);

    fault = new Error(`connect ${LEAKTOKEN}`);
    const broken = await httpPost();
    assert.equal(broken.status, 500);
    assert.equal(AppErrorDTOSchema.parse(broken.body).error, 'internal_error');
    assert.equal(broken.text.includes(LEAKTOKEN), false);
    assert.equal(broken.text.includes('connect'), false);

    fault = null;
    executeFault = new Error(LEAKTOKEN);
    const kept = await httpPost();
    assert.equal(kept.status, 200);
    ChatSessionDTOSchema.parse(kept.body);
    assert.equal(kept.text.includes(LEAKTOKEN), false);
    assert.equal(kept.cookies.length, 1);
  });

  test('loopback postgres applies the touch predicate', { skip: loopbackDatabaseUrl() ? false : 'CHAT_SESSION_TEST_DATABASE_URL is unset or not a loopback postgres URL' }, async () => {
    const url = loopbackDatabaseUrl();
    assert.ok(url);
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '5');
    pooled.searchParams.set('pool_timeout', '10');
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    try {
      execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: pooled.toString() },
        stdio: 'pipe',
      });
    } catch {
      throw new Error('db push failed');
    }
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
    const stamp = new Date('2026-06-01T00:00:00.000Z');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashChatToken(token);
    try {
      await client.chatVisitorSession.create({
        data: {
          id: randomBytes(16).toString('base64url'),
          tokenHash,
          createdAt: stamp,
          lastActivityAt: stamp,
          absoluteExpiresAt: new Date(stamp.getTime() + CHAT_VISITOR_POLICY.absoluteMs),
          revokedAt: null,
        },
      });
      const repo = createVisitorSessionRepo(client as unknown as VisitorSessionStore);
      const atEdge = new Date(stamp.getTime() + CHAT_VISITOR_POLICY.idleMs);
      assert.equal(await repo.touchIfValid(tokenHash, atEdge, CHAT_VISITOR_POLICY.idleMs), null);
      const inside = new Date(stamp.getTime() + CHAT_VISITOR_POLICY.idleMs - 1);
      const touched = await repo.touchIfValid(tokenHash, inside, CHAT_VISITOR_POLICY.idleMs);
      assert.equal(touched?.lastActivityAt.getTime(), inside.getTime());
      const stored = await client.chatVisitorSession.findUnique({ where: { tokenHash } });
      assert.equal(stored?.tokenHash, tokenHash);
      assert.equal(JSON.stringify(stored).includes(token), false);
    } finally {
      await client.chatVisitorSession.delete({ where: { tokenHash } }).catch(() => undefined);
      await client.$disconnect();
    }
  });
});
