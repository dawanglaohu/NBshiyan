import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { beforeEach, afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/app/api/sanity/revalidate/route';
import { signPayload } from '../src/lib/server/sanity-webhook';

const SECRET = 'synthetic-webhook-logging-test-key';
const NOW = 1_760_000_000_000;
const PRIVATE = 'private-body-and-header-must-not-be-logged';
const BODY = JSON.stringify({ _type: 'article', note: PRIVATE });
const warnings: unknown[][] = [];
let clock = 0;

beforeEach(() => {
  clock += 1_000_000;
  warnings.length = 0;
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'production';
  env.SANITY_WEBHOOK_SECRET = SECRET;
  delete env.SANITY_REVALIDATE_SECRET;
  mock.method(Date, 'now', () => NOW);
  mock.method(performance, 'now', () => clock);
  mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
});
afterEach(() => { mock.restoreAll(); });

async function withServer(run: (origin: string) => Promise<void>) {
  const errors: string[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const response = await POST(new Request('http://127.0.0.1/api/sanity/revalidate', {
        method: 'POST', headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      errors.push(error instanceof Error ? error.name : 'unknown');
      res.writeHead(500); res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.deepEqual(errors, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function reject(origin: string, signature: string | null, expected = 401, body = BODY) {
  const response = await fetch(origin + '/api/sanity/revalidate', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-private-test': PRIVATE, ...(signature ? { 'sanity-webhook-signature': signature } : {}) },
  });
  assert.equal(response.status, expected);
  assert.deepEqual(await response.json(), { error: expected === 401 ? 'unauthorized' : expected === 503 ? 'not_configured' : 'invalid_payload' });
}

function entries() {
  for (const warning of warnings) assert.equal(warning[0], '[sanity-webhook]');
  const out = warnings.map((warning) => warning[1] as { errorSummary: string; suppressedCount?: number });
  const serialized = JSON.stringify(warnings);
  assert.equal(serialized.includes(PRIVATE), false);
  assert.equal(serialized.includes(SECRET), false);
  for (const entry of out) assert.ok(Object.keys(entry).every((key) => ['errorSummary', 'suppressedCount'].includes(key)));
  return out;
}

test('route default logger bounds authentication floods and reports suppression when its minute window reopens', async () => {
  const signatures = [
    null,
    'invalid-signature-' + PRIVATE,
    signPayload(BODY, SECRET, NOW - 600_001),
    signPayload(BODY, 'synthetic-wrong-key', NOW),
  ];
  await withServer(async (origin) => {
    for (const signature of signatures) {
      for (let i = 0; i < 12; i++) await reject(origin, signature?.startsWith('invalid-') ? signature + i : signature);
    }
    assert.deepEqual(entries().map((entry) => entry.errorSummary).sort(), [
      'signature malformed', 'signature mismatch', 'signature missing', 'signature stale',
    ]);
    clock += 59_999;
    for (const signature of signatures) await reject(origin, signature);
    assert.equal(warnings.length, 4);
    clock += 1;
    for (const signature of signatures) await reject(origin, signature);
    assert.equal(warnings.length, 8);
    assert.ok(entries().slice(4).every((entry) => entry.suppressedCount === 12));
  });
});

test('route default logger gives configuration and invalid-payload diagnostics independent bounded slots', async () => {
  await withServer(async (origin) => {
    for (let i = 0; i < 8; i++) await reject(origin, null);
    delete process.env.SANITY_WEBHOOK_SECRET;
    for (let i = 0; i < 8; i++) await reject(origin, null, 503);
    process.env.SANITY_WEBHOOK_SECRET = SECRET;
    for (const body of ['not json', '{"_type":"unknown"}']) {
      for (let i = 0; i < 8; i++) await reject(origin, signPayload(body, SECRET, NOW), 400, body);
    }
    assert.deepEqual(entries().map((entry) => entry.errorSummary).sort(), [
      'invalid json', 'missing SANITY_WEBHOOK_SECRET', 'payload rejected', 'signature missing',
    ]);
  });
});

test('route rejection status survives a default warning sink failure', async () => {
  mock.method(console, 'warn', () => { throw new Error('synthetic logging sink failure'); });
  await withServer(async (origin) => {
    await reject(origin, null);
    await reject(origin, null);
  });
});
