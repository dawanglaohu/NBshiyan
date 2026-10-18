import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import sharp from 'sharp';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import type { Page } from '@playwright/test';

// #350 /admin/settings「关于我们 · 图片列表」：真实页面 + 真实接口（#374 PublicAsset），仅 E2E 测试库。
// 每个测试新建一个 ADMIN（scripts/create-admin.mjs，ADMIN_SEED_TOTP_SECRET 只在非生产可用），按管理员的上传限速互不影响。
const PASSWORD = 'e2e-img-Passw0rd!';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 测试用假密钥
const origin = { Origin: BASE };
const S = '/api/admin/site-settings';

async function loginFreshAdmin(page: Page) {
  const email = `e2e-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: 'E2E img', ADMIN_SEED_ROLE: 'ADMIN', ADMIN_SEED_TOTP_SECRET: TOTP },
  });
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrfToken as string;
  const ok = await page.request.post('/api/auth/callback/credentials', { headers: origin, form: { csrfToken: csrf, email, password: PASSWORD, totp: authenticator.generate(TOTP) }, maxRedirects: 0 });
  expect(ok.headers()['location'] ?? '').not.toContain('error');
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

const fileInput = (page: Page) => page.locator('.st-im input[type=file]');
const pick = (page: Page, name: string, mimeType: string, buffer: Buffer) => fileInput(page).setInputFiles({ name, mimeType, buffer });
const saveBtn = (page: Page) => page.getByRole('region', { name: '保存' }).getByRole('button', { name: '保存' });
const savedOk = (page: Page) => expect(page.getByRole('status').filter({ hasText: '✓ 已保存' })).toBeVisible();

test('图片列表：上传、替代文字必填、各种被拒、429 保留文件、去重、6 张上限、排序保存、前台 srcset', async ({ page }) => {
  test.setTimeout(150_000);
  await loginFreshAdmin(page);
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
  // 右栏完整度清单最后一项：!「图片替代文字 · 1 张缺失」→ 填了以后 ✓
  const chk = page.locator('section[aria-labelledby="st-chk-h"] li').last();
  await expect(chk).toContainText('图片替代文字 · 1 张缺失');
  await expect(chk.locator('.i')).toHaveClass(/missing/);
  // 「1 张」之间的空格在 12px 下也看得出来（≥ 4px）
  expect(await chk.evaluate((li) => { const cs = getComputedStyle(li); const c = document.createElement('canvas').getContext('2d')!; c.font = `${cs.fontSize} ${cs.fontFamily}`; return c.measureText(' ').width + parseFloat(cs.wordSpacing); })).toBeGreaterThanOrEqual(4);
  await cards.first().getByLabel(/替代文字（EN）/).fill('Sample alt 1');
  await expect(saveBtn(page)).toBeEnabled();
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
  await expect(imgs.first()).toHaveAttribute('sizes', '(min-width: 1024px) 50vw, 100vw');
});

test('图片库：在用的图不能删（asset_in_use）；移除并保存后可以删，先确认；409 走关于页的冲突流程', async ({ page }) => {
  test.setTimeout(90_000);
  await loginFreshAdmin(page);
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
  await loginFreshAdmin(page);
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

test('UX 复审：<640px 单列卡片、输入框占满宽度；1440 多列；删除用 ✕，上移 / 下移 / 删除第 N 张图片的 aria-label；控件 ≥ 44px', async ({ page }) => {
  test.setTimeout(90_000);
  await loginFreshAdmin(page);
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
    await loginFreshAdmin(page);
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
  await loginFreshAdmin(page);
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
