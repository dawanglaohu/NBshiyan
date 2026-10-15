import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortlink, probeShortlink, probeConfig, probeHeaders, _resetCache } from '../src/lib/edge/shortlink';

test('parseShortlink', () => {
  assert.deepEqual(parseShortlink('/s/abcDEF1234'), { locale: null, id: 'abcDEF1234' });
  assert.deepEqual(parseShortlink('/ru/s/abcDEF1234'), { locale: 'ru', id: 'abcDEF1234' });
  assert.equal(parseShortlink('/en/s/expired'), null);
  assert.equal(parseShortlink('/s/../api'), null);
  assert.equal(parseShortlink('/en/products'), null);
  assert.equal(parseShortlink('/s/abc-def_12345'), null);
  assert.equal(parseShortlink('/s/abcdefghi'), null);
  assert.equal(parseShortlink('/s/abcdefghijklmnopq'), null);
});
test('probeConfig / probeHeaders', () => {
  assert.equal(probeConfig({}), null);
  assert.equal(probeConfig({ NEXT_PUBLIC_SITE_URL: 'javascript:x' }), null);
  assert.deepEqual(probeConfig({ NEXT_PUBLIC_SITE_URL: 'https://packjoyu.com/' }), { origin: 'https://packjoyu.com', secret: null });
  assert.deepEqual(probeConfig({ SHORTLINK_PROBE_ORIGIN: 'http://internal:3000', NEXT_PUBLIC_SITE_URL: 'https://a.com', MIDDLEWARE_PROBE_SECRET: 's' }), { origin: 'http://internal:3000', secret: 's' });
  assert.deepEqual(probeHeaders(null, '1.2.3.4'), {});
  const k = 'k'.repeat(32);
  assert.deepEqual(probeHeaders('short', '1.2.3.4'), {});
  assert.deepEqual(probeHeaders(k, '1.2.3.4'), { 'x-internal-probe': k, 'x-probe-client-ip': '1.2.3.4' });
  assert.deepEqual(probeHeaders(k, '2001:db8::1'), { 'x-internal-probe': k, 'x-probe-client-ip': '2001:db8::1' });
  assert.deepEqual(probeHeaders(k, '1.2.3.4\r\nx: y'), {});
  assert.deepEqual(probeHeaders(k, '999.1.1.1'), {});
  assert.deepEqual(probeHeaders(k, null), {});
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
  assert.equal(await isExpired('http://x', 'bbbbbbbbbbbb', mk(500), 0), null);
  assert.equal(await isExpired('http://x', 'bbbbbbbbbbbb', mk(404), 1), false);
  const boom = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
  assert.equal(await isExpired('http://x', 'cccccccccccc', boom, 0), null);
});

test('probeShortlink：503 = 数据库不可用，返回 unavailable 且不缓存', async () => {
  _resetCache();
  let calls = 0;
  const mk = (status: number) => (async () => { calls++; return new Response(null, { status }); }) as unknown as typeof fetch;
  assert.deepEqual(await probeShortlink('http://x', 'ffffffffffff', mk(503), 0), { expired: false, category: null, unavailable: true });
  assert.deepEqual(await probeShortlink('http://x', 'ffffffffffff', mk(404), 1), { expired: false, category: null });
  assert.equal(calls, 2);
  assert.deepEqual(await probeShortlink('http://x', 'gggggggggggg', mk(410), 0), { expired: true, category: null });
});
test('parseShortlink：/s/unavailable 不当作短链接 id', () => {
  assert.equal(parseShortlink('/en/s/unavailable'), null);
  assert.equal(parseShortlink('/ru/s/unavailable/'), null);
});
