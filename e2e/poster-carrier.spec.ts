import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures';
import type { Browser, Page } from '@playwright/test';

/**
 * M2-T6 组件级载体（不进入生产路由）：
 * 真实 ProductGallery + QuoteProvider + FloatingActions，只替换 next/dynamic、next-intl、
 * @/i18n/navigation 三个边界。用于「当前生产目录 12/12 产品都有 model、纯 poster 不可达」
 * 时验证组件的 no-model 输入能力。
 *
 * 边界（不冒称）：
 * - 这是组件测试，不是 Next 生产路由，也不是原 CSP 验证；CSP/生产构建证据属于
 *   `e2e/model-fallback.spec.ts` 的 standalone 运行。
 * - 适配器只覆盖本测试用到的调用形态，不宣称与 Next.js 全部语义等价。
 *
 * 负控 2 的判据按「纯 poster 卡片自己的状态/回调」计算（purePosterVerdict），
 * 不用「出现任意模型请求」——正控本来就会请求模型，那种 OR 条件会假阳性。
 */

const REPO = path.resolve(process.cwd());
const CARRIER = path.join(REPO, 'e2e', 'poster-carrier');
if (!existsSync(path.join(CARRIER, 'build.mjs'))) throw new Error(`run Playwright from the repository root (cwd=${REPO})`);
const ORIGIN = 'http://carrier.local';
const MEDIA_DIR = process.env.M2T6_CARRIER_MEDIA_DIR;
const EVIDENCE = process.env.M2T6_CARRIER_EVIDENCE;

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

type BuildMeta = {
  repo: { head: string; tree: string; status: string };
  builds: { role: string; js: { bytes: number }; css: { bytes: number } | null; ms: number; bundledModules: number; chain: Record<string, boolean> }[];
};

type Served = { path: string; status: number; bytes: number; sha256: string; count: number };
type Snapshot = {
  results: { slug: string; status: 'ready' | 'failed'; reason?: string }[] | null;
  model: { state: string | null; reason: string } | null;
  purePoster: { state: string | null; reason: string } | null;
  modelImg: { src: string | null; complete: boolean; naturalWidth: number; opacity: string; inlineOpacity: string; objectFit: string; width: number; height: number } | null;
  purePosterImg: { src: string | null; complete: boolean; naturalWidth: number; opacity: string; inlineOpacity: string; objectFit: string; width: number; height: number } | null;
  purePosterFallbacks: number;
  canvas: number;
  quoteBefore: string | null;
};
type Quote = {
  pressed: string | null;
  text: string | null;
  drawer: { title: string | null; items: (string | null)[] } | null;
  stored: string | null;
  drawer2: { title: string | null; items: (string | null)[] } | null;
  stored2: string | null;
};
type Run = { label: string; snapshot: Snapshot; quote: Quote | null; served: Served[]; misses: string[]; pageErrors: string[]; modelReady: boolean };

let tmpDir = '';
let meta: BuildMeta;

const MIME: Record<string, string> = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream', '.ktx2': 'application/octet-stream', '.json': 'application/json',
  '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
};
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>M2-T6 poster carrier</title></head><body><div id="root"></div></body></html>';

function publicFile(pathname: string): string | null {
  const root = path.resolve(REPO, 'public');
  const abs = path.resolve(root, decodeURIComponent(pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root + path.sep)) return null;
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

async function shot(page: Page, name: string) {
  if (!MEDIA_DIR) return;
  mkdirSync(MEDIA_DIR, { recursive: true });
  await page.screenshot({ path: path.join(MEDIA_DIR, name), fullPage: true });
}

async function runCarrier(browser: Browser, js: string, css: string, label: string, withQuote = false): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'en-US' });
  const page = await context.newPage();
  const served = new Map<string, Served>();
  const misses = new Set<string>();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String((e as Error)?.message ?? e)));
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
      }
      const file = publicFile(url.pathname);
      if (!file) {
        misses.add(url.pathname);
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      }
      const body = readFileSync(file);
      const prev = served.get(url.pathname);
      served.set(url.pathname, { path: url.pathname, status: 200, bytes: body.length, sha256: sha256(body), count: (prev?.count ?? 0) + 1 });
      return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', body });
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.addStyleTag({ content: readFileSync(path.join(tmpDir, css), 'utf8') });
    await page.addScriptTag({ content: readFileSync(path.join(tmpDir, js), 'utf8') });
    await page.waitForSelector('[data-testid="product-viewport"]', { timeout: 30_000 });
    await page.mouse.move(420, 300);

    let modelReady = false;
    try {
      await page.waitForFunction(
        () => document.querySelector('[data-slug="corrugated-boxes"]')?.getAttribute('data-model-state') === 'ready',
        undefined,
        { timeout: 90_000 },
      );
      modelReady = true;
      await page.waitForTimeout(800);
    } catch { /* 负控 1 预期拿不到 ready */ }

    const snapshot = await page.evaluate(() => {
      const vp = (slug: string) => {
        const el = document.querySelector(`[data-slug="${slug}"]`);
        return el ? { state: el.getAttribute('data-model-state'), reason: el.getAttribute('data-failure-reason') ?? '' } : null;
      };
      const img = (slug: string) => {
        const el = document.querySelector(`[data-slug="${slug}"] img`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          src: el.getAttribute('src'), complete: el.complete, naturalWidth: el.naturalWidth,
          opacity: cs.opacity, inlineOpacity: (el as HTMLElement).style.opacity, objectFit: cs.objectFit,
          width: Math.round(rect.width), height: Math.round(rect.height),
        };
      };
      return {
        results: window.__modelResults ?? null,
        model: vp('corrugated-boxes'),
        purePoster: vp('pure-poster'),
        modelImg: img('corrugated-boxes'),
        purePosterImg: img('pure-poster'),
        purePosterFallbacks: document.querySelectorAll('#pure-poster [data-testid="model-fallback"]').length,
        canvas: document.querySelectorAll('canvas').length,
        quoteBefore: (() => { try { return localStorage.getItem('pj-quote-v1'); } catch { return 'ERR'; } })(),
      };
    });

    let quote: Quote | null = null;
    if (withQuote) {
      await shot(page, 'carrier-main.png');
      const card = page.locator('#pure-poster');
      await card.getByRole('button', { name: 'Add to quote' }).click();
      const inQuote = card.getByRole('button', { name: /In quote/ });
      const pressed = await inQuote.getAttribute('aria-pressed');
      const text = (await inQuote.textContent())?.trim() ?? null;
      await inQuote.click();
      const drawerEl = page.locator('.drawer[role="dialog"]');
      await expect(drawerEl).toBeVisible({ timeout: 10_000 });
      const drawer = await page.evaluate(() => {
        const d = document.querySelector('.drawer');
        return {
          title: d?.querySelector('header strong')?.textContent?.trim() ?? null,
          items: d ? [...d.querySelectorAll('li')].map((li) => li.querySelector('span')?.textContent?.trim() ?? null) : [],
        };
      });
      const stored = await page.evaluate(() => { try { return localStorage.getItem('pj-quote-v1'); } catch { return 'ERR'; } });
      await shot(page, 'carrier-quote-panel.png');
      await drawerEl.getByRole('button', { name: 'Close' }).click();
      await page.locator('#corrugated-boxes').getByRole('button', { name: 'Add to quote' }).click();
      await page.locator('.fab button[aria-label^="Quote list"]').first().click();
      await expect(drawerEl).toBeVisible({ timeout: 10_000 });
      const drawer2 = await page.evaluate(() => {
        const d = document.querySelector('.drawer');
        return {
          title: d?.querySelector('header strong')?.textContent?.trim() ?? null,
          items: d ? [...d.querySelectorAll('li')].map((li) => li.querySelector('span')?.textContent?.trim() ?? null) : [],
        };
      });
      const stored2 = await page.evaluate(() => { try { return localStorage.getItem('pj-quote-v1'); } catch { return 'ERR'; } });
      quote = { pressed, text, drawer, stored, drawer2, stored2 };
    }

    return { label, snapshot, quote, served: [...served.values()].sort((a, b) => a.path.localeCompare(b.path)), misses: [...misses], pageErrors, modelReady };
  } finally {
    await context.close();
  }
}

type Verdict = { pass: boolean; failures: string[] };

/** 纯 poster 自己的状态/回调判据（负控 2 修的就是这里：不看“任意模型请求”）。 */
function purePosterVerdict(run: Run): Verdict {
  const failures: string[] = [];
  const state = run.snapshot.purePoster?.state;
  if (state !== 'pending') failures.push(`state:${state}`);
  if (run.snapshot.purePoster?.reason) failures.push(`reason:${run.snapshot.purePoster.reason}`);
  if (run.snapshot.purePosterFallbacks !== 0) failures.push(`fallback:${run.snapshot.purePosterFallbacks}`);
  const results = (run.snapshot.results ?? []).filter((r) => r?.slug === 'pure-poster');
  if (results.length) failures.push(`modelResults:${results.map((r) => r.status).join(',')}`);
  const img = run.snapshot.purePosterImg;
  if (!img?.complete || img.naturalWidth <= 0) failures.push('decode');
  if (img?.opacity !== '1') failures.push(`opacity:${img?.opacity}`);
  return { pass: failures.length === 0, failures };
}

/** 真实模型正控的判据（负控 1 使其失败）。 */
function modelVerdict(run: Run): Verdict {
  const failures: string[] = [];
  if (run.snapshot.model?.state !== 'ready') failures.push(`state:${run.snapshot.model?.state}`);
  const ready = (run.snapshot.results ?? []).filter((r) => r?.slug === 'corrugated-boxes' && r.status === 'ready');
  if (ready.length !== 1) failures.push(`readyResults:${ready.length}`);
  if (run.snapshot.canvas < 1) failures.push('canvas:0');
  return { pass: failures.length === 0, failures };
}

test.beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'm2t6-poster-carrier-'));
  execFileSync(process.execPath, [path.join(CARRIER, 'build.mjs'), tmpDir], { cwd: REPO, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  meta = JSON.parse(readFileSync(path.join(tmpDir, 'build-meta.json'), 'utf8')) as BuildMeta;
});

test.afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('M2-T6 组件载体：纯 poster 能力、真实模型链、询盘与两组负控', async ({ browser }) => {
  test.setTimeout(300_000);
  const main = await runCarrier(browser, 'bundle.js', 'bundle.css', 'main', true);
  const negStub = await runCarrier(browser, 'bundle-neg-stub.js', 'bundle-neg-stub.css', 'negative-stub');
  const negModel = await runCarrier(browser, 'bundle-neg-model.js', 'bundle-neg-model.css', 'negative-model');

  const expected = {
    poster: sha256(readFileSync(path.join(REPO, 'public/images/posters/custom-color-boxes.8f12372d.webp'))),
    modelPoster: sha256(readFileSync(path.join(REPO, 'public/images/posters/custom-corrugated-boxes.5f405542.webp'))),
    glb: sha256(readFileSync(path.join(REPO, 'public/models/corrugated-box.anim.0d57c36a.glb'))),
  };

  // 构建链：真实 dynamic 必须把 GalleryScene/ProductModel/three/drei/progressive 打进同一个 bundle
  const mainBuild = meta.builds.find((b) => b.role === 'main')!;
  expect(mainBuild.chain).toEqual({ galleryScene: true, productModel: true, three: true, drei: true, needleProgressive: true });
  expect(mainBuild.bundledModules).toBeGreaterThan(100);

  // 正控：真实模型
  expect(modelVerdict(main).failures).toEqual([]);
  expect(main.modelReady).toBe(true);
  const glb = main.served.find((s) => s.path === '/models/corrugated-box.anim.0d57c36a.glb');
  expect(glb).toMatchObject({ status: 200, sha256: expected.glb });
  const modelPoster = main.served.filter((s) => s.path.includes('custom-corrugated-boxes'));
  expect(modelPoster.length).toBeGreaterThan(0);
  for (const s of modelPoster) expect(s.sha256).toBe(expected.modelPoster);
  expect(Number(main.snapshot.modelImg?.opacity ?? 1)).toBeLessThan(0.05);

  // 纯 poster：同一组“自己的状态/回调/海报”断言
  expect(purePosterVerdict(main).failures).toEqual([]);
  const poster = main.served.filter((s) => s.path.includes('custom-color-boxes'));
  expect(poster.length).toBeGreaterThan(0);
  for (const s of poster) {
    expect(s.status).toBe(200);
    expect(s.sha256).toBe(expected.poster);
  }
  expect(main.snapshot.purePosterImg).toMatchObject({ complete: true, objectFit: 'contain' });
  expect(main.snapshot.purePosterImg!.naturalWidth).toBeGreaterThan(0);
  expect(main.snapshot.purePosterImg!.width).toBeGreaterThan(100);
  expect(main.snapshot.purePosterImg!.height).toBeGreaterThan(100);
  const modelRequests = main.served.filter((s) => s.path.startsWith('/models/'));
  expect(modelRequests.length).toBeGreaterThan(0);
  expect(modelRequests.every((s) => s.path.includes('corrugated-box.anim.0d57c36a'))).toBe(true);
  expect(main.pageErrors).toEqual([]);

  // 真实询盘：点击路径 + Provider 写入 + 面板归属（不注入 localStorage）
  expect(main.snapshot.quoteBefore === null || main.snapshot.quoteBefore === '[]').toBe(true);
  expect(main.quote).not.toBeNull();
  expect(main.quote!.pressed).toBe('true');
  expect(main.quote!.text).toBe('In quote ✓');
  expect(main.quote!.drawer?.title).toBe('Quote list (1)');
  expect(main.quote!.drawer?.items).toEqual(['pure-poster']);
  expect(main.quote!.stored).toBe('[{"slug":"pure-poster"}]');
  expect(main.quote!.drawer2?.title).toBe('Quote list (2)');
  expect(main.quote!.drawer2?.items).toContain('Corrugated Boxes');
  expect(main.quote!.stored2).toBe('[{"slug":"pure-poster"},{"slug":"corrugated-boxes"}]');

  // 负控 1：空 dynamic 替身 → 真实模型链不可达，同一 modelVerdict 必须失败
  const negStubVerdict = modelVerdict(negStub);
  expect(negStubVerdict.pass).toBe(false);
  expect(negStubVerdict.failures.some((f) => f.startsWith('state:'))).toBe(true);
  expect(negStub.served.filter((s) => s.path.startsWith('/models/'))).toEqual([]);
  expect(negStub.snapshot.canvas).toBe(0);
  expect(negStub.snapshot.results).toEqual([]);

  // 负控 2：给纯 poster 塞 GLB → 同一 purePosterVerdict 必须因它自己的 state/result 失败；
  // 不依赖“出现模型请求”（正控本来就有请求，那种判据会假阳性）。
  const negModelVerdict = purePosterVerdict(negModel);
  expect(negModelVerdict.pass).toBe(false);
  expect(negModelVerdict.failures.some((f) => f === 'state:ready' || f.startsWith('modelResults:'))).toBe(true);
  expect(negModelVerdict.failures).toContain('state:ready');

  if (EVIDENCE) {
    mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify({
      head: meta.repo.head, tree: meta.repo.tree, builds: meta.builds,
      main: { verdict: purePosterVerdict(main), modelVerdict: modelVerdict(main), snapshot: main.snapshot, quote: main.quote, served: main.served, misses: main.misses, pageErrors: main.pageErrors },
      negStub: { verdict: modelVerdict(negStub), snapshot: negStub.snapshot, served: negStub.served, misses: negStub.misses },
      negModel: { verdict: purePosterVerdict(negModel), snapshot: negModel.snapshot, served: negModel.served, misses: negModel.misses },
    }, null, 2)}\n`);
  }
});
