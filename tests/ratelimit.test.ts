import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, UpstashStore, createRateLimitStore } from '../src/lib/server/ratelimit/index';
import { mockServer } from './helpers';

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

test('upstash: 5xx falls back to local memory limiting (not fail-open)', async () => {
  const srv = await mockServer((_r, res) => { res.statusCode = 503; res.end('down'); });
  const err = console.error; console.error = () => {};
  try {
    const s = new UpstashStore(srv.url, 't');
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await s.hit('k', 2, 60_000));
    assert.deepEqual(r, [true, true, false]);
  } finally { console.error = err; await srv.close(); }
});

test('upstash: timeout falls back', async () => {
  const srv = await mockServer(() => { /* never answers */ });
  const err = console.error; console.error = () => {};
  try {
    const s = new UpstashStore(srv.url, 't', new MemoryStore(), 100);
    const t0 = Date.now();
    assert.equal(await s.hit('k', 1, 60_000), true);
    assert.ok(Date.now() - t0 < 1000);
  } finally { console.error = err; await srv.close(); }
});

test('upstash: error payload falls back', async () => {
  const srv = await mockServer((_r, res) => { res.end(JSON.stringify([{ error: 'WRONGPASS' }, { error: 'x' }])); });
  const err = console.error; console.error = () => {};
  try { assert.equal(await new UpstashStore(srv.url, 't').hit('k', 1, 60_000), true); }
  finally { console.error = err; await srv.close(); }
});

test('factory: env selection and validation', () => {
  assert.ok(createRateLimitStore({}) instanceof MemoryStore);
  assert.ok(createRateLimitStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }) instanceof UpstashStore);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'upstash' }), /UPSTASH_REDIS_REST_URL/);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't', NODE_ENV: 'production' }), /https/);
  assert.throws(() => createRateLimitStore({ RATE_LIMIT_STORE: 'redis' }), /未知/);
});
