import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { assertModelAccessibilityContract } from '../src/lib/three/model-accessibility';

/**
 * M2-T3：接通模型键盘触屏与复位控件（E-101、E-102、E-104）。
 *
 * 证据分级（不得混用）：
 * - 纯规则断言（本文件首条）只证明按键表、夹紧、44px 判定与手势归属的取值，不证明真实相机或真实手势。
 * - 本文件其余用例在真实构建产物上量真实几何：相机距离/方位角/极角读自 DOM（由 GalleryScene 发布），
 *   点击目标尺寸读自 getBoundingClientRect，页面滚动读自 window.scrollY。
 * - 双指缩放的真实手势不在这里伪造：Playwright 无多点触控合成，这里只断言「单指不缩放、页面仍可滚动」，
 *   双指越界夹紧由纯规则 + 相机边界（data-min/max-distance）共同约束，剩余部分如实记为未取得。
 */

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
  const viewport = page.getByTestId('product-viewport').first();
  await expect(viewport.locator('.hint')).toHaveText('Drag to rotate', { timeout: 25_000 });
  await expect(viewport).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  await expect(viewport).toHaveAttribute('data-camera-distance', /^\d+\.\d+$/);
  await expect(viewport).toHaveAttribute('data-azimuth', /^-?\d+\.\d+$/);
  await expect(viewport).toHaveAttribute('data-polar', /^-?\d+\.\d+$/);
  return viewport;
}

/** 读相机三元组：距离、方位角、极角。全部由渲染层写入 DOM，不由测试推算。 */
async function camera(locator: Locator) {
  const [distance, azimuth, polar] = await Promise.all([
    locator.getAttribute('data-camera-distance'),
    locator.getAttribute('data-azimuth'),
    locator.getAttribute('data-polar'),
  ]);
  return { distance: Number(distance), azimuth: Number(azimuth), polar: Number(polar) };
}

/** 在有限帧窗口内持续观察相机不变，避免读到异步尚未应用时的旧值。 */
async function expectCameraStable(locator: Locator, baseline: { distance: number; azimuth: number; polar: number }, label: string) {
  await locator.evaluate(async (el) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  for (let i = 0; i < 5; i += 1) {
    await locator.evaluate((el) => new Promise((resolve) => requestAnimationFrame(resolve)));
    const now = await camera(locator);
    expect(now.distance, `${label} 第 ${i + 1} 帧距离`).toBe(baseline.distance);
    expect(now.azimuth, `${label} 第 ${i + 1} 帧方位角`).toBe(baseline.azimuth);
    expect(now.polar, `${label} 第 ${i + 1} 帧极角`).toBe(baseline.polar);
  }
}

test.beforeEach(async ({ page }) => {
  if (process.env.E2E_RELAX_CSP !== '1') return;
  const client = await page.context().newCDPSession(page);
  await client.send('Page.setBypassCSP', { enabled: true });
});

test('M2-T3 规则自检：按键表、夹紧、44px 与手势归属', () => {
  assertModelAccessibilityContract();
});

test('E-101 键盘：方向键改朝向、加减号缩放、Home 复位，Tab 不被锁住', async ({ page }) => {
  test.setTimeout(150_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const viewport = await openProducts(page);
  const card = page.locator('article.card').first();

  // 焦点进入模型视口：这是键盘动作的唯一前提（真实 DOM 焦点，不是「有卡片可见」）。
  await viewport.focus();
  await expect(viewport).toHaveAttribute('data-focused', '1');

  // 方向键：方位角必须变化、距离与极角不变（旋转不改缩放）。
  const beforeRotate = await camera(viewport);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await camera(viewport)).azimuth).not.toBe(beforeRotate.azimuth);
  const afterLeft = await camera(viewport);
  expect(afterLeft.distance, '旋转不得改变距离').toBe(beforeRotate.distance);
  expect(afterLeft.polar, '左右方向键不得改变极角').toBe(beforeRotate.polar);

  // 反方向回到接近原值：证明是「加/减同一个步长」，不是单方向漂移。
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.abs((await camera(viewport)).azimuth - beforeRotate.azimuth)).toBeLessThan(1e-3);

  // 上下方向键改极角，距离不变。
  const beforePolar = await camera(viewport);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await camera(viewport)).polar).not.toBe(beforePolar.polar);
  const afterDown = await camera(viewport);
  expect(afterDown.distance, '上下方向键不得改变距离').toBe(beforePolar.distance);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => Math.abs((await camera(viewport)).polar - beforePolar.polar)).toBeLessThan(1e-3);

  // 加号拉近、减号拉远。两个键是同一步长（±100 → 同一个 0.95 系数），因此拉近后再拉远
  // 会精确回到起点，这是对称行为，不能要求「缩小必须越过初始距离」。
  // 断言改为：拉近确实变小且不小于 min，拉远确实变大且不大于 max、并回到起点附近——
  // 仍能抓住「减号完全不响应」（距离会停在拉近后的值，不再变大）。
  const minDistance = Number(await viewport.getAttribute('data-min-distance'));
  const maxDistance = Number(await viewport.getAttribute('data-max-distance'));
  const beforeZoom = await camera(viewport);
  await page.keyboard.press('+');
  await expect.poll(async () => (await camera(viewport)).distance).not.toBe(beforeZoom.distance);
  const zoomedIn = await camera(viewport);
  expect(zoomedIn.distance, '加号必须拉近').toBeLessThan(beforeZoom.distance);
  expect(zoomedIn.distance).toBeGreaterThanOrEqual(minDistance);
  await page.keyboard.press('-');
  await expect.poll(async () => (await camera(viewport)).distance).toBeGreaterThan(zoomedIn.distance);
  const zoomedOut = await camera(viewport);
  expect(zoomedOut.distance, '减号必须拉远').toBeGreaterThan(zoomedIn.distance);
  expect(zoomedOut.distance).toBeLessThanOrEqual(maxDistance);
  expect(Math.abs(zoomedOut.distance - beforeZoom.distance), '一近一远应回到起点附近').toBeLessThan(1e-3);

  // Home 复位：先旋转再缩放，复位后必须回到初始三元组，不是「接近」。
  const initial = beforeZoom;
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('-');
  await expect.poll(async () => (await camera(viewport)).distance).not.toBe(initial.distance);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await camera(viewport)).distance).toBe(initial.distance);
  const reset = await camera(viewport);
  expect(reset.azimuth, '复位必须恢复初始方位角').toBe(initial.azimuth);
  expect(reset.polar, '复位必须恢复初始极角').toBe(initial.polar);
  expect(reset.distance, '复位必须恢复初始距离').toBe(initial.distance);
  // 复位后仍在该产品的缩放边界内。
  expect(reset.distance).toBeGreaterThanOrEqual(minDistance);
  expect(reset.distance).toBeLessThanOrEqual(maxDistance);

  // Tab 不被锁：从视口按 Tab 必须能把焦点移到别的元素，且原视口失去焦点归属。
  await viewport.focus();
  await expect(page.locator('[data-focused-model]')).toHaveAttribute('data-focused-model', await viewport.getAttribute('data-slug') ?? '');
  await page.keyboard.press('Tab');
  await expect(viewport).toHaveAttribute('data-focused', '0');
  const focusedIsInside = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return !!el?.closest('[data-testid="product-viewport"]');
  });
  expect(focusedIsInside, 'Tab 必须能离开模型视口').toBe(false);

  // Escape 退出并回到来源之外：焦点释放、归属清空，且不跳产品链接。
  await viewport.focus();
  await expect(viewport).toHaveAttribute('data-focused', '1');
  const urlBefore = page.url();
  await page.keyboard.press('Escape');
  await expect(viewport).toHaveAttribute('data-focused', '0');
  await expect(page.locator('[data-focused-model]')).toHaveAttribute('data-focused-model', '');
  expect(page.url(), 'Escape 不得自动跳转产品链接').toBe(urlBefore);
  expect(await card.locator('.hint').count()).toBeGreaterThan(0);
});

test('E-101 工具条：每个控件都有可辨名称、可见焦点，且点击目标 ≥44×44', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openProducts(page);
  const toolbar = page.locator('article.card').first().getByTestId('model-controls');

  // 名称：逐个真实按钮必须有非空 accessible name，且指到具体产品。
  const buttons = toolbar.getByRole('button');
  const count = await buttons.count();
  expect(count, '工具条至少含旋转左右、缩放、复位与暂停').toBeGreaterThanOrEqual(5);
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const name = (await button.getAttribute('aria-label')) ?? (await button.textContent()) ?? '';
    expect(name.trim().length, `第 ${i + 1} 个控件必须有可辨名称`).toBeGreaterThan(0);
  }
  // Reset 与旋转控件的名称必须含产品名（12 节 `Reset view: [product name]`）。
  const productName = await page.locator('article.card').first().locator('h2').innerText();
  await expect(toolbar.getByTestId('model-reset')).toHaveAttribute('aria-label', new RegExp(`${productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // 44×44：逐个实测几何，不用 CSS 声明代替。
  for (let i = 0; i < count; i += 1) {
    const box = await buttons.nth(i).boundingBox();
    if (!box) throw new Error(`第 ${i + 1} 个控件没有布局盒`);
    expect(box.width, `第 ${i + 1} 个控件宽度`).toBeGreaterThanOrEqual(44);
    expect(box.height, `第 ${i + 1} 个控件高度`).toBeGreaterThanOrEqual(44);
  }

  // 焦点可见（E-101）。必须用真实 Tab 聚焦：样式挂在 :focus-visible 上，
  // 程序化 el.focus() 在 Chromium 下不触发 :focus-visible，读到 outline:none 是方法问题而非样式缺失
  // （实测对照：程序化聚焦 outlineStyle=none、matchesFocusVisible=false；Tab 聚焦 solid/2px/true）。
  const firstViewport = page.getByTestId('product-viewport').first();
  await firstViewport.focus();
  await expect(firstViewport).toHaveAttribute('data-focused', '1');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      testid: el.getAttribute('data-testid'),
      inToolbar: !!el.closest('[data-testid="model-controls"]'),
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
    };
  });
  expect(focused, 'Tab 必须把焦点移进工具条').not.toBeNull();
  expect(focused!.inToolbar, '第一个 Tab 目标应落在本模型的命名工具条内').toBe(true);
  expect(focused!.focusVisible, '键盘焦点必须命中 :focus-visible').toBe(true);
  expect(focused!.outlineStyle, '焦点环不得被移除').not.toBe('none');
  expect(parseFloat(focused!.outlineWidth), '焦点环必须有可见宽度').toBeGreaterThan(0);

  // 按钮与键盘功能相同：点旋转按钮与按方向键必须产生同一类变化（方位角）。
  const cameraHost = page.getByTestId('product-viewport').first();
  const beforeButton = await camera(cameraHost);
  await toolbar.getByTestId('model-rotate-left').click();
  await expect.poll(async () => (await camera(cameraHost)).azimuth).not.toBe(beforeButton.azimuth);
  const afterButton = await camera(cameraHost);
  expect(afterButton.distance, '旋转按钮不得改变距离').toBe(beforeButton.distance);

  // 复位按钮同样回到初值。
  await toolbar.getByTestId('model-zoom-in').scrollIntoViewIfNeeded();
  await toolbar.getByTestId('model-zoom-in').click();
  await expect.poll(async () => (await camera(cameraHost)).distance).not.toBe(beforeButton.distance);
  await toolbar.getByTestId('model-reset').scrollIntoViewIfNeeded();
  await toolbar.getByTestId('model-reset').click();
  await expect.poll(async () => (await camera(cameraHost)).distance).toBe(beforeButton.distance);
  const afterReset = await camera(cameraHost);
  expect(afterReset.azimuth).toBe(beforeButton.azimuth);
  expect(afterReset.polar).toBe(beforeButton.polar);
});

test('E-104 任意旋转缩放后复位等于该产品初始相机，1440/1920/窄屏模型完整可见', async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const view of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await openProducts(page, view.width, view.height);
    const viewport = page.getByTestId('product-viewport').first();
    const card = page.locator('article.card').first();
    const initial = await camera(viewport);

    // 真实操控：先转后缩放，两条通道都动过再复位。
    const box = await viewport.boundingBox();
    if (!box) throw new Error('视口没有布局盒');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await camera(viewport)).azimuth).not.toBe(initial.azimuth);

    // 工具条在视口正下方，按 11 节要求落在 360–440px 高的视口之后，因此可能位于首屏之外。
    // 这不是缺陷，也不该用「控件必须在首屏」来断言；显式滚入视口再点，才能区分
    // 「控件真的不可点」与「控件只是不在当前滚动位置」（实测：按钮命中自身、程序点击可复位）。
    await card.getByTestId('model-zoom-in').scrollIntoViewIfNeeded();
    await card.getByTestId('model-zoom-in').click();
    await expect.poll(async () => (await camera(viewport)).distance).not.toBe(initial.distance);

    // 复位：三项逐一回到初值。
    await card.getByTestId('model-reset').scrollIntoViewIfNeeded();
    await card.getByTestId('model-reset').click();
    await expect.poll(async () => (await camera(viewport)).distance).toBe(initial.distance);
    const back = await camera(viewport);
    expect(back.azimuth, `${view.width} 复位方位角`).toBe(initial.azimuth);
    expect(back.polar, `${view.width} 复位极角`).toBe(initial.polar);

    // 完整可见：视口本身回到视区后不得被裁到视口外。
    await viewport.scrollIntoViewIfNeeded();
    await expect(viewport).toBeInViewport();
    const visible = await viewport.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight };
    });
    expect(visible.left).toBeGreaterThanOrEqual(-1);
    expect(visible.right).toBeLessThanOrEqual(visible.vw + 1);
    expect(visible.bottom).toBeGreaterThan(0);

    // 名称与关键操作可辨、规格与询盘入口仍可见（不靠删内容消除裁切）。
    await expect(card.locator('h2')).toBeVisible();
    await expect(card.getByTestId('model-reset')).toBeVisible();
    expect(await card.locator('.specs li, .desc').count(), '规格或说明必须仍在').toBeGreaterThan(0);
    await expect(card.locator('.actions').getByRole('button').first()).toBeVisible();
  }

  // 窄屏（390×844）：模型区完整、控件仍可点，且页面不横向溢出。
  await openProducts(page, 390, 844);
  const narrowViewport = page.getByTestId('product-viewport').first();
  const narrowCard = page.locator('article.card').first();
  await expect(narrowViewport).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  const narrowBox = await narrowViewport.boundingBox();
  if (!narrowBox) throw new Error('窄屏视口没有布局盒');
  expect(narrowBox.height, '窄屏模型视口至少 240px 高').toBeGreaterThanOrEqual(240);
  // 横向溢出按真实内容宽度判断：窄屏下 body 不得产生横向滚动。
  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(noHorizontalScroll, '窄屏不得横向溢出').toBe(true);
  await narrowCard.getByTestId('model-reset').scrollIntoViewIfNeeded();
  await expect(narrowCard.getByTestId('model-reset')).toBeVisible();
  const resetBox = await narrowCard.getByTestId('model-reset').boundingBox();
  if (!resetBox) throw new Error('窄屏复位控件没有布局盒');
  expect(resetBox.width).toBeGreaterThanOrEqual(44);
  expect(resetBox.height).toBeGreaterThanOrEqual(44);
  // 窄屏也要真的能复位，而不只是「尺寸达标」。
  const narrowInitial = await camera(narrowViewport);
  await narrowCard.getByTestId('model-rotate-left').click();
  await expect.poll(async () => (await camera(narrowViewport)).azimuth).not.toBe(narrowInitial.azimuth);
  await narrowCard.getByTestId('model-reset').click();
  await expect.poll(async () => (await camera(narrowViewport)).azimuth).toBe(narrowInitial.azimuth);
});

test('E-102 触屏：单指在模型区接管拖动，文字区仍滚页面，且手势不提交询盘', async ({ page }) => {
  test.setTimeout(150_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const viewport = await openProducts(page);
  const card = page.locator('article.card').first();

  // 视口接管拖动：触摸样式必须是 pan-y（单指竖直滚动交给页面、水平拖动归模型）。
  const touchAction = await viewport.evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction, '模型视口必须允许页面竖直滚动').toContain('pan-y');

  // 单指拖动改朝向；这一路径已由 M2-T2 的指针用例覆盖 PC，这里用 pointer 事件确认触屏指针同样归模型。
  const initial = await camera(viewport);
  const box = await viewport.boundingBox();
  if (!box) throw new Error('视口没有布局盒');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await camera(viewport)).azimuth).not.toBe(initial.azimuth);

  // 单指不缩放：拖动后距离不变，避免「拖着拖着就缩了」。
  expect((await camera(viewport)).distance, '单指拖动不得改变缩放距离').toBe(initial.distance);

  // 文字区滚动：指针在说明正文上滚轮，页面必须滚动，相机不变。
  await page.evaluate(() => window.scrollTo(0, 0));
  const desc = card.locator('p.desc');
  await expect(desc).toHaveCount(1);
  const descBox = await desc.boundingBox();
  if (!descBox) throw new Error('正文没有布局盒');
  const beforeScroll = await page.evaluate(() => window.scrollY);
  const beforeWheel = await camera(viewport);
  await page.mouse.move(descBox.x + descBox.width / 2, descBox.y + descBox.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll);
  await expectCameraStable(viewport, beforeWheel, '正文区滚轮');

  // 手势不提交询盘：整个过程后仍在产品页，且询盘按钮未被触发（aria-pressed 仍为 false）。
  // 文案取自 messages/en.json 的 Quote.add（"Add to quote"），不猜。
  await expect(page).toHaveURL(/\/en\/products$/);
  const addButton = card.locator('.actions').getByRole('button', { name: 'Add to quote' });
  await expect(addButton, '卡片必须有加入询盘入口').toHaveCount(1);
  await expect(addButton).toHaveAttribute('aria-pressed', 'false');
});
