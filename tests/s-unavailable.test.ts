import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDbUnavailable, errorSummary, lookupDesignForPage, type DesignLookup } from '../src/lib/server/designs';

const err = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('postgres://user:secret@db/x refused'), { name, ...extra });

test('isDbUnavailable：连接类错误为 true，其它为 false', () => {
  assert.equal(isDbUnavailable(err('PrismaClientInitializationError')), true);
  assert.equal(isDbUnavailable(err('PrismaClientRustPanicError')), true);
  for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024']) assert.equal(isDbUnavailable(err('PrismaClientKnownRequestError', { code })), true, code);
  assert.equal(isDbUnavailable(err('PrismaClientInitializationError', { errorCode: 'P1001' })), true);
  assert.equal(isDbUnavailable(err('Error', { code: 'ECONNREFUSED' })), true);
  assert.equal(isDbUnavailable(err('Error', { cause: err('Error', { code: 'ETIMEDOUT' }) })), true);
  assert.equal(isDbUnavailable(err('PrismaClientKnownRequestError', { code: 'P2025' })), false);
  assert.equal(isDbUnavailable(new TypeError('x')), false);
  assert.equal(isDbUnavailable(null), false);
});

test('errorSummary 只含类型和错误码，不含 message / 连接串', () => {
  const s = errorSummary(err('PrismaClientKnownRequestError', { code: 'P1001' }));
  assert.equal(s, 'PrismaClientKnownRequestError:P1001');
  assert.ok(!s.includes('secret'));
});

test('lookupDesignForPage：DB 不可用 → unavailable；missing/expired 照旧；其它错误照常抛出', async () => {
  const orig = console.error; const logs: unknown[][] = []; console.error = (...a: unknown[]) => { logs.push(a); };
  try {
    const down = async (): Promise<DesignLookup> => { throw err('PrismaClientInitializationError'); };
    assert.deepEqual(await lookupDesignForPage('abcdefghij12', down), { state: 'unavailable' });
    assert.ok(!JSON.stringify(logs).includes('secret'));
    assert.deepEqual(await lookupDesignForPage('abcdefghij12', async () => ({ state: 'missing' })), { state: 'missing' });
    assert.deepEqual(await lookupDesignForPage('abcdefghij12', async () => ({ state: 'expired', category: null, locale: 'ru' })), { state: 'expired', category: null, locale: 'ru' });
    await assert.rejects(lookupDesignForPage('abcdefghij12', async () => { throw new TypeError('bug'); }), TypeError);
  } finally { console.error = orig; }
});
