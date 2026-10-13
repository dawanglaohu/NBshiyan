import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// 只验证在连库之前就退出；用不存在的端口，万一没拦住也连不上
function run(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
    env: { PATH: process.env.PATH ?? '', ADMIN_SEED_EMAIL: 'a@ci.test', ADMIN_SEED_PASSWORD: 'ci-password-123456', ...env },
    encoding: 'utf8', timeout: 20_000,
  });
  return { code: r.status, err: r.stderr };
}

test('seed refuses production database host (exact and wildcard)', () => {
  let r = run({ DATABASE_URL: 'postgresql://u:p@db.prod.example.com:1/x', PROD_DATABASE_HOST: 'other.host, db.prod.example.com' });
  assert.equal(r.code, 1); assert.match(r.err, /生产库/);
  r = run({ DATABASE_URL: 'postgresql://u:p@abc.pooler.supabase.com:1/x', PROD_DATABASE_HOST: '*.supabase.com' });
  assert.equal(r.code, 1); assert.match(r.err, /生产库/);
});

test('seed refuses ADMIN_SEED_TOTP_SECRET in production env', () => {
  const r = run({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x', NODE_ENV: 'production', ADMIN_SEED_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DP' });
  assert.equal(r.code, 1); assert.match(r.err, /ADMIN_SEED_TOTP_SECRET/);
});

test('non-matching host passes the guard (fails later only on DB connect)', () => {
  const r = run({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x', PROD_DATABASE_HOST: 'db.prod.example.com' });
  assert.doesNotMatch(r.err, /生产库/);
});

test('seed refuses missing or unparseable DATABASE_URL', () => {
  for (const url of ['', 'not a url', 'postgresql://', '://@:5432/x']) {
    const r = run({ DATABASE_URL: url, PROD_DATABASE_HOST: 'db.prod.example.com' });
    assert.equal(r.code, 1, url); assert.match(r.err, /无法解析/, url);
  }
});
