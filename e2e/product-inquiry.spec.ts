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

/** 真实拖动并按键控制卡片模型；调用方负责断言此间没有询盘 POST。 */
async function controlCardModel(page: Page, card: ReturnType<Page['locator']>) {
  const viewport = card.getByTestId('product-viewport');
  await viewport.scrollIntoViewIfNeeded();
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await viewport.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('+');
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
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
  await controlCardModel(page, first);
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
  let inquiryPosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries') inquiryPosts += 1;
  });

  // 390 窄屏同样先真实拖动、键盘控制，确认不产生询盘 POST。
  await controlCardModel(page, first);
  expect(inquiryPosts).toBe(0);
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
  expect(inquiryPosts).toBe(1);

  const saved = await db.inquiry.findUnique({ where: { ref }, select: { locale: true, source: true, items: { select: { productSlug: true } } } });
  expect(saved).not.toBeNull();
  expect(saved!.locale).toBe('ru');
  expect(saved!.source).toBe('WIZARD');
  expect(saved!.items.map((i) => i.productSlug)).toContain(card.slug);
});

test('EN 390: card name/spec and inquiry entry stay visible and submit a real Inquiry', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.goto('/en/products');
  const first = page.locator('article.card').first();
  const card = await cardText(first);
  expect(card.slug).not.toBe('');
  await expect(first.locator('h2')).toBeVisible();
  await expect(first.locator('.specs li').first()).toBeVisible();
  await expect(first.getByTestId('inquire-product')).toBeVisible();

  let inquiryPosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries') inquiryPosts += 1;
  });
  await controlCardModel(page, first);
  expect(inquiryPosts).toBe(0);
  await first.getByTestId('inquire-product').click();
  await expect(page).toHaveURL(new RegExp(`/en/contact\\?product=${card.slug}$`));
  await expect(page.getByTestId('inquiry-product-context')).toContainText(card.name);
  const shownSpecs = (await page.getByTestId('inquiry-product-specs').locator('li').allTextContents()).map(norm);
  expect(shownSpecs).toEqual(card.specs.slice(0, 3));
  expect(inquiryPosts).toBe(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await advanceTwice(page);
  await fillContact(page, `m2t5-en390-${Date.now()}@example.test`);
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

test('API: non-catalog WIZARD is 400 and from=quote keeps CART prefill', async ({ page }) => {
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

  // from=quote 仍按原 CART 清单预填；同 URL 的 product 参数不得覆盖。
  await page.goto('/en');
  await page.evaluate(() => localStorage.setItem('pj-quote-v1', JSON.stringify([{ slug: 'gift-boxes' }])));
  await page.goto('/en/contact?from=quote&product=color-boxes');
  await expect(page.getByRole('checkbox', { name: 'Gift Boxes' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Color Boxes' })).not.toBeChecked();
});

test('catalog: gift-boxes card keeps its category key; published READY and designId items are accepted', async ({ page }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const emailPrefix = `m2t5-pub-${stamp}`;
  const publishedSlug = `published-gift-box-${stamp}`;
  let modelId: string | undefined;
  let designId: string | undefined;
  let failure: unknown;
  try {
    const model = await db.model3D.create({
      data: {
        productSlug: publishedSlug,
        category: 'gift-boxes',
        sortOrder: -2_000_000_000,
        publishedAt: new Date(),
        sourceKey: `e2e/m2t5/${stamp}.glb`,
        published: true,
        status: 'READY',
      },
    });
    modelId = model.id;

    const listed = await page.request.get('/api/models');
    expect(listed.status()).toBe(200);
    const list = (await listed.json()) as { items?: { productSlug?: string }[] };
    expect(list.items?.some((item) => item.productSlug === publishedSlug)).toBe(true);

    const design = await page.request.post('/api/designs', {
      data: { productSlug: 'not-a-catalog-product', locale: 'en', config: {}, turnstileToken: 'XXXX.DUMMY.TOKEN.1' },
    });
    expect(design.status()).toBe(201);
    designId = ((await design.json()) as { id: string }).id;

    // 一次请求同时覆盖：静态卡片键、published READY productSlug、designId 豁免。
    const accepted = await page.request.post('/api/inquiries', {
      data: {
        source: 'WIZARD', locale: 'en',
        contact: { name: 'M2-T5 Published', email: `${emailPrefix}-api@example.test`, region: 'DE' },
        items: [
          { productSlug: 'gift-boxes' },
          { productSlug: publishedSlug },
          { productSlug: 'not-a-catalog-product', designId },
        ],
        turnstileToken: 'XXXX.DUMMY.TOKEN.1',
      },
    });
    expect(accepted.status()).toBe(201);
    const apiRef = ((await accepted.json()) as { ref: string }).ref;
    const apiItems = await db.inquiryItem.findMany({
      where: { inquiry: { ref: apiRef } },
      select: { productSlug: true, designId: true },
    });
    expect(apiItems).toHaveLength(3);
    expect(apiItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ productSlug: 'gift-boxes', designId: null }),
      expect.objectContaining({ productSlug: publishedSlug, designId: null }),
      expect.objectContaining({ productSlug: 'not-a-catalog-product', designId }),
    ]));

    // 同一个 Model3D 的 category 是 gift-boxes，卡片入口必须仍发 gift-boxes，而不是 productSlug。
    const revalidated = await page.request.post('/api/site-settings-revalidate');
    expect(revalidated.status()).toBe(204);
    await page.goto('/en/products');
    await dismissConsent(page);
    const pageHtml = await page.content();
    expect(pageHtml).toContain(`/api/models/${model.id}/glb`);
    const entry = page.locator('[data-testid="inquire-product"][data-slug="gift-boxes"]');
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute('href', '/en/contact?product=gift-boxes');
    expect(await page.locator(`[data-testid="inquire-product"][data-slug="${publishedSlug}"]`).count()).toBe(0);
    await entry.click();
    await expect(page).toHaveURL(/\/en\/contact\?product=gift-boxes$/);
    await expect(page.getByTestId('inquiry-product-context')).toContainText('Gift Boxes');
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await clean(() => db.inquiry.deleteMany({ where: { contact: { email: { startsWith: emailPrefix } } } }));
    if (designId) await clean(() => db.sharedDesign.deleteMany({ where: { id: designId } }));
    if (modelId) await clean(() => db.model3D.deleteMany({ where: { id: modelId } }));
    await clean(() => db.contact.deleteMany({ where: { email: { startsWith: emailPrefix }, inquiries: { none: {} } } }));
    if (cleanupErrors.length) {
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'catalog fixture cleanup failed');
    }
    if (failure) throw failure;
  }
  const afterCleanup = await page.request.get('/api/models');
  expect(afterCleanup.status()).toBe(200);
  const afterItems = (await afterCleanup.json()) as { items?: { productSlug?: string }[] };
  expect(afterItems.items?.some((item) => item.productSlug === publishedSlug)).toBe(false);
});

test('invalid product with an old CART leaves the wizard empty instead of substituting another product', async ({ page }) => {
  await page.goto('/en');
  await dismissConsent(page);
  await page.evaluate(() => localStorage.setItem('pj-quote-v1', JSON.stringify([{ slug: 'gift-boxes' }])));
  await page.goto('/en/contact?product=not-a-catalog-product');
  await expect(page.getByRole('button', { name: /Quote list \(1\)/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Gift Boxes' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Corrugated Boxes' })).not.toBeChecked();
  await expect(page.getByTestId('inquiry-product-context')).toHaveCount(0);
});
