import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, UpstashStore, createRateLimitStore } from '../src/lib/server/ratelimit/index';
import { mockServer } from './helpers';
import { MemoryStore as MS, setRateLimitStore, type RateLimitStore } from '../src/lib/server/ratelimit/index';
import { hitRateLimit, peekRateLimit, rateLimitEnv, rateLimitKeyHash, resetRateLimitLogThrottle } from '../src/lib/server/security';
import { loginRateOk } from '../src/lib/server/admin/login';
import { enforceAdminRateLimit } from '../src/lib/server/admin-guard';
import { POST as rumPOST } from '../src/app/api/rum/route';

test('memory: allows up to limit then blocks, per key', async () => {
  const s = new MemoryStore();
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await s.hit('a', 3, 60_000));
  assert.deepEqual(r, [true, true, true, false]);
  assert.equal(await s.hit('b', 3, 60_000), true);
});

test('memory: window expires', async () => {
  const s = new MemoryStore();
  assert.equal(await s.hit('w', 1, 50), true);
  assert.equal(await s.hit('w', 1, 50), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await s.hit('w', 1, 50), true);
});

test('upstash: sends INCR + PEXPIRE NX pipeline with bearer token, counts from server', async () => {
  const counts = new Map<string, number>();
  const srv = await mockServer((r, res) => {
    const cmds = JSON.parse(r.body.toString()) as string[][];
    const k = cmds[0][1];
    counts.set(k, (counts.get(k) ?? 0) + 1);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ result: counts.get(k) }, { result: 1 }]));
  });
  try {
    const s = new UpstashStore(srv.url, 'tok123');
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await s.hit('login:1.2.3.4', 2, 60_000));
    assert.deepEqual(r, [true, true, false]);
    const q = srv.reqs[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.url, '/pipeline');
    assert.equal(q.headers.authorization, 'Bearer tok123');
    const cmds = JSON.parse(q.body.toString());
    assert.equal(cmds[0][0], 'INCR');
    assert.match(cmds[0][1], /^rl:login:1\.2\.3\.4:\d+$/);
    assert.deepEqual(cmds[1], ['PEXPIRE', cmds[0][1], '60000', 'NX']);
  } finally { await srv.close(); }
});

test('upstash: 5xx throws (fail mode decided by hitRateLimit)', async () => {
  const srv = await mockServer((_r, res) => { res.statusCode = 503; res.end('down'); });
  try { await assert.rejects(new UpstashStore(srv.url, 't').hit('k', 2, 60_000), /upstash 503/); }
  finally { await srv.close(); }
});

test('upstash: timeout throws quickly', async () => {
  const srv = await mockServer(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    await assert.rejects(new UpstashStore(srv.url, 't', 100).hit('k', 1, 60_000));
    assert.ok(Date.now() - t0 < 1000);
  } finally { await srv.close(); }
});

test('upstash: error payload throws', async () => {
  const srv = await mockServer((_r, res) => { res.end(JSON.stringify([{ error: 'WRONGPASS' }, { error: 'x' }])); });
  try { await assert.rejects(new UpstashStore(srv.url, 't').hit('k', 1, 60_000), /bad response/); }
  finally { await srv.close(); }
});

test('factory: env selection and validation', () => {
  assert.ok(createRateLimitStore({}) instanceof MemoryStore);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }) instanceof UpstashStore);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'upstash' }), /UPSTASH_REDIS_REST_URL/);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't', NODE_ENV: 'production' }), /https/);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'redis' }), /未知/);
});

// ---- #74：按路由的故障模式、环境前缀、邮箱 HMAC、noip ----
const failing: RateLimitStore = { hit: async () => { throw new Error('down'); }, peek: async () => { throw new Error('down'); } };
const recording = () => { const keys: string[] = []; const m = new MS(); return { keys, store: { hit: (k: string, l: number, w: number) => { keys.push(k); return m.hit(k, l, w); }, peek: (k: string, l: number, w: number) => { keys.push(k); return m.peek(k, l, w); } } as RateLimitStore }; };
async function quiet<T>(f: () => Promise<T>) { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } }

test('hitRateLimit: store error -> closed denies, open allows, local counts in memory (default)', async () => {
  setRateLimitStore(failing);
  try {
    await quiet(async () => {
      assert.equal(await hitRateLimit('fm:c', 100, 60_000, { onStoreError: 'closed' }), false);
      for (let i = 0; i < 5; i++) assert.equal(await hitRateLimit('fm:o', 1, 60_000, { onStoreError: 'open' }), true);
      const r = []; for (let i = 0; i < 3; i++) r.push(await hitRateLimit('fm:l', 2, 60_000, { onStoreError: 'local' }));
      assert.deepEqual(r, [true, true, false]);
      const d = []; for (let i = 0; i < 3; i++) d.push(await hitRateLimit('fm:d', 2, 60_000));
      assert.deepEqual(d, [true, true, false]);
    });
  } finally { setRateLimitStore(undefined); }
});

test('hitRateLimit: healthy store ignores fail mode', async () => {
  setRateLimitStore(new MS());
  try { assert.equal(await hitRateLimit('fm:h', 1, 60_000, { onStoreError: 'closed' }), true); }
  finally { setRateLimitStore(undefined); }
});

test('keys get environment prefix (APP_ENV > VERCEL_ENV > NODE_ENV)', async () => {
  assert.equal(rateLimitEnv({ APP_ENV: 'production', VERCEL_ENV: 'preview', NODE_ENV: 'development' }), 'production');
  assert.equal(rateLimitEnv({ VERCEL_ENV: 'preview', NODE_ENV: 'production' }), 'preview');
  assert.equal(rateLimitEnv({ NODE_ENV: 'test' }), 'test');
  assert.equal(rateLimitEnv({}), 'development');
  const r = recording(); setRateLimitStore(r.store);
  try { await hitRateLimit('x:1', 5); assert.equal(r.keys[0], `${rateLimitEnv()}:x:1`); }
  finally { setRateLimitStore(undefined); }
});

test('email keys are HMACed: stable, no plaintext, depends on secret', () => {
  const a = rateLimitKeyHash('a@b.com', { AUTH_SECRET: 's1' });
  assert.equal(a, rateLimitKeyHash('a@b.com', { AUTH_SECRET: 's1' }));
  assert.notEqual(a, rateLimitKeyHash('a@b.com', { AUTH_SECRET: 's2' }));
  assert.notEqual(a, rateLimitKeyHash('c@b.com', { AUTH_SECRET: 's1' }));
  assert.ok(!a.includes('@') && a.length === 32);
});

test('login/2FA: store down -> denied (closed); keys hold no plaintext email', async () => {
  setRateLimitStore(failing);
  try { assert.equal(await quiet(() => loginRateOk('1.2.3.4', 'Admin@Example.com')), false); }
  finally { setRateLimitStore(undefined); }
  const r = recording(); setRateLimitStore(r.store);
  try {
    assert.equal(await loginRateOk(null, 'Admin@Example.com'), true);
    assert.ok(r.keys.every((k) => !/example/i.test(k)));
    assert.ok(r.keys.some((k) => k.includes('login-ip:untrusted')));
  } finally { setRateLimitStore(undefined); }
});

test('admin guard: store down -> 429 (closed); untrusted request uses shared untrusted bucket', async () => {
  const req = () => new Request('http://x/api/admin/x', { method: 'POST' });
  setRateLimitStore(failing);
  try { assert.equal((await quiet(() => enforceAdminRateLimit(req(), 'k')))?.status, 429); }
  finally { setRateLimitStore(undefined); }
  const r = recording(); setRateLimitStore(r.store);
  try { assert.equal(await enforceAdminRateLimit(req(), 'k'), null); assert.match(r.keys[0], /admin:k:untrusted$/); }
  finally { setRateLimitStore(undefined); }
});

test('rum: store down -> allowed (open); untrusted request uses rum:untrusted', async () => {
  const req = () => new Request('http://x/api/rum', { method: 'POST', body: '{}' });
  setRateLimitStore(failing);
  try { assert.notEqual((await quiet(() => rumPOST(req()))).status, 429); }
  finally { setRateLimitStore(undefined); }
  const r = recording(); setRateLimitStore(r.store);
  try { await rumPOST(req()); assert.match(r.keys[0], /:rum:untrusted$/); }
  finally { setRateLimitStore(undefined); }
});

test('routes that used to skip limiting when IP is null now hit the shared untrusted bucket', async () => {
  const { GET: logoGET } = await import('../src/app/api/designs/[id]/logo/route');
  const { GET: designGET } = await import('../src/app/api/designs/[id]/route');
  const { POST: inqPOST } = await import('../src/app/api/inquiries/route');
  const r = recording(); setRateLimitStore(r.store);
  const p = { params: Promise.resolve({ id: '!bad' }) };
  try {
    await logoGET(new Request('http://x/api/designs/!bad/logo'), p);
    await designGET(new Request('http://x/api/designs/!bad'), p).catch(() => {});
    await inqPOST(new Request('http://x/api/inquiries', { method: 'POST', body: '{}' }));
    for (const k of ['design-logo:untrusted', 'design-get:untrusted', 'inq-bad:untrusted']) assert.ok(r.keys.some((x) => x.endsWith(':' + k)), k);
  } finally { setRateLimitStore(undefined); }
});

test('spoofed CF-Connecting-IP / X-Forwarded-For without valid X-Edge-Auth all land in ONE untrusted bucket', async () => {
  const { GET: designGET } = await import('../src/app/api/designs/[id]/route');
  const r = recording(); setRateLimitStore(r.store);
  const p = { params: Promise.resolve({ id: '!bad' }) };
  const prev = process.env.EDGE_AUTH_SECRET;
  process.env.EDGE_AUTH_SECRET = 'edge-test-secret-0123456789abcdef-XYZ';
  try {
    const spoofed: Record<string, string>[] = [{ 'cf-connecting-ip': '1.1.1.1' }, { 'cf-connecting-ip': '2.2.2.2', 'x-edge-auth': 'wrong' }, { 'x-forwarded-for': '3.3.3.3' }, { 'x-real-ip': '4.4.4.4' }, {}];
    for (const h of spoofed)
      await designGET(new Request('http://x/api/designs/!bad', { headers: h }), p).catch(() => {});
    const keys = r.keys.filter((k) => k.includes(':design-get:'));
    assert.equal(keys.length, 5);
    assert.equal(new Set(keys).size, 1);
    assert.match(keys[0], /:design-get:untrusted$/);
    // 带正确 X-Edge-Auth 时按 CF-Connecting-IP 分桶
    await designGET(new Request('http://x/api/designs/!bad', { headers: { 'x-edge-auth': process.env.EDGE_AUTH_SECRET!, 'cf-connecting-ip': '5.5.5.5' } }), p).catch(() => {});
    assert.ok(r.keys.some((k) => k.endsWith(':design-get:5.5.5.5')));
  } finally { setRateLimitStore(undefined); if (prev === undefined) delete process.env.EDGE_AUTH_SECRET; else process.env.EDGE_AUTH_SECRET = prev; }
});

// ---- #74 安全复审：子密钥派生、日志不含原始邮箱/IP ----
import { createHmac } from 'node:crypto';

test('email HMAC uses domain-separated subkey, never AUTH_SECRET directly', () => {
  const secret = 'test-auth-secret-xyz';
  const sub = createHmac('sha256', secret).update('ratelimit-email-v1').digest();
  const expected = createHmac('sha256', sub).update('a@b.com').digest('base64url').slice(0, 32);
  assert.equal(rateLimitKeyHash('a@b.com', { AUTH_SECRET: secret }), expected);
  const direct = createHmac('sha256', secret).update('a@b.com').digest('base64url').slice(0, 32);
  assert.notEqual(rateLimitKeyHash('a@b.com', { AUTH_SECRET: secret }), direct);
});

test('store-failure logs contain no raw email, IP or key', async () => {
  const logs: string[] = [];
  const e = console.error, w = console.warn, l = console.log;
  const cap = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = cap; console.warn = cap; console.log = cap;
  // 让错误信息本身带上 key，确认也不会被打出来
  setRateLimitStore({ hit: async (k: string) => { throw new Error(`boom ${k}`); }, peek: async (k: string) => { throw new Error(`boom ${k}`); } });
  try {
    resetRateLimitLogThrottle();
    await hitRateLimit('inq:email:x@leak.com:192.0.2.5', 1, 60_000);
    resetRateLimitLogThrottle();
    await loginRateOk('203.0.113.77', 'Victim.User@Example.com');
    await hitRateLimit('rum:198.51.100.9', 1, 60_000, { onStoreError: 'open' });
  } finally { console.error = e; console.warn = w; console.log = l; setRateLimitStore(undefined); }
  assert.ok(logs.length >= 2, 'expected log lines');
  const all = logs.join('\n');
  for (const s of ['203.0.113.77', '198.51.100.9', '192.0.2.5', 'leak.com', 'victim', 'example.com', 'login:', 'rum:', 'inq:']) assert.ok(!all.toLowerCase().includes(s), `log leaked ${s}: ${all}`);
});

// ---- P2 enroll 作废：只读 peek ----
test('memory peek: read-only, true while count < limit, never increments', async () => {
  const s = new MemoryStore();
  for (let i = 0; i < 10; i++) assert.equal(await s.peek('p', 2, 60_000), true);
  assert.equal(await s.hit('p', 2, 60_000), true, 'first hit still allowed after 10 peeks');
  assert.equal(await s.peek('p', 2, 60_000), true);
  assert.equal(await s.hit('p', 2, 60_000), true);
  assert.equal(await s.peek('p', 2, 60_000), false, 'full after limit hits');
  assert.equal(await s.peek('p', 2, 60_000), false);
});

test('memory peek: window expires', async () => {
  const s = new MemoryStore();
  await s.hit('pw', 1, 50);
  assert.equal(await s.peek('pw', 1, 50), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await s.peek('pw', 1, 50), true);
});

test('upstash peek: GETs the same key hit INCRs, missing key = 0, errors throw', async () => {
  const counts = new Map<string, number>();
  const srv = await mockServer((r, res) => {
    const cmds = JSON.parse(r.body.toString()) as string[][];
    const [op, k] = cmds[0];
    if (op === 'INCR') counts.set(k, (counts.get(k) ?? 0) + 1);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(op === 'INCR' ? [{ result: counts.get(k) }, { result: 1 }] : [{ result: counts.has(k) ? String(counts.get(k)) : null }]));
  });
  try {
    const s = new UpstashStore(srv.url, 'tok');
    assert.equal(await s.peek('login:k', 2, 60_000), true);
    await s.hit('login:k', 2, 60_000);
    assert.equal(await s.peek('login:k', 2, 60_000), true);
    await s.hit('login:k', 2, 60_000);
    assert.equal(await s.peek('login:k', 2, 60_000), false);
    const get = JSON.parse(srv.reqs[0].body.toString());
    const incr = JSON.parse(srv.reqs[1].body.toString());
    assert.deepEqual(get, [['GET', incr[0][1]]], 'same key format as hit');
    assert.equal(counts.get(incr[0][1]), 2, 'peeks did not increment');
  } finally { await srv.close(); }
  const bad = await mockServer((_r, res) => { res.end(JSON.stringify([{ error: 'WRONGPASS' }])); });
  try { await assert.rejects(new UpstashStore(bad.url, 't').peek('k', 1, 60_000), /bad response/); } finally { await bad.close(); }
  const down = await mockServer((_r, res) => { res.statusCode = 503; res.end('down'); });
  try { await assert.rejects(new UpstashStore(down.url, 't').peek('k', 1, 60_000), /upstash 503/); } finally { await down.close(); }
});

test('peekRateLimit: store error -> closed denies, open allows, local reads memory; healthy store does not count', async () => {
  setRateLimitStore(failing);
  try {
    await quiet(async () => {
      assert.equal(await peekRateLimit('pk:c', 100, 60_000, { onStoreError: 'closed' }), false);
      assert.equal(await peekRateLimit('pk:o', 1, 60_000, { onStoreError: 'open' }), true);
      assert.equal(await peekRateLimit('pk:l', 1, 60_000, { onStoreError: 'local' }), true);
      assert.equal(await loginRateOk('1.2.3.4', 'a@b.com'), false, 'login peek is closed');
    });
  } finally { setRateLimitStore(undefined); }
  const r = recording(); setRateLimitStore(r.store);
  try {
    for (let i = 0; i < 5; i++) assert.equal(await peekRateLimit('pk:h', 1, 60_000, { onStoreError: 'closed' }), true);
    assert.equal(r.keys[0], `${rateLimitEnv()}:pk:h`, 'same env prefix as hitRateLimit');
    assert.equal(await hitRateLimit('pk:h', 1, 60_000), true, 'peeks did not consume');
  } finally { setRateLimitStore(undefined); }
});
