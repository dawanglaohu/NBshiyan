// deploy-readiness：standalone 产物（node .next/standalone/server.js）启动时的生产配置检查。
// 需要先做一次生产构建（output: 'standalone'），默认跳过；CI / 本地这样跑：
//   pnpm build && STANDALONE_TEST=1 node --import tsx --test tests/standalone-start.test.ts
// 只用假值；服务只按子进程 PID 停止。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SERVER = path.resolve('.next/standalone/server.js');
const enabled = process.env.STANDALONE_TEST === '1' && existsSync(SERVER);
const FAKE = {
  APP_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', NEXT_PUBLIC_SITE_URL: 'https://packjoyu.example', APP_ORIGIN: 'https://packjoyu.example',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAAfakePublicSiteKey', RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://fake.upstash.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'fake-upstash-token-ZZQ1', STORAGE_DRIVER: 'local',
  DATABASE_URL: 'postgresql://fakeuser:fake-db-pass-ZZQ2@127.0.0.1:1/fake', AUTH_SECRET: 'fake-auth-secret-ZZQ3-0123456789abcdef', AUTH_URL: 'https://packjoyu.example',
  ADMIN_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'), PRIVACY_HASH_SECRET: 'fake-privacy-hash-ZZQ4-0123456789abcdef', CRON_SECRET: 'fake-cron-secret-ZZQ5-0123456789abcdef',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAfakeSecretKeyZZQ6', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'fake-smtp-user-zzq7@gmail.com',
  SMTP_PASS: 'fake-smtp-pass-ZZQ8', MAIL_FROM: 'PackJoyU <fake-smtp-user-zzq7@gmail.com>', INQUIRY_NOTIFY_EMAIL: 'notify@packjoyu.example', MAIL_SEND_ADAPTER: 'smtp',
  MAIL_WEBHOOK_SECRET: 'fake-webhook-secret-ZZQ9-0123456789abcdef', EDGE_AUTH_SECRET: 'fake-edge-auth-ZZQ0-0123456789abcdef0123',
};
const SECRET_VALUES = Object.entries(FAKE).filter(([k]) => /SECRET|PASS|TOKEN|DATABASE_URL|TOTP/.test(k)).map(([, v]) => v);

type Run = { code: number | null; out: string; ready: boolean; port: number };
/** 向系统要一个空闲端口（listen 0 再关掉），不再随机挑 3400–3899，避免和别的进程撞端口 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}
/**
 * 「Ready in」只说明 Next 打印了日志，不保证端口已经能接请求、instrumentation 已经跑完。
 * 这里轮询到真的能连上（任何 HTTP 状态都算连上）为止：每 250ms 一次，最多 15 秒；连不上就抛错，由调用方让测试失败。
 */
export async function waitForHttp(url: string, timeoutMs = 15_000, intervalMs = 250): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try { const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) }); await r.arrayBuffer(); return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`not reachable within ${timeoutMs}ms: ${(last as Error)?.name ?? 'unknown'}`);
}
async function start(env: Record<string, string | undefined>, onReady?: (port: number) => Promise<void>): Promise<Run> {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: { PATH: process.env.PATH ?? '', PORT: String(port), HOSTNAME: '127.0.0.1', ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let ready = false;
    const timer = setTimeout(() => { process.kill(child.pid!, 'SIGTERM'); reject(new Error(`timeout; output:\n${out}`)); }, 30_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      if (!ready && /Ready in/.test(out)) {
        ready = true;
        // 只有传了 onReady（要发请求的用例）才轮询；失败场景不需要。轮询失败时把错误交给 reject，测试直接失败
        (onReady ? waitForHttp(`http://127.0.0.1:${port}/api/health`).then(() => onReady(port)) : Promise.resolve())
          .catch((e) => { clearTimeout(timer); reject(new Error(`${(e as Error).message}; output:\n${out}`)); })
          .finally(() => process.kill(child.pid!, 'SIGTERM')); // 只按 PID 停自己的进程
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, ready, port }); });
  });
}

test('standalone：缺 EDGE_AUTH_SECRET / DATABASE_URL / SMTP_PASS、MAIL_SEND_ADAPTER=mock、SMTP_PORT=25 各自 exit 1，只打印变量名，不打印任何值', { skip: !enabled }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sa-upl-'));
  const cases: [string, Record<string, string | undefined>, RegExp][] = [
    ['EDGE_AUTH_SECRET missing', { EDGE_AUTH_SECRET: undefined }, /- EDGE_AUTH_SECRET/],
    ['DATABASE_URL missing', { DATABASE_URL: undefined }, /- DATABASE_URL/],
    ['SMTP_PASS missing', { SMTP_PASS: undefined }, /- SMTP_PASS/],
    ['MAIL_SEND_ADAPTER=mock', { MAIL_SEND_ADAPTER: 'mock' }, /- MAIL_SEND_ADAPTER/],
    ['SMTP_PORT=25', { SMTP_PORT: '25' }, /- SMTP 发信配置无效[^\n]*SMTP_PORT/],
  ];
  try {
    for (const [label, over, re] of cases) {
      const r = await start({ ...FAKE, UPLOAD_DIR: dir, ...over });
      assert.equal(r.code, 1, `${label}: ${r.out}`);
      assert.equal(r.ready, false, label);
      assert.match(r.out, re, label);
      assert.equal((r.out.match(/^- /gm) ?? []).length, 1, `${label}: exactly one problem`);
      for (const v of SECRET_VALUES) assert.ok(!r.out.includes(v), `value leaked (${label})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standalone：UPLOAD_DIR 不存在 / 不可写 → exit 1', { skip: !enabled }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sa-upl-'));
  try {
    let r = await start({ ...FAKE, UPLOAD_DIR: path.join(dir, 'missing') });
    assert.equal(r.code, 1); assert.match(r.out, /UPLOAD_DIR 不存在或当前用户不可读写/); assert.ok(!r.out.includes(dir));
    if (process.getuid?.() !== 0) {
      chmodSync(dir, 0o500);
      r = await start({ ...FAKE, UPLOAD_DIR: dir });
      assert.equal(r.code, 1); assert.match(r.out, /UPLOAD_DIR/);
      chmodSync(dir, 0o700);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standalone：全部假值 → 正常启动；/api/health 不跳转 locale，数据库不可达时 503 {ok:false} + no-store', { skip: !enabled }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sa-upl-'));
  try {
    let health: { status: number; body: string; cc: string | null } | null = null;
    const r = await start({ ...FAKE, UPLOAD_DIR: dir }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'manual' });
      health = { status: res.status, body: await res.text(), cc: res.headers.get('cache-control') };
    });
    assert.equal(r.ready, true, r.out);
    assert.deepEqual(health, { status: 503, body: '{"ok":false}', cc: 'no-store' });
    for (const v of SECRET_VALUES) assert.ok(!r.out.includes(v), 'value leaked in server output');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
