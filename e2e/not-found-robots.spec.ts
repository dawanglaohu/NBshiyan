import { test, expect } from './fixtures';

// notFound() 插入唯一的 <meta name="robots" content="noindex">。
// 本地化 404 不再声明 robots，否则会多出第二条。标题仍是 NotFound.meta.title。
const cases = [
  { path: '/en/does-not-exist-seo5', title: 'Page not found | PackJoyU' },
  { path: '/ru/does-not-exist-seo5', title: 'Страница не найдена | PackJoyU' },
  { path: '/en/products/zzz-not-a-category', title: 'Page not found | PackJoyU' },
];

test.describe('404 robots meta (#429)', () => {
  for (const item of cases) {
    test(`${item.path} 恰好 1 个 robots meta，状态 404，标题不变`, async ({ page }) => {
      const res = await page.goto(item.path);
      expect(res!.status()).toBe(404);
      expect(new URL(page.url()).pathname).toBe(item.path);
      const robots = page.locator('meta[name="robots"]');
      await expect(robots).toHaveCount(1);
      await expect(robots).toHaveAttribute('content', 'noindex');
      const html = await res!.text();
      expect(html).toContain(`<title>${item.title}</title>`);
    });
  }

  // 未上线语言 rewrite 到 locale-unavailable 后，Next 会在 head 和客户端渲染各插一次 noindex（框架行为），所以渲染后 DOM 不限条数，只要求都是 noindex。
  test('/de 语言未上线：状态 404，原始 HTML 恰好 1 条 robots 为 noindex', async ({ page }) => {
    const res = await page.goto('/de');
    expect(res!.status()).toBe(404);
    const html = await res!.text();
    const robotsTags = html.match(/<meta name="robots"[^>]*>/g) ?? [];
    expect(robotsTags).toHaveLength(1);
    expect(robotsTags[0]).toContain('content="noindex"');
    expect(html).toContain('<title>Page not found | PackJoyU</title>');
    const contents = await page.locator('meta[name="robots"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('content') ?? ''),
    );
    expect(contents.length).toBeGreaterThanOrEqual(1);
    for (const content of contents) {
      expect(content).toContain('noindex');
      expect(content).not.toMatch(/(^|[\s,])index\b/);
      expect(content).not.toMatch(/\bfollow\b/);
    }
  });
});
