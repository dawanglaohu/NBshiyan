import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prodEnvProblems, assertProdEnv } from '../prod-env-check';

test('非生产环境（CI/预览/本地）不检查', () => {
  assert.deepEqual(prodEnvProblems({ CI: 'true', NODE_ENV: 'production', NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }), []);
  assert.deepEqual(prodEnvProblems({ VERCEL: '1', VERCEL_ENV: 'preview', NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }), []);
});
test('生产环境：mock 开启或 ADMIN_API 不是 http 时失败', () => {
  const base = { VERCEL: '1', VERCEL_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' };
  assert.deepEqual(prodEnvProblems(base), []);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '0' }).length, 0);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_FOO_MOCK: 'true' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, NEXT_PUBLIC_ADMIN_API: 'mock' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, RATE_LIMIT_STORE: 'memory' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, UPSTASH_REDIS_REST_TOKEN: '' }).length, 1);
  assert.equal(prodEnvProblems({ ...base, UPSTASH_REDIS_REST_URL: 'http://x' }).length, 1);
  assert.equal(prodEnvProblems({ VERCEL: '1', NODE_ENV: 'production' }).length, 4);
  assert.throws(() => assertProdEnv({ VERCEL_ENV: 'production' }));
});
