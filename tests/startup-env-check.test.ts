// deploy-readiness：standalone 启动时的生产配置检查（src/instrumentation.ts → runStartupEnvCheck）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runStartupEnvCheck } from '../src/lib/server/startup/env-check';

const SECRET = 'fake-startup-value-0123456789abcdef-XYZ';
const prod = {
  APP_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', RATE_LIMIT_STORE: 'upstash',
  UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: SECRET, STORAGE_DRIVER: 'local', UPLOAD_DIR: '/data/uploads',
  DATABASE_URL: `postgresql://u:${SECRET}@db/x`, AUTH_SECRET: SECRET, AUTH_URL: 'https://packjoyu.com', ADMIN_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
  PRIVACY_HASH_SECRET: SECRET, CRON_SECRET: SECRET, TURNSTILE_SECRET_KEY: '0x4AAAAAAArealSecretKey', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAArealSiteKey',
  SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'u@gmail.com', SMTP_PASS: SECRET, MAIL_FROM: 'PackJoyU <u@gmail.com>', INQUIRY_NOTIFY_EMAIL: 'n@example.com',
  MAIL_SEND_ADAPTER: 'smtp', MAIL_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_SITE_URL: 'https://packjoyu.com', APP_ORIGIN: 'https://packjoyu.com', EDGE_AUTH_SECRET: SECRET,
};
function run(env: Record<string, string | undefined>) {
  const logs: string[] = []; const exits: number[] = [];
  runStartupEnvCheck(env, { dirProblem: () => null, cwd: '/app', log: (m) => logs.push(m), exit: ((c: number) => { exits.push(c); }) as never });
  return { logs, exits };
}

test('完整配置：不退出、不打印', () => {
  assert.deepEqual(run(prod), { logs: [], exits: [] });
});

test('非生产：什么都不查', () => {
  assert.deepEqual(run({ APP_ENV: 'preview' }), { logs: [], exits: [] });
});

test('EDGE_AUTH_SECRET / DATABASE_URL / SMTP_PASS / UPLOAD_DIR / MAIL_SEND_ADAPTER 逐个缺失 → exit(1)，只打印变量名，不含任何值', () => {
  for (const k of ['EDGE_AUTH_SECRET', 'DATABASE_URL', 'SMTP_PASS', 'UPLOAD_DIR', 'MAIL_SEND_ADAPTER']) {
    const { logs, exits } = run({ ...prod, [k]: undefined });
    assert.deepEqual(exits, [1], k);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(k));
    assert.ok(!logs[0].includes(SECRET) && !logs[0].includes('/data/uploads'), `value leaked (${k})`);
  }
});

test('instrumentation.ts：只在 nodejs runtime 调用启动检查；next.config 仍按阶段检查', () => {
  const src = readFileSync('src/instrumentation.ts', 'utf8');
  assert.match(src, /export async function register\(\)/);
  assert.match(src, /process\.env\.NEXT_RUNTIME === 'nodejs'/);
  assert.match(src, /runStartupEnvCheck\(\)/);
  const lib = readFileSync('src/lib/server/startup/env-check.ts', 'utf8');
  assert.match(lib, /prodEnvProblems\(env, 'runtime', deps\)/);
  assert.match(lib, /process\.exit\(code\)/);
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /output: 'standalone'/);
});
