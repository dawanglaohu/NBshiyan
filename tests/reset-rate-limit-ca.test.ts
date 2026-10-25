// #432：reset 脚本用 https.request 读取 NODE_EXTRA_CA_CERTS；rediss 存储同样带上这份 CA。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { clearAccountRateLimits, runReset } from '../scripts/admin-reset-initial-password-lib.mjs';
import { redisEndpointFromEnv, RedisStore } from '../src/lib/server/ratelimit/redis';
import { startFakeRedis } from './fake-redis';

const EMAIL = 'ryan@example.com';
const PW = 'Correct-Horse-Battery-9!';
const UPSTASH_TOKEN = 'pipeline-token-SHOULD-NOT-LEAK';
const REDIS_PW = 'redis-secret-SHOULD-NOT-LEAK';

function opensslBin() {
  if (process.platform !== 'win32') return 'openssl';
  for (const c of ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'D:\\Program Files\\Git\\usr\\bin\\openssl.exe']) {
    try { readFileSync(c); return c; } catch { /* next */ }
  }
  return 'openssl';
}

function openssl(cwd: string, args: string[]) {
  const r = spawnSync(opensslBin(), args, { cwd, encoding: 'utf8', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' } });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} exited ${r.status}`);
}

function makeCa() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rl-ca-'));
  openssl(dir, ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-nodes', '-subj', '/CN=TestCA']);
  openssl(dir, ['req', '-newkey', 'rsa:2048', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-nodes', '-subj', '/CN=leaf', '-addext', 'subjectAltName=IP:127.0.0.1']);
  openssl(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '1', '-copy_extensions', 'copy']);
  return {
    dir,
    caPath: path.join(dir, 'ca.crt'),
    cert: readFileSync(path.join(dir, 'leaf.crt')),
    key: readFileSync(path.join(dir, 'leaf.key')),
  };
}

function startHttps(cert: Buffer, key: Buffer, reply: { status: number; body: string }) {
  const requests: string[] = [];
  const sockets = new Set<{ destroy: () => void }>();
  const srv = https.createServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  srv.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  return new Promise<{ port: number; requests: string[]; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        requests,
        close: () => new Promise((ok) => {
          for (const sock of sockets) sock.destroy();
          srv.close(() => ok());
        }),
      });
    });
  });
}

function fakeDb() {
  const row = {
    id: 'cuid_admin_1', email: EMAIL, role: 'ADMIN', disabled: false, totpEnabled: false, totpSecret: null, totpLastStep: null,
    enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0, createdAt: new Date(Date.now() - 3_600_000),
  };
  const userApi = {
    async findUnique() { return { ...row }; },
    async update() { return { id: row.id }; },
  };
  return {
    user: userApi,
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      const tx = {
        user: userApi,
        auditLog: { async create() { return {}; } },
        async $executeRaw() { return 1; },
      };
      return fn(tx);
    },
    async $disconnect() {},
  };
}

test('#432 https + NODE_EXTRA_CA_CERTS：rate_limit=cleared，请求体不含邮箱', async () => {
  const ca = makeCa();
  const srv = await startHttps(ca.cert, ca.key, { status: 200, body: JSON.stringify([1, 1, 1, 1, 1, 1].map(() => ({ result: 1 }))) });
  try {
    const env = {
      RATE_LIMIT_STORE: 'upstash',
      UPSTASH_REDIS_REST_URL: `https://127.0.0.1:${srv.port}`,
      UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN,
      NODE_EXTRA_CA_CERTS: ca.caPath,
      AUTH_SECRET: 'a',
    };
    assert.equal(await clearAccountRateLimits({ email: EMAIL, env, now: Date.now() }), 'cleared');
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].includes(EMAIL), false);
    assert.equal(srv.requests[0].includes(UPSTASH_TOKEN), false);

    let out = '', err = '';
    const code = await runReset({
      argv: ['--email', EMAIL],
      env: { ...env, DATABASE_URL: 'set', NEXT_PUBLIC_SITE_URL: 'https://example.com' },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      readPassword: async () => PW,
      db: async () => fakeDb(),
      hash: async () => 'H',
      now: () => Date.now(),
      out: (s: string) => { out += s; },
      err: (s: string) => { err += s; },
    });
    assert.equal(code, 0, err);
    assert.match(out, /rate_limit=cleared/);
    const blob = out + err;
    for (const s of [PW, EMAIL, UPSTASH_TOKEN, 'login-acct']) assert.equal(blob.includes(s), false, s);
  } finally {
    await srv.close();
    rmSync(ca.dir, { recursive: true, force: true });
  }
});

test('#432 没有 CA、CA 文件缺失、或响应带敏感正文：failed，且不回显', async () => {
  const ca = makeCa();
  const leak = `ERR ${EMAIL} ${UPSTASH_TOKEN} login-acct:abc`;
  const srv = await startHttps(ca.cert, ca.key, { status: 500, body: JSON.stringify({ error: leak }) });
  try {
    const base = {
      RATE_LIMIT_STORE: 'upstash',
      UPSTASH_REDIS_REST_URL: `https://127.0.0.1:${srv.port}`,
      UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN,
      AUTH_SECRET: 'a',
    };
    const missing = path.join(ca.dir, 'missing.crt');
    assert.equal(await clearAccountRateLimits({ email: EMAIL, env: { ...base, NODE_EXTRA_CA_CERTS: missing }, now: Date.now() }), 'failed');
    assert.equal(srv.requests.length, 0);
    assert.equal(await clearAccountRateLimits({ email: EMAIL, env: base, now: Date.now() }), 'failed');
    assert.equal(srv.requests.length, 0);

    let out = '', err = '';
    const code = await runReset({
      argv: ['--email', EMAIL],
      env: { ...base, NODE_EXTRA_CA_CERTS: ca.caPath, DATABASE_URL: 'set', NEXT_PUBLIC_SITE_URL: 'https://example.com' },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      readPassword: async () => PW,
      db: async () => fakeDb(),
      hash: async () => 'H',
      out: (s: string) => { out += s; },
      err: (s: string) => { err += s; },
    });
    assert.equal(code, 0, err);
    assert.match(out, /rate_limit=failed/);
    assert.match(err, /10 分钟/);
    const blob = out + err;
    for (const s of [PW, EMAIL, UPSTASH_TOKEN, 'login-acct', leak]) assert.equal(blob.includes(s), false, s);
  } finally {
    await srv.close();
    rmSync(ca.dir, { recursive: true, force: true });
  }
});

test('#432 rediss：带上 CA 能计数；缺少 CA 文件或校验失败只报固定短句', async () => {
  const ca = makeCa();
  const fake = await startFakeRedis({ password: REDIS_PW, tls: { cert: ca.cert, key: ca.key } });
  try {
    const url = `rediss://:${REDIS_PW}@127.0.0.1:${fake.port}`;
    const ep = redisEndpointFromEnv({ REDIS_URL: url, NODE_EXTRA_CA_CERTS: ca.caPath });
    const store = new RedisStore(ep);
    assert.equal(await store.hit('k', 1, 60_000), true);
    assert.deepEqual(fake.auths(), [REDIS_PW]);
    await assert.rejects(new RedisStore({ host: '127.0.0.1', port: fake.port, tls: true, db: 0, password: REDIS_PW }).hit('k', 1, 60_000), (e: Error) => {
      assert.equal(e.message, 'redis connection failed');
      assert.equal(e.message.includes(REDIS_PW), false);
      return true;
    });
    const missing = path.join(ca.dir, 'no-such.crt');
    assert.throws(() => redisEndpointFromEnv({ REDIS_URL: url, NODE_EXTRA_CA_CERTS: missing }), (e: Error) => {
      assert.equal(e.message, 'redis connection failed');
      assert.equal(e.message.includes(missing), false);
      assert.equal(e.message.includes(REDIS_PW), false);
      return true;
    });
    assert.equal(await clearAccountRateLimits({
      email: EMAIL,
      env: { RATE_LIMIT_STORE: 'redis', REDIS_URL: url, NODE_EXTRA_CA_CERTS: ca.caPath, AUTH_SECRET: 'a' },
      now: Date.now(),
    }), 'cleared');
    assert.equal(await clearAccountRateLimits({
      email: EMAIL,
      env: { RATE_LIMIT_STORE: 'redis', REDIS_URL: url, NODE_EXTRA_CA_CERTS: missing, AUTH_SECRET: 'a' },
      now: Date.now(),
    }), 'failed');
  } finally {
    await fake.close();
    rmSync(ca.dir, { recursive: true, force: true });
  }
});

test('#432 文档写明真实 IP 桶和 CA', () => {
  const readme = readFileSync('deploy/README.md', 'utf8');
  assert.match(readme, /login-ip/);
  assert.match(readme, /10-minute window/);
  assert.match(readme, /NODE_EXTRA_CA_CERTS/);
  assert.match(readme, /rate_limit=cleared/);
  assert.match(readme, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
  const api = readFileSync('docs/API.md', 'utf8');
  assert.match(api, /最多再保留一个 10 分钟窗口/);
  assert.match(api, /或 `redis`/);
});
