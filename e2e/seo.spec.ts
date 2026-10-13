import { test, expect } from './fixtures';

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PAGES = ['/en', '/ru', '/en/products', '/ru/products'];
const other = (p: string) => (p.startsWith('/en') ? p.replace(/^\/en/, '/ru') : p.replace(/^\/ru/, '/en'));

test.describe('SEO（#144 评论 6150724426）', () => {
  test('1. canonical 指向自身，hreflang en/ru/x-default 互相指向', async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(p);
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `${SITE}${p}`);
      const hl = async (l: string) => page.locator(`link[rel=alternate][hreflang="${l}"]`).getAttribute('href');
      const self = p.startsWith('/en') ? 'en' : 'ru';
      expect(await hl(self)).toBe(`${SITE}${p}`);
      expect(await hl(self === 'en' ? 'ru' : 'en')).toBe(`${SITE}${other(p)}`);
      expect(await hl('x-default')).toBeTruthy();
    }
  });
  test('1b. 产品落地页 canonical/hreflang', async () => { test.fixme(true, '产品落地页尚未合并'); });

  test('2. 另一种语言的 slug 301/308 到本语言 slug；内部 key 不能 200', async () => {
    test.fixme(true, '产品落地页（各语言 slug）尚未合并');
  });

  test('3. 非生产环境 noindex，robots.txt Disallow: /；privacy 不在 sitemap', async ({ page, request }) => {
    const r = await page.goto('/en');
    const meta = await page.locator('meta[name=robots]').getAttribute('content').catch(() => null);
    expect(`${meta ?? ''} ${r!.headers()['x-robots-tag'] ?? ''}`).toContain('noindex');
    expect(await (await request.get('/robots.txt')).text()).toMatch(/Disallow:\s*\/\s*$/m);
    await page.goto('/en/privacy');
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
    expect(await (await request.get('/sitemap.xml')).text()).not.toContain('/privacy');
  });

  test('4. /s/<过期> 返回 410 + noindex + 品类链接', async () => { test.fixme(true, '等 #101 短链接合并'); });

  test('5. 不存在的路径真实返回 404，不跳转，有品类入口', async ({ page }) => {
    const r = await page.goto('/en/does-not-exist');
    expect(r!.status()).toBe(404);
    expect(new URL(page.url()).pathname).toBe('/en/does-not-exist');
    await expect(page.locator('a[href*="/products"]').first()).toBeVisible();
  });

  test('6. sitemap 200，所有地址 200，每条带 hreflang alternates', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const xml = await res.text();
    const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const loc = /<loc>(.*?)<\/loc>/.exec(u)![1];
      expect(u, loc).toMatch(/hreflang="en"/); expect(u, loc).toMatch(/hreflang="ru"/);
      const path = new URL(loc).pathname;
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
    }
  });

  test('7. JSON-LD：首页 Organization+WebSite，/products ItemList+BreadcrumbList，无 offers/aggregateRating', async ({ page }) => {
    const ld = async () => (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));
    const types = (arr: unknown[]) => JSON.stringify(arr);
    await page.goto('/en');
    let a = await ld();
    expect(types(a)).toContain('"Organization"'); expect(types(a)).toContain('"WebSite"');
    await page.goto('/en/products');
    a = await ld();
    expect(types(a)).toContain('"ItemList"'); expect(types(a)).toContain('"BreadcrumbList"');
    expect(types(a)).not.toMatch(/"offers"|"aggregateRating"/);
  });
});
