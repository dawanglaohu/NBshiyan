// #432 复查：RESP 深度、长度字段、分片回复、Upstash 半截响应。只连 127.0.0.1 上的假服务器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { parseResp, RedisStore } from '../src/lib/server/ratelimit/redis';
import { clearAccountRateLimits, readResp } from '../scripts/admin-reset-initial-password-lib.mjs';

const EMAIL = 'a@example.com';
const NOW = 1_700_000_000_000;
const NEST_BOMB = Buffer.from('*1\r\n'.repeat(200000) + ':1\r\n');

type Node = { kind: string; value?: unknown };

function tree(node: Node): unknown {
  if (node.kind === 'arr') return { kind: 'arr', value: (node.value as Node[]).map(tree) };
  if (node.kind === 'bulk') {
    const v = node.value;
    return { kind: 'bulk', value: v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : v };
  }
  return { kind: node.kind, value: node.value };
}

function normApp(buf: Buffer) {
  const r = parseResp(buf);
  if (!r) return { status: 'partial' as const };
  if (r.reply === 'bad') return { status: 'bad' as const, next: r.next };
  return { status: 'ok' as const, next: r.next, value: tree(r.reply) };
}

function normScript(buf: Buffer) {
  const r = readResp(buf) as (Node & { next: number }) | null;
  if (!r) return { status: 'partial' as const };
  if (r.kind === 'bad') return { status: 'bad' as const, next: r.next };
  return { status: 'ok' as const, next: r.next, value: tree(r) };
}

test('app and reset-script RESP parsers agree, including strict lengths and the nesting bomb', () => {
  assert.ok(NEST_BOMB.length > 700_000 && NEST_BOMB.length < 1_000_000);
  const cases: { name: string; buf: Buffer; bad: boolean; next?: number }[] = [
    { name: 'simple', buf: Buffer.from('+OK\r\n'), bad: false },
    { name: 'error', buf: Buffer.from('-ERR no\r\n'), bad: false },
    { name: 'int', buf: Buffer.from(':42\r\n'), bad: false },
    { name: 'bulk', buf: Buffer.from('$3\r\nfoo\r\n'), bad: false },
    { name: 'null bulk', buf: Buffer.from('$-1\r\n'), bad: false },
    { name: 'flat array', buf: Buffer.from('*2\r\n:1\r\n+OK\r\n'), bad: false },
    { name: 'depth 2', buf: Buffer.from('*1\r\n*1\r\n:7\r\n'), bad: false },
    { name: 'nested too deep', buf: Buffer.from('*1\r\n*1\r\n*1\r\n:1\r\n'), bad: true, next: 12 },
    { name: 'empty bulk length', buf: Buffer.from('$\r\n'), bad: true },
    { name: 'exp bulk length', buf: Buffer.from('$1e3\r\n'), bad: true },
    { name: 'spaced bulk length', buf: Buffer.from('$ 5\r\n'), bad: true },
    { name: 'empty array count', buf: Buffer.from('*\r\n'), bad: true },
    { name: 'exp array count', buf: Buffer.from('*1e3\r\n'), bad: true },
    { name: 'spaced array count', buf: Buffer.from('* 5\r\n'), bad: true },
    { name: 'empty int', buf: Buffer.from(':\r\n'), bad: true },
    { name: 'exp int', buf: Buffer.from(':1e3\r\n'), bad: true },
    { name: 'spaced int', buf: Buffer.from(': 5\r\n'), bad: true },
    { name: 'nesting bomb', buf: NEST_BOMB, bad: true, next: 12 },
  ];
  for (const c of cases) {
    const t0 = Date.now();
    const a = normApp(c.buf);
    const b = normScript(c.buf);
    assert.ok(Date.now() - t0 < 1000, c.name);
    assert.deepEqual(a, b, c.name);
    assert.equal(a.status, c.bad ? 'bad' : 'ok', c.name);
    if (c.next !== undefined && a.status === 'bad') assert.equal(a.next, c.next, c.name);
  }
  const ok = normApp(Buffer.from('+PONG\r\n'));
  assert.deepEqual(ok, { status: 'ok', next: 7, value: { kind: 'ok', value: 'PONG' } });
});

function listen(onConn: (sock: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    onConn(sock);
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as AddressInfo).port,
        close: () => new Promise((ok) => {
          for (const s of sockets) s.destroy();
          srv.close(() => ok());
        }),
      });
    });
  });
}

/** 先写出 cut 个字节，等对端处理完再写剩下的，迫使回复跨两次 data。 */
function writeSplit(sock: net.Socket, payload: Buffer, cut: number) {
  sock.setNoDelay(true);
  sock.write(payload.subarray(0, cut), () => {
    setTimeout(() => { if (!sock.destroyed) sock.write(payload.subarray(cut)); }, 50);
  });
}

test('app client accepts integer replies split across TCP chunks', { timeout: 10_000 }, async () => {
  const payload = Buffer.from(':1\r\n:1\r\n');
  const srv = await listen((sock) => { sock.once('data', () => writeSplit(sock, payload, 2)); });
  try {
    const store = new RedisStore({ host: '127.0.0.1', port: srv.port, tls: false, db: 0 }, 1000);
    assert.equal(await store.hit('k', 5, 60_000), true);
  } finally { await srv.close(); }
});

test('nesting bomb on the app socket ends as redis bad response', { timeout: 10_000 }, async () => {
  const srv = await listen((sock) => { sock.once('data', () => { sock.write(NEST_BOMB); }); });
  try {
    const t0 = Date.now();
    const store = new RedisStore({ host: '127.0.0.1', port: srv.port, tls: false, db: 0 }, 2000);
    await assert.rejects(store.hit('k', 5, 60_000), (e: Error) => e.message === 'redis bad response');
    assert.ok(Date.now() - t0 < 2000);
  } finally { await srv.close(); }
});

test('nesting bomb on the reset script ends rate-limit failed', { timeout: 10_000 }, async () => {
  const srv = await listen((sock) => { sock.once('data', () => { sock.write(NEST_BOMB); }); });
  try {
    const t0 = Date.now();
    const status = await clearAccountRateLimits({
      email: EMAIL,
      env: { RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://127.0.0.1:${srv.port}`, AUTH_SECRET: 'placeholder' },
      now: NOW,
    });
    assert.equal(status, 'failed');
    assert.ok(Date.now() - t0 < 2000);
  } finally { await srv.close(); }
});

test('Codex P2: split replies whose last line is an error end failed, not cleared', { timeout: 10_000 }, async () => {
  const payload = Buffer.from(':1\r\n'.repeat(5) + '-ERR denied\r\n');
  const srv = await listen((sock) => { sock.once('data', () => writeSplit(sock, payload, 10)); });
  try {
    const t0 = Date.now();
    const status = await clearAccountRateLimits({
      email: EMAIL,
      env: { RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://127.0.0.1:${srv.port}`, AUTH_SECRET: 'placeholder' },
      now: NOW,
    });
    assert.equal(status, 'failed');
    assert.ok(Date.now() - t0 < 2000);
  } finally { await srv.close(); }
});

test('upstash response destroyed mid-body ends failed without hanging', { timeout: 10_000 }, async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[');
    res.destroy();
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const t0 = Date.now();
    const status = await clearAccountRateLimits({
      email: EMAIL,
      env: {
        RATE_LIMIT_STORE: 'upstash',
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${port}`,
        UPSTASH_REDIS_REST_TOKEN: 'placeholder-token',
        AUTH_SECRET: 'placeholder',
      },
      now: NOW,
    });
    assert.equal(status, 'failed');
    assert.equal(hits, 1);
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    await new Promise<void>((ok) => srv.close(() => ok()));
  }
});
