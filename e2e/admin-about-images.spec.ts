import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import sharp from 'sharp';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import type { APIRequestContext, Page } from '@playwright/test';

// #350 /admin/settings「关于我们 · 图片列表」：真实页面 + 真实接口（#374 PublicAsset），仅 E2E 测试库。
// 每组新建一个 ADMIN、只登录一次（scripts/create-admin.mjs，ADMIN_SEED_TOTP_SECRET 只在非生产可用），见 useSharedAdmin。
const PASSWORD = 'e2e-img-Passw0rd!';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 测试用假密钥
const origin = { Origin: BASE };
const S = '/api/admin/site-settings';

/**
 * 每组只登录一次：beforeAll 新建一个 ADMIN、用独立的 request context 登录一次，存下 storageState（会话 cookie），
 * 组里每个测试开始前把 cookie 放进自己的 page context（page.request 和页面共用），不再重新登录。
 * 为什么：单 IP 登录桶 30 次 / 10 分钟（#376 起 enroll / confirm 也算、而且不退），整套 e2e 1 个 worker 共用一个 IP，
 * 原来每个测试登录一次（9 次）会把后面 admin.spec.ts 的登录挤爆（CredentialsSignin）。
 * 分两组两个账号：图片上传按管理员每分钟 20 次（ASSET_UPLOAD_RATE），整个文件约 22 次上传、跑完不到一分钟，一个账号会撞上限。
 * 不用 serial：某个测试失败不会连带跳过同组其他测试；失败后 Playwright 换 worker 会重跑 beforeAll，多登录一次（只在出错时）。
 * 每个测试仍然自己 reset()（清列表、删图库、内容回到基线），互不依赖。
 */
function useSharedAdmin(tag: string) {
  let state: Awaited<ReturnType<APIRequestContext['storageState']>>;
  test.beforeAll(async ({ playwright }) => {
    const email = `e2e-img-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    execFileSync('node', ['scripts/create-admin.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: `E2E img ${tag}`, ADMIN_SEED_ROLE: 'ADMIN', ADMIN_SEED_TOTP_SECRET: TOTP },
    });
    const req = await playwright.request.newContext({ baseURL: BASE });
    const csrf = (await (await req.get('/api/auth/csrf')).json()).csrfToken as string;
    const ok = await req.post('/api/auth/callback/credentials', { headers: origin, form: { csrfToken: csrf, email, password: PASSWORD, totp: authenticator.generate(TOTP) }, maxRedirects: 0 });
    expect(ok.headers()['location'] ?? '').not.toContain('error');
    expect((await req.get(`${S}/about`)).status()).toBe(200);
    state = await req.storageState();
    await req.dispose();
  });
  test.beforeEach(async ({ page }) => { await page.context().addCookies(state.cookies); });
}

/**
 * 从干净状态开始：清空列表、删掉图库里的图、en 填完整内容（无图）、ru 清空、开关打开。
 * 已经是目标状态的就不发 PUT：site_settings.update 按 IP 每分钟 30 次，整个 e2e 共用一个 IP。
 */
const EN_BODY = `<p>${'Sample text for the about page. '.repeat(4)}</p>`;
async function reset(page: Page) {
  const about = await (await page.request.get(`${S}/about`)).json();
  if (about.images.items.length) expect((await page.request.put(`${S}/about/images`, { headers: origin, data: { expectedVersion: about.images.version, ids: [] } })).status()).toBe(200);
  const lib = await (await page.request.get(`${S}/assets`)).json();
  for (const a of lib.assets) expect((await page.request.delete(`${S}/assets/${a.id}`, { headers: origin })).status()).toBe(200);
  const en = about.locales.en;
  const enClean = en && en.title === 'About PackJoyU (sample)' && !en.summary && en.bodyHtml === EN_BODY && !en.stats?.length && !en.home?.title && !en.home?.intro && !Object.keys(en.imageMeta ?? {}).length;
  if (!enClean) {
    const put = await page.request.put(`${S}/about/en`, { headers: origin, data: {
      expectedVersion: en?.version ?? 0, title: 'About PackJoyU (sample)', summary: '', bodyHtml: EN_BODY,
      stats: [], home: { title: '', intro: '' }, imageMeta: {},
    } });
    expect(put.status()).toBe(200);
  }
  const ru = about.locales.ru;
  const ruClean = !ru || (!ru.title && !ru.summary && !ru.bodyHtml && !ru.stats?.length && !ru.home?.title && !ru.home?.intro && !Object.keys(ru.imageMeta ?? {}).length);
  if (!ruClean) {
    expect((await page.request.put(`${S}/about/ru`, { headers: origin, data: { expectedVersion: ru.version, title: '', summary: '', bodyHtml: '', stats: [], home: { title: '', intro: '' }, imageMeta: {} } })).status()).toBe(200);
  }
  if (!about.enabled) expect((await page.request.put(`${S}/about/enabled`, { headers: origin, data: { enabled: true, expectedVersion: about.enabledMeta.version } })).status()).toBe(200);
}

const jpeg = (w: number, h: number, rgb: [number, number, number]) => sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg({ quality: 80 }).toBuffer();
/** 只有 PNG 头（IHDR 宽高）没有像素数据：后端只读文件头就判像素超限 */
function pngHeader(w: number, h: number) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(16)), chunk('IEND', Buffer.alloc(0))]);
}
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** 假的上传成功响应（只在 page.route 里用，不经过服务端、不占上传限速） */
const fakeAsset = (id: string) => ({
  id, width: 1600, height: 1200, bytes: 2000, createdAt: new Date().toISOString(), inUse: false, warnings: [],
  sm: { url: `/media/${id}-800.webp`, width: 800, height: 600, bytes: 1000 }, lg: { url: `/media/${id}-1600.webp`, width: 1600, height: 1200, bytes: 2000 },
});
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const fileInput = (page: Page) => page.locator('.st-im input[type=file]');
const pick = (page: Page, name: string, mimeType: string, buffer: Buffer) => fileInput(page).setInputFiles({ name, mimeType, buffer });
const saveBtn = (page: Page) => page.getByRole('region', { name: '保存' }).getByRole('button', { name: '保存' });
const savedOk = (page: Page) => expect(page.getByRole('status').filter({ hasText: '✓ 已保存' })).toBeVisible();

test.describe('账号 A：上传 / 被拒 / 429 / 6 张上限 / 排序、图片库删除和 409、合 #378 后的错误条', () => {
  useSharedAdmin('a');

  test('图片列表：上传、替代文字必填、各种被拒、429 保留文件、去重、6 张上限、排序保存、前台 srcset', async ({ page }) => {
    test.setTimeout(150_000);
    await reset(page);
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`${S}/assets`)) posts.push(r.url()); });

    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    await expect(area.getByText('图片列表（选填，/about 与首页共用）')).toBeVisible();
    await expect(area.locator('.st-count').first()).toHaveText('0 / 6');
    await expect(area.getByText('JPG / PNG / WebP，单张 ≤ 10 MB')).toBeVisible();
    await expect(area.getByText('上传后统一转为 WebP · 建议长边 ≥ 1600 px · 还可加 6 张')).toBeVisible();

    // 正常上传 → 卡片；en 有内容，替代文字必填，保存禁用
    await pick(page, 'factory-1.jpg', 'image/jpeg', await jpeg(1600, 1200, [200, 120, 80]));
    const cards = area.locator('.st-im-card');
    await expect(cards).toHaveCount(1);
    await expect(area.locator('.st-count').first()).toHaveText('1 / 6');
    await expect(cards.first().getByText('请填写替代文字')).toBeVisible();
    await expect(area.getByText('1 张图片缺少替代文字，补齐后才能保存。')).toBeVisible();
    await expect(page.getByRole('region', { name: '保存' })).toContainText('图片列表');
    await expect(saveBtn(page)).toBeDisabled();
    // UX #379 P3 ③：保存栏第二行写明为什么不能保存，「保存」按钮关联这句
    await expect(page.locator('.st-bar-why')).toHaveText('1 张图片缺少替代文字');
    await expect(saveBtn(page)).toHaveAttribute('aria-describedby', 'st-bar-why');
    // 右栏完整度清单最后一项：!「图片替代文字 · 1 张缺失」→ 填了以后 ✓
    const chk = page.locator('section[aria-labelledby="st-chk-h"] li').last();
    await expect(chk).toContainText('图片替代文字 · 1 张缺失');
    await expect(chk.locator('.i')).toHaveClass(/missing/);
    // 「1 张」之间的空格在 12px 下也看得出来（≥ 4px）
    expect(await chk.evaluate((li) => { const cs = getComputedStyle(li); const c = document.createElement('canvas').getContext('2d')!; c.font = `${cs.fontSize} ${cs.fontFamily}`; return c.measureText(' ').width + parseFloat(cs.wordSpacing); })).toBeGreaterThanOrEqual(4);
    await cards.first().getByLabel(/替代文字（EN）/).fill('Sample alt 1');
    await expect(saveBtn(page)).toBeEnabled();
    await expect(page.locator('.st-bar-why')).toHaveCount(0);
    await expect(chk).toHaveText(/^✓图片替代文字（已满足）$/);

    // 小图：能传，但提示
    await pick(page, 'small.jpg', 'image/jpeg', await jpeg(1200, 900, [90, 140, 200]));
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1).getByText('图片较小，大屏上可能不够清晰')).toBeVisible();

    // 被拒：长边 < 800（422）、GIF 改成 png 类型（服务端 magic bytes → 415）、损坏（422）、像素超限（422）、>10 MB（前端拦住，不发请求）
    const errTile = (name: string) => area.locator('.st-im-up.bad').filter({ hasText: name });
    await pick(page, 'tiny.jpg', 'image/jpeg', await jpeg(600, 400, [10, 10, 10]));
    await expect(errTile('tiny.jpg')).toContainText('图片太小，长边至少 800 像素');
    await expect(errTile('tiny.jpg')).toContainText('未上传');
    await pick(page, 'fake.png', 'image/png', GIF);
    await expect(errTile('fake.png')).toContainText('仅支持 JPG、PNG、WebP 静态图片');
    await pick(page, 'broken.png', 'image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));
    await expect(errTile('broken.png')).toContainText('图片处理失败，请换一张重试');
    await pick(page, 'huge-mp.png', 'image/png', pngHeader(8000, 8000));
    await expect(errTile('huge-mp.png')).toContainText('图片像素过大（超过 6000 万），请缩小后再上传');
    const before = posts.length;
    await pick(page, 'big.jpg', 'image/jpeg', Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    await expect(errTile('big.jpg')).toContainText('图片不能超过 10MB');
    await expect(errTile('big.jpg')).toContainText('10.0 MB');
    expect(posts.length).toBe(before);
    for (const n of ['tiny.jpg', 'fake.png', 'broken.png', 'huge-mp.png', 'big.jpg']) await errTile(n).getByRole('button', { name: '关闭' }).click();
    await expect(area.locator('.st-im-up.bad')).toHaveCount(0);

    // 429：文案 + 保留文件，Retry-After 之后才能重试，重试成功
    let limited = true;
    await page.route(`**${S}/assets`, (route) => (limited && route.request().method() === 'POST'
      ? route.fulfill({ status: 429, headers: { 'Retry-After': '2', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'rate_limited' }) })
      : route.fallback()));
    await pick(page, 'retry.jpg', 'image/jpeg', await jpeg(1600, 1200, [30, 160, 90]));
    await expect(errTile('retry.jpg')).toContainText('上传太频繁，请稍后再试');
    await expect(errTile('retry.jpg').getByRole('button', { name: /秒后可重试/ })).toBeDisabled();
    limited = false;
    await errTile('retry.jpg').getByRole('button', { name: '重试' }).click({ timeout: 6000 });
    await expect(cards).toHaveCount(3);
    await page.unroute(`**${S}/assets`);

    // 同一张图再传：200 deduplicated，不重复加
    await pick(page, 'factory-1-again.jpg', 'image/jpeg', await jpeg(1600, 1200, [200, 120, 80]));
    await expect(area.getByText('这张图已经在列表里了')).toBeVisible();
    await expect(cards).toHaveCount(3);

    // 加到 6 张：上传区变成「已达上限」
    for (const [i, c] of ([[4, [250, 0, 0]], [5, [0, 250, 0]], [6, [0, 0, 250]]] as const)) await pick(page, `f${i}.jpg`, 'image/jpeg', await jpeg(1600, 1200, [...c]));
    await expect(cards).toHaveCount(6);
    await expect(area.getByText('已达上限：最多 6 张')).toBeVisible();
    await expect(fileInput(page)).toHaveCount(0);
    for (let i = 1; i < 6; i++) await cards.nth(i).getByLabel(/替代文字（EN）/).fill(`Sample alt ${i + 1}`);

    // 排序：第 1 张下移（宽屏是 →）
    const firstSrc = await cards.nth(0).locator('img').getAttribute('src');
    await cards.nth(0).getByRole('button', { name: '下移第 1 张图片' }).click();
    expect(await cards.nth(1).locator('img').getAttribute('src')).toBe(firstSrc);

    await saveBtn(page).click();
    await savedOk(page);
    const about = await (await page.request.get(`${S}/about`)).json();
    expect(about.images.items).toHaveLength(6);
    expect(`/media/${about.images.items[1].id}-800.webp`).toBe(firstSrc);
    expect(Object.keys(about.locales.en.imageMeta).sort()).toEqual(about.images.items.map((i: { id: string }) => i.id).sort());
    expect(about.locales.en.imageMeta[about.images.items[1].id].alt).toBe('Sample alt 1');

    // 前台：6 张都在，srcset 的 w 描述符 = sm / lg 实际宽度，width / height = lg，有 alt
    await page.goto('/en/about');
    const imgs = page.locator('.ab-imgs img');
    await expect(imgs).toHaveCount(6);
    const smallItem = about.images.items.find((i: { lg: { w: number } }) => i.lg.w === 1200);
    const im = page.locator(`.ab-imgs img[src="/media/${smallItem.id}-800.webp"]`);
    await expect(im).toHaveAttribute('srcset', `/media/${smallItem.id}-800.webp 800w, /media/${smallItem.id}-1600.webp 1200w`);
    await expect(im).toHaveAttribute('width', '1200');
    await expect(im).toHaveAttribute('height', '900');
    await expect(im).toHaveAttribute('alt', /Sample alt/);
    // spec v1.0.10 + SEO P3：sizes 按布局（断点 768px）；第 1 张不懒加载，其余 lazy
    await expect(imgs.first()).toHaveAttribute('sizes', '(min-width: 768px) 66vw, 100vw');
    await expect(imgs.first()).toHaveAttribute('loading', 'eager');
    for (let i = 1; i < 6; i++) {
      await expect(imgs.nth(i)).toHaveAttribute('sizes', '(min-width: 768px) 33vw, 50vw');
      await expect(imgs.nth(i)).toHaveAttribute('loading', 'lazy');
    }
    // 统一 4:3 居中裁切：容器 4:3、img cover + center；img 的 width / height 仍是文件实际尺寸（上面 1200×900）
    for (const w of [1440, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      const r = await page.locator('.ab-imgs .ab-fig-box').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e.querySelector('img')!); return { ratio: b.width / b.height, fit: cs.objectFit, pos: cs.objectPosition }; }));
      expect(r).toHaveLength(6);
      for (const x of r) { expect(Math.abs(x.ratio - 4 / 3)).toBeLessThan(0.02); expect(x.fit).toBe('cover'); expect(x.pos).toBe('50% 50%'); }
    }
  });

  test('图片库：在用的图不能删（asset_in_use）；移除并保存后可以删，先确认；409 走关于页的冲突流程', async ({ page }) => {
    test.setTimeout(90_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    await area.locator('input[type=file]').setInputFiles([
      { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [120, 60, 30]) },
      { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [30, 60, 120]) },
    ]);
    const cards = area.locator('.st-im-card');
    await expect(cards).toHaveCount(2);
    await cards.nth(0).getByLabel(/替代文字（EN）/).fill('Alt A');
    await cards.nth(1).getByLabel(/替代文字（EN）/).fill('Alt B');
    await saveBtn(page).click();
    await savedOk(page);

    // 在用：点删除直接提示，不弹确认、不发 DELETE
    let deletes = 0;
    page.on('request', (r) => { if (r.method() === 'DELETE') deletes++; });
    await area.getByText(/图片库（已上传 2 张）/).click();
    const libItems = area.locator('.st-im-libl li');
    await expect(libItems).toHaveCount(2);
    await libItems.first().getByRole('button', { name: '删除' }).click();
    await expect(libItems.first().getByRole('alert')).toHaveText('这张图正在关于页使用，请先从关于页移除');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(deletes).toBe(0);

    // 服务端同样拦：直接调接口 409 asset_in_use
    const about0 = await (await page.request.get(`${S}/about`)).json();
    const del409 = await page.request.delete(`${S}/assets/${about0.images.items[0].id}`, { headers: origin });
    expect(del409.status()).toBe(409);
    expect((await del409.json()).error).toBe('asset_in_use');

    // 从关于页移除第 2 张并保存 → 图库里那张可以删：确认框文案、取消 / 红色删除
    await cards.nth(1).getByRole('button', { name: '删除第 2 张图片' }).click();
    await expect(cards).toHaveCount(1);
    await saveBtn(page).click();
    await savedOk(page);
    const removedId = about0.images.items[1].id;
    const target = libItems.filter({ has: page.locator(`img[src="/media/${removedId}-800.webp"]`) });
    await expect(target.getByText('关于页使用中')).toHaveCount(0);
    await target.getByRole('button', { name: '删除' }).click();
    const dlg = page.getByRole('alertdialog', { name: '删除这张图片？' });
    await expect(dlg).toContainText('删除后，旧的图片链接可能仍能访问一段时间');
    await expect(dlg.getByRole('button', { name: '取消' })).toBeFocused();
    await expect(dlg.getByRole('button', { name: '删除' })).toHaveCSS('background-color', 'rgb(192, 57, 43)');
    await dlg.getByRole('button', { name: '取消' }).click();
    await expect(libItems).toHaveCount(2);
    await target.getByRole('button', { name: '删除' }).click();
    await dlg.getByRole('button', { name: '删除' }).click();
    await expect(libItems).toHaveCount(1);
    expect((await page.request.get(`/media/${removedId}-1600.webp`)).status()).toBe(404);
    // 删掉的图在库里留下的旧文字会被剪掉：接着改 en 文字能正常保存（不会 400 unknown_asset）
    await cards.nth(0).getByLabel(/替代文字（EN）/).fill('Alt A2');
    await saveBtn(page).click();
    await savedOk(page);
    const about1 = await (await page.request.get(`${S}/about`)).json();
    expect(Object.keys(about1.locales.en.imageMeta)).toEqual([about0.images.items[0].id]);

    // 409：别人先改了图片列表 → 我保存时冲突横幅 + 刷新；草稿保留、保存禁用、只发一次 PUT images
    const other = await page.request.put(`${S}/about/images`, { headers: origin, data: { expectedVersion: about1.images.version, ids: [] } });
    expect(other.status()).toBe(200);
    let imagePuts = 0;
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith('/about/images')) imagePuts++; });
    await cards.nth(0).getByRole('button', { name: '删除第 1 张图片' }).click();
    await area.getByText(/图片库/).first().isVisible();
    await libItems.first().getByRole('button', { name: '加入关于页' }).click(); // 再加回来 → 列表和已保存一样，但文字改了
    await area.locator('input[type=file]').setInputFiles({ name: 'c.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [60, 120, 30]) });
    await expect(cards).toHaveCount(2);
    await cards.nth(1).getByLabel(/替代文字（EN）/).fill('Alt C');
    await saveBtn(page).click();
    const banner = page.getByRole('alert').filter({ hasText: '内容已被他人修改，请刷新后重新编辑' });
    await expect(banner).toBeVisible();
    await expect(banner).toBeFocused(); // #378 revealAlert：横幅滚进视野并聚焦
    await expect(banner).toBeInViewport();
    await expect(cards).toHaveCount(2);
    await expect(saveBtn(page)).toBeDisabled();
    expect(imagePuts).toBe(1);
    await banner.getByRole('button', { name: '刷新' }).click();
    await page.getByRole('alertdialog', { name: '未保存的修改将丢弃' }).getByRole('button', { name: '丢弃并刷新' }).click();
    await expect(banner).toHaveCount(0);
    await expect(cards).toHaveCount(0);
    await expect(area.locator('.st-count').first()).toHaveText('0 / 6');
  });

  test('合 #378 后：imageMeta 的字段错误和 unknown_asset 都进顶部错误条（中文），错误条滚进视野并聚焦', async ({ page }) => {
    test.setTimeout(90_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    await fileInput(page).setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [120, 60, 30]) });
    const cards = area.locator('.st-im-card');
    await expect(cards).toHaveCount(1);
    await cards.first().getByLabel(/替代文字（EN）/).fill('Alt A');
    const lib = await (await page.request.get(`${S}/assets`)).json();
    const id = lib.assets[0].id as string;
    const alertBar = page.locator('.st-page p[role=alert].st-err');

    // ① 后端 400 imageMeta issue（前端有 maxlength，正常走不到，这里拦截 PUT 模拟）→ 顶部错误条「第 1 张图片的替代文字…」，不显示 path
    await page.route('**/api/admin/site-settings/about/en', (route) => (route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid', issues: [{ path: `imageMeta.${id}.alt`, message: 'max 125 chars' }] }) })
      : route.fallback()));
    await saveBtn(page).click();
    await expect(alertBar).toHaveText('参数不正确，请检查后重试。（第 1 张图片的替代文字超出上限（最多 125 字））');
    await expect(alertBar).toBeFocused();
    await expect(alertBar).toBeInViewport();
    await page.unroute('**/api/admin/site-settings/about/en');

    // ② 图片在保存前被删了（别的窗口删的）→ 后端 400 unknown_asset → 中文，不出现裸错误码
    expect((await page.request.delete(`${S}/assets/${id}`, { headers: origin })).status()).toBe(200);
    await cards.first().getByLabel(/替代文字（EN）/).fill('Alt A2');
    await saveBtn(page).click();
    await expect(alertBar).toHaveText('列表里有图片已经被删除，请移除后再保存');
    await expect(alertBar).toBeFocused();
    await expect(page.locator('.st-page')).not.toContainText('unknown_asset');
    await expect(cards).toHaveCount(1); // 草稿还在
  });
});

test.describe('账号 B：UX 复审（单列 / ✕ / aria-label）、1–4 行、计数', () => {
  useSharedAdmin('b');

  test('UX 复审：<640px 单列卡片、输入框占满宽度；1440 多列；删除用 ✕，上移 / 下移 / 删除第 N 张图片的 aria-label；控件 ≥ 44px', async ({ page }) => {
    test.setTimeout(90_000);
    await reset(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    await area.locator('input[type=file]').setInputFiles([
      { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [120, 60, 30]) },
      { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [30, 60, 120]) },
    ]);
    const cards = area.locator('.st-im-card');
    await expect(cards).toHaveCount(2);
    const grid = (await area.locator('.st-im-grid').boundingBox())!;
    const [c0, c1] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(c0.x).toBe(c1.x); // 单列：上下排
    expect(c1.y).toBeGreaterThan(c0.y + c0.height - 1);
    expect(Math.abs(c0.width - grid.width)).toBeLessThanOrEqual(1);
    for (const name of [/替代文字（EN）/, /图片说明/]) {
      const input = cards.first().getByLabel(name);
      const ib = (await input.boundingBox())!;
      expect(ib.width).toBeGreaterThan(c0.width - 32); // 输入框占满卡片（减去内边距）
      expect(ib.height).toBeGreaterThanOrEqual(44);
    }
    // 占位「≤80 字，显示在图片下方」放得下：用同样字体量一下文字宽度
    const fits = await cards.first().getByLabel(/图片说明/).evaluate((el: HTMLInputElement) => {
      const cs = getComputedStyle(el); const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
      return ctx.measureText(el.placeholder).width <= el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });
    expect(fits).toBe(true);
    // 长替代文字整段可见：自动长高、不出滚动、不截断；回车不换行
    const alt = cards.first().getByLabel(/替代文字（EN）/);
    const h1 = (await alt.boundingBox())!.height;
    await alt.fill('Corrugated box production line with workers checking the printed cartons before packing them for shipment');
    await alt.press('Enter');
    await expect(alt).toHaveValue(/shipment$/);
    expect((await alt.boundingBox())!.height).toBeGreaterThan(h1);
    expect(await alt.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const up = cards.nth(1).getByRole('button', { name: '上移第 2 张图片' });
    const down = cards.nth(0).getByRole('button', { name: '下移第 1 张图片' });
    const del = cards.nth(0).getByRole('button', { name: '删除第 1 张图片' });
    for (const b of [up, down, del]) { const bb = (await b.boundingBox())!; expect(bb.width).toBeGreaterThanOrEqual(44); expect(bb.height).toBeGreaterThanOrEqual(44); }
    await expect(del).toHaveText('✕');
    await expect(down).toHaveText(/↓/);
    await expect(area.getByText('🗑')).toHaveCount(0);
    // 1440：保持多列
    await page.setViewportSize({ width: 1440, height: 900 });
    const [d0, d1] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(d1.x).toBeGreaterThan(d0.x + d0.width - 1);
    expect(d1.y).toBe(d0.y);
    await expect(cards.nth(0).getByRole('button', { name: '下移第 1 张图片' })).toHaveText(/→/);
  });

  // 量高度（在浏览器里算）：1 行 / 4 行的 border-box 高度 = 行高 × 行数 + 上下内边距 + 边框
  const measure = (box: import('@playwright/test').Locator) => box.evaluate((el) => {
    const cs = getComputedStyle(el); const extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const lh = parseFloat(cs.lineHeight);
    return { h: el.getBoundingClientRect().height, one: lh + extra, four: 4 * lh + extra, scroll: el.scrollHeight > el.clientHeight + 1, oy: cs.overflowY };
  });
  const LONG_CJK = '工厂生产线上的工人正在检查印好的瓦楞纸箱，'.repeat(6).slice(0, 120);

  for (const mode of ['field-sizing', 'JS 兜底'] as const) for (const w of [1440, 390]) {
    test(`UX 条件 1：替代文字 / 说明 1–4 行，超过 4 行框内滚动，不能拖动（${mode}，${w}）`, async ({ page }) => {
      test.setTimeout(90_000);
      if (mode === 'JS 兜底') {
        // 模拟不支持 field-sizing 的浏览器：CSS.supports 报不支持，并让 CSS 的 field-sizing 不生效
        await page.addInitScript(() => { const orig = CSS.supports.bind(CSS); CSS.supports = ((a: string, b?: string) => (a === 'field-sizing' ? false : b === undefined ? orig(a) : orig(a, b))) as typeof CSS.supports; });
      }
      await page.setViewportSize({ width: w, height: 900 });
      await reset(page);
      await page.goto('/admin/settings');
      if (mode === 'JS 兜底') await page.addStyleTag({ content: '.st-im-card textarea{field-sizing:fixed !important}' });
      const area = page.locator('.st-im');
      await fileInput(page).setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [120, 60, 30]) });
      await expect(area.locator('.st-im-card')).toHaveCount(1);
      for (const label of [/替代文字（EN）/, /图片说明/]) {
        const box = area.locator('.st-im-card').first().getByLabel(label);
        await expect(box).toHaveCSS('resize', 'none');
        const one = await measure(box);
        expect(one.h).toBeGreaterThanOrEqual(one.one - 1); // 空的时候 1 行（手机上再保证 ≥ 44px）
        expect(one.h).toBeLessThanOrEqual(Math.max(one.one, w === 390 ? 44 : 0) + 1);
        expect(one.scroll).toBe(false);
        await box.fill('Two rows of text '.repeat(3)); // 2–3 行：跟着长高、不滚动
        const mid = await measure(box);
        expect(mid.h).toBeGreaterThan(one.h + 5);
        expect(mid.scroll).toBe(false);
        await box.fill(label.source.includes('说明') ? LONG_CJK.slice(0, 80) : LONG_CJK); // 超过 4 行：停在 4 行，框内滚动
        const big = await measure(box);
        expect(Math.abs(big.h - big.four)).toBeLessThanOrEqual(1);
        expect(big.scroll).toBe(true);
        expect(big.oy).toBe('auto');
        await box.fill('');
        expect(Math.abs((await box.boundingBox())!.height - one.h)).toBeLessThanOrEqual(1); // 清空后回到 1 行
      }
    });
  }

  test('UX 条件 2：maxLength 125 / 80；剩 ≤ 10 字时框内右下角显示「n/上限」，aria-live polite、aria-describedby 关联', async ({ page }) => {
    test.setTimeout(90_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    await fileInput(page).setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [120, 60, 30]) });
    const card = area.locator('.st-im-card').first();
    await expect(card).toBeVisible();
    for (const [label, max] of [[/替代文字（EN）/, 125], [/图片说明/, 80]] as const) {
      const box = card.getByLabel(label);
      const id = await box.getAttribute('id');
      const cnt = page.locator(`[id="${id}-cnt"]`);
      await expect(box).toHaveAttribute('maxlength', String(max));
      await expect(cnt).toHaveAttribute('aria-live', 'polite');
      await box.fill('a'.repeat(max - 11)); // 剩 11 字：不显示
      await expect(cnt).toBeHidden();
      expect(await box.getAttribute('aria-describedby') ?? '').not.toContain(`${id}-cnt`);
      await box.pressSequentially('b'); // 剩 10 字：显示
      await expect(cnt).toBeVisible();
      await expect(cnt).toHaveText(`${max - 10}/${max}`);
      await expect(box).toHaveAttribute('aria-describedby', new RegExp(`${id}-cnt`));
      // 在框里的右下角
      const [b, c] = [(await box.boundingBox())!, (await cnt.boundingBox())!];
      expect(c.x + c.width).toBeLessThanOrEqual(b.x + b.width);
      expect(c.x + c.width).toBeGreaterThan(b.x + b.width - 16);
      expect(c.y + c.height).toBeLessThanOrEqual(b.y + b.height);
      expect(c.y + c.height).toBeGreaterThan(b.y + b.height - 12);
      // 打满后再打也进不去（maxlength 硬上限）
      await box.pressSequentially('c'.repeat(15));
      await expect(box).toHaveValue(new RegExp(`^.{${max}}$`));
      await expect(cnt).toHaveText(`${max}/${max}`);
      await expect(cnt).toHaveClass(/at-max/);
      await box.fill('short');
      await expect(cnt).toBeHidden();
    }
  });
  test('UX #378 P3 ②：390 下正文编辑器工具栏一行（不换行，放不下的横向滑），按钮 44×44；1440 也是一行、不滚动', async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    for (const w of [390, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto('/admin/settings');
      const bar = page.getByRole('toolbar', { name: '正文格式' });
      await expect(bar).toBeVisible();
      const m = await bar.evaluate((el) => {
        const btns = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
        return { tops: new Set(btns.map((r) => Math.round(r.top))).size, minH: Math.min(...btns.map((r) => r.height)), minW: Math.min(...btns.map((r) => r.width)), overflow: el.scrollWidth - el.clientWidth, n: btns.length };
      });
      expect(m.n).toBe(8);
      expect(m.tops).toBe(1); // 一行
      // spec v1.0.11：常用按钮在前
      expect(await bar.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))).toEqual(['加粗', '链接', '二级标题', '项目符号列表', '斜体', '三级标题', '编号列表', '清除格式']);
      await expect(bar.getByRole('button', { name: '链接' }).locator('svg')).toHaveCount(1);
      const wrap = page.locator('.st-tools-wrap');
      if (w === 390) {
        // spec v1.0.11：开头只有右侧渐隐；滚到中间两侧都有；滚到末尾只有左侧
        await expect(wrap).toHaveClass(/fade-r/);
        await expect(wrap).not.toHaveClass(/fade-l/);
        await bar.evaluate((el) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
        await expect(wrap).toHaveClass(/fade-l/);
        await expect(wrap).toHaveClass(/fade-r/);
        await bar.evaluate((el) => { el.scrollLeft = 0; });
        await expect(wrap).not.toHaveClass(/fade-l/);
        expect(m.minH).toBeGreaterThanOrEqual(44);
        expect(m.minW).toBeGreaterThanOrEqual(44);
        // 最后一个按钮滑得到：键盘 Tab 到它时工具栏会滚过去，按钮整个露出来
        const last = bar.getByRole('button', { name: '清除格式' });
        await last.focus();
        const vis = await last.evaluate((b) => { const r = b.getBoundingClientRect(), p = b.parentElement!.getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1; });
        expect(vis).toBe(true);
        await expect(wrap).toHaveClass(/fade-l/);
        await expect(wrap).not.toHaveClass(/fade-r/);
      } else {
        expect(m.overflow).toBeLessThanOrEqual(0);
        await expect(wrap).not.toHaveClass(/fade-[lr]/);
      }
    }
  });
  test('UX #379 P3 ①：一次选多张时按选择的顺序进列表（第 1 张最后传完也排第 1）', async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    // 第 1 个 POST 晚 2 秒放行：第 2、3 张先传完
    let first = true;
    await page.route(`**${S}/assets`, async (route) => {
      if (route.request().method() === 'POST' && first) { first = false; await new Promise((r) => setTimeout(r, 2000)); }
      await route.fallback();
    });
    // 三张尺寸不同（卡片 img 的 width / height = sm 实际宽高），用来认顺序
    await fileInput(page).setInputFiles([
      { name: 'one.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [200, 40, 40]) },
      { name: 'two.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1000, [40, 200, 40]) },
      { name: 'three.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1500, 1200, [40, 40, 200]) },
    ]);
    const cards = area.locator('.st-im-card');
    // 第 2、3 张传完了但第 1 张还没：先不入列（仍在上传区）
    await expect(area.locator('.st-im-up[aria-busy="true"]')).toHaveCount(3);
    await expect(cards).toHaveCount(0);
    await expect(cards).toHaveCount(3, { timeout: 10_000 });
    const dims = await cards.locator('.th img').evaluateAll((els) => els.map((e) => `${e.getAttribute('width')}x${e.getAttribute('height')}`));
    expect(dims).toEqual(['800x600', '800x500', '800x640']); // 1500×1200 → sm 长边 800
    await page.unroute(`**${S}/assets`);
  });
  test('UX #379 P3 ②：等 429 重试的文件不占名额（5 张 + 1 个等重试 → 5 / 6、没有「已达上限」、还能加）；满 6 张时重试禁用并说明', async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    // 上传全部用假响应：不经过服务端（不占每分钟 20 次的上传限速）
    let n = 0; let limited = false;
    await page.route(`**${S}/assets`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (limited) return route.fulfill({ status: 429, headers: { 'Retry-After': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'rate_limited' }) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(fakeAsset(`fakeasset${String(++n).padStart(15, '0')}`)) });
    });
    const cards = area.locator('.st-im-card');
    await fileInput(page).setInputFiles([1, 2, 3, 4, 5].map((i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: TINY_JPEG })));
    await expect(cards).toHaveCount(5);
    limited = true;
    await pick(page, 'retry.jpg', 'image/jpeg', TINY_JPEG);
    const tile = area.locator('.st-im-up.bad').filter({ hasText: 'retry.jpg' });
    await expect(tile).toContainText('上传太频繁，请稍后再试');
    await expect(area.locator('.st-count').first()).toHaveText('5 / 6');
    await expect(area.getByText('已达上限：最多 6 张')).toHaveCount(0);
    await expect(fileInput(page)).toHaveCount(1);
    await expect(area.getByText('还可加 1 张')).toBeVisible();
    // 再传一张占满 6 张：「已达上限」、上传区隐藏；等重试的那张重试禁用并说明原因
    limited = false;
    await pick(page, 'six.jpg', 'image/jpeg', TINY_JPEG);
    await expect(cards).toHaveCount(6);
    await expect(area.getByText('已达上限：最多 6 张')).toBeVisible();
    await expect(fileInput(page)).toHaveCount(0);
    await expect(tile).toContainText('已有 6 张，移除一张后才能重试');
    await page.waitForTimeout(1200); // 过了 Retry-After 也不能重试
    await expect(tile.getByRole('button', { name: '重试' })).toBeDisabled();
    // 移除一张 → 可以重试，重试成功回到 6 张
    await cards.nth(5).getByRole('button', { name: '删除第 6 张图片' }).click();
    await expect(cards).toHaveCount(5);
    await expect(tile).not.toContainText('已有 6 张');
    await tile.getByRole('button', { name: '重试' }).click();
    await expect(cards).toHaveCount(6);
    await expect(area.locator('.st-im-up.bad')).toHaveCount(0);
    await page.unroute(`**${S}/assets`);
  });
  test('spec v1.0.10：后台卡片缩略图 4:3 裁切（1440 / 390）；竖图卡片下黄色提示，不阻止保存', async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    // 假响应：一张横图、一张竖图（lg 1200×1600），不经过服务端
    let n = 0;
    await page.route(`**${S}/assets`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const id = `fakeportrait${String(++n).padStart(12, '0')}`;
      const a = fakeAsset(id);
      const body = n === 2 ? { ...a, width: 1200, height: 1600, sm: { ...a.sm, width: 600, height: 800 }, lg: { ...a.lg, width: 1200, height: 1600 } } : a;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await fileInput(page).setInputFiles([{ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG }, { name: 'tall.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG }]);
    const cards = area.locator('.st-im-card');
    await expect(cards).toHaveCount(2);
    const note = '竖图在前台会裁成 4:3 横图显示，建议上传横图';
    await expect(cards.nth(0).getByText(note)).toHaveCount(0);
    await expect(cards.nth(1).getByText(note)).toBeVisible();
    await expect(cards.nth(1).locator('.st-im-portrait')).toHaveCSS('color', 'rgb(138, 101, 0)');
    for (const w of [1440, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      for (const i of [0, 1]) {
        const th = (await cards.nth(i).locator('.th').boundingBox())!;
        expect(Math.abs(th.width / th.height - 4 / 3)).toBeLessThan(0.02);
        await expect(cards.nth(i).locator('.th img')).toHaveCSS('object-fit', 'cover');
      }
    }
    // 不阻止保存：填了替代文字就能点「保存」（这里不真的保存：假图片不在库里）
    for (const i of [0, 1]) await cards.nth(i).getByLabel(/替代文字（EN）/).fill(`Alt ${i}`);
    await expect(saveBtn(page)).toBeEnabled();
    await page.unroute(`**${S}/assets`);
  });
  test('UX #379 P2：确认框的焦点锁在框内（Tab / Shift+Tab 循环、点到框外再 Tab 也回到框内），Esc 关闭后焦点回到「删除」', async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await page.goto('/admin/settings');
    const area = page.locator('.st-im');
    await fileInput(page).setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, [120, 60, 30]) });
    await expect(area.locator('.st-im-card')).toHaveCount(1);
    await area.getByText(/图片库（已上传 1 张）/).click();
    const del = area.locator('.st-im-libl li').first().getByRole('button', { name: '删除' });
    await del.click(); // 草稿里加了、还没保存：不在「已保存」列表里，可以删 → 弹确认
    const dlg = page.getByRole('alertdialog', { name: '删除这张图片？' });
    const cancel = dlg.getByRole('button', { name: '取消' });
    const ok = dlg.getByRole('button', { name: '删除' });
    await expect(cancel).toBeFocused();
    for (const [key, el] of [['Tab', ok], ['Tab', cancel], ['Tab', ok], ['Shift+Tab', cancel], ['Shift+Tab', ok], ['Shift+Tab', cancel]] as const) {
      await page.keyboard.press(key);
      await expect(el).toBeFocused();
    }
    // 点遮罩（焦点落到 body）后再按 Tab：回到框内第一个
    await page.mouse.click(4, 4);
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(del).toBeFocused();
    await expect(area.locator('.st-im-libl li')).toHaveCount(1); // Esc = 取消，没删
  });
});
