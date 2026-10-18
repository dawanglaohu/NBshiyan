import { test, expect, type APIResponse, type APIRequestContext } from '@playwright/test';

// 分享图路径不经过 i18n middleware（src/middleware.ts matcher），不能下发 NEXT_LOCALE cookie（运维 Set-Cookie 预检）。
// /<l>/about/og 已被 matcher 排除；#350 第 6 项的路由先按 PUBLISHED_LOCALES 白名单校验 locale（/ja、乱写 → 404），
// 再要求 v = 当前内容版本：E2E 库里没有已发布的 about 内容，所以 /en、/ru 不带 v / v 不对也都是 404 no-store、无 Set-Cookie。
// 200 PNG（v 正确）由 tests/about-og-route.test.ts 用真实模板覆盖。
// 每个请求用全新的 request context（不带 cookie）：next-intl 在请求已带同值 NEXT_LOCALE 时不会再下发，共用 cookie 罐会让断言失真
const fresh = async (playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, path: string) => {
  const ctx = await playwright.request.newContext({ baseURL });
  const r = await ctx.get(path, { maxRedirects: 0 });
  return { r, text: await r.text(), dispose: () => ctx.dispose() };
};
const setCookies = (r: APIResponse) => r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);

test.describe('OG 路径不经过 middleware（无 NEXT_LOCALE）', () => {
  for (const path of ['/ja/about/og', '/ja/about/og?v=a1b2c3d4', '/zz-garbage/about/og', '/en/about/og', '/ru/about/og', '/en/about/og?v=00000000', '/ru/about/og?v=00000000']) {
    test(`${path}：404，无 Set-Cookie，no-store，不跳转`, async ({ playwright, baseURL }) => {
      const { r, text, dispose } = await fresh(playwright, baseURL, path);
      expect(r.status(), path).toBe(404);
      expect(setCookies(r), path).toEqual([]);
      expect(r.headers()['location'], path).toBeUndefined();
      expect(r.headers()['cache-control'] ?? '', path).toContain('no-store');
      // noindex：路由的 404 自己显式带 X-Robots-Tag（生产 next.config 不加），响应体为空，不是 Next 的 404 页
      expect(r.headers()['x-robots-tag'] ?? '', path).toContain('noindex');
      expect(text, path).toBe('');
      await dispose();
    });
  }

  test('对照：普通页面仍经过 middleware，照常下发 NEXT_LOCALE', async ({ playwright, baseURL }) => {
    for (const path of ['/en', '/en/about']) {
      const { r, dispose } = await fresh(playwright, baseURL, path);
      expect(setCookies(r).join('\n'), path).toMatch(/NEXT_LOCALE=en/);
      await dispose();
    }
  });
});
