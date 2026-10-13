import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortlink, probeShortlink, _resetCache } from '../src/lib/edge/shortlink';

test('parseShortlink', () => {
  assert.deepEqual(parseShortlink('/s/abcDEF123456'), { locale: null, id: 'abcDEF123456' });
  assert.deepEqual(parseShortlink('/ru/s/abcDEF123456'), { locale: 'ru', id: 'abcDEF123456' });
  assert.equal(parseShortlink('/en/s/expired'), null);
  assert.equal(parseShortlink('/s/../api'), null);
  assert.equal(parseShortlink('/en/products'), null);
});
test('probeShortlink：X-Design-Category 只接受 categoryMeta 的 key', async () => {
  _resetCache();
  const h = (cat: string) => (async () => new Response(null, { status: 410, headers: { 'x-design-category': cat } })) as unknown as typeof fetch;
  assert.deepEqual(await probeShortlink('http://x', 'dddddddddddd', h('corrugated-boxes'), 0), { expired: true, category: 'corrugated-boxes' });
  assert.deepEqual(await probeShortlink('http://x', 'eeeeeeeeeeee', h('../evil?x=1'), 0), { expired: true, category: null });
});
const isExpired = async (o: string, id: string, f: typeof fetch, n: number) => { const r = await probeShortlink(o, id, f, n); return r ? r.expired : null; };
test('isExpired：410 为 true，200/404 为 false，5xx/超时放行且不缓存，结果缓存 60 秒', async () => {
  _resetCache();
  let calls = 0;
  const mk = (status: number) => (async () => { calls++; return new Response(null, { status }); }) as unknown as typeof fetch;
  assert.equal(await isExpired('http://x', 'aaaaaaaaaaaa', mk(410), 0), true);
  assert.equal(await isExpired('http://x', 'aaaaaaaaaaaa', mk(200), 1000), true); // 命中缓存
  assert.equal(calls, 1);
  assert.equal(await isExpired('http://x', 'aaaaaaaaaaaa', mk(200), 61_000), false);
  assert.equal(await isExpired('http://x', 'bbbbbbbbbbbb', mk(503), 0), null);
  assert.equal(await isExpired('http://x', 'bbbbbbbbbbbb', mk(404), 1), false);
  const boom = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
  assert.equal(await isExpired('http://x', 'cccccccccccc', boom, 0), null);
});
