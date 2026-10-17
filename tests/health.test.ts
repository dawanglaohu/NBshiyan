// deploy-readiness：GET /api/health。见 PR 正文安全审查清单第 3 项。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { healthResponse, HEALTH_DB_TIMEOUT_MS, HEALTH_RATE_LIMIT } from '../src/lib/server/health';
import { MemoryStore } from '../src/lib/server/ratelimit';

const quiet = { log: () => {} };
const fresh = () => ({ limiter: new MemoryStore(), subject: '203.0.113.7', ...quiet });

test('DB 正常：200，body 只有 {ok:true}，Cache-Control: no-store', async () => {
  const r = await healthResponse({ ...fresh(), selectOne: async () => [{ '?column?': 1 }] });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"ok":true}');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual([...r.headers.keys()].sort(), ['cache-control', 'content-type']);
});

test('DB 失败：503 {ok:false}，响应里没有错误信息；日志只记错误类型 / Prisma 错误码', async () => {
  const logs: string[] = [];
  const secretish = 'connect ECONNREFUSED postgres://u:hunter2@db:5432/x';
  const r = await healthResponse({ ...fresh(), log: (m) => logs.push(m), selectOne: async () => { throw Object.assign(new Error(secretish), { code: 'P1001' }); } });
  assert.equal(r.status, 503);
  assert.equal(await r.text(), '{"ok":false}');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(logs, ['[health] db check failed: P1001']);
  const r2 = await healthResponse({ ...fresh(), log: (m) => logs.push(m), selectOne: async () => { throw new Error(secretish); } });
  assert.equal(r2.status, 503);
  assert.equal(logs[1], '[health] db check failed: error');
  assert.ok(!logs.join('').includes('hunter2'));
});

test('DB 超时（1–2 秒内）：503，不会一直挂着', async () => {
  assert.ok(HEALTH_DB_TIMEOUT_MS >= 1000 && HEALTH_DB_TIMEOUT_MS <= 2000);
  const logs: string[] = [];
  const t0 = Date.now();
  const r = await healthResponse({ ...fresh(), log: (m) => logs.push(m), timeoutMs: 50, selectOne: () => new Promise(() => {}) });
  assert.equal(r.status, 503);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(logs, ['[health] db check failed: timeout']);
});

test('并发请求共用一次 SELECT 1', async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  const d = { ...fresh(), selectOne: async () => { calls++; await gate; } };
  const ps = [healthResponse(d), healthResponse(d), healthResponse(d)];
  await new Promise((ok) => setTimeout(ok, 10)); release();
  const rs = await Promise.all(ps);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  assert.equal(calls, 1);
});

test('限流：按 rateLimitSubject 分桶（进程内存，不连 Redis），超限 429 {ok:false} + Retry-After，不再查库', async () => {
  const d = fresh(); let calls = 0;
  const sel = async () => { calls++; };
  for (let i = 0; i < HEALTH_RATE_LIMIT; i++) assert.equal((await healthResponse({ ...d, selectOne: sel })).status, 200);
  const before = calls;
  const r = await healthResponse({ ...d, selectOne: sel });
  assert.equal(r.status, 429); assert.equal(await r.text(), '{"ok":false}');
  assert.equal(r.headers.get('retry-after'), '60'); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(calls, before);
  // 其他来源不受影响
  assert.equal((await healthResponse({ ...d, subject: '198.51.100.1', selectOne: sel })).status, 200);
});

test('路由：只做 SELECT 1、用 rateLimitSubject(clientIp(req))，不引用 Redis/SMTP/存储/版本/环境；middleware 不处理 /api', () => {
  const src = readFileSync('src/app/api/health/route.ts', 'utf8');
  assert.match(src, /prisma\.\$queryRaw`SELECT 1`/);
  assert.match(src, /rateLimitSubject\(clientIp\(req\)\)/);
  assert.match(src, /dynamic = 'force-dynamic'/);
  const lib = readFileSync('src/lib/server/health.ts', 'utf8');
  const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const s of [code(src), code(lib)]) {
    assert.doesNotMatch(s, /upstash|hitRateLimit|rateLimitStore\(|nodemailer|smtp|storage|fetch\(|process\.env|version|VERCEL_GIT|COMMIT|SHA/i);
  }
  assert.doesNotMatch(src, /mailSwitchGate|requireAdmin/);
  const mw = readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /matcher: \['\/\(\(\?!api\|/); // /api/* 不进 middleware，不会被加 locale 前缀
});
