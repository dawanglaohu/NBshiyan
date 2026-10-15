import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMailError, toSendResult, KNOWN_409 } from '../src/lib/admin/mail/http';

test('409：按错误体 error 字段分支，不再一律当 anonymized', () => {
  for (const code of KNOWN_409) assert.equal(toMailError(409, { error: code }).code, code);
  assert.deepEqual([...KNOWN_409].sort(), ['anonymized', 'not_retryable', 'not_unassigned', 'retry_limit', 'sending_disabled']);
});
test('409：不认识的 error / 没有错误体 → unknown（不可重试）', () => {
  assert.equal(toMailError(409, { error: 'locked_somehow' }).code, 'unknown');
  assert.equal(toMailError(409, null).code, 'unknown');
  assert.equal(toMailError(409, { error: 42 }).code, 'unknown');
});
test('429：retryAfterSec 优先，缺失时用 Retry-After 头，至少 1 秒', () => {
  const a = toMailError(429, { error: 'rate_limited', scope: 'admin', retryAfterSec: 12.2, limit: 30, windowSec: 3600 });
  assert.equal(a.code, 'rate_limited'); assert.equal(a.body.retryAfterSec, 13); assert.equal(a.body.scope, 'admin'); assert.equal(a.body.limit, 30);
  assert.equal(toMailError(429, {}, '90').body.retryAfterSec, 90);
  assert.equal(toMailError(429, { retryAfterSec: 0 }).body.retryAfterSec, 1);
});
test('400 / 413 / 502 / 503 / 403 / 410：保留附加字段', () => {
  const inv = toMailError(400, { error: 'invalid', fields: { subject: 'too_long' }, limits: { subject: 200 } });
  assert.equal(inv.code, 'invalid'); assert.deepEqual(inv.body.fields, { subject: 'too_long' }); assert.deepEqual(inv.body.limits, { subject: 200 });
  const big = toMailError(413, { error: 'too_large', field: 'body', limit: 20000, unit: 'chars' });
  assert.equal(big.code, 'too_large'); assert.equal(big.body.field, 'body'); assert.equal(big.body.unit, 'chars');
  const f = toMailError(502, { error: 'mail_failed', id: 'm1', reason: 'unknown_delivery', retryable: false });
  assert.equal(f.code, 'mail_failed'); assert.equal(f.body.reason, 'unknown_delivery'); assert.equal(f.body.retryable, false);
  assert.equal(toMailError(503, { error: 'mail_not_configured' }).code, 'mail_not_configured');
  assert.equal(toMailError(503, { error: 'whatever' }).code, 'unknown');
  assert.equal(toMailError(403, { error: 'expired' }).code, 'expired');
  assert.equal(toMailError(403, {}).code, 'forbidden');
  assert.equal(toMailError(410, { error: 'deleted' }).code, 'deleted');
  assert.equal(toMailError(404, { error: 'not_found' }).code, 'not_found');
  assert.equal(toMailError(401, {}).code, 'unauthorized');
  assert.equal(toMailError(500, {}).code, 'unknown');
});
test('201 → sent；202 → sending（pollAfterMs 缺省 5000）', () => {
  assert.deepEqual(toSendResult(201, { id: 'a', status: 'SENT', messageId: null, sentAt: 't', retryCount: 0, maxRetries: 5 }), { kind: 'sent', id: 'a', sentAt: 't', retryCount: 0, maxRetries: 5 });
  assert.deepEqual(toSendResult(202, { id: 'b', status: 'SENDING', pollAfterMs: 5000 }), { kind: 'sending', id: 'b', pollAfterMs: 5000 });
  assert.deepEqual(toSendResult(202, { id: 'c' }), { kind: 'sending', id: 'c', pollAfterMs: 5000 });
});
