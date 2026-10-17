import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prodEnvProblems, assertProdEnv, storageProblems, RUNTIME_ONLY } from '../prod-env-check';

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
  assert.equal(prodEnvProblems({ APP_ENV: 'production' }).length, 24); // APP_ORIGIN 生产必填；deploy-readiness：STORAGE_DRIVER 未设置只报一条（不再连带 4 个 R2_*）；#74：RESEND_API_KEY → SMTP_HOST/PORT/USER/PASS；MAIL_SEND_ADAPTER、MAIL_WEBHOOK_SECRET 必填；#311：EDGE_AUTH_SECRET（运行时）；SMTP_USER/SMTP_PASS/MAIL_WEBHOOK_SECRET 也是运行时（默认 any 阶段照样报）
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
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u@example.test', SMTP_PASS: SECRET, MAIL_FROM: 'a@b.com', INQUIRY_NOTIFY_EMAIL: 'c@d.com',
  MAIL_SEND_ADAPTER: 'smtp', MAIL_WEBHOOK_SECRET: SECRET,
  NEXT_PUBLIC_SITE_URL: 'https://packjoyu.com', APP_ORIGIN: 'https://packjoyu.com', ADMIN_SEED_TOTP_SECRET: '', EDGE_AUTH_SECRET: SECRET,
};

test('#74 完整生产配置通过', () => {
  assert.deepEqual(prodEnvProblems(prodFull), []);
  assert.doesNotThrow(() => assertProdEnv(prodFull));
});

test('#74 每一项缺失或不合规都单独报错', () => {
  const cases: Record<string, string | undefined>[] = [
    { STORAGE_DRIVER: 'local' },
    ...['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL',
      'PRIVACY_HASH_SECRET', 'CRON_SECRET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'INQUIRY_NOTIFY_EMAIL'].map((k) => ({ [k]: '' })),
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
    // #74 §16 Gmail SMTP：端口只能 465 / 587（TLS 强制）、不能关证书校验、From 不能是 REPLY_DOMAIN、生产不能用 mock 发信、上限必须合法
    { SMTP_PORT: '25' }, { SMTP_PORT: '2525' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { MAIL_FROM: 'no-reply@geiom.com', REPLY_DOMAIN: 'geiom.com' },
    { MAIL_SEND_ADAPTER: 'mock' }, { MAIL_SEND_ADAPTER: 'log' }, { MAIL_SEND_ADAPTER: '' }, { MAIL_SEND_ADAPTER: undefined }, { MAIL_SEND_ADAPTER: 'SMTP' }, { MAIL_DAILY_CAP: '0' }, { MAIL_DAILY_CAP: 'abc' }, { MAIL_DAILY_CAP_RESET: '25:00' }, { MAIL_WEBHOOK_SECRET: 'short' }, { MAIL_WEBHOOK_SECRET: 'x'.repeat(31) }, { MAIL_WEBHOOK_SECRET: '' }, { MAIL_WEBHOOK_SECRET: undefined },
  ];
  for (const c of cases) assert.equal(prodEnvProblems({ ...prodFull, ...c }).length, 1, JSON.stringify(c));
  // 空的 ADMIN_TOTP_KEY / TURNSTILE / SITE_URL 只报“未设置”一条
  for (const k of ['ADMIN_TOTP_KEY', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_SITE_URL'])
    assert.deepEqual(prodEnvProblems({ ...prodFull, [k]: '' }), [`${k} 未设置`]);
});

test('#74 多个问题一次性报出', () => {
  const p = prodEnvProblems({ ...prodFull, CRON_SECRET: '', R2_BUCKET: '', STORAGE_DRIVER: 'local' });
  // local 驱动不再要求 R2_*，改为要求 UPLOAD_DIR
  assert.deepEqual(p.map((s) => s.split(/[ ：（]/)[0]), ['CRON_SECRET', 'UPLOAD_DIR']);
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

test('#74 审查：MAIL_SEND_ADAPTER 必须是 smtp、MAIL_WEBHOOK_SECRET 必须 ≥32 字节，否则 assertProdEnv 拒绝启动；报错不含值', () => {
  for (const over of [{ MAIL_SEND_ADAPTER: 'mock' }, { MAIL_SEND_ADAPTER: 'log' }, { MAIL_SEND_ADAPTER: undefined }]) {
    assert.throws(() => assertProdEnv({ ...prodFull, ...over }), /MAIL_SEND_ADAPTER/);
  }
  for (const over of [{ MAIL_WEBHOOK_SECRET: undefined }, { MAIL_WEBHOOK_SECRET: 'z'.repeat(31) }]) {
    let msg = '';
    try { assertProdEnv({ ...prodFull, ...over }); } catch (e) { msg = (e as Error).message; }
    assert.match(msg, /MAIL_WEBHOOK_SECRET/); assert.ok(!msg.includes('zzzz'));
  }
  assert.doesNotThrow(() => assertProdEnv({ ...prodFull, MAIL_WEBHOOK_SECRET: 'z'.repeat(32) }));
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

const MAIL_RUNTIME = ['SMTP_USER', 'SMTP_PASS', 'MAIL_WEBHOOK_SECRET'] as const;
test('#74 邮件密钥只在运行时检查：RUNTIME_ONLY 含 SMTP_USER / SMTP_PASS / MAIL_WEBHOOK_SECRET（不含 CRON_SECRET 等其他变量）', () => {
  assert.deepEqual([...RUNTIME_ONLY].sort(), ['EDGE_AUTH_SECRET', ...MAIL_RUNTIME].sort());
});

test('deploy-readiness：build 阶段只查公开值（NEXT_PUBLIC_*、mock），构建机不需要任何密钥或服务端配置', () => {
  // 只有公开值：build 通过
  const publicOnly = { APP_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', NEXT_PUBLIC_SITE_URL: 'https://packjoyu.com', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAArealSiteKey' };
  assert.deepEqual(prodEnvProblems(publicOnly, 'build'), []);
  assert.doesNotThrow(() => assertProdEnv(publicOnly, 'build'));
  // 同样的输入在 runtime 阶段必须拒绝：密钥、数据库、存储、限流、发信全部报出
  const rt = prodEnvProblems(publicOnly, 'runtime').map((s) => s.split(/[ ：（=]/)[0]);
  for (const k of [...RUNTIME_ONLY, 'DATABASE_URL', 'AUTH_SECRET', 'CRON_SECRET', 'PRIVACY_HASH_SECRET', 'ADMIN_TOTP_KEY', 'TURNSTILE_SECRET_KEY', 'STORAGE_DRIVER', 'RATE_LIMIT_STORE', 'MAIL_SEND_ADAPTER', 'SMTP_HOST'])
    assert.ok(rt.includes(k), k);
  // 公开值在 build 阶段照样拒绝（会被内联进产物，构建后改不了）
  for (const over of [{ NEXT_PUBLIC_SITE_URL: 'http://packjoyu.com' }, { NEXT_PUBLIC_SITE_URL: '' }, { NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
    { NEXT_PUBLIC_ADMIN_API: 'mock' }, { NEXT_PUBLIC_ADMIN_MAIL: 'mock' }, { NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }])
    assert.equal(prodEnvProblems({ ...publicOnly, ...over }, 'build').length, 1, JSON.stringify(over));
});

test('#74 build 阶段：三个邮件密钥全部缺失 → 没有任何邮件密钥问题；MAIL_SEND_ADAPTER / SMTP 端口改在 runtime 检查（deploy-readiness）', () => {
  const noSecrets = { ...prodFull, UPSTASH_REDIS_REST_TOKEN: 't', EDGE_AUTH_SECRET: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, MAIL_WEBHOOK_SECRET: undefined };
  assert.deepEqual(prodEnvProblems(noSecrets, 'build'), []);
  assert.doesNotThrow(() => assertProdEnv(noSecrets, 'build'));
  // 非密钥的邮件配置不合规：runtime（standalone 启动 / next start）拒绝
  assert.ok(prodEnvProblems({ ...prodFull, MAIL_SEND_ADAPTER: 'mock' }, 'runtime').some((p) => p.startsWith('MAIL_SEND_ADAPTER')));
  assert.ok(prodEnvProblems({ ...prodFull, SMTP_PORT: '25' }, 'runtime').some((p) => p.includes('SMTP 发信配置无效')));
  // 构建时也不会因为密钥“太短”报错（根本不看）
  assert.deepEqual(prodEnvProblems({ ...noSecrets, MAIL_WEBHOOK_SECRET: 'short' }, 'build'), []);
});

test('#74 runtime 阶段：三个邮件密钥逐个缺失 → 各自单独报错，只报变量名，不含任何值', () => {
  const full = { ...prodFull, UPSTASH_REDIS_REST_TOKEN: 't' };
  assert.deepEqual(prodEnvProblems(full, 'runtime'), []);
  const fakes: Record<string, string> = { SMTP_USER: 'fake-runtime-user-7f3a@example.test', SMTP_PASS: 'fake-runtime-pass-7f3a', MAIL_WEBHOOK_SECRET: 'fake-runtime-webhook-7f3a'.padEnd(40, 'q') };
  const withFakes = { ...full, ...fakes };
  for (const k of MAIL_RUNTIME) {
    for (const missing of [undefined, '', '   ']) {
      const env = { ...withFakes, [k]: missing };
      const p = prodEnvProblems(env, 'runtime');
      assert.equal(p.length, 1, `${k}=${JSON.stringify(missing)}: ${p}`);
      assert.ok(p[0].startsWith(k), p[0]);
      let msg = ''; try { assertProdEnv(env, 'runtime'); } catch (e) { msg = (e as Error).message; }
      assert.match(msg, new RegExp(k));
      for (const v of Object.values(fakes)) assert.ok(!msg.includes(v), `value leaked for ${k}`);
    }
  }
  // webhook 密钥少于 32 字节在运行时拒绝
  const short = prodEnvProblems({ ...withFakes, MAIL_WEBHOOK_SECRET: 'z'.repeat(31) }, 'runtime');
  assert.deepEqual(short, ['MAIL_WEBHOOK_SECRET：必须设置且至少 32 字节']);
  // 三个都缺 → 三条，一次性报出
  const all = prodEnvProblems({ ...full, SMTP_USER: undefined, SMTP_PASS: undefined, MAIL_WEBHOOK_SECRET: undefined }, 'runtime');
  assert.deepEqual(all.map((s) => s.split(/[ ：]/)[0]).sort(), [...MAIL_RUNTIME].sort());
});

// ---- deploy-readiness：STORAGE_DRIVER=local（自建服务器挂载数据卷）----
const okDir = () => null;
const localEnv = (over: Record<string, string | undefined> = {}) => {
  const e: Record<string, string | undefined> = { ...prodFull, STORAGE_DRIVER: 'local', UPLOAD_DIR: '/data/uploads', ...over };
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) if (!(k in over)) delete e[k];
  return e;
};

test('local 驱动：UPLOAD_DIR 是存在且可写的绝对路径时通过，不再要求 R2_*', () => {
  assert.deepEqual(prodEnvProblems(localEnv(), 'runtime', { dirProblem: okDir, cwd: '/app' }), []);
  assert.deepEqual(storageProblems(localEnv(), { dirProblem: okDir, cwd: '/app' }), []);
});

test('local 驱动：UPLOAD_DIR 缺失 / 相对 / 非规范 / 根目录 / public/.next 下 / 不可写 都拒绝启动，只报变量名不报路径', () => {
  const cases: [string | undefined, RegExp][] = [
    [undefined, /UPLOAD_DIR 未设置/], ['', /UPLOAD_DIR 未设置/], ['data/uploads', /绝对路径/], ['./uploads', /绝对路径/],
    ['/', /规范/], ['/data/../etc', /规范/], ['/data/./uploads', /规范/], ['/data//uploads', /规范/], ['/data/up\0loads', /绝对路径/],
    ['/app/public/uploads', /public\//], ['/app/public', /public\//], ['/app/.next/cache/u', /\.next\//],
  ];
  for (const [dir, re] of cases) {
    const p = storageProblems(localEnv({ UPLOAD_DIR: dir }), { dirProblem: okDir, cwd: '/app' });
    assert.equal(p.length, 1, String(dir)); assert.match(p[0], re, String(dir));
    if (dir && dir.length > 1) assert.ok(!p[0].includes(dir), `path leaked: ${dir}`);
  }
  const p = prodEnvProblems(localEnv(), 'runtime', { dirProblem: () => '不存在或当前用户不可读写', cwd: '/app' });
  assert.deepEqual(p, ['UPLOAD_DIR 不存在或当前用户不可读写']);
});

test('local 驱动：默认 fs 检查真实目录（可写通过、不存在 / 只读 / 是文件 拒绝）', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'upl-'));
  try {
    assert.deepEqual(storageProblems(localEnv({ UPLOAD_DIR: base }), { cwd: '/app' }), []);
    assert.match(storageProblems(localEnv({ UPLOAD_DIR: join(base, 'missing') }), { cwd: '/app' })[0], /不存在或当前用户不可读写/);
    writeFileSync(join(base, 'f'), 'x');
    assert.match(storageProblems(localEnv({ UPLOAD_DIR: join(base, 'f') }), { cwd: '/app' })[0], /不是目录/);
    if (process.getuid?.() !== 0) {
      const ro = join(base, 'ro'); (await import('node:fs')).mkdirSync(ro); chmodSync(ro, 0o500);
      assert.match(storageProblems(localEnv({ UPLOAD_DIR: ro }), { cwd: '/app' })[0], /不可读写/);
      chmodSync(ro, 0o700);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('r2 驱动行为不变：4 个 R2_* 逐个缺失各报一条；STORAGE_DRIVER 未设置或未知值拒绝', () => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'])
    assert.deepEqual(prodEnvProblems({ ...prodFull, [k]: '' }, 'runtime'), [`${k} 未设置`]);
  for (const d of [undefined, '', 's3', 'R2', 'LOCAL'])
    assert.deepEqual(storageProblems({ ...prodFull, STORAGE_DRIVER: d }), ['STORAGE_DRIVER 必须为 "local"（挂载的数据卷）或 "r2"'], String(d));
});

test('存储检查只在 runtime：build 阶段不看 STORAGE_DRIVER / UPLOAD_DIR / R2_*', () => {
  assert.deepEqual(prodEnvProblems({ ...prodFull, STORAGE_DRIVER: 'local', UPLOAD_DIR: 'relative' }, 'build'), []);
  assert.deepEqual(prodEnvProblems({ ...prodFull, R2_SECRET_ACCESS_KEY: '' }, 'build'), []);
});

test('build 阶段：NEXT_PUBLIC_SITE_URL 缺失 / 非 https / 本机或回环主机名都拒绝', () => {
  const base = { APP_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAArealSiteKey' };
  const bad: [string | undefined, RegExp][] = [
    [undefined, /未设置/], ['', /未设置/], ['http://packjoyu.com', /https/],
    ['https://localhost', /正式域名/], ['https://localhost:3000', /正式域名/], ['https://LOCALHOST.', /正式域名/], ['https://app.localhost', /正式域名/],
    ['https://127.0.0.1', /正式域名/], ['https://127.1.2.3:8443', /正式域名/], ['https://[::1]', /正式域名/], ['https://[::1]:3000/x', /正式域名/],
    ['https://0.0.0.0', /正式域名/], ['https://', /正式域名/], ['https://%zz', /正式域名/],
  ];
  for (const [site, re] of bad) {
    const p = prodEnvProblems({ ...base, NEXT_PUBLIC_SITE_URL: site }, 'build');
    assert.equal(p.length, 1, `${site}: ${p}`); assert.match(p[0], re, String(site));
    assert.ok(site === undefined || site.length < 9 || !p[0].includes(site), 'value not echoed');
  }
  for (const site of ['https://packjoyu.com', 'https://www.packjoyu.com/', 'https://localhost-shop.com', 'https://my.localhosting.ru'])
    assert.deepEqual(prodEnvProblems({ ...base, NEXT_PUBLIC_SITE_URL: site }, 'build'), [], site);
});
