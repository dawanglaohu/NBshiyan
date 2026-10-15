import { test, expect } from '@playwright/test';

// Refs #162：数据库不可用时 /s/<id> 返回 503。e2e 环境里难以单独让数据库掉线（同一个 webServer 还要服务其它用例），先挂起；
// 逻辑由 tests/shortlink.test.ts 和 tests/s-unavailable.test.ts 覆盖。
test.fixme('DB down: /en/s/<id> → 503 + Retry-After + noindex, localized page', async ({ request }) => {
  const r = await request.get('/en/s/abcdefghij12');
  expect(r.status()).toBe(503);
  expect(r.headers()['retry-after']).toBe('60');
  expect(r.headers()['cache-control']).toContain('no-store');
  expect(r.headers()['x-robots-tag']).toContain('noindex');
  expect(await r.text()).toContain('Temporarily unavailable');
});

test('direct /en/s/unavailable → 404', async ({ request }) => {
  const r = await request.get('/en/s/unavailable');
  expect(r.status()).toBe(404);
});
