import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, REFUND_LUA, UpstashStore, createRateLimitStore } from '../src/lib/server/ratelimit/index';
import { RedisStore, parseRedisUrl, parseResp } from '../src/lib/server/ratelimit/redis';
import { startFakeRedis } from './fake-redis';
import net from 'node:net';
import { mockServer } from './helpers';
import { MemoryStore as MS, setRateLimitStore, type RateLimitStore } from '../src/lib/server/ratelimit/index';
import { hitRateLimit, rateLimitEnv, rateLimitKeyHash, refundRateLimit, resetRateLimitLogThrottle } from '../src/lib/server/security';
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

test('RESP bulk length -1 is null and any other negative length is an error', () => {
  const nil = parseResp(Buffer.from('$-1\r\n'));
  if (!nil || nil.reply === 'bad') assert.fail('expected a null bulk');
  assert.equal(nil.reply.kind, 'bulk');
  assert.equal(nil.reply.value, null);
  const bad = parseResp(Buffer.from('$-2\r\n'));
  assert.ok(bad && bad.reply === 'bad');
});

test('factory: env selection and validation', () => {
  assert.ok(createRateLimitStore({}) instanceof MemoryStore);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }) instanceof UpstashStore);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'upstash' }), /UPSTASH_REDIS_REST_URL/);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't', NODE_ENV: 'production' }), /https/);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://:<password>@127.0.0.1:1' }) instanceof RedisStore);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://:pw@127.0.0.1:1', APP_ENV: 'production' }) instanceof RedisStore);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'rediss://:pw@203.0.113.10:6379', APP_ENV: 'production' }) instanceof RedisStore);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://:pw@203.0.113.10:6379' }) instanceof RedisStore);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://:pw@203.0.113.10:6379', APP_ENV: 'production' }), (e: Error) => {
    assert.equal(e.message, 'REDIS_URL 必须是 rediss://');
    assert.equal(e.message.includes('203.0.113.10'), false);
    return true;
  });
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://:pw@203.0.113.10:6379', VERCEL_ENV: 'production' }) instanceof RedisStore);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'redis' }), /REDIS_URL/);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'http://:supersecret@example.invalid' }), (e: Error) => {
    assert.equal(e.message, 'REDIS_URL 必须是 redis:// 或 rediss://');
    assert.doesNotMatch(e.message, /supersecret/);
    return true;
  });
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'mysql' }), /未知/);
  const parsed = parseRedisUrl('redis://user:p%40ss@[::1]:6380/2');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.endpoint.password, 'p@ss');
    assert.equal(parsed.endpoint.username, 'user');
    assert.equal(parsed.endpoint.host, '::1');
    assert.equal(parsed.endpoint.port, 6380);
    assert.equal(parsed.endpoint.db, 2);
    assert.equal(parsed.endpoint.tls, false);
  }
});

async function closedPort() {
  const srv = net.createServer();
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((ok, err) => srv.close((e) => (e ? err(e) : ok())));
  return port;
}

test('redis: INCR is atomic, PEXPIRE NX, same rl:<key>:<window> key as upstash', async () => {
  const fake = await startFakeRedis();
  try {
    const s = new RedisStore({ host: '127.0.0.1', port: fake.port, tls: false, db: 0 });
    const results = await Promise.all([0, 1, 2, 3].map(() => s.hit('login:1.2.3.4', 3, 60_000)));
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(results.filter((x) => !x).length, 1);
    const incrs = fake.commands().filter((c) => c[0] === 'INCR');
    assert.equal(incrs.length, 4);
    assert.match(incrs[0][1], /^rl:login:1\.2\.3\.4:\d+$/);
    const expires = fake.commands().filter((c) => c[0] === 'PEXPIRE');
    assert.deepEqual(expires[0], ['PEXPIRE', incrs[0][1], '60000', 'NX']);
    assert.ok(fake.commands().every((c) => c[0] === 'INCR' || c[0] === 'PEXPIRE'));
  } finally { await fake.close(); }
});

test('redis: refund floors at 0 and does not touch TTL; expiry does not recreate the key', async () => {
  const fake = await startFakeRedis();
  try {
    const s = new RedisStore({ host: '127.0.0.1', port: fake.port, tls: false, db: 0 });
    await s.hit('login:k', 5, 60_000);
    await s.hit('login:k', 5, 60_000);
    const key = [...fake.keys().keys()][0];
    const ttl = fake.keys().get(key)!.exp;
    const ev = fake.commands().find((c) => c[0] === 'EVAL');
    await s.refund('login:k', 60_000);
    const evals = fake.commands().filter((c) => c[0] === 'EVAL');
    assert.equal(evals[0][1], REFUND_LUA);
    assert.equal(evals[0][3], key);
    assert.equal(ev, undefined);
    assert.equal(fake.keys().get(key)!.v, 1);
    assert.equal(fake.keys().get(key)!.exp, ttl);
    await s.refund('login:k', 60_000);
    await s.refund('login:k', 60_000);
    assert.equal(fake.keys().get(key)!.v, 0);
    assert.equal(fake.keys().get(key)!.exp, ttl);
    fake.expire(key);
    await s.refund('login:k', 60_000);
    assert.equal(fake.keys().has(key), false);
    await s.hit('login:k', 5, 60_000);
    assert.equal(fake.keys().get(key)!.v, 1);
    assert.notEqual(fake.keys().get(key)!.exp, null);
  } finally { await fake.close(); }
});

test('redis: clear deletes current and previous window only', async () => {
  const fake = await startFakeRedis();
  const real = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const s = new RedisStore({ host: '127.0.0.1', port: fake.port, tls: false, db: 0 });
    await s.hit('acct', 5, 60_000);
    now -= 60_000;
    await s.hit('acct', 5, 60_000);
    // 上一个窗口的 PEXPIRE 恰好落在起始时刻。停在窗口内 1ms，两个 key 都还活着，窗口号不变。
    now = 1_700_000_000_000 - 1;
    assert.equal(fake.keys().size, 2);
    await s.clear([{ key: 'acct', windowMs: 60_000 }]);
    assert.equal(fake.keys().size, 0);
    const dels = fake.commands().filter((c) => c[0] === 'DEL').map((c) => c[1]);
    const w = Math.floor(now / 60_000);
    assert.deepEqual(dels, [`rl:acct:${w}`, `rl:acct:${w - 1}`]);
    assert.ok(fake.commands().every((c) => c[0] !== 'SCAN' && c[0] !== 'KEYS'));
    assert.equal(await s.hit('acct', 5, 60_000), true);
    assert.equal([...fake.keys().values()][0].v, 1);
  } finally { Date.now = real; await fake.close(); }
});

test('redis: auth failure, bad reply, timeout and disconnect throw safe errors', async () => {
  const auth = await startFakeRedis({ password: 'expected-secret' });
  try {
    await assert.rejects(new RedisStore({ host: '127.0.0.1', port: auth.port, tls: false, db: 0, password: 'other-secret' }).hit('k', 1, 60_000), (e: Error) => {
      assert.equal(e.message, 'redis auth failed');
      assert.equal(e.message.includes('other-secret') || e.message.includes('expected-secret'), false);
      return true;
    });
  } finally { await auth.close(); }
  const bad = await startFakeRedis({ failCommand: 'INCR' });
  try {
    await assert.rejects(new RedisStore({ host: '127.0.0.1', port: bad.port, tls: false, db: 0 }).hit('k', 1, 60_000), (e: Error) => {
      assert.equal(e.message, 'redis bad response');
      return true;
    });
  } finally { await bad.close(); }
  const slow = await startFakeRedis({ hold: true });
  try {
    const t0 = Date.now();
    await assert.rejects(new RedisStore({ host: '127.0.0.1', port: slow.port, tls: false, db: 0 }, 100).hit('k', 1, 60_000), /redis timeout/);
    assert.ok(Date.now() - t0 < 1000);
  } finally { await slow.close(); }
  const port = await closedPort();
  await assert.rejects(new RedisStore({ host: '127.0.0.1', port, tls: false, db: 0 }).hit('k', 1, 60_000), (e: Error) => {
    assert.equal(e.message, 'redis connection failed');
    assert.equal(e.message.includes(String(port)), false);
    return true;
  });
});

test('redis: SELECT when the URL has a db, and hitRateLimit fail modes still apply', async () => {
  const fake = await startFakeRedis({ password: 'pw' });
  try {
    const s = createRateLimitStore({ RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://:pw@127.0.0.1:${fake.port}/2` });
    assert.ok(s instanceof RedisStore);
    assert.equal(await s.hit('k', 1, 60_000), true);
    assert.ok(fake.commands().some((c) => c[0] === 'SELECT' && c[1] === '2'));
    assert.deepEqual(fake.auths(), ['pw']);
  } finally { await fake.close(); }
  const port = await closedPort();
  setRateLimitStore(new RedisStore({ host: '127.0.0.1', port, tls: false, db: 0 }));
  try {
    await quiet(async () => {
      assert.equal(await hitRateLimit('rds:c', 100, 60_000, { onStoreError: 'closed' }), false);
      assert.equal(await hitRateLimit('rds:o', 1, 60_000, { onStoreError: 'open' }), true);
      const r = [];
      for (let i = 0; i < 3; i++) r.push(await hitRateLimit('rds:l', 2, 60_000, { onStoreError: 'local' }));
      assert.deepEqual(r, [true, true, false]);
    });
  } finally { setRateLimitStore(undefined); }
});

// ---- #74：按路由的故障模式、环境前缀、邮箱 HMAC、noip ----
const failing: RateLimitStore = { hit: async () => { throw new Error('down'); }, refund: async () => { throw new Error('down'); } };
const recording = () => { const keys: string[] = []; const m = new MS(); return { keys, store: { hit: (k: string, l: number, w: number) => { keys.push(k); return m.hit(k, l, w); }, refund: (k: string, w: number) => m.refund(k, w) } as RateLimitStore }; };
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
  setRateLimitStore({ hit: async (k: string) => { throw new Error(`boom ${k}`); }, refund: async (k: string) => { throw new Error(`boom ${k}`); } });
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

// ---- P2 enroll 作废：refund（退回一次 hit）----
async function withClock<T>(f: (set: (t: number) => void) => Promise<T>) {
  const real = Date.now; let now = 1_000_000; Date.now = () => now;
  try { return await f((t) => { now = t; }); } finally { Date.now = real; }
}

test('memory refund: removes the latest hit, floors at 0, no-op on missing/expired key', async () => {
  await withClock(async (set) => {
    const s = new MemoryStore();
    await s.refund('none', 1000); // 不存在：不报错
    await s.hit('r', 2, 1000); await s.hit('r', 2, 1000);
    assert.equal(await s.hit('r', 2, 1000), false, 'full');
    await s.refund('r', 1000); await s.refund('r', 1000);
    assert.equal(await s.hit('r', 2, 1000), true, 'room again after refunds');
    for (let i = 0; i < 5; i++) await s.refund('r', 1000); // 退到 0 以下也不会变成负数
    assert.deepEqual([await s.hit('r', 2, 1000), await s.hit('r', 2, 1000), await s.hit('r', 2, 1000)], [true, true, false], 'floored at 0');
    set(1_000_000 + 5000); // 窗口过期
    await s.refund('r', 1000);
    assert.deepEqual([await s.hit('r', 1, 1000), await s.hit('r', 1, 1000)], [true, false], 'after expiry: refund no-op, fresh count starts at 1');
  });
});

/** 很小的 Redis 模拟：INCR、PEXPIRE NX、按 TTL 过期，EVAL 只认 REFUND_LUA（按脚本语义执行：存在且 > 0 才 DECR，不碰 TTL） */
function fakeRedis() {
  const kv = new Map<string, { v: number; exp: number | null }>();
  let now = 0;
  const live = (k: string) => { const e = kv.get(k); if (e && e.exp !== null && e.exp <= now) { kv.delete(k); return undefined; } return e; };
  const run = (c: string[]): unknown => {
    if (c[0] === 'INCR') { const e = live(c[1]) ?? { v: 0, exp: null }; e.v++; kv.set(c[1], e); return e.v; }
    if (c[0] === 'PEXPIRE') { const e = live(c[1]); if (!e || (c[3] === 'NX' && e.exp !== null)) return 0; e.exp = now + Number(c[2]); return 1; }
    if (c[0] === 'EVAL') { assert.equal(c[1], REFUND_LUA); assert.equal(c[2], '1'); const e = live(c[3]); if (e && e.v > 0) return --e.v; return 0; }
    throw new Error('unexpected ' + c[0]);
  };
  return { kv, live, tick: (ms: number) => { now += ms; }, handler: (r: { body: Buffer }, res: import('node:http').ServerResponse) => {
    const cmds = JSON.parse(r.body.toString()) as string[][];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(cmds.map((c) => ({ result: run(c) }))));
  } };
}

test('upstash refund: conditional DECR via EVAL on the same rl:<key>:<window> key hit INCRs; script never touches TTL', async () => {
  assert.match(REFUND_LUA, /GET/); assert.match(REFUND_LUA, /v > 0/); assert.match(REFUND_LUA, /DECR/);
  assert.doesNotMatch(REFUND_LUA, /EXPIRE|PERSIST|SET|TTL|INCR/i);
  const r = fakeRedis();
  const srv = await mockServer(r.handler);
  try {
    const s = new UpstashStore(srv.url, 'tok');
    await s.hit('login:k', 5, 60_000); await s.hit('login:k', 5, 60_000);
    await s.refund('login:k', 60_000);
    const incr = JSON.parse(srv.reqs[0].body.toString()) as string[][];
    const ev = JSON.parse(srv.reqs[2].body.toString()) as string[][];
    assert.deepEqual(ev, [['EVAL', REFUND_LUA, '1', incr[0][1]]], 'same key as INCR');
    assert.equal(srv.reqs[2].headers.authorization, 'Bearer tok');
    const k = incr[0][1];
    assert.equal(r.live(k)!.v, 1); const ttl = r.live(k)!.exp;
    await s.refund('login:k', 60_000); await s.refund('login:k', 60_000);
    assert.equal(r.live(k)!.v, 0, 'floored at 0'); assert.equal(r.live(k)!.exp, ttl, 'TTL untouched');
  } finally { await srv.close(); }
});

test('upstash refund after key expiry does not recreate the key; next hit counts 1 and sets a TTL', async () => {
  const r = fakeRedis();
  const srv = await mockServer(r.handler);
  try {
    const s = new UpstashStore(srv.url, 'tok');
    await s.hit('k2', 5, 60_000);
    const k = (JSON.parse(srv.reqs[0].body.toString()) as string[][])[0][1];
    r.tick(60_000); // key 过期（同一个窗口序号的 key，在 Redis 里按 TTL 消失）
    assert.equal(r.live(k), undefined);
    await s.refund('k2', 60_000);
    assert.equal(r.kv.has(k), false, 'refund did not create the key');
    await s.hit('k2', 5, 60_000);
    assert.equal(r.live(k)!.v, 1); assert.notEqual(r.live(k)!.exp, null, 'TTL set by PEXPIRE NX');
  } finally { await srv.close(); }
});

test('upstash refund: errors throw from the store; refundRateLimit swallows them silently', async () => {
  const down = await mockServer((_r, res) => { res.statusCode = 503; res.end('down'); });
  try { await assert.rejects(new UpstashStore(down.url, 't').refund('k', 60_000), /upstash 503/); } finally { await down.close(); }
  const bad = await mockServer((_r, res) => { res.end(JSON.stringify([{ error: 'NOSCRIPT' }])); });
  try { await assert.rejects(new UpstashStore(bad.url, 't').refund('k', 60_000), /bad response/); } finally { await bad.close(); }
  setRateLimitStore(failing);
  const logs: unknown[] = []; const e = console.error; console.error = (...a: unknown[]) => { logs.push(a); };
  try { await refundRateLimit('x', 60_000); } finally { console.error = e; setRateLimitStore(undefined); }
  assert.deepEqual(logs, []);
});

test('refundRateLimit: same env prefix as hitRateLimit, gives one hit back', async () => {
  const m = new MS(); const keys: string[] = [];
  setRateLimitStore({ hit: (k, l, w) => m.hit(k, l, w), refund: (k, w) => { keys.push(k); return m.refund(k, w); } });
  try {
    assert.equal(await hitRateLimit('rf:a', 1, 60_000), true);
    await refundRateLimit('rf:a', 60_000);
    assert.equal(keys[0], `${rateLimitEnv()}:rf:a`);
    assert.equal(await hitRateLimit('rf:a', 1, 60_000), true, 'refunded slot reused');
    assert.equal(await hitRateLimit('rf:a', 1, 60_000), false);
  } finally { setRateLimitStore(undefined); }
});
