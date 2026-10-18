import { test, expect, type APIResponse, type APIRequestContext } from '@playwright/test';

// 分享图路径不经过 i18n middleware（src/middleware.ts matcher），不能下发 NEXT_LOCALE cookie（运维 Set-Cookie 预检）。
// /<l>/about/og 已被 matcher 排除，但 about 分享图路由要到 #350 第 6 项才有：在那之前这几个地址都必须是 404、无 Set-Cookie、no-store。
// #350 第 6 项落地后：/en、/ru 改为断言 200 image/png（仍无 Set-Cookie），/ja 和乱写 locale 仍是 404 no-store（由路由的 isPublishedLocale 校验）。
// 每个请求用全新的 request context（不带 cookie）：next-intl 在请求已带同值 NEXT_LOCALE 时不会再下发，共用 cookie 罐会让断言失真
const fresh = async (playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, path: string) => {
  const ctx = await playwright.request.newContext({ baseURL });
  const r = await ctx.get(path, { maxRedirects: 0 });
  return { r, text: await r.text(), dispose: () => ctx.dispose() };
};
const setCookies = (r: APIResponse) => r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);

test.describe('OG 路径不经过 middleware（无 NEXT_LOCALE）', () => {
  for (const path of ['/ja/about/og', '/zz-garbage/about/og', '/en/about/og', '/ru/about/og']) {
    test(`${path}：404，无 Set-Cookie，no-store，不跳转`, async ({ playwright, baseURL }) => {
      const { r, text, dispose } = await fresh(playwright, baseURL, path);
      expect(r.status(), path).toBe(404);
      expect(setCookies(r), path).toEqual([]);
      expect(r.headers()['location'], path).toBeUndefined();
      expect(r.headers()['cache-control'] ?? '', path).toContain('no-store');
      // noindex：非生产环境另有 X-Robots-Tag 响应头；404 页本身的 meta robots 在所有环境都有
      expect(text, path).toMatch(/<meta name="robots" content="noindex/);
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
