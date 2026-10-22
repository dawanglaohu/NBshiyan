import { expect, test, type Page } from './fixtures';

const GIF = '/brand/packjoyu-industrial-city-v3-loop.gif';
const STILL_RATIO = 1384 / 720;
const VIDEO_RATIO = 16 / 9;

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  if (await bar.isVisible().catch(() => false)) {
    await bar.getByRole('button', { name: 'Reject all' }).click();
    await expect(bar).toBeHidden();
  }
}

function gifPaths(urls: string[]) {
  return urls.filter((url) => new URL(url).pathname === GIF);
}

async function placeScene(page: Page, belowFoldPx: number) {
  await page.evaluate((gap) => {
    const el = document.querySelector('[data-testid="brand-scene"]');
    if (!el) throw new Error('brand scene missing');
    const delta = el.getBoundingClientRect().top - (window.innerHeight + gap);
    window.scrollBy(0, delta);
  }, belowFoldPx);
  await page.evaluate((gap) => {
    const top = document.querySelector('[data-testid="brand-scene"]')?.getBoundingClientRect().top ?? 0;
    if (Math.abs(top - (window.innerHeight + gap)) > 2) throw new Error(`scene top ${top} expected ${window.innerHeight + gap}`);
  }, belowFoldPx);
}

async function contentRatio(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const width = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const height = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    return { width, height, ratio: width / height, fit: style.objectFit };
  });
}

function overlaps(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 1 && height > 1;
}

test('wordmark, products and contact are clicked through; catalog HTML comes from the server', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/\/en$/);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const ssr = await page.request.get('/en/products');
  expect(ssr.status()).toBe(200);
  const html = await ssr.text();
  expect(html).toContain('Our products in 3D');
  expect((html.match(/<article[^>]*class="card/g) ?? []).length).toBeGreaterThanOrEqual(12);
  await expect(page.locator('main article.card').first()).toBeVisible();
  expect(seen.filter((hit) => hit === 'GET /api/models')).toEqual([]);

  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/\/en$/);
  await page.locator('[data-testid="contact-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/contact$/);
  await expect(page.locator('main h1')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('[data-testid="contact-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/contact$/);
});

test('video stays muted and inline, keeps a poster when autoplay is blocked, and does not keep forcing playback', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.play;
    let blocked = true;
    HTMLVideoElement.prototype.play = function play() {
      if (blocked) {
        blocked = false;
        return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      }
      return original.apply(this, arguments);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const frame = page.getByTestId('home-video');
  await page.waitForFunction(() => localStorage.getItem('pj-hero-115-seen') === '1');
  await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'poster');
  await expect(frame.locator('.hero-media-poster')).toBeVisible();
  const play = frame.getByRole('button', { name: 'Play video' });
  await expect(play).toBeVisible();
  await expect(frame.locator('video')).toHaveCount(0);
  await play.click();
  const video = frame.locator('video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).muted && (el as HTMLVideoElement).playsInline)).toBe(true);
  await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'playing');
  await frame.getByRole('button', { name: 'Pause video' }).click();
  await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true);
});

test('reduced motion and a failed video stay on the poster and offer play once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const videos: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('.mp4')) videos.push(new URL(request.url()).pathname);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const frame = page.getByTestId('home-video');
  await expect(frame.locator('.hero-media-poster')).toBeVisible();
  await expect(frame.locator('video')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'Play video' })).toBeVisible();
  expect(videos).toEqual([]);

  await page.unroute('**/*.mp4').catch(() => undefined);
  await page.route('**/*.mp4', (route) => route.abort());
  await frame.getByRole('button', { name: 'Play video' }).click();
  await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'poster');
  await expect(frame.getByRole('button', { name: 'Play video' })).toBeVisible();
  await expect.poll(() => videos.length).toBeGreaterThan(0);
  const after = videos.length;
  await page.waitForTimeout(500);
  expect(videos.length).toBe(after);
});

test('the city GIF is not requested until it is within 300px, and a pause survives scroll and a hidden tab', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  for (const height of [900, 700, 520]) {
    await page.setViewportSize({ width: 1440, height });
    const fits = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="brand-scene"]');
      if (!el) return false;
      return el.getBoundingClientRect().top + window.scrollY > window.innerHeight + 360;
    });
    if (fits) break;
  }
  await placeScene(page, 360);
  expect(gifPaths(requested)).toEqual([]);
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await expect(page.getByTestId('brand-scene-still')).toBeVisible();

  await placeScene(page, 200);
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();
  await expect.poll(() => gifPaths(requested).length).toBeGreaterThan(0);
  const scene = page.getByTestId('brand-scene');
  await scene.getByRole('button', { name: 'Pause illustration animation' }).click();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await page.getByTestId('brand-scene-still').scrollIntoViewIfNeeded();
  const pausedStill = await page.getByTestId('brand-scene-still').evaluate((el) => ({
    width: (el as HTMLImageElement).naturalWidth,
    height: (el as HTMLImageElement).naturalHeight,
  }));
  expect(pausedStill).toEqual({ width: 1384, height: 720 });

  await placeScene(page, 360);
  await placeScene(page, 200);
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);

  await scene.getByRole('button', { name: 'Play illustration animation' }).click();
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();
  const setPageHidden = async (hidden: boolean) => {
    await page.evaluate((isHidden) => {
      const value = isHidden ? 'hidden' : 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  };
  await setPageHidden(true);
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  await setPageHidden(false);
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();
  await scene.getByRole('button', { name: 'Pause illustration animation' }).click();
  await setPageHidden(true);
  await setPageHidden(false);
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
});

test('reduced motion does not start the city GIF until the visitor presses play', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await placeScene(page, 200);
  expect(gifPaths(requested)).toEqual([]);
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await page.getByTestId('brand-scene').getByRole('button', { name: 'Play illustration animation' }).click();
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();
  expect(gifPaths(requested).length).toBeGreaterThan(0);
});

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const) {
  test(`media keeps its source ratio and stays off the nav and copy at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/en');
    await dismissConsent(page);
    const videoBox = await contentRatio(page, '.hero-media');
    expect(Math.abs(videoBox.ratio - VIDEO_RATIO)).toBeLessThan(0.02);
    const poster = await page.locator('.hero-media-poster').evaluate((el) => ({
      width: (el as HTMLImageElement).naturalWidth,
      height: (el as HTMLImageElement).naturalHeight,
      fit: getComputedStyle(el).objectFit,
    }));
    expect(Math.abs(poster.width / poster.height - VIDEO_RATIO)).toBeLessThan(0.02);
    expect(poster.fit).toBe('contain');

    await page.getByTestId('brand-scene').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('brand-scene-still')).toBeVisible();
    const stillBox = await contentRatio(page, '.brand-scene-media');
    expect(Math.abs(stillBox.ratio - STILL_RATIO)).toBeLessThan(0.02);
    const still = await page.getByTestId('brand-scene-still').evaluate((el) => {
      const image = el as HTMLImageElement;
      const rect = image.getBoundingClientRect();
      const frame = image.parentElement!.getBoundingClientRect();
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        fit: getComputedStyle(image).objectFit,
        inside: rect.left >= frame.left - 1 && rect.top >= frame.top - 1 && rect.right <= frame.right + 1 && rect.bottom <= frame.bottom + 1,
      };
    });
    expect(still).toMatchObject({ width: 1384, height: 720, fit: 'contain', inside: true });

    const media = await page.locator('.hero-media, .brand-scene-media').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }));
    const clickable = await page.locator('header.site a, header.site button, h1, .hero p, #brand-scene-title, canvas, .pv-controls button').evaluateAll((nodes) => nodes.flatMap((node) => {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return [];
      return [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, name: node.tagName }];
    }));
    for (const box of media) {
      for (const hit of clickable) expect(overlaps(box, hit), hit.name).toBe(false);
    }
    await expect(page.getByTestId('home-video').getByRole('button').first()).toBeVisible();
    await expect(page.getByTestId('brand-scene').getByRole('button')).toBeVisible();
  });
}
