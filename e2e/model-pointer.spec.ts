import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { assertModelPointerContract } from '../src/lib/three/model-pointer';

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  const appeared = await bar.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true, () => false);
  if (!appeared) return;
  await bar.getByRole('button', { name: 'Reject all' }).click();
  await expect(bar).toBeHidden();
}

async function openProducts(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const viewport = page.getByTestId('product-viewport').first();
  await expect(viewport.locator('.hint')).toHaveText('Drag to rotate', { timeout: 25_000 });
  await expect(viewport).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  return viewport;
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('viewport has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.beforeEach(async ({ page }) => {
  // 本地 next dev 的热更新要 eval，而站点 CSP 不含 unsafe-eval，客户端不会水合。
  // CI 用生产构建，不设这个变量，CSP 保持原样。
  if (process.env.E2E_RELAX_CSP !== '1') return;
  const client = await page.context().newCDPSession(page);
  await client.send('Page.setBypassCSP', { enabled: true });
});

test('legacy hover zoom fails the wheel contract and the focused policy passes', () => {
  assertModelPointerContract();
});

test('pointer capture, page wheel, modifier zoom, and release', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await openProducts(page);
  const second = page.getByTestId('product-viewport').nth(1);
  await expect(second).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  await expect(page.locator('[data-direct-rotate]')).toHaveAttribute('data-direct-rotate', '1');
  // 同一阶段的两条非重试 getAttribute 合并为一次页内读取：选择器与 `getByTestId('product-viewport')`
  // 相同（默认 data-testid、主文档、文档顺序），不跨用户动作/帧窗口，断言仍是原来的严格比较。
  const [slugA, slugB] = await page.evaluate(() => {
    const views = document.querySelectorAll('[data-testid="product-viewport"]');
    return [views[0]?.getAttribute('data-slug') ?? null, views[1]?.getAttribute('data-slug') ?? null];
  });
  expect(slugA && slugB && slugA !== slugB).toBe(true);

  const card = page.locator('article.card').first();
  const scale = await card.evaluate((el) => ({
    card: getComputedStyle(el).transform,
    stage: getComputedStyle(el.querySelector('[data-testid="product-viewport"]')!).transform,
  }));
  expect(scale.card === 'none' || scale.card.startsWith('matrix(1, 0, 0, 1')).toBe(true);
  expect(scale.stage === 'none' || scale.stage.startsWith('matrix(1, 0, 0, 1')).toBe(true);

  const distanceBeforeHover = await first.getAttribute('data-camera-distance');
  await first.hover();
  const hoverHeld = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-camera-distance');
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (el.getAttribute('data-camera-distance') !== start) return false;
    }
    return true;
  });
  expect(hoverHeld).toBe(true);
  expect(await first.getAttribute('data-camera-distance')).toBe(distanceBeforeHover);
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');

  const [azimuthA, azimuthB] = await page.evaluate(() => {
    const views = document.querySelectorAll('[data-testid="product-viewport"]');
    return [views[0]?.getAttribute('data-azimuth') ?? null, views[1]?.getAttribute('data-azimuth') ?? null];
  });
  const start = await center(first);
  const other = await center(second);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugA!);
  // steps 4→2：4e trace 里该拖动已从 19,005 ms 降到 7,495 ms，但整例仍超 90s 预算约 2.8s；
  // 中间步只影响采样密度，终点仍是第二张卡中心，捕获与所有断言不变。
  await page.mouse.move(other.x, other.y, { steps: 2 });
  // 减采样后仍须证明跨卡移动没有丢 capture owner：移动后、mouseup 前 owner 仍是 A。
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugA!);
  await expect(first).not.toHaveAttribute('data-azimuth', azimuthA!);
  await expect(second).toHaveAttribute('data-azimuth', azimuthB!);
  await expect(page).toHaveURL(/\/en\/products$/);
  await expect(first).not.toHaveClass(/\bactive\b/);
  const locked = await page.evaluate(() => ({
    body: document.body.style.overflow,
    touch: getComputedStyle(document.querySelector('[data-testid="product-viewport"]')!).touchAction,
  }));
  expect(locked.body).not.toBe('hidden');
  expect(locked.touch).toContain('pan-y');
  await page.mouse.up();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');

  await page.evaluate(() => window.scrollTo(0, 0));
  const plainDistance = await first.getAttribute('data-camera-distance');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const back = await center(first);
  await page.mouse.move(back.x, back.y);
  await page.mouse.wheel(0, 480);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);
  await expect(first).toHaveAttribute('data-camera-distance', plainDistance!);

  await page.evaluate(() => window.scrollTo(0, 0));
  const cardB = page.locator('article.card').nth(1);
  const beforeButton = await second.getAttribute('data-camera-distance');
  await cardB.getByTestId('model-zoom-in').click();
  await expect(second).not.toHaveAttribute('data-camera-distance', beforeButton!);
  const minDistance = Number(await second.getAttribute('data-min-distance'));
  for (let step = 0; step < 18; step += 1) await cardB.getByTestId('model-zoom-in').click();
  const clamped = Number(await second.getAttribute('data-camera-distance'));
  expect(Math.abs(clamped - minDistance)).toBeLessThan(0.05);

  await first.focus();
  await expect(first).toHaveAttribute('data-focused', '1');
  const focusedDistance = Number(await first.getAttribute('data-camera-distance'));
  const scrollAtFocus = await page.evaluate(() => window.scrollY);
  await page.keyboard.down('Control');
  const focusedPoint = await center(first);
  await page.mouse.move(focusedPoint.x, focusedPoint.y);
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect.poll(async () => Number(await first.getAttribute('data-camera-distance'))).not.toBe(focusedDistance);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollAtFocus);

  await page.keyboard.press('Escape');
  await expect(first).toHaveAttribute('data-focused', '0');
  await expect(page.locator('[data-focused-model]')).toHaveAttribute('data-focused-model', '');
  const afterEscape = await first.getAttribute('data-camera-distance');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect(first).toHaveAttribute('data-camera-distance', afterEscape!);

  const again = await center(first);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugA!);
  await first.dispatchEvent('pointercancel');
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');
  await page.mouse.up();

  await second.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(second).toHaveAttribute('data-focused', '0');
  const next = await center(second);
  await page.mouse.move(next.x, next.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugB!);
  await page.mouse.up();

  await page.locator('[data-testid="home-link"]:visible').first().click();
  await expect(page).toHaveURL(/\/en$/);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const returned = page.getByTestId('product-viewport').nth(1);
  await expect(returned).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  const returnedSlug = await returned.getAttribute('data-slug');
  const point = await center(returned);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', returnedSlug!);
  await page.mouse.up();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');
});

/**
 * 在有限帧窗口内持续观察某属性不变，避免「异步事件尚未应用时读到旧值」的误判。
 * 用法：调用前记录基线，wheel 之后等待处理完成，再持续若干帧确认仍等于基线。
 */
async function expectStable(locator: Locator, attribute: string, baseline: string, label: string) {
  // 先等两帧，让 wheel 事件的默认处理与 React 更新落地。
  await locator.evaluate(async (el) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  for (let i = 0; i < 6; i += 1) {
    await locator.evaluate(
      (el) => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    await expect(locator, `${label} 第 ${i + 1} 帧`).toHaveAttribute(attribute, baseline);
  }
}

test('E-98 准入域限定在本模型视口与命名工具条，标题与说明不缩放', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await openProducts(page);
  // openProducts 已等到 data-framed=1，此时 publishCamera 已写过距离。
  await expect(first).toHaveAttribute('data-camera-distance', /^\d+\.\d+$/);

  // 第二张卡也必须就绪后再用它的距离做基线，不能把 TS 非空断言当就绪证据。
  const secondViewport = page.locator('article.card').nth(1).getByTestId('product-viewport');
  await expect(secondViewport).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  await expect(secondViewport).toHaveAttribute('data-camera-distance', /^\d+\.\d+$/);

  // 1) 焦点在本模型视口、指针在本模型命名工具条的按钮上 → 应缩放本模型。
  await first.focus();
  await expect(first).toHaveAttribute('data-focused', '1');
  const beforeToolbar = await first.getAttribute('data-camera-distance');
  const zoomIn = page.locator('article.card').first().getByTestId('model-zoom-in');
  const zoomBox = await zoomIn.boundingBox();
  if (!zoomBox) throw new Error('zoom button has no box');
  await page.mouse.move(zoomBox.x + zoomBox.width / 2, zoomBox.y + zoomBox.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect
    .poll(async () => Number(await first.getAttribute('data-camera-distance')))
    .not.toBe(Number(beforeToolbar));

  // 2) 焦点仍在本模型、指针移到本模型标题 → 处理完成后持续不缩放。
  const titleBaseline = (await first.getAttribute('data-camera-distance'))!;
  const titleBox = await page.locator('article.card').first().locator('h2').boundingBox();
  if (!titleBox) throw new Error('title has no box');
  await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expectStable(first, 'data-camera-distance', titleBaseline, '标题命中');

  // 3) 指针移到本模型说明正文 → 同样持续不缩放（复核指出的未覆盖点）。
  // 不用条件分支：第一张卡是 corrugated-boxes，locale 文案里必有 desc。
  // 若将来正文缺失，这里直接失败，而不是静默跳过本场景。
  const desc = page.locator('article.card').first().locator('p.desc');
  await expect(desc, '正文必须存在').toHaveCount(1);
  await expect(desc, '正文必须可见').toBeVisible();
  await expect(desc, '正文必须有非空文本').not.toHaveText(/^\s*$/);
  const descBaseline = (await first.getAttribute('data-camera-distance'))!;
  const descBox = await desc.boundingBox();
  if (!descBox) throw new Error('正文有可见文本却没有布局盒');
  // 命中前确认该点确实落在正文元素上，避免摸到别的元素还以为测了正文。
  const descHit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return { tag: el?.tagName ?? null, isDesc: !!el?.closest('p.desc') };
    },
    { x: descBox.x + descBox.width / 2, y: descBox.y + descBox.height / 2 },
  );
  expect(descHit.isDesc, `指针应命中正文，实际命中 ${descHit.tag}`).toBe(true);
  await page.mouse.move(descBox.x + descBox.width / 2, descBox.y + descBox.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expectStable(first, 'data-camera-distance', descBaseline, '说明正文命中');

  // 4) 焦点在本模型、指针移到另一模型的视口 → 两个模型处理完成后都不变。
  const crossFirst = (await first.getAttribute('data-camera-distance'))!;
  const crossSecond = (await secondViewport.getAttribute('data-camera-distance'))!;
  const secondBox = await secondViewport.boundingBox();
  if (!secondBox) throw new Error('second viewport has no box');
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expectStable(first, 'data-camera-distance', crossFirst, '跨模型：本模型');
  await expectStable(secondViewport, 'data-camera-distance', crossSecond, '跨模型：另一模型');
});

test('E-98 退出后遗留 DOM 焦点不得重新接管修饰滚轮', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await openProducts(page);
  await expect(first).toHaveAttribute('data-camera-distance', /^\d+\.\d+$/);

  // 基线：先证明同模型焦点 + 命中确实能缩放，避免把「一直不缩放」误判成退出生效。
  await first.focus();
  await expect(first).toHaveAttribute('data-focused', '1');
  const working = await first.getAttribute('data-camera-distance');
  await page.keyboard.down('Control');
  const center1 = await center(first);
  await page.mouse.move(center1.x, center1.y);
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect
    .poll(async () => Number(await first.getAttribute('data-camera-distance')))
    .not.toBe(Number(working));

  // 场景 A：pointercancel 后 DOM 焦点仍在视口，不重新聚焦、不重新按下，直接修饰滚轮。
  await first.dispatchEvent('pointercancel');
  await expect(first).toHaveAttribute('data-focused', '0');
  const afterCancel = (await first.getAttribute('data-camera-distance'))!;
  await page.keyboard.down('Control');
  await page.mouse.move(center1.x, center1.y);
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expectStable(first, 'data-camera-distance', afterCancel, '取消后直接 wheel');

  // 场景 B：窗口失焦后 DOM 焦点保留，直接修饰滚轮。
  // 上一场景的 pointercancel 已让视口失焦，先经一次主动重入把焦点放回，再测失焦。
  const refocusPoint = await center(first);
  await page.mouse.move(refocusPoint.x, refocusPoint.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(first).toHaveAttribute('data-focused', '1');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(first).toHaveAttribute('data-focused', '0');
  const afterBlur = (await first.getAttribute('data-camera-distance'))!;
  await page.keyboard.down('Control');
  await page.mouse.move(center1.x, center1.y);
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expectStable(first, 'data-camera-distance', afterBlur, '失焦后直接 wheel');

  // 场景 C：主动重入 —— 重新按下取得交互后，修饰滚轮必须恢复工作。
  const reentry = await center(first);
  await page.mouse.move(reentry.x, reentry.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).not.toHaveAttribute('data-capture-owner', '');
  await page.mouse.up();
  const afterReentry = (await first.getAttribute('data-camera-distance'))!;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect
    .poll(async () => Number(await first.getAttribute('data-camera-distance')))
    .not.toBe(Number(afterReentry));

  // 场景 D：再次退出后，明确 Zoom 按钮仍可用（不能沿用 C 的重入状态当退出前提）。
  await page.keyboard.press('Escape');
  await expect(first, 'Escape 后必须释放焦点').toHaveAttribute('data-focused', '0');
  await expect(page.locator('[data-capture-owner]'), 'Escape 后必须释放归属').toHaveAttribute(
    'data-capture-owner',
    '',
  );
  // 本用例只观察退出后相机距离不变。
  // 源码的准入失败分支在调用 preventDefault 之前 return；但本用例不读取 event.defaultPrevented，
  // 也不验证浏览器默认动作（如页缩放）是否被其他处理器取消或实际执行，那些另以事件/运行证据确认。
  const afterEscapeD = (await first.getAttribute('data-camera-distance'))!;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expectStable(first, 'data-camera-distance', afterEscapeD, '退出后相机保持不变');
  // 再点明确 Zoom 按钮：它不经过许可判定，退出状态下必须仍能改变相机。
  await page.locator('article.card').first().getByTestId('model-zoom-in').click();
  await expect
    .poll(async () => Number(await first.getAttribute('data-camera-distance')))
    .not.toBe(Number(afterEscapeD));
});

test('hover pauses spin and a user pause survives hide and foreground', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const first = await openProducts(page);
  await expect(first).toHaveAttribute('data-spinning', '1');
  // 三处 paused/spinning 合并为一次真实快照 + poll：仍用全局 7s 重试窗，且要求同阶段同时满足（比逐条更强）。
  // 读取改在同一页内直接取 `[data-testid="product-viewport"]` 首个节点，与 `getByTestId(...).first()` 同一元素
  // （默认 data-testid、主文档、文档顺序）；4e trace 里 poll 首个动作仅 locator 解析就花 6,416 ms，
  // 几乎吃满 7s 窗，故不再在窗内反复解析 locator。节点缺失返回 null（断言失败），无任何 fallback；
  // 失败时只回放本次 poll 缓存到的快照与耗时，不另发一次 CDP 读取去掩盖原时点。
  let lastPausedSnapshot: { paused: string | null; spinning: string | null } | null = null;
  const expectPaused = async (stage: string) => {
    const startedAt = Date.now();
    try {
      await expect
        .poll(
          async () => {
            lastPausedSnapshot = await page.evaluate(() => {
              const el = document.querySelectorAll('[data-testid="product-viewport"]')[0];
              if (!el) return null;
              return { paused: el.getAttribute('data-user-paused'), spinning: el.getAttribute('data-spinning') };
            });
            return lastPausedSnapshot;
          },
          { timeout: 7_000 },
        )
        .toEqual({ paused: '1', spinning: '0' });
    } catch (error) {
      console.log(
        `[M5-T10][model345] stage=paused:${stage}:fail elapsed=${Date.now() - startedAt}ms snapshot=${JSON.stringify(lastPausedSnapshot)}`,
      );
      throw error;
    }
  };
  console.log('[M5-T10][model345] stage=moved:start');
  const moved = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-azimuth');
    const t0 = performance.now();
    let frames = 0;
    while (performance.now() - t0 < 500) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      frames += 1;
      if (el.getAttribute('data-azimuth') !== start) return { moved: true, frames, elapsed: Math.round(performance.now() - t0) };
    }
    return { moved: false, frames, elapsed: Math.round(performance.now() - t0) };
  });
  console.log(`[M5-T10][model345] stage=moved:done ${JSON.stringify(moved)}`);
  expect(moved.moved).toBe(true);

  // 指针进入用真实几何坐标：hover() 的 actionability 重试与“指针进入即暂停”无关；
  // 命中与覆盖关系仍由 data-spinning 的结果断言把关。滚动与取点合并为一次页内计算：
  // 只在需要时滚动，等矩形稳定且完全可见后才返回非零可达框，不依赖未完成的平滑滚动坐标。
  const enter = await first.evaluate(async (el) => {
    const fullyVisible = () => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
        && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
    };
    if (!fullyVisible()) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    let previous = '';
    let stable = 0;
    for (let i = 0; i < 60 && stable < 2; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      const r = el.getBoundingClientRect();
      const key = [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(',');
      stable = key === previous ? stable + 1 : 0;
      previous = key;
    }
    const box = el.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (!(box.width > 0 && box.height > 0)) throw new Error('模型视口没有非零可达框');
    if (!(x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight)) throw new Error('模型中心不在视口内');
    return { x, y };
  });
  await page.mouse.move(enter.x, enter.y);
  await expect(first).toHaveAttribute('data-spinning', '0');
  console.log('[M5-T10][model345] stage=held:start');
  const held = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-azimuth');
    const t0 = performance.now();
    let frames = 0;
    while (performance.now() - t0 < 300) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      frames += 1;
      if (el.getAttribute('data-azimuth') !== start) return { held: false, frames, elapsed: Math.round(performance.now() - t0) };
    }
    return { held: true, frames, elapsed: Math.round(performance.now() - t0) };
  });
  console.log(`[M5-T10][model345] stage=held:done ${JSON.stringify(held)}`);
  expect(held.held).toBe(true);

  // 离开模型同样用真实坐标；若指针仍落在模型上，恢复自转会失败。
  const title = await center(page.locator('h1'));
  await page.mouse.move(title.x, title.y);
  await expect(first).toHaveAttribute('data-spinning', '1');
  // 暂停按钮在离开 hover 后再取点：没有源码/CSS 证据表明离开 hover 不改变按钮布局，保留这次必需的新读。
  const pauseButton = page.locator('article.card').first().getByTestId('model-pause-rotation');
  const pausePoint = await center(pauseButton);
  await page.mouse.click(pausePoint.x, pausePoint.y);
  await expectPaused('after-pause-click');

  await page.mouse.move(8, 8);
  await page.mouse.wheel(0, 2400);
  await expect(first).not.toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(first).toBeInViewport();
  await expectPaused('after-scroll-back');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(first).toHaveAttribute('data-spinning', '0');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expectPaused('after-foreground');
  console.log('[M5-T10][model345] stage=still:start');
  const still = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-azimuth');
    const t0 = performance.now();
    let frames = 0;
    while (performance.now() - t0 < 300) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      frames += 1;
      if (el.getAttribute('data-azimuth') !== start) return { paused: false, frames, elapsed: Math.round(performance.now() - t0) };
    }
    return { paused: el.getAttribute('data-user-paused') === '1', frames, elapsed: Math.round(performance.now() - t0) };
  });
  console.log(`[M5-T10][model345] stage=still:done ${JSON.stringify(still)}`);
  expect(still.paused).toBe(true);
  console.log(`[M5-T10][model345] moved=${JSON.stringify(moved)} held=${JSON.stringify(held)} still=${JSON.stringify(still)}`);
});
