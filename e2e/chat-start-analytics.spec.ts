import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { E2E_EDGE_AUTH_SECRET } from '../scripts/e2e-edge-auth';
import { expect, test } from './fixtures';

const CHAT_ANALYTICS_EDGE_IPS: Readonly<Record<string, string>> = {
  'consented chat emits single chat_start -> aggregate increments chatStarts; reply & retry dedupe cleanly': '198.18.20.1',
  'decline + later post-consent never backfills chat_start; failed send and spoofed productSlug handled cleanly': '198.18.20.2',
  'R3: declined submit saved on server -> lost response -> post-consent -> same-key retry duplicate=true emits zero chat_start': '198.18.20.3',
  'R3: originally consented submit -> lost response -> manual retry duplicate=true emits chat_start once': '198.18.20.4',
};

const E2E_DB = process.env.DATABASE_URL;
let db: PrismaClient | undefined;

function prisma(): PrismaClient {
  if (!E2E_DB) throw new Error('E2E requires DATABASE_URL');
  db ??= new PrismaClient({ datasources: { db: { url: E2E_DB } } });
  return db;
}

test.afterAll(async () => {
  await db?.$disconnect();
});

async function runAggregateNow(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('expected CRON_SECRET');
  const res = await request.post('/api/admin/cron/operations', {
    headers: { authorization: `Bearer ${secret}` },
    data: { jobKey: 'analytics-aggregate' },
    timeout: 60_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('SUCCEEDED');
}

async function readSiteAndProductChatStarts(productSlug: string): Promise<{ site: number; product: number }> {
  const rows = await prisma().analyticsDaily.findMany({
    where: {
      dimension: { in: ['site', `product:${productSlug}`] },
    },
    orderBy: { localDate: 'desc' },
  });
  let site = 0;
  let product = 0;
  for (const row of rows) {
    if (row.dimension === 'site') site += row.chatStarts;
    if (row.dimension === `product:${productSlug}`) product += row.chatStarts;
  }
  return { site, product };
}

test.describe('M4-T5 consent-gated chat_start analytics producer', () => {
  test.beforeEach(async ({ context }, testInfo) => {
    const ip = CHAT_ANALYTICS_EDGE_IPS[testInfo.title];
    if (!ip) throw new Error(`Missing edge IP mapping for test: ${testInfo.title}`);
    await context.setExtraHTTPHeaders({
      'x-edge-auth': E2E_EDGE_AUTH_SECRET,
      'cf-connecting-ip': ip,
    });
  });

  test('consented chat emits single chat_start -> aggregate increments chatStarts; reply & retry dedupe cleanly', async ({
    page,
    request,
    external,
  }) => {
    const productSlug = 'color-boxes';
    await runAggregateNow(request);
    const beforeCounts = await readSiteAndProductChatStarts(productSlug);

    const postedEvents: Array<Record<string, unknown>> = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/analytics/events') && req.method() === 'POST') {
        const json = req.postDataJSON() as { events?: Array<Record<string, unknown>> } | null;
        if (json?.events) postedEvents.push(...json.events);
      }
    });

    await page.goto('/en/products');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.waitForResponse(
      (res) => res.url().endsWith('/api/analytics/consent') && res.request().method() === 'POST',
    );

    // Navigate from products page to contact page via visible product inquiry CTA
    await page.locator(`a[href*="/contact?product=${productSlug}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/en/contact\\?product=${productSlug}`));

    // Capture current navigationId from page_view on /en/contact
    await expect
      .poll(() => postedEvents.filter((e) => e.kind === 'page_view' && e.path === '/en/contact').length)
      .toBeGreaterThanOrEqual(1);
    const contactPageView = [...postedEvents]
      .reverse()
      .find((e) => e.kind === 'page_view' && e.path === '/en/contact')!;
    const navigationId = String(contactPageView.navigationId);
    expect(navigationId).toMatch(/^[0-9a-f-]{36}$/i);

    // Opening chat window alone must NOT emit chat_start
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.waitForTimeout(200);
    expect(postedEvents.filter((e) => e.kind === 'chat_start')).toHaveLength(0);

    // Force first /api/analytics/events batch carrying chat_start to fail 503 once so M5 queue retries with SAME eventId
    let failAnalyticsOnce = true;
    await page.route('**/api/analytics/events', async (route) => {
      if (failAnalyticsOnce && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { events?: Array<{ kind?: string }> };
        if (body.events?.some((e) => e.kind === 'chat_start')) {
          failAnalyticsOnce = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'service_unavailable', requestId: randomUUID() }),
          });
          return;
        }
      }
      await route.continue();
    });

    // Also drop first /api/chat/conversations response once to verify requestApi idempotent retry does NOT generate a 2nd chat_start
    let dropCreateOnce = true;
    await page.route('**/api/chat/conversations', async (route) => {
      if (dropCreateOnce && route.request().method() === 'POST') {
        dropCreateOnce = false;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.getByLabel('Email (optional)').fill('lead@example.com');
    await page.getByLabel('Message').fill('Need 5000 color boxes with foil print');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling', {
      timeout: 15_000,
    });

    await expect.poll(() => postedEvents.filter((e) => e.kind === 'chat_start').length).toBeGreaterThanOrEqual(2);
    const chatStarts = postedEvents.filter((e) => e.kind === 'chat_start');
    const eventIds = new Set(chatStarts.map((e) => String(e.eventId)));
    expect(eventIds.size).toBe(1);

    const emitted = chatStarts[0];
    expect(emitted.navigationId).toBe(navigationId);
    expect(emitted.path).toBe('/en/contact');
    expect(emitted.productSlug).toBe(productSlug);
    expect(Object.keys(emitted).sort()).toEqual(
      ['eventId', 'kind', 'locale', 'navigationId', 'occurredAt', 'path', 'productSlug'].sort(),
    );

    // Reply in same thread does NOT emit another chat_start
    const countBeforeReply = chatStarts.length;
    await page.getByLabel('Message').fill('Second follow-up reply');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message-item')).toHaveCount(2);
    await page.waitForTimeout(300);
    expect(postedEvents.filter((e) => e.kind === 'chat_start').length).toBe(countBeforeReply);

    // Verify DB raw event and real analytics-aggregate rollup chatStarts increment by 1
    const dbEvents = await prisma().analyticsEvent.findMany({
      where: { navigationId, kind: 'chat_start' },
    });
    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0].eventId).toBe(emitted.eventId);
    expect(dbEvents[0].productSlug).toBe(productSlug);
    expect(dbEvents[0].path).toBe('/en/contact');

    await runAggregateNow(request);
    const afterCounts = await readSiteAndProductChatStarts(productSlug);
    expect(afterCounts.site).toBe(beforeCounts.site + 1);
    expect(afterCounts.product).toBe(beforeCounts.product + 1);
    expect(external.urls).toEqual([]);
  });

  test('decline + later post-consent never backfills chat_start; failed send and spoofed productSlug handled cleanly', async ({
    page,
    external,
  }) => {
    const analyticsCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/analytics/events')) {
        analyticsCalls.push(req.postData() ?? '');
      }
    });

    // 1) Decline analytics, complete necessary chat, then grant consent afterwards -> zero backfill
    await page.goto('/en/contact');
    await page.getByRole('button', { name: 'Reject all' }).click();
    await page.waitForResponse(
      (res) => res.url().endsWith('/api/analytics/consent') && res.request().method() === 'POST',
    );

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.getByLabel('Message').fill('Necessary inquiry while analytics declined');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling');
    expect(analyticsCalls).toEqual([]);

    // Post-consent after message already received
    await page.getByTestId('chat-close').click();
    await page.getByRole('button', { name: 'Cookie settings' }).click();
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.waitForResponse(
      (res) => res.url().endsWith('/api/analytics/consent') && res.request().method() === 'POST',
    );

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.getByTestId('chat-refresh').click();
    await page.getByLabel('Message').fill('Reply after post-consent');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message-item')).toHaveCount(2);
    await page.waitForTimeout(300);

    expect(analyticsCalls.some((payload) => payload.includes('chat_start'))).toBe(false);

    // 2) Spoofed ?product= query is sanitized out; failed send emits zero chat_start
    const capturedChatStarts: Array<Record<string, unknown>> = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/analytics/events') && req.method() === 'POST') {
        const parsed = req.postDataJSON() as { events?: Array<Record<string, unknown>> } | null;
        for (const item of parsed?.events ?? []) {
          if (item.kind === 'chat_start') capturedChatStarts.push(item);
        }
      }
    });

    await page.goto('/en/contact?product=forged-nonexistent-slug&utm_secret=token123');
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    // Failed submit emits 0 chat_start
    let failOnce = true;
    await page.route('**/api/chat/conversations', async (route) => {
      if (failOnce && route.request().method() === 'POST') {
        failOnce = false;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid', requestId: randomUUID(), fieldErrors: { bodyText: 'Bad body' } }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByLabel('Message').fill('First attempt fails 400');
    await page.getByTestId('chat-send').click();
    await expect(page.getByText('Bad body')).toBeVisible();
    await page.waitForTimeout(200);
    expect(capturedChatStarts).toHaveLength(0);

    // Clean retry succeeds and emits chat_start WITHOUT forged productSlug or ?query
    await page.unroute('**/api/chat/conversations');
    await page.getByLabel('Message').fill('Valid message with forged URL param stripped');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling');

    await expect.poll(() => capturedChatStarts.length).toBe(1);
    expect(capturedChatStarts[0].productSlug).toBeUndefined();
    expect(capturedChatStarts[0].path).toBe('/en/contact');
    expect(external.urls).toEqual([]);
  });

  test('R3: declined submit saved on server -> lost response -> post-consent -> same-key retry duplicate=true emits zero chat_start', async ({
    page,
    external,
  }) => {
    test.setTimeout(45_000);
    const marker = randomUUID().slice(0, 8);
    const analyticsCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/analytics/events') && req.method() === 'POST') {
        analyticsCalls.push(req.postData() ?? '');
      }
    });

    await page.goto('/en/contact');
    await page.getByRole('button', { name: 'Reject all' }).click();
    await page.waitForResponse(
      (res) => res.url().endsWith('/api/analytics/consent') && res.request().method() === 'POST',
    );

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    // First real attempt writes to DB, then drops response across internal retries to enter manual retry;
    // when unblocked, capture the real HTTP JSON body directly via route.fetch() to verify duplicate=true safely.
    let capturedClientConvId = '';
    let dropStage = true;
    let forwardedWriteCount = 0;
    let retryJson: { conversationId: string; duplicate: boolean } | undefined;
    await page.route('**/api/chat/conversations', async (route) => {
      if (route.request().method() === 'POST') {
        if (dropStage) {
          const body = route.request().postDataJSON() as { clientConversationId: string };
          capturedClientConvId = body.clientConversationId;
          if (forwardedWriteCount === 0) {
            forwardedWriteCount += 1;
            const realRes = await route.fetch();
            expect([200, 201]).toContain(realRes.status());
          }
          await route.abort('failed');
          return;
        }
        const realRes = await route.fetch();
        expect(realRes.status()).toBe(200);
        retryJson = (await realRes.json()) as { conversationId: string; duplicate: boolean };
        await route.fulfill({ response: realRes });
        return;
      }
      await route.continue();
    });

    const msgText = `R3 declined lost response [${marker}]`;
    await page.getByLabel('Message').fill(msgText);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-send-error')).toBeVisible({ timeout: 20_000 });
    expect(capturedClientConvId).toBeTruthy();

    // Verify 1 conversation & 1 message are already persisted in PostgreSQL while UI has no receipt yet
    const preRetryConv = await prisma().chatConversation.findFirst({
      where: { clientConversationId: capturedClientConvId },
      include: { messages: true },
    });
    expect(preRetryConv).not.toBeNull();
    expect(preRetryConv?.messages).toHaveLength(1);
    expect(analyticsCalls).toEqual([]);

    // User now grants analytics consent AFTER the original submission was already saved under decline.
    // Activate footer Cookie settings via keyboard focus so the open floating chat panel stays mounted with its draft.
    await page.locator('#cookie-settings-link').focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Accept all' }).click();
    await page.waitForResponse(
      (res) => res.url().endsWith('/api/analytics/consent') && res.request().method() === 'POST',
    );

    // Unblock and manually retry with the SAME clientConversationId -> server returns duplicate=true
    dropStage = false;
    const retryPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const retryRes = await retryPromise;
    expect(retryRes.status()).toBe(200);
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling');
    await page.unroute('**/api/chat/conversations');
    expect(retryJson?.duplicate).toBe(true);
    expect(retryJson?.conversationId).toBe(preRetryConv!.id);
    await page.waitForTimeout(400);

    // Zero chat_start emitted or persisted, and DB still has exactly 1 conversation & 1 message
    expect(analyticsCalls.some((p) => p.includes('chat_start'))).toBe(false);
    const convRows = await prisma().chatConversation.findMany({
      where: { clientConversationId: capturedClientConvId },
      include: { messages: true },
    });
    expect(convRows).toHaveLength(1);
    expect(convRows[0].messages).toHaveLength(1);
    expect(external.urls).toEqual([]);
  });

  test('R3: originally consented submit -> lost response -> manual retry duplicate=true emits chat_start once', async ({
    page,
    request,
    external,
  }) => {
    test.setTimeout(45_000);
    const marker = randomUUID().slice(0, 8);
    await runAggregateNow(request);
    const beforeCounts = await readSiteAndProductChatStarts('color-boxes');

    const postedEvents: Array<Record<string, unknown>> = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/analytics/events') && req.method() === 'POST') {
        const json = req.postDataJSON() as { events?: Array<Record<string, unknown>> } | null;
        if (json?.events) postedEvents.push(...json.events);
      }
    });

    await page.goto('/en/products');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.waitForResponse(
      (res) => res.url().endsWith('/api/analytics/consent') && res.request().method() === 'POST',
    );
    await page.locator('a[href*="/contact?product=color-boxes"]').first().click();
    await expect(page).toHaveURL(/\/en\/contact\?product=color-boxes/);

    await expect
      .poll(() => postedEvents.filter((e) => e.kind === 'page_view' && e.path === '/en/contact').length)
      .toBeGreaterThanOrEqual(1);
    const navigationId = String(
      [...postedEvents].reverse().find((e) => e.kind === 'page_view' && e.path === '/en/contact')!.navigationId,
    );

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    let dropStage = true;
    let forwarded = 0;
    let retryJson: { duplicate: boolean } | undefined;
    await page.route('**/api/chat/conversations', async (route) => {
      if (route.request().method() === 'POST') {
        if (dropStage) {
          if (forwarded === 0) {
            forwarded += 1;
            const realRes = await route.fetch();
            expect([200, 201]).toContain(realRes.status());
          }
          await route.abort('failed');
          return;
        }
        const realRes = await route.fetch();
        expect(realRes.status()).toBe(200);
        retryJson = (await realRes.json()) as { duplicate: boolean };
        await route.fulfill({ response: realRes });
        return;
      }
      await route.continue();
    });

    await page.getByLabel('Message').fill(`R3 consented lost response [${marker}]`);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-send-error')).toBeVisible({ timeout: 20_000 });
    expect(postedEvents.filter((e) => e.kind === 'chat_start')).toHaveLength(0);

    // Manual same-key retry receives duplicate=true and emits chat_start once
    dropStage = false;
    const retryPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const retryRes = await retryPromise;
    expect(retryRes.status()).toBe(200);
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling');
    await page.unroute('**/api/chat/conversations');
    expect(retryJson?.duplicate).toBe(true);

    await expect.poll(() => postedEvents.filter((e) => e.kind === 'chat_start').length).toBe(1);
    const dbEvents = await prisma().analyticsEvent.findMany({
      where: { navigationId, kind: 'chat_start' },
    });
    expect(dbEvents).toHaveLength(1);

    await runAggregateNow(request);
    const afterCounts = await readSiteAndProductChatStarts('color-boxes');
    expect(afterCounts.site).toBe(beforeCounts.site + 1);
    expect(afterCounts.product).toBe(beforeCounts.product + 1);
    expect(external.urls).toEqual([]);
  });
});
