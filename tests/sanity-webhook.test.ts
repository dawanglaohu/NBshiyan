import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleSanityWebhook, signPayload, verifySignature } from '../src/lib/server/sanity-webhook';

const SECRET = 'test-secret-123';
const NOW = 1_760_000_000_000;
const body = JSON.stringify({ _type: 'article', _id: 'a1' });
function run(raw: string | null, sig: string | null, env: Record<string, string | undefined> = { SANITY_WEBHOOK_SECRET: SECRET, NODE_ENV: 'production' }) {
  const tags: string[] = []; const logs: unknown[] = [];
  const r = handleSanityWebhook(raw, sig, { env, revalidateTag: (t) => tags.push(t), log: (o) => logs.push(o), now: NOW });
  return { ...r, tags, logs };
}

test('valid signature → 200 and revalidates only sanity:<type>', () => {
  const r = run(body, signPayload(body, SECRET, NOW));
  assert.equal(r.status, 200); assert.deepEqual(r.tags, ['sanity:article']);
});
test('bad signature → 401, no revalidate', () => {
  const r = run(body, signPayload(body, 'wrong', NOW));
  assert.equal(r.status, 401); assert.deepEqual(r.tags, []);
  assert.deepEqual(r.logs, [{ errorSummary: 'signature mismatch' }]);
});
test('missing / malformed signature → 401', () => {
  assert.equal(run(body, null).status, 401);
  assert.equal(run(body, 'Bearer ' + SECRET).status, 401);
  assert.equal(run(body, 'garbage').tags.length, 0);
});
test('tampered body → 401', () => {
  const sig = signPayload(body, SECRET, NOW);
  const r = run(body.replace('article', 'product'), sig);
  assert.equal(r.status, 401); assert.deepEqual(r.tags, []);
});
test('missing secret in production → 503, no side effects; non-prod → 401', () => {
  const r = run(body, signPayload(body, SECRET, NOW), { NODE_ENV: 'production' });
  assert.equal(r.status, 503); assert.deepEqual(r.tags, []);
  assert.equal(run(body, signPayload(body, SECRET, NOW), { NODE_ENV: 'development' }).status, 401);
});
test('stale or future timestamp (>5 min) → 401', () => {
  for (const t of [NOW - 6 * 60_000, NOW + 6 * 60_000]) {
    const r = run(body, signPayload(body, SECRET, t));
    assert.equal(r.status, 401); assert.deepEqual(r.logs, [{ errorSummary: 'signature stale' }]);
  }
  assert.equal(run(body, signPayload(body, SECRET, NOW - 4 * 60_000)).status, 200);
});
test('payload validated with zod: unknown _type / bad json → 400, no revalidate', () => {
  for (const b of [JSON.stringify({ _type: 'sanity.imageAsset' }), '{}', 'not json', JSON.stringify({ _type: '../x' })]) {
    const r = run(b, signPayload(b, SECRET, NOW));
    assert.equal(r.status, 400, b); assert.deepEqual(r.tags, []);
  }
  assert.equal(run(null, 'x').status, 413);
});
test('official @sanity/webhook 4.0.4 vectors preserve raw whitespace and Unicode', () => {
  const vectors = JSON.parse(readFileSync('tests/fixtures/sanity-webhook-vectors.json', 'utf8')) as Array<{
    body: string; secret: string; timestamp: number; signature: string;
  }>;
  for (const v of vectors) {
    assert.equal(signPayload(v.body, v.secret, v.timestamp), v.signature);
    assert.deepEqual(verifySignature(v.body, v.signature, v.secret, v.timestamp), { ok: true });
    assert.equal(verifySignature(v.body + ' ', v.signature, v.secret, v.timestamp).ok, false);
    assert.equal(verifySignature(v.body, v.signature, 'wrong', v.timestamp).ok, false);
  }
});
test('route: no legacy bearer path, reads raw body before parsing', () => {
  const src = readFileSync('src/app/api/sanity/revalidate/route.ts', 'utf8');
  assert.ok(!/SANITY_REVALIDATE_SECRET|authorization|Bearer|secretMatches/i.test(src.replace(/不再接受 Bearer/, '')));
  assert.ok(src.indexOf('readBody(') < src.indexOf('handleSanityWebhook('));
  assert.match(readFileSync('docs/launch-checklist.md', 'utf8'), /SANITY_WEBHOOK_SECRET/);
});
