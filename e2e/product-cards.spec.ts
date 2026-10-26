import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from './fixtures';

async function dismissConsent(page: Page, locale: 'en' | 'ru' = 'en') {
  const name = locale === 'ru' ? 'Согласие на использование cookie' : 'Cookie consent';
  const reject = locale === 'ru' ? 'Отклонить все' : 'Reject all';
  const bar = page.getByRole('region', { name });
  // 同意条在客户端 effect 里才出现。只看当前是否可见会漏掉，横幅 z-index 高于悬浮按钮。
  const appeared = await bar.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true, () => false);
  if (!appeared) return;
  await bar.getByRole('button', { name: reject }).click();
  await expect(bar).toBeHidden();
}

function clampViewport(viewportWidth: number) {
  return Math.min(440, Math.max(360, viewportWidth * 0.28));
}

function isGlbRequest(hit: string) {
  const path = hit.replace(/^[A-Z]+ /, '');
  return path.includes('/glb') || path.includes('.glb');
}

async function cardBox(page: Page) {
  return page.locator('article.card').first().evaluate((card) => {
    const stage = card.querySelector('[data-testid="product-viewport"]');
    if (!stage) throw new Error('viewport missing');
    const cardRect = card.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const name = card.querySelector('h2');
    const spec = card.querySelector('.specs');
    const nameStyle = name ? getComputedStyle(name) : null;
    const specStyle = spec ? getComputedStyle(spec) : null;
    return {
      cardWidth: cardRect.width,
      viewportHeight: stageRect.height,
      viewportWidth: stageRect.width,
      nameSize: nameStyle?.fontSize ?? '',
      nameLine: nameStyle?.lineHeight ?? '',
      specSize: specStyle?.fontSize ?? '',
      specLine: specStyle?.lineHeight ?? '',
      specColor: specStyle?.color ?? '',
      viewportInLink: !!stage.closest('a'),
      descCount: card.querySelectorAll('.desc').length,
    };
  });
}

async function assertDescriptionsFitTwoLines(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const descs = page.locator('.desc');
  const count = await descs.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const measured = await descs.nth(index).evaluate((el) => {
      const probe = el.cloneNode(true) as HTMLElement;
      probe.style.setProperty('-webkit-line-clamp', 'unset');
      probe.style.lineClamp = 'unset';
      probe.style.display = 'block';
      probe.style.overflow = 'visible';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.width = `${el.getBoundingClientRect().width}px`;
      probe.style.maxHeight = 'none';
      probe.style.margin = '0';
      el.insertAdjacentElement('afterend', probe);
      const node = probe.firstChild;
      const range = document.createRange();
      let lines = 0;
      let top: number | null = null;
      if (node && node.nodeType === Node.TEXT_NODE) {
        const text = node as Text;
        for (let i = 0; i < text.length; i++) {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.height) continue;
          if (top === null || Math.abs(rect.top - top) > 1) {
            lines += 1;
            top = rect.top;
          }
        }
      }
      probe.remove();
      return { lines, text: (el.textContent ?? '').trim() };
    });
    expect(measured.lines, measured.text).toBeLessThanOrEqual(2);
  }
}

function articleChunks(html: string) {
  return html.split(/<article\b/).slice(1).map((part) => part.split('</article>')[0]);
}

function itemListDescriptions(html: string): string[] {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const block of blocks) {
    const json = JSON.parse(block[1]) as { '@graph'?: { '@type'?: string; itemListElement?: { description?: string }[] }[]; '@type'?: string; itemListElement?: { description?: string }[] };
    const nodes = json['@graph'] ?? [json];
    const list = nodes.find((node) => node['@type'] === 'ItemList');
    if (list?.itemListElement) return list.itemListElement.map((item) => item.description ?? '');
  }
  return [];
}

function renderedModes(): { anchor: string; hash: string; live: string } {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'tests/product-card-markup.ts'], {
    encoding: 'utf8',
    env: { ...process.env, PRINT_PRODUCT_CARDS: '1' },
  });
  return JSON.parse(out);
}

test('products-link opens the server catalog, large cards, and the real model file', async ({ page }) => {
  test.setTimeout(60_000);
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/models' || path.endsWith('.glb') || /^\/api\/models\/[^/]+\//.test(path)) {
      seen.push(`${request.method()} ${path}`);
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const ssr = await page.request.get('/en/products');
  expect(ssr.status()).toBe(200);
  const html = await ssr.text();
  const cards = articleChunks(html);
  expect(cards.length).toBeGreaterThanOrEqual(12);
  expect(html).toMatch(/\/models\/[^"'\\\s]+\.glb|\/api\/models\/[^"'\\\s]+\/glb/);
  const descriptions = itemListDescriptions(html);
  expect(descriptions.length).toBe(cards.length);
  for (const [index, card] of cards.entries()) {
    const descs = [...card.matchAll(/<p class="desc">([\s\S]*?)<\/p>/g)];
    expect(descs.length).toBe(1);
    expect(descs[0][1]).toBe(descriptions[index]);
    expect(card).not.toContain('product-name-link');
    expect(card).not.toContain('category-link');
    expect(card).not.toMatch(/<h2[^>]*>\s*<a\b/);
  }
  await expect(page.locator('main article.card').first()).toBeVisible();

  const desktop = await cardBox(page);
  expect(desktop.cardWidth).toBeGreaterThanOrEqual(560);
  expect(desktop.viewportHeight).toBeGreaterThanOrEqual(clampViewport(1440) - 1);
  expect(desktop.viewportHeight).toBeLessThanOrEqual(clampViewport(1440) + 1);
  expect(desktop.nameSize).toBe('24px');
  expect(desktop.nameLine).toBe('28px');
  expect(desktop.specSize).toBe('16px');
  expect(desktop.specLine).toBe('24px');
  expect(desktop.specColor).toBe('rgb(0, 0, 0)');
  expect(desktop.viewportInLink).toBe(false);
  expect(desktop.descCount).toBe(1);
  const first = page.locator('article.card').first();
  await expect(first.locator('h2 a')).toHaveCount(0);
  await expect(first.getByTestId('category-link')).toHaveCount(0);
  await expect(page.getByTestId('category-link')).toHaveCount(0);
  await expect(first.getByRole('button', { name: 'Add to quote' })).toBeVisible();
  await expect(first.locator('.specs li').first()).toBeVisible();
  const heading = await first.locator('h2').evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(heading).toBe('none');
  const actions = await first.locator('.actions').evaluate((el) => {
    const button = el.querySelector('button');
    if (!button) return { children: el.childElementCount, inset: -1 };
    return { children: el.childElementCount, inset: button.getBoundingClientRect().left - el.getBoundingClientRect().left };
  });
  expect(actions.children).toBe(1);
  expect(actions.inset).toBeLessThanOrEqual(1);
  const descStyle = await first.locator('.desc').evaluate((el) => {
    const style = getComputedStyle(el);
    return { size: style.fontSize, line: style.lineHeight, color: style.color, clamp: style.webkitLineClamp, weight: style.fontWeight };
  });
  expect(descStyle).toEqual({ size: '14px', line: '20px', color: 'rgb(90, 86, 80)', clamp: '2', weight: '400' });
  const premiumColor = await page.locator('article.theme-premium .desc').first().evaluate((el) => getComputedStyle(el).color);
  expect(premiumColor).toBe('rgb(185, 175, 156)');
  const actionInset = await page.locator('.product-grid > .card').evaluateAll((nodes) => nodes.slice(0, 2).map((card) => {
    const row = card.querySelector('.actions');
    if (!row) return null;
    return Math.round(card.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom);
  }));
  expect(actionInset[0]).not.toBeNull();
  expect(Math.abs((actionInset[0] ?? 0) - (actionInset[1] ?? 0))).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 1920, height: 1080 });
  const wide = await cardBox(page);
  expect(wide.cardWidth).toBeGreaterThanOrEqual(560);
  expect(wide.viewportHeight).toBeGreaterThanOrEqual(clampViewport(1920) - 1);
  expect(wide.viewportHeight).toBeLessThanOrEqual(clampViewport(1920) + 1);

  await page.setViewportSize({ width: 1440, height: 900 });
  const viewport = page.getByTestId('product-viewport').first();
  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport box missing');
  await page.mouse.move(box.x + 48, box.y + 48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/en\/products$/);
  await expect(first.getByRole('button', { name: 'Add to quote' })).toBeVisible();
  expect(seen.filter((hit) => hit === 'GET /api/models')).toEqual([]);
  await expect.poll(() => seen.some(isGlbRequest), { timeout: 25_000 }).toBe(true);

  const blocked = await page.request.get('/en/products/custom-corrugated-boxes');
  expect(blocked.status()).toBe(404);

  const api = await page.request.get('/api/models');
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toContain('max-age=60');
  const body = await api.json() as { items: unknown };
  expect(Array.isArray(body.items)).toBe(true);
  expect(seen.filter((hit) => hit === 'GET /api/models')).toEqual([]);
});

test('a 900px products column caps the model stage at 440px and the card inner width', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto('/en/products');
  await dismissConsent(page);
  const measured = await page.locator('article.card').first().evaluate((card) => {
    const stage = card.querySelector('[data-testid="product-viewport"]');
    if (!stage) throw new Error('viewport missing');
    const stageRect = stage.getBoundingClientRect();
    return { stageHeight: stageRect.height, stageWidth: stageRect.width, cardInner: card.clientWidth };
  });
  expect(measured.stageHeight).toBeLessThanOrEqual(440);
  expect(measured.stageHeight).toBeGreaterThanOrEqual(439);
  expect(Math.abs(measured.stageWidth - measured.cardInner)).toBeLessThanOrEqual(1);
});

test('a 390px products entry does not overflow and keeps the name, specs, and inquiry control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const narrow = await cardBox(page);
  expect(narrow.cardWidth).toBeLessThanOrEqual(390);
  expect(narrow.viewportWidth).toBeLessThanOrEqual(390);
  expect(narrow.viewportHeight).toBeGreaterThanOrEqual(240);
  const ratio = narrow.viewportWidth / narrow.viewportHeight;
  expect(ratio).toBeGreaterThan(1.2);
  expect(ratio).toBeLessThan(1.5);
  expect(narrow.nameSize).toBe('20px');
  expect(narrow.nameLine).toBe('24px');
  expect(narrow.descCount).toBe(1);
  const first = page.locator('article.card').first();
  await expect(first.locator('h2 a')).toHaveCount(0);
  await expect(first.locator('.specs li').first()).toBeVisible();
  await expect(first.getByRole('button', { name: 'Add to quote' })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
  await assertDescriptionsFitTwoLines(page);
});

test('ru 390 products page does not overflow and each control center hits itself', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ru/products');
  await dismissConsent(page, 'ru');
  await assertDescriptionsFitTwoLines(page);
  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(docOverflow).toBe(0);
  const title = await page.locator('#pulp-molding h2').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(title.scroll).toBeLessThanOrEqual(title.client);
  const misses = await page.evaluate(() => {
    const freeze = document.createElement('style');
    freeze.textContent = '*, *::before, *::after { scroll-behavior: auto !important; }';
    document.head.appendChild(freeze);
    const nodes = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')];
    const bad: string[] = [];
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
      if (el.closest('[hidden], [aria-hidden="true"], [inert]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const scroller = el.closest('.catbar');
      if (scroller instanceof HTMLElement && scroller !== el) {
        scroller.scrollLeft = Math.max(0, el.offsetLeft - (scroller.clientWidth - el.offsetWidth) / 2);
      } else if (style.position !== 'fixed') {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      }
      const next = el.getBoundingClientRect();
      const left = Math.max(next.left, 0);
      const right = Math.min(next.right, window.innerWidth);
      const top = Math.max(next.top, 0);
      const bottom = Math.min(next.bottom, window.innerHeight);
      if (right - left < 8 || bottom - top < 8) {
        bad.push(`offscreen ${el.tagName} ${el.innerText.slice(0, 40)}`);
        continue;
      }
      const cx = Math.min(window.innerWidth - 1, Math.max(0, next.left + next.width / 2));
      const cy = Math.min(window.innerHeight - 1, Math.max(0, next.top + next.height / 2));
      const x = cx < left || cx > right ? (left + right) / 2 : cx;
      const y = cy < top || cy > bottom ? (top + bottom) / 2 : cy;
      const hit = document.elementFromPoint(x, y);
      if (hit !== el && !el.contains(hit)) {
        const target = hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : String(hit);
        bad.push(`${el.tagName}.${el.className} "${el.innerText.slice(0, 40)}" hit ${target}`);
      }
    }
    freeze.remove();
    return bad;
  });
  expect(misses).toEqual([]);
});

test('unpublished cards stay plain text and published cards keep both links', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en/products');
  const css = await page.locator('link[rel="stylesheet"]').evaluateAll((els) => els.map((el) => (el as HTMLLinkElement).href));
  const modes = renderedModes();
  const shell = (body: string) => `<!doctype html><html><head>${css.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}</head><body>${body}</body></html>`;
  await page.setContent(shell(`<div id="anchor">${modes.anchor}</div><div id="hash">${modes.hash}</div><div id="live">${modes.live}</div>`), { waitUntil: 'load' });

  for (const id of ['anchor', 'hash']) {
    const root = page.locator(`#${id}`);
    await expect(root.locator('h2 a')).toHaveCount(0);
    await expect(root.getByTestId('category-link')).toHaveCount(0);
    await expect(root.locator('h2')).toHaveText('Corrugated Boxes');
    const decoration = await root.locator('h2').evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(decoration).toBe('none');
    const row = await root.locator('.actions').evaluate((el) => {
      const button = el.querySelector('button');
      if (!button) return { children: el.childElementCount, inset: -1 };
      return { children: el.childElementCount, inset: button.getBoundingClientRect().left - el.getBoundingClientRect().left };
    });
    expect(row.children).toBe(1);
    expect(row.inset).toBeLessThanOrEqual(1);
  }

  const live = page.locator('#live');
  await expect(live.getByTestId('product-name-link')).toHaveAttribute('href', /\/products\/custom-corrugated-boxes$/);
  await expect(live.getByTestId('category-link')).toHaveAttribute('href', /\/products\/custom-corrugated-boxes$/);
  const linkDecoration = await live.getByTestId('product-name-link').evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(linkDecoration).toContain('underline');
  const desktopPad = await live.getByTestId('product-name-link').evaluate((el) => getComputedStyle(el).paddingTop);
  expect(desktopPad).toBe('8px');
  const desktopHeight = await live.getByTestId('product-name-link').evaluate((el) => el.getBoundingClientRect().height);
  expect(desktopHeight).toBeGreaterThanOrEqual(44);
  const desktopOverlap = await live.evaluate((root) => {
    const link = root.querySelector('[data-testid="product-name-link"]');
    const desc = root.querySelector('.desc');
    if (!link || !desc) return 99;
    return link.getBoundingClientRect().bottom - desc.getBoundingClientRect().top;
  });
  expect(desktopOverlap).toBeLessThanOrEqual(0.5);

  await page.setViewportSize({ width: 390, height: 844 });
  const phonePad = await live.getByTestId('product-name-link').evaluate((el) => getComputedStyle(el).paddingTop);
  expect(phonePad).toBe('10px');
  const phoneHeight = await live.getByTestId('product-name-link').evaluate((el) => el.getBoundingClientRect().height);
  expect(phoneHeight).toBeGreaterThanOrEqual(44);
  const phoneOverlap = await live.evaluate((root) => {
    const link = root.querySelector('[data-testid="product-name-link"]');
    const desc = root.querySelector('.desc');
    if (!link || !desc) return 99;
    return link.getBoundingClientRect().bottom - desc.getBoundingClientRect().top;
  });
  expect(phoneOverlap).toBeLessThanOrEqual(0.5);
});

const liveOrigin = process.env.M2_LIVE_ORIGIN;
if (liveOrigin) {
  test('category-link opens the published shell and returns to the 3D catalog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${liveOrigin}/en`);
    await dismissConsent(page);
    await page.locator('[data-testid="products-link"]:visible').click();
    await expect(page).toHaveURL(/\/en\/products$/);
    const card = page.locator('article.card').first();
    const link = card.getByTestId('category-link');
    await expect(link).toHaveAttribute('href', /\/products\/custom-corrugated-boxes$/);
    await expect(card.getByTestId('product-name-link')).toHaveAttribute('href', /\/products\/custom-corrugated-boxes$/);
    await expect(card.locator('.desc')).toHaveCount(1);
    await link.click();
    await expect(page).toHaveURL(/\/en\/products\/custom-corrugated-boxes$/);
    await expect(page.locator('main h1')).toHaveText('Corrugated Boxes');
    await expect(page.getByTestId('product-viewport')).toHaveCount(0);
    await page.getByTestId('catalog-return-link').click();
    await expect(page).toHaveURL(/\/en\/products/);
    await expect(page.getByTestId('product-viewport').first()).toBeVisible();
  });
}
