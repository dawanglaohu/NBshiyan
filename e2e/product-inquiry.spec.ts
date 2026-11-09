import { PrismaClient } from '@prisma/client';
import { expect, test, type Page } from './fixtures';

const db = new PrismaClient();

test.afterAll(async () => {
  await db.$disconnect();
});

type Locale = 'en' | 'ru';

async function dismissConsent(page: Page, locale: Locale = 'en') {
  const name = locale === 'ru' ? 'Согласие на использование cookie' : 'Cookie consent';
  const reject = locale === 'ru' ? 'Отклонить все' : 'Reject all';
  const bar = page.getByRole('region', { name });
  const appeared = await bar.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true, () => false);
  if (!appeared) return;
  await bar.getByRole('button', { name: reject }).click();
  await expect(bar).toBeHidden();
}

/** 向导第 0/1 步的 Next 与第 2 步的 Submit 都是同一个 submit 按钮；点两次进第 3 步。 */
async function advanceTwice(page: Page) {
  const button = page.locator('.iq-actions button[type="submit"]');
  await button.click();
  await button.click();
  await expect(page.locator('#iq-name')).toBeVisible();
}

async function fillContact(page: Page, email: string) {
  await page.locator('#iq-name').fill('M2-T5 QA');
  await page.locator('#iq-email').fill(email);
  await page.locator('#iq-company').fill('M2-T5 QA Co');
  await page.locator('#iq-region').selectOption('DE');
  await page.locator('#iq-consent').check();
}

async function submitAndRead(page: Page) {
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveCount(1);
  await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('');
  const reqPromise = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries');
  const respPromise = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries');
  await page.locator('.iq-actions button[type="submit"]').click();
  const req = await reqPromise;
  const resp = await respPromise;
  expect(resp.status()).toBe(201);
  const body = (await resp.json()) as { ref?: string };
  expect(body.ref).toMatch(/^PJ-/);
  await expect(page.locator('.wizard-done')).toContainText(body.ref!);
  return { body: req.postDataJSON() as { source?: string; items?: { productSlug?: string }[] }, ref: body.ref! };
}

function norm(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

async function cardText(first: ReturnType<Page['locator']>) {
  const name = norm((await first.locator('h2').textContent()) ?? '');
  const specs = (await first.locator('.specs li').allTextContents()).map(norm);
  const slug = await first.getByTestId('inquire-product').getAttribute('data-slug');
  return { name, specs, slug: slug ?? '' };
}

test('EN: card inquire-product carries the same product/spec into the wizard and persists a real Inquiry', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/en');
  await dismissConsent(page);
  await page.goto('/en/products');
  const first = page.locator('article.card').first();
  const card = await cardText(first);
  expect(card.slug).not.toBe('');
  expect(card.specs.length).toBeGreaterThan(0);

  let inquiryPosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries') inquiryPosts += 1;
  });

  // 提交前拖动模型、用键盘控制，不得产生询盘 POST。
  const viewport = first.getByTestId('product-viewport');
  await viewport.scrollIntoViewIfNeeded();
  const box = await viewport.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 6 });
    await page.mouse.up();
  }
  await viewport.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('+');
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  expect(inquiryPosts).toBe(0);

  await first.getByTestId('inquire-product').click();
  await expect(page).toHaveURL(new RegExp(`/en/contact\\?product=${card.slug}$`));
  await expect(page.getByTestId('inquiry-product-context')).toContainText(card.name);
  const shownSpecs = (await page.getByTestId('inquiry-product-specs').locator('li').allTextContents()).map(norm);
  expect(shownSpecs).toEqual(card.specs.slice(0, 3));

  await advanceTwice(page);
  await fillContact(page, `m2t5-en-${Date.now()}@example.test`);
  const { body, ref } = await submitAndRead(page);
  expect(body.source).toBe('WIZARD');
  expect(body.items?.[0]?.productSlug).toBe(card.slug);
  expect(inquiryPosts).toBe(1);

  const saved = await db.inquiry.findUnique({ where: { ref }, select: { locale: true, source: true, items: { select: { productSlug: true } } } });
  expect(saved).not.toBeNull();
  expect(saved!.locale).toBe('en');
  expect(saved!.source).toBe('WIZARD');
  expect(saved!.items.map((i) => i.productSlug)).toContain(card.slug);
});

test('RU 390: card entry preselects the same product/spec and submits a real Inquiry', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ru');
  await dismissConsent(page, 'ru');
  await page.goto('/ru/products');
  const first = page.locator('article.card').first();
  const card = await cardText(first);
  expect(card.slug).not.toBe('');
  await first.getByTestId('inquire-product').click();
  await expect(page).toHaveURL(new RegExp(`/ru/contact\\?product=${card.slug}$`));
  await expect(page.getByTestId('inquiry-product-context')).toContainText(card.name);
  const shownSpecs = (await page.getByTestId('inquiry-product-specs').locator('li').allTextContents()).map(norm);
  expect(shownSpecs).toEqual(card.specs.slice(0, 3));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await advanceTwice(page);
  await fillContact(page, `m2t5-ru-${Date.now()}@example.test`);
  const { body, ref } = await submitAndRead(page);
  expect(body.source).toBe('WIZARD');
  expect(body.items?.[0]?.productSlug).toBe(card.slug);

  const saved = await db.inquiry.findUnique({ where: { ref }, select: { locale: true, source: true, items: { select: { productSlug: true } } } });
  expect(saved).not.toBeNull();
  expect(saved!.locale).toBe('ru');
  expect(saved!.source).toBe('WIZARD');
  expect(saved!.items.map((i) => i.productSlug)).toContain(card.slug);
});

test('EN 390: card name/spec and the inquiry entry stay visible without a POST', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.goto('/en/products');
  const first = page.locator('article.card').first();
  const card = await cardText(first);
  await expect(first.locator('h2')).toBeVisible();
  await expect(first.locator('.specs li').first()).toBeVisible();
  await expect(first.getByTestId('inquire-product')).toBeVisible();

  let inquiryPosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries') inquiryPosts += 1;
  });
  await first.getByTestId('inquire-product').click();
  await expect(page).toHaveURL(new RegExp(`/en/contact\\?product=${card.slug}$`));
  await expect(page.getByTestId('inquiry-product-context')).toContainText(card.name);
  expect(inquiryPosts).toBe(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('API: non-catalog WIZARD is 400, designId item is exempt after liveDesignIds, from=quote keeps CART prefill', async ({ page }) => {
  test.setTimeout(60_000);
  const token = 'XXXX.DUMMY.TOKEN.1';
  const contact = { name: 'M2-T5 API', email: `m2t5-api-${Date.now()}@example.test`, region: 'DE' };

  const before = await db.inquiryItem.count({ where: { productSlug: 'not-a-catalog-product' } });
  const bad = await page.request.post('/api/inquiries', {
    data: { source: 'WIZARD', locale: 'en', contact, items: [{ productSlug: 'not-a-catalog-product' }], turnstileToken: token },
  });
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { error?: string }).error).toBe('invalid');
  expect(await db.inquiryItem.count({ where: { productSlug: 'not-a-catalog-product' } })).toBe(before);

  const design = await page.request.post('/api/designs', {
    data: { productSlug: 'not-a-catalog-product', locale: 'en', config: {}, turnstileToken: token },
  });
  expect(design.status()).toBe(201);
  const designId = ((await design.json()) as { id: string }).id;

  const exempt = await page.request.post('/api/inquiries', {
    data: {
      source: 'WIZARD', locale: 'en',
      contact: { ...contact, email: `m2t5-design-${Date.now()}@example.test` },
      items: [{ productSlug: 'not-a-catalog-product', designId }], turnstileToken: token,
    },
  });
  expect(exempt.status()).toBe(201);
  const ref = ((await exempt.json()) as { ref: string }).ref;
  const saved = await db.inquiryItem.findFirst({ where: { inquiry: { ref } }, select: { productSlug: true, designId: true } });
  expect(saved).toMatchObject({ productSlug: 'not-a-catalog-product', designId });

  // from=quote 仍按原 CART 清单预填；同 URL 的 product 参数不得覆盖。
  await page.goto('/en');
  await page.evaluate(() => localStorage.setItem('pj-quote-v1', JSON.stringify([{ slug: 'gift-boxes' }])));
  await page.goto('/en/contact?from=quote&product=color-boxes');
  await expect(page.getByRole('checkbox', { name: 'Gift Boxes' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Color Boxes' })).not.toBeChecked();
});
