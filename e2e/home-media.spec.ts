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
    window.scrollBy({ top: delta, behavior: 'instant' });
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

async function sceneState(page: Page) {
  return page.getByTestId('brand-scene').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewport: window.innerHeight,
      admitted: el.getAttribute('data-admitted'),
      inView: el.getAttribute('data-in-view'),
      state: el.getAttribute('data-state'),
      userPaused: el.getAttribute('data-user-paused'),
      pageVisible: el.getAttribute('data-page-visible'),
      gif: el.querySelectorAll('[data-testid="brand-scene-gif"]').length,
    };
  });
}

test('the city GIF may download within 300px and plays only while it intersects the viewport', async ({ page }) => {
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
  const scene = page.getByTestId('brand-scene');
  await placeScene(page, 360);
  await expect(scene).toHaveAttribute('data-admitted', '0');
  await expect(scene).toHaveAttribute('data-in-view', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  expect(gifPaths(requested)).toEqual([]);
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await expect(page.getByTestId('brand-scene-still')).toBeVisible();

  // The section sits fully below the fold and still inside the 300px load margin.
  await placeScene(page, 150);
  await expect(scene).toHaveAttribute('data-admitted', '1');
  await expect(scene).toHaveAttribute('data-in-view', '0');
  const parked = await sceneState(page);
  expect(parked.top).toBeGreaterThan(parked.viewport);
  expect(parked.bottom).toBeGreaterThan(parked.viewport);
  expect(parked.top).toBeLessThan(parked.viewport + 300);
  expect(parked.state).toBe('still');
  expect(parked.userPaused).toBe('0');
  expect(parked.gif).toBe(0);
  await expect.poll(() => gifPaths(requested).length).toBeGreaterThan(0);
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);

  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-in-view', '1');
  await expect(scene).toHaveAttribute('data-state', 'playing');
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();

  await placeScene(page, 150);
  await expect(scene).toHaveAttribute('data-in-view', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  const leftStill = await page.getByTestId('brand-scene-still').evaluate((el) => ({
    width: (el as HTMLImageElement).naturalWidth,
    height: (el as HTMLImageElement).naturalHeight,
  }));
  expect(leftStill).toEqual({ width: 1384, height: 720 });

  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();

  await scene.getByRole('button', { name: 'Pause illustration animation' }).click();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await placeScene(page, 360);
  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
});

test('freeze and resume handlers preserve the city animation pause choice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const scene = page.getByTestId('brand-scene');
  await scene.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();
  // Isolated handler coverage; genuine hidden/visible transitions require a separate native-browser acceptance run.
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect(scene).toHaveAttribute('data-page-visible', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(scene).toHaveAttribute('data-page-visible', '1');
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();

  await scene.getByRole('button', { name: 'Pause illustration animation' }).click();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(scene).toHaveAttribute('data-page-visible', '1');
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
});

test('reduced motion does not start the city GIF until the visitor presses play inside the viewport', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await placeScene(page, 200);
  const scene = page.getByTestId('brand-scene');
  await expect(scene).toHaveAttribute('data-admitted', '1');
  await expect(scene).toHaveAttribute('data-in-view', '0');
  expect(gifPaths(requested)).toEqual([]);
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await scene.getByRole('button', { name: 'Play illustration animation' }).evaluate((el: HTMLButtonElement) => el.click());
  await expect(scene).toHaveAttribute('data-in-view', '0');
  await expect(page.getByTestId('brand-scene-gif')).toHaveCount(0);
  await scene.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('brand-scene-gif')).toBeVisible();
  expect(gifPaths(requested).length).toBeGreaterThan(0);
});

async function tokenButton(page: Page, name: string) {
  const button = page.getByTestId('home-video').getByRole('button', { name, exact: true });
  await expect(button).toBeVisible();
  await page.bringToFront();
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    if (await button.evaluate((el) => document.hasFocus() && document.activeElement === el && el.matches(':focus-visible'))) break;
  }
  await expect(button).toBeFocused();
  await expect.poll(() => button.evaluate((el) => document.hasFocus() && el.matches(':focus-visible'))).toBe(true);
  await expect(button).toHaveCSS('outline-width', '2px');
  await expect(button).toHaveCSS('outline-style', 'solid');
  await expect(button).toHaveCSS('outline-color', 'rgb(180, 87, 0)');
  const chrome = await button.evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderTopStyle: style.borderTopStyle,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      minHeight: parseFloat(style.minHeight),
      minWidth: parseFloat(style.minWidth),
      height: rect.height,
      width: rect.width,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      context: el.getAttribute('data-context'),
      className: el.className,
    };
  });
  expect(chrome.borderTopWidth).toBe('2px');
  expect(chrome.borderRightWidth).toBe('2px');
  expect(chrome.borderBottomWidth).toBe('2px');
  expect(chrome.borderLeftWidth).toBe('2px');
  expect(chrome.borderTopStyle).toBe('solid');
  for (const part of chrome.borderRadius.split(' ')) expect(part === '0px' || part === '0').toBe(true);
  expect(chrome.boxShadow).toBe('none');
  expect(chrome.minHeight).toBeGreaterThanOrEqual(44);
  expect(chrome.minWidth).toBeGreaterThanOrEqual(44);
  expect(chrome.height).toBeGreaterThanOrEqual(44);
  expect(chrome.width).toBeGreaterThanOrEqual(44);
  expect(chrome.outlineWidth).toBe('2px');
  expect(chrome.outlineStyle).toBe('solid');
  expect(chrome.outlineColor).toBe('rgb(180, 87, 0)');
  expect(chrome.context).toBe('public');
  expect(chrome.className).toContain('pj-button');
}

test('video play, pause and skip keep the shared button chrome at 1920, 1440 and 390', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto('/en');
    await dismissConsent(page);
    const frame = page.getByTestId('home-video');
    await tokenButton(page, 'Play video');
    await frame.getByRole('button', { name: 'Play video', exact: true }).click();
    await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'playing');
    await tokenButton(page, 'Pause video');
    await tokenButton(page, 'Skip video');
  }
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
