import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { expect, test } from './fixtures';

// 品类页已随 CATEGORY_PAGES_LIVE 打开。不登录后台。
const paths = categoryMeta.flatMap((meta) => (['en', 'ru'] as const).map((locale) => `/${locale}/products/${meta[locale].slug}`));

test('category pages are 200, in the sitemap, with self canonical and en/ru/x-default', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  for (const path of paths) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(xml, path).toContain(path);
    const html = await res.text();
    expect(html, path).toMatch(new RegExp(`rel="canonical"[^>]*href="[^"]*${path}"|href="[^"]*${path}"[^>]*rel="canonical"`));
    for (const lang of ['en', 'ru', 'x-default']) expect(html, path).toContain(`hreflang="${lang}"`);
  }
  for (const meta of categoryMeta) {
    expect(xml).toContain(`/en/products/${meta.en.slug}`);
    expect(xml).toContain(`/ru/products/${meta.ru.slug}`);
  }
  expect((await request.get('/en/products/gift-boxes', { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get('/en/products/not-a-category', { maxRedirects: 0 })).status()).toBe(404);
});

test('lead is on the first 390 screen; 390 and 1280 do not overflow', async ({ page }) => {
  test.setTimeout(60_000);
  const samples = ['/en/products/custom-gift-boxes', '/ru/products/podarochnye-korobki', '/ru/products/tovary-dlya-prazdnikov'];
  for (const path of samples) {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }] as const) {
      await page.setViewportSize(viewport);
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const lead = page.getByTestId('category-lead');
      await expect(lead).toBeVisible();
      const box = await lead.boundingBox();
      expect(box, path).toBeTruthy();
      if (viewport.width === 390) expect(box!.y, path).toBeLessThan(viewport.height - 24);
      const fit = await page.evaluate(() => {
        const main = document.querySelector('main.category-prose');
        const root = document.documentElement;
        const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
        return {
          overflow: root.scrollWidth <= root.clientWidth + 1,
          wrap: getComputedStyle(document.querySelector('[data-testid="category-lead"] p') ?? document.body).textWrap,
          // UX P2：行宽上限从 70ch 改为 32rem。按 rem 计算，避免字体族差异让 ch 漂移。
          prose: main ? main.getBoundingClientRect().width <= Math.min(32 * rem, root.clientWidth) + 1 : false,
          // UX P2：英文关闭自动断词（manual），俄语保留（auto）。
          hyphens: main ? getComputedStyle(main).hyphens : '',
        };
      });
      expect(fit.overflow, `${path} ${viewport.width}`).toBe(true);
      expect(fit.wrap, path).toBe('pretty');
      if (viewport.width === 1280) expect(fit.prose, path).toBe(true);
      // en 页不得自动断词；ru 页仍需断词避免 390 溢出。
      if (path.startsWith('/en/')) expect(fit.hyphens, path).toBe('manual');
      if (path.startsWith('/ru/')) expect(fit.hyphens, path).toBe('auto');
    }
  }
});
