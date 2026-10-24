import { expect, test, type Page } from './fixtures';
import type { Route } from '@playwright/test';

const CITY_1384 = '/brand/packjoyu-industrial-city-v3-loop-1384.mp4';
const CITY_2000 = '/brand/packjoyu-industrial-city-v3-loop-2000.mp4';
const CITY_GIF = '/brand/packjoyu-industrial-city-v3-loop.gif';
const HERO_MP4S = ['/brand/video2-packjoyu-products-v3.mp4', '/brand/video2-packjoyu-products-web-720p60-v3.mp4'];
/** 361 frames across 30.080s. A pause may not move the playhead by a whole frame. */
const FRAME_S = 30.080 / 361;
const STILL_RATIO = 1384 / 720;
const VIDEO_RATIO = 16 / 9;

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  if (await bar.isVisible().catch(() => false)) {
    await bar.getByRole('button', { name: 'Reject all' }).click();
    await expect(bar).toBeHidden();
  }
}

function pathname(url: string) {
  return new URL(url).pathname;
}

function cityPaths(urls: string[]) {
  return urls.map(pathname).filter((path) => path === CITY_1384 || path === CITY_2000);
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
      return original.call(this);
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

test('pausing during a pending video start preserves pause and can resume', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const held: Route[] = [];
  // Hold the real media response so native play() is still pending when pause runs.
  const hold = (route: Route) => { held.push(route); };
  await page.route('**/*.mp4', hold);
  try {
    await page.goto('/en');
    await dismissConsent(page);
    const frame = page.getByTestId('home-video');
    await frame.getByRole('button', { name: 'Play video', exact: true }).click();
    const video = frame.locator('video');
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false);
    await frame.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
    await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'paused');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true);

    await frame.getByRole('button', { name: 'Play video', exact: true }).click();
    await page.unroute('**/*.mp4', hold);
    await Promise.all(held.splice(0).map((route) => route.continue().catch(() => undefined)));
    await expect(frame.locator('.hero-media')).toHaveAttribute('data-state', 'playing');
    await expect(video).toHaveAttribute('data-visible', '1');
  } finally {
    await Promise.all(held.map((route) => route.abort().catch(() => undefined)));
  }
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
    const video = el.querySelector('[data-testid="brand-scene-video"]') as HTMLVideoElement | null;
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewport: window.innerHeight,
      admitted: el.getAttribute('data-admitted'),
      inView: el.getAttribute('data-in-view'),
      state: el.getAttribute('data-state'),
      userPaused: el.getAttribute('data-user-paused'),
      pageVisible: el.getAttribute('data-page-visible'),
      video: el.querySelectorAll('[data-testid="brand-scene-video"]').length,
      revealed: video?.getAttribute('data-revealed') ?? '0',
      paused: video ? video.paused : true,
      currentTime: video?.currentTime ?? 0,
      src: video?.currentSrc ? new URL(video.currentSrc).pathname : '',
    };
  });
}

test('the city video may download within 300px and plays only while it intersects the viewport', async ({ page }) => {
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
  expect(cityPaths(requested)).toEqual([]);
  expect(requested.map(pathname).filter((path) => path === CITY_GIF)).toEqual([]);
  await expect(page.getByTestId('brand-scene-video')).toHaveCount(0);
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
  expect(parked.revealed).toBe('0');
  await expect.poll(() => cityPaths(requested).length, { timeout: 10_000 }).toBeGreaterThan(0);
  const heroAt = requested.findIndex((url) => HERO_MP4S.includes(pathname(url)));
  const cityAt = requested.findIndex((url) => cityPaths([url]).length > 0);
  expect(heroAt).toBeGreaterThanOrEqual(0);
  expect(cityAt).toBeGreaterThan(heroAt);
  const loaded = await sceneState(page);
  expect(loaded.video).toBe(1);
  expect(loaded.revealed).toBe('0');
  expect(loaded.paused).toBe(true);
  expect(loaded.src).toBe(CITY_1384);

  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-in-view', '1');
  await expect(scene).toHaveAttribute('data-state', 'playing');
  await expect(page.getByTestId('brand-scene-video')).toHaveAttribute('data-revealed', '1');

  await placeScene(page, 150);
  await expect(scene).toHaveAttribute('data-in-view', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  const leftView = await sceneState(page);
  expect(leftView.video).toBe(1);
  expect(leftView.paused).toBe(true);
  expect(leftView.revealed).toBe('1');
  expect(leftView.src).toBe(CITY_1384);
  const leftStill = await page.getByTestId('brand-scene-still').evaluate((el) => {
    const image = el as HTMLImageElement;
    return {
      currentSrc: new URL(image.currentSrc).pathname,
      attrWidth: Number(image.getAttribute('width')),
      attrHeight: Number(image.getAttribute('height')),
      ratio: image.naturalWidth / image.naturalHeight,
    };
  });
  // w 描述符下 naturalWidth 是 sizes 槽宽，不是文件像素。1440 仍应选 1384 的 WebP，属性保持 1384×720。
  expect(leftStill.currentSrc).toBe('/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp');
  expect(leftStill.attrWidth).toBe(1384);
  expect(leftStill.attrHeight).toBe(720);
  expect(Math.abs(leftStill.ratio - STILL_RATIO)).toBeLessThan(0.01);

  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  await expect(scene).toHaveAttribute('data-state', 'playing');
  await expect.poll(() => sceneState(page).then((state) => state.paused)).toBe(false);
  const resumed = await sceneState(page);
  expect(resumed.src).toBe(leftView.src);
  expect(resumed.currentTime).toBeGreaterThanOrEqual(leftView.currentTime);

  await scene.getByRole('button', { name: 'Pause illustration animation' }).click();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(scene).toHaveAttribute('data-state', 'still');
  await expect(scene.getByRole('button', { name: 'Play illustration animation' })).toHaveAttribute('aria-pressed', 'false');
  const userPaused = await sceneState(page);
  expect(userPaused.video).toBe(1);
  expect(userPaused.paused).toBe(true);
  expect(userPaused.revealed).toBe('1');
  expect(userPaused.src).toBe(CITY_1384);
  await placeScene(page, 360);
  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(scene).toHaveAttribute('data-state', 'still');
  const stillPaused = await sceneState(page);
  expect(stillPaused.video).toBe(1);
  expect(stillPaused.paused).toBe(true);
  expect(stillPaused.src).toBe(CITY_1384);
  expect(requested.map(pathname).filter((path) => path === CITY_GIF)).toEqual([]);
});

test('freeze and resume handlers preserve the city animation pause choice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const scene = page.getByTestId('brand-scene');
  await scene.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('brand-scene-video')).toHaveAttribute('data-revealed', '1');
  const playing = await sceneState(page);
  // Isolated handler coverage; genuine hidden/visible transitions require a separate native-browser acceptance run.
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect(scene).toHaveAttribute('data-page-visible', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  await expect(scene).toHaveAttribute('data-user-paused', '0');
  const frozen = await sceneState(page);
  expect(frozen.video).toBe(1);
  expect(frozen.paused).toBe(true);
  expect(frozen.revealed).toBe('1');
  expect(frozen.currentTime).toBeGreaterThanOrEqual(playing.currentTime);
  expect(frozen.src).toBe(playing.src);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(scene).toHaveAttribute('data-page-visible', '1');
  await expect(scene).toHaveAttribute('data-state', 'playing');
  await expect(page.getByTestId('brand-scene-video')).toHaveAttribute('data-revealed', '1');
  await expect.poll(() => sceneState(page).then((state) => state.paused)).toBe(false);
  await expect.poll(() => sceneState(page).then((state) => state.currentTime)).toBeGreaterThanOrEqual(frozen.currentTime);

  await scene.getByRole('button', { name: 'Pause illustration animation' }).click();
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  const held = await sceneState(page);
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  const frozenHeld = await sceneState(page);
  expect(frozenHeld.video).toBe(1);
  expect(frozenHeld.paused).toBe(true);
  expect(frozenHeld.currentTime).toBe(held.currentTime);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(scene).toHaveAttribute('data-page-visible', '1');
  await expect(scene).toHaveAttribute('data-user-paused', '1');
  await expect(scene).toHaveAttribute('data-state', 'still');
  const after = await sceneState(page);
  expect(after.video).toBe(1);
  expect(after.paused).toBe(true);
  expect(after.currentTime).toBe(held.currentTime);
  expect(after.src).toBe(held.src);
});

test('reduced motion does not start the city video until the visitor presses play inside the viewport', async ({ page }) => {
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
  expect(requested.filter((url) => pathname(url).endsWith('.mp4'))).toEqual([]);
  expect(cityPaths(requested)).toEqual([]);
  await expect(page.getByTestId('brand-scene-video')).toHaveCount(0);
  await scene.getByRole('button', { name: 'Play illustration animation' }).evaluate((el: HTMLButtonElement) => el.click());
  await expect(scene).toHaveAttribute('data-in-view', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  const armed = await sceneState(page);
  expect(armed.video).toBe(1);
  expect(armed.revealed).toBe('0');
  expect(armed.paused).toBe(true);
  await expect.poll(() => cityPaths(requested).length).toBeGreaterThan(0);
  await scene.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('brand-scene-video')).toHaveAttribute('data-revealed', '1');
  const playing = await sceneState(page);
  expect(playing.paused).toBe(false);
  expect(playing.src).toBe(CITY_1384);
  expect(requested.map(pathname).filter((path) => path === CITY_GIF)).toEqual([]);
});

test('a rejected city play() keeps the still and the Play button', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.play;
    HTMLVideoElement.prototype.play = function play(this: HTMLVideoElement, ...args: Parameters<typeof original>) {
      if (this.dataset.testid === 'brand-scene-video') return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      return original.apply(this, args);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const scene = page.getByTestId('brand-scene');
  await scene.scrollIntoViewIfNeeded();
  const play = scene.getByRole('button', { name: 'Play illustration animation' });
  await expect(play).toBeVisible();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(scene).toHaveAttribute('data-state', 'still');
  await expect(page.getByTestId('brand-scene-still')).toBeVisible();
  await expect(page.getByTestId('brand-scene-video')).toHaveAttribute('data-revealed', '0');
});

test('city video pauses within one frame and resumes from that playhead', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const scene = page.getByTestId('brand-scene');
  await scene.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('brand-scene-video')).toHaveAttribute('data-revealed', '1');
  await expect.poll(() => sceneState(page).then((state) => state.currentTime)).toBeGreaterThan(0.2);

  const buttonPause = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="brand-scene"]');
    const video = section?.querySelector('[data-testid="brand-scene-video"]') as HTMLVideoElement | null;
    const button = section?.querySelector('button') as HTMLButtonElement | null;
    if (!video || !button) throw new Error('city controls missing');
    const before = video.currentTime;
    button.click();
    return { before, after: video.currentTime, paused: video.paused, src: video.currentSrc };
  });
  expect(buttonPause.paused).toBe(true);
  expect(buttonPause.after - buttonPause.before).toBeLessThan(FRAME_S);
  expect(buttonPause.after).toBeGreaterThanOrEqual(buttonPause.before);
  await page.waitForTimeout(2000);
  const buttonHeld = await sceneState(page);
  expect(buttonHeld.currentTime).toBe(buttonPause.after);
  expect(buttonHeld.paused).toBe(true);
  expect(buttonHeld.src).toBe(CITY_1384);
  expect(buttonHeld.revealed).toBe('1');
  await scene.getByRole('button', { name: 'Play illustration animation' }).click();
  await expect.poll(() => sceneState(page).then((state) => state.currentTime)).toBeGreaterThan(buttonPause.after);
  const continuedSrc = await sceneState(page);
  expect(continuedSrc.src).toBe(pathname(buttonPause.src));
  expect(continuedSrc.paused).toBe(false);

  const hidden = await page.evaluate(() => {
    const video = document.querySelector('[data-testid="brand-scene-video"]') as HTMLVideoElement;
    const before = video.currentTime;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    return { before, after: video.currentTime, paused: video.paused, src: video.currentSrc, pageVisible: document.querySelector('[data-testid="brand-scene"]')?.getAttribute('data-page-visible') };
  });
  expect(hidden.pageVisible).toBe('0');
  expect(hidden.paused).toBe(true);
  expect(hidden.after - hidden.before).toBeLessThan(FRAME_S);
  expect(hidden.src).toBe(buttonPause.src);
  await page.waitForTimeout(2000);
  const hiddenHeld = await sceneState(page);
  expect(hiddenHeld.currentTime).toBe(hidden.after);
  expect(hiddenHeld.paused).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => sceneState(page).then((state) => state.currentTime)).toBeGreaterThan(hidden.after);

  const beforeLeave = await sceneState(page);
  await page.evaluate(() => {
    const video = document.querySelector('[data-testid="brand-scene-video"]') as HTMLVideoElement;
    const orig = video.pause.bind(video);
    const mark = window as Window & { __cityPauseAt?: number };
    mark.__cityPauseAt = -1;
    video.pause = () => {
      mark.__cityPauseAt = video.currentTime;
      orig();
    };
  });
  await placeScene(page, 150);
  await expect(scene).toHaveAttribute('data-in-view', '0');
  await expect(scene).toHaveAttribute('data-state', 'still');
  const left = await sceneState(page);
  expect(left.paused).toBe(true);
  expect(left.video).toBe(1);
  expect(left.revealed).toBe('1');
  expect(left.src).toBe(beforeLeave.src);
  expect(left.currentTime).toBeGreaterThanOrEqual(beforeLeave.currentTime);
  const pauseAt = await page.evaluate(() => (window as Window & { __cityPauseAt?: number }).__cityPauseAt ?? -1);
  expect(pauseAt).toBeGreaterThanOrEqual(0);
  expect(Math.abs(left.currentTime - pauseAt)).toBeLessThan(FRAME_S);
  await page.waitForTimeout(2000);
  const leftHeld = await sceneState(page);
  expect(leftHeld.currentTime).toBe(left.currentTime);
  expect(leftHeld.paused).toBe(true);
  await scene.scrollIntoViewIfNeeded();
  await expect.poll(() => sceneState(page).then((state) => state.currentTime)).toBeGreaterThan(left.currentTime);
  const returned = await sceneState(page);
  expect(returned.src).toBe(left.src);
  expect(returned.paused).toBe(false);
});

test('the city source chosen at 1440 stays put when the viewport grows to 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  const scene = page.getByTestId('brand-scene');
  await scene.scrollIntoViewIfNeeded();
  await expect.poll(() => sceneState(page).then((state) => state.src)).toBe(CITY_1384);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(() => sceneState(page).then((state) => state.src)).toBe(CITY_1384);
  const held = await sceneState(page);
  expect(held.video).toBe(1);
  expect(held.src).toBe(CITY_1384);
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
    await expect.poll(() => page.getByTestId('brand-scene-still').evaluate((el) => (el as HTMLImageElement).currentSrc)).not.toBe('');
    const still = await page.getByTestId('brand-scene-still').evaluate((el) => {
      const image = el as HTMLImageElement;
      const rect = image.getBoundingClientRect();
      const frame = image.parentElement!.getBoundingClientRect();
      return {
        attrWidth: Number(image.getAttribute('width')),
        attrHeight: Number(image.getAttribute('height')),
        currentSrc: new URL(image.currentSrc).pathname,
        loading: image.getAttribute('loading'),
        fetchPriority: image.getAttribute('fetchpriority'),
        fit: getComputedStyle(image).objectFit,
        ratio: image.naturalWidth / image.naturalHeight,
        inside: rect.left >= frame.left - 1 && rect.top >= frame.top - 1 && rect.right <= frame.right + 1 && rect.bottom <= frame.bottom + 1,
      };
    });
    // DPR 1：≥1489 的 sizes 槽宽超过 1384，选 2000w；1440 与 390 仍选 1384w。
    // w 描述符下 naturalWidth 跟着槽宽走，所以这里核 currentSrc、属性宽高和比例，不拿文件像素当 naturalWidth。
    const wide = viewport.width >= 1489;
    expect(still.currentSrc).toBe(wide
      ? '/brand/packjoyu-industrial-city-v3-loop-poster-2000.webp'
      : '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp');
    expect(still.attrWidth).toBe(1384);
    expect(still.attrHeight).toBe(720);
    expect(still.loading).toBe('lazy');
    expect(still.fetchPriority).toBeNull();
    expect(still.fit).toBe('contain');
    expect(still.inside).toBe(true);
    expect(Math.abs(still.ratio - STILL_RATIO)).toBeLessThan(0.01);

    const city = page.getByTestId('brand-scene-video');
    await expect(city).toHaveAttribute('data-revealed', '1');
    const played = await city.evaluate((el) => {
      const video = el as HTMLVideoElement;
      const stillImage = el.parentElement?.querySelector('[data-testid="brand-scene-still"]') as HTMLImageElement | null;
      const videoBox = video.getBoundingClientRect();
      const stillBox = stillImage?.getBoundingClientRect();
      const frame = el.parentElement?.getBoundingClientRect();
      const player = video as HTMLVideoElement & { disablePictureInPicture?: boolean; audioTracks?: { length: number } };
      return {
        src: video.currentSrc ? new URL(video.currentSrc).pathname : '',
        frameWidth: frame?.width ?? 0,
        dpr: window.devicePixelRatio,
        fit: getComputedStyle(video).objectFit,
        preload: video.getAttribute('preload'),
        poster: video.getAttribute('poster'),
        controls: video.hasAttribute('controls'),
        hidden: video.getAttribute('aria-hidden'),
        muted: video.muted,
        loop: video.loop,
        inline: video.playsInline,
        pip: player.disablePictureInPicture === true,
        remote: video.hasAttribute('disableremoteplayback'),
        opacity: getComputedStyle(video).opacity,
        audio: player.audioTracks?.length ?? 0,
        overlap: Boolean(stillBox) && Math.abs(videoBox.left - stillBox.left) < 1 && Math.abs(videoBox.top - stillBox.top) < 1 && Math.abs(videoBox.width - stillBox.width) < 1 && Math.abs(videoBox.height - stillBox.height) < 1,
      };
    });
    expect(played.dpr).toBe(1);
    expect(played.frameWidth * played.dpr > 1384).toBe(viewport.width === 1920);
    expect(played.src).toBe(viewport.width === 1920 ? CITY_2000 : CITY_1384);
    expect(played.fit).toBe('contain');
    expect(played.preload).toBe('none');
    expect(played.poster).toBeNull();
    expect(played.controls).toBe(false);
    expect(played.hidden).toBe('true');
    expect(played.muted).toBe(true);
    expect(played.loop).toBe(true);
    expect(played.inline).toBe(true);
    expect(played.pip).toBe(true);
    expect(played.remote).toBe(true);
    expect(played.opacity).toBe('1');
    expect(played.audio).toBe(0);
    expect(played.overlap).toBe(true);

    // 1920 铺满后品牌场景高于 1080 视口。scrollIntoViewIfNeeded 把区块中线对齐视口中线，
    // 吸顶页头会盖住画框上沿。重叠断言量的是版面是否压住导航和文案，不是滚动经过页头。
    // 只在画框顶进入吸顶页头时，把画框顶移到页头下沿再量。窄屏页头不吸顶，这里不动。
    await page.evaluate(() => {
      const header = document.querySelector('header.site');
      const frame = document.querySelector('.brand-scene-media');
      if (!header || !frame) return;
      if (getComputedStyle(header).position !== 'sticky') return;
      const limit = header.getBoundingClientRect().bottom;
      const top = frame.getBoundingClientRect().top;
      if (top >= limit) return;
      window.scrollBy({ top: top - limit, behavior: 'instant' });
    });

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
