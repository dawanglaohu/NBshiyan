import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prodEnvProblems, assertProdEnv } from '../prod-env-check';

test('非生产环境（CI/预览/本地）不检查', () => {
  assert.deepEqual(prodEnvProblems({ CI: 'true', NODE_ENV: 'production', NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }), []);
  assert.deepEqual(prodEnvProblems({ VERCEL: '1', VERCEL_ENV: 'preview', NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }), []);
});
test('生产环境：mock 开启或 ADMIN_API 不是 http 时失败', () => {
  const base = { ...prodFull, UPSTASH_REDIS_REST_TOKEN: 't' };
  assert.deepEqual(prodEnvProblems(base), []);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '0' }).length, 0);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_FOO_MOCK: 'true' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_ADMIN_API: 'mock' }).length, 1);
  // #291：mock 改成动态 import 后，生产环境仍然拒绝 mock 开关
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_ADMIN_MAIL: 'mock' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_ADMIN_MAIL: 'http' }).length, 0);
  assert.throws(() => assertProdEnv({ ...base, NEXT_PUBLIC_ADMIN_API: 'mock' }), /NEXT_PUBLIC_ADMIN_API/);
  assert.equal(prodEnvProblems({ ...base, RATE_LIMIT_STORE: 'memory' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, UPSTASH_REDIS_REST_TOKEN: '' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, UPSTASH_REDIS_REST_URL: 'http://x' }).length, 1);
  assert.equal(prodEnvProblems({ APP_ENV: 'production' }).length, 4 + 18);
  assert.throws(() => assertProdEnv({ VERCEL_ENV: 'production' }));
});

const SECRET = 'S3cr3t-value-that-must-not-leak-0123456789';
const prodFull = {
  VERCEL: '1', VERCEL_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', RATE_LIMIT_STORE: 'upstash',
  UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: SECRET,
  STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'akid', R2_SECRET_ACCESS_KEY: SECRET, R2_BUCKET: 'b',
  DATABASE_URL: `postgres://u:${SECRET}@h/db`, AUTH_SECRET: SECRET, AUTH_URL: 'https://packjoyu.com',
  ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'), PRIVACY_HASH_SECRET: SECRET, CRON_SECRET: SECRET,
  TURNSTILE_SECRET_KEY: '0x4AAAAAAArealSecretKey', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAArealSiteKey',
  RESEND_API_KEY: 're_' + SECRET, MAIL_FROM: 'a@b.com', INQUIRY_NOTIFY_EMAIL: 'c@d.com',
  NEXT_PUBLIC_SITE_URL: 'https://packjoyu.com', ADMIN_SEED_TOTP_SECRET: '', EDGE_AUTH_SECRET: SECRET,
};

test('#74 完整生产配置通过', () => {
  assert.deepEqual(prodEnvProblems(prodFull), []);
  assert.doesNotThrow(() => assertProdEnv(prodFull));
});

test('#74 每一项缺失或不合规都单独报错', () => {
  const cases: Record<string, string | undefined>[] = [
    { STORAGE_DRIVER: 'local' },
    ...['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL',
      'PRIVACY_HASH_SECRET', 'CRON_SECRET', 'RESEND_API_KEY', 'MAIL_FROM', 'INQUIRY_NOTIFY_EMAIL'].map((k) => ({ [k]: '' })),
    { ADMIN_TOTP_KEY: Buffer.alloc(16).toString('base64') },
    { PRIVACY_HASH_SECRET: 'short' },
    { CRON_SECRET: 'x'.repeat(31) },
    { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    { TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' },
    { TURNSTILE_SECRET_KEY: '3x0000000000000000000000000000000AA' },
    { NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
    { NEXT_PUBLIC_TURNSTILE_SITE_KEY: '2x00000000000000000000AB' },
    { NEXT_PUBLIC_TURNSTILE_SITE_KEY: '3x00000000000000000000FF' },
    { NEXT_PUBLIC_SITE_URL: 'http://packjoyu.com' },
    { ADMIN_SEED_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' },
  ];
  for (const c of cases) assert.equal(prodEnvProblems({ ...prodFull, ...c }).length, 1, JSON.stringify(c));
  // 空的 ADMIN_TOTP_KEY / TURNSTILE / SITE_URL 只报“未设置”一条
  for (const k of ['ADMIN_TOTP_KEY', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_SITE_URL'])
    assert.deepEqual(prodEnvProblems({ ...prodFull, [k]: '' }), [`${k} 未设置`]);
});

test('#74 多个问题一次性报出', () => {
  const p = prodEnvProblems({ ...prodFull, CRON_SECRET: '', R2_BUCKET: '', STORAGE_DRIVER: 'local' });
  assert.equal(p.length, 3);
  assert.throws(() => assertProdEnv({ ...prodFull, CRON_SECRET: '', R2_BUCKET: '' }), /CRON_SECRET[\s\S]*R2_BUCKET|R2_BUCKET[\s\S]*CRON_SECRET/);
});

test('#74 预览环境不检查', () => {
  assert.deepEqual(prodEnvProblems({ ...prodFull, VERCEL_ENV: 'preview', STORAGE_DRIVER: 'local', CRON_SECRET: '', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }), []);
  assert.deepEqual(prodEnvProblems({ VERCEL_ENV: 'development' }), []);
});

test('#74 错误信息里不出现密钥值', () => {
  const bad = { ...prodFull, ADMIN_TOTP_KEY: 'bm90LTMyLWJ5dGVz', PRIVACY_HASH_SECRET: 'short-secret-xyz', CRON_SECRET: 'short-cron-abc',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', ADMIN_SEED_TOTP_SECRET: 'JBSWY3DPEHPK3PXP', STORAGE_DRIVER: 'local' };
  let msg = '';
  try { assertProdEnv(bad); } catch (e) { msg = (e as Error).message; }
  assert.ok(msg);
  for (const s of [SECRET, 'bm90LTMyLWJ5dGVz', 'short-secret-xyz', 'short-cron-abc', '1x0000000000000000000000000000000AA', 'JBSWY3DPEHPK3PXP'])
    assert.ok(!msg.includes(s), s);
});

test('APP_ENV: Vercel 自动变量单独不再触发生产自检', () => {
  assert.deepEqual(prodEnvProblems({ VERCEL: '1', NODE_ENV: 'production' }), []);
});

test('EDGE_AUTH_SECRET is runtime-only: build phase skips it, runtime / default require >= 32 bytes', () => {
  const noEdge = { ...prodFull, UPSTASH_REDIS_REST_TOKEN: 't', EDGE_AUTH_SECRET: undefined };
  assert.deepEqual(prodEnvProblems(noEdge, 'build'), []);
  assert.doesNotThrow(() => assertProdEnv(noEdge, 'build'));
  assert.deepEqual(prodEnvProblems(noEdge, 'runtime'), ['EDGE_AUTH_SECRET 未设置']);
  assert.deepEqual(prodEnvProblems(noEdge), ['EDGE_AUTH_SECRET 未设置']);
  assert.throws(() => assertProdEnv(noEdge, 'runtime'), /EDGE_AUTH_SECRET/);
  const short = { ...noEdge, EDGE_AUTH_SECRET: 'short-edge-value' };
  assert.equal(prodEnvProblems(short, 'runtime').length, 1);
  let msg = ''; try { assertProdEnv(short, 'runtime'); } catch (e) { msg = (e as Error).message; }
  assert.ok(msg.includes('EDGE_AUTH_SECRET') && !msg.includes('short-edge-value'));
  assert.deepEqual(prodEnvProblems({ ...noEdge, EDGE_AUTH_SECRET: SECRET }, 'runtime'), []);
});

test('next.config runs the prod check per phase (build skips runtime-only secrets)', () => {
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /assertProdEnv\(process\.env, phase === PHASE_PRODUCTION_BUILD \? 'build' : 'runtime'\)/);
  assert.doesNotMatch(cfg, /EDGE_AUTH_SECRET/);
});
