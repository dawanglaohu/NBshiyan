import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { expect, test } from './fixtures';

// fix1 口径：本轮只上 en，ru 的品类页未上线（404），因此 e2e 只覆盖 en 的 11 条 URL。
// ru 待文案通过母语审校后单独开 PR，再补回 en/ru 双向断言。
const paths = categoryMeta.map((meta) => `/en/products/${meta.en.slug}`);

test('category pages are 200 for en, in the sitemap, with self canonical and hreflang en/x-default', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  for (const path of paths) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(xml, path).toContain(path);
    const html = await res.text();
    expect(html, path).toMatch(new RegExp(`rel="canonical"[^>]*href="[^"]*${path}"|href="[^"]*${path}"[^>]*rel="canonical"`));
    // 已上线语言只有 en，x-default 指向 en；不得出现 ru 的 hreflang。
    for (const lang of ['en', 'x-default']) expect(html, path).toContain(`hreflang="${lang}"`);
    expect(html, path).not.toContain('hreflang="ru"');
  }
  for (const meta of categoryMeta) {
    expect(xml).toContain(`/en/products/${meta.en.slug}`);
    // ru 品类 URL 不得进 sitemap。
    expect(xml).not.toContain(`/ru/products/${meta.ru.slug}`);
  }
  // ru 品类页按 fix1 口径未上线，直接访问应 404。
  for (const meta of categoryMeta) {
    expect((await request.get(`/ru/products/${meta.ru.slug}`, { maxRedirects: 0 })).status(), meta.key).toBe(404);
  }
  expect((await request.get('/en/products/gift-boxes', { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get('/en/products/not-a-category', { maxRedirects: 0 })).status()).toBe(404);
});

test('lead is on the first 390 screen; 390 and 1280 do not overflow', async ({ page }) => {
  test.setTimeout(60_000);
  const samples = ['/en/products/custom-gift-boxes', '/en/products/custom-paper-cups'];
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
      // en 页不得自动断词。ru 品类页本轮未上线，样本里没有 ru 路径，
      // 因此这里不写 ru 的断词断言，避免给出「已验证」的假象。
      if (path.startsWith('/en/')) expect(fit.hyphens, path).toBe('manual');
    }
  }
});
