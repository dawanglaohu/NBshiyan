import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fallbackCopy, MAX_MODEL_RETRIES, retryAllowed, retrySrc } from '../src/lib/three/model-fallback';

/**
 * M2-T6：真实模型失败与海报回退。
 *
 * 证据分级（不得混用）：
 * - 首条纯规则断言只证明重试上限/URL 变化/文案，不证明真实浏览器行为。
 * - 其余用例在真实服务上注入四类状态：GLB 下载失败、WebGL 不支持、context lost、刀模 FoldBox。
 *   分别断言「对应产品海报可见」「重试是有界的新加载尝试」「询盘入口仍可用」。
 * - 正式验收跑 production build（standalone）；实际使用的配置/服务来源另记，不用截图推断。
 */

const POSTER = '/images/posters/custom-corrugated-boxes.5f405542.webp';
const BASE_MODEL = /\/models\/corrugated-box\.anim\.[0-9a-f]+\.glb(\?.*)?$/;
const MEDIA_DIR = process.env.M2T6_MEDIA_DIR;

async function shot(page: Page, name: string) {
  if (!MEDIA_DIR) return;
  mkdirSync(MEDIA_DIR, { recursive: true });
  await page.screenshot({ path: path.join(MEDIA_DIR, name) });
}

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  const appeared = await bar.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true, () => false);
  if (!appeared) return;
  await bar.getByRole('button', { name: 'Reject all' }).click();
  await expect(bar).toBeHidden();
}

async function openProducts(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto('/en');
  await dismissConsent(page);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  return page.locator('article.card').first();
}

async function readyHint(stage: ReturnType<Page['getByTestId']>) {
  await expect(stage.locator('.hint')).toHaveText('Drag to rotate', { timeout: 45_000 });
}

/** 真实用户路径：加入清单 → 再点已加入按钮打开清单面板 → 核清单项归属。 */
async function verifyQuotePanel(page: Page, mediaName?: string) {
  const card = page.locator('article.card').first();
  const name = (await card.locator('h2').innerText()).trim();
  const add = card.getByRole('button', { name: 'Add to quote' });
  await add.click();
  const inQuote = card.getByRole('button', { name: /In quote/ });
  await expect(inQuote).toHaveAttribute('aria-pressed', 'true');
  await inQuote.click();
  const drawer = page.getByRole('dialog', { name: 'Quote list' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('listitem')).toHaveCount(1);
  await expect(drawer.getByRole('listitem').first()).toContainText(name);
  if (mediaName) await shot(page, mediaName);
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
}

test('M2-T6 规则自检：重试有界、重试 URL 是新加载、en/ru 文案齐全', () => {
  expect(MAX_MODEL_RETRIES).toBe(3);
  expect([0, 1, 2].every((n) => retryAllowed(n))).toBe(true);
  expect(retryAllowed(3)).toBe(false);
  expect(retryAllowed(-1)).toBe(false);
  expect(retrySrc('/models/a.glb', 0)).toBe('/models/a.glb');
  expect(retrySrc('/models/a.glb', 2)).toBe('/models/a.glb?retry=2');
  expect(retrySrc('/models/a.glb?x=1', 1)).toBe('/models/a.glb?x=1&retry=1');
  for (const locale of ['en', 'ru']) {
    const c = fallbackCopy(locale);
    for (const value of [c.failed, c.retry, c.retryLimit, c.webgl]) expect(value.trim().length).toBeGreaterThan(0);
  }
});

test('GLB 下载失败：显示对应产品海报，手动重试建立新的真实加载，询盘仍可用', async ({ page }) => {
  test.setTimeout(150_000);
  let requests = 0;
  let allow = false;
  await page.route(BASE_MODEL, async (route) => {
    requests += 1;
    if (!allow) return route.abort('failed');
    return route.continue();
  });
  const card = await openProducts(page);
  const stage = card.getByTestId('product-viewport');
  const fallback = stage.getByTestId('model-fallback');

  await expect(fallback).toBeVisible({ timeout: 40_000 });
  await expect(fallback).toHaveAttribute('data-reason', 'LOAD_ERROR');
  await expect(stage.locator('img')).toHaveAttribute('src', POSTER);
  await expect(stage.locator('img')).toHaveCSS('opacity', '1');
  await shot(page, '01-glb-fallback.png');

  // 失败后不自动重试：等一段有界时间仍是同一次请求
  await page.waitForTimeout(1_200);
  expect(requests).toBe(1);

  const before = requests;
  allow = true;
  await stage.getByTestId('model-retry').click();
  await expect.poll(() => requests, { timeout: 20_000 }).toBeGreaterThan(before);
  await readyHint(stage);
  await expect(fallback).toBeHidden();
  await expect(stage.locator('img')).toHaveCSS('opacity', '0');
  await shot(page, '02-glb-retry-ready.png');

  // 询盘入口仍在真实卡片上可用：加入 → 打开清单面板 → 核产品归属
  await verifyQuotePanel(page, '08-quote-panel.png');
});

test('WebGL 不支持：全部卡片显示产品海报，重试次数有界', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (String(type).startsWith('webgl') || type === 'experimental-webgl') return null;
      return (original as unknown as (t: string, ...a: unknown[]) => unknown).call(this, type, ...args);
    } as typeof original;
  });
  const card = await openProducts(page);
  const stage = card.getByTestId('product-viewport');
  const fallback = stage.getByTestId('model-fallback');

  await expect(fallback).toBeVisible({ timeout: 30_000 });
  await expect(fallback).toHaveAttribute('data-reason', 'WEBGL_UNAVAILABLE');
  await expect(stage.locator('img')).toHaveAttribute('src', POSTER);
  await expect(stage.locator('img')).toHaveCSS('opacity', '1');
  await expect(page.locator('canvas')).toHaveCount(0);
  await shot(page, '03-webgl-unavailable.png');

  const retry = stage.getByTestId('model-retry');
  for (let i = 0; i < MAX_MODEL_RETRIES; i += 1) await retry.click();
  await expect(retry).toBeDisabled();
  await expect(stage.locator('img')).toHaveCSS('opacity', '1');
  await expect(page.locator('canvas')).toHaveCount(0);

  await verifyQuotePanel(page);
});

test('context lost：显示海报，重试重建画布并发起新的模型加载', async ({ page }) => {
  test.setTimeout(180_000);
  let requests = 0;
  await page.route(BASE_MODEL, async (route) => {
    requests += 1;
    await route.continue();
  });
  const card = await openProducts(page);
  const stage = card.getByTestId('product-viewport');
  await readyHint(stage);
  const before = requests;
  await shot(page, '04-model-ready.png');

  const lost = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    return true;
  });
  expect(lost, '浏览器必须支持 WEBGL_lose_context 才能注入 context lost').toBe(true);

  const fallback = stage.getByTestId('model-fallback');
  await expect(fallback).toBeVisible({ timeout: 20_000 });
  await expect(fallback).toHaveAttribute('data-reason', 'WEBGL_UNAVAILABLE');
  await expect(stage.locator('img')).toHaveCSS('opacity', '1');
  await shot(page, '05-context-lost.png');

  await stage.getByTestId('model-retry').click();
  await expect.poll(() => requests, { timeout: 40_000 }).toBeGreaterThan(before);
  await readyHint(stage);
  await expect(fallback).toBeHidden();
  await shot(page, '06-context-retry-ready.png');
});

test('刀模 FoldBox：不是失败回退，不显示重试条、不串海报', async ({ page }) => {
  test.setTimeout(120_000);
  const card = await openProducts(page);
  const stage = card.getByTestId('product-viewport');
  await readyHint(stage);
  await card.getByRole('button', { name: 'Dieline' }).click();
  await expect(stage.getByTestId('model-fallback')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(stage.locator('img')).toHaveCSS('opacity', '0', { timeout: 30_000 });
  await shot(page, '07-dieline-foldbox.png');
});
