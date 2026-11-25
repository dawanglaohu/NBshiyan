import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { consent, expect, test } from './fixtures';

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

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

test.describe('M4-T5 visitor first-party chat composer & UX boundaries', () => {
  test('home -> contact -> lazy session -> send/append/refresh with real DB receipt and no fake online indicators', async ({
    page,
    external,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const sessionRequests: string[] = [];
    const analyticsRequests: string[] = [];

    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/chat/session')) sessionRequests.push(req.method());
      if (url.includes('/api/analytics/')) analyticsRequests.push(url);
    });

    await page.goto('/en');
    await consent(page, 'none');
    await page.goto('/en');

    // Home visible entry control -> /en/contact
    const homeQuote = page.locator('.hero a[href*="/contact"]').first();
    await expect(homeQuote).toBeVisible();
    await homeQuote.click();
    await expect(page).toHaveURL(/\/en\/contact(?:\?.*)?$/);

    // No session call on contact page mount
    await page.waitForLoadState('networkidle');
    expect(sessionRequests).toEqual([]);
    expect(analyticsRequests).toEqual([]);
    expect(external.urls).toEqual([]);
    expect(await page.content()).not.toMatch(/tawk\.to/i);

    const entryBtn = page.getByTestId('contact-human-chat');
    await expect(entryBtn).toBeVisible();
    await expect(entryBtn).toHaveAccessibleName('Contact a person');

    const sessionResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/chat/session') && res.request().method() === 'POST',
    );
    await entryBtn.click();
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.status()).toBe(200);
    const sessionJson = (await sessionResponse.json()) as { available: boolean; expiresAt: string };
    expect(sessionJson.available).toBe(true);
    expect(sessionRequests).toEqual(['POST']);

    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await expect(panel).not.toContainText(/received/i);
    await expect(panel).not.toContainText(/agent.*online|live\s*chat|within\s+\d+\s*h|24\/7|instant/i);
    await expect(panel.locator('[data-online="true"], .online-dot')).toHaveCount(0);

    // Email left empty is valid; also test plain-text characters (<, > without HTML tag)
    const body1 = `Need corrugated sample quote > 200mm & print [${marker}-1]`;
    await page.getByLabel('Message').fill(body1);

    const createResPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const createRes = await createResPromise;
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      conversationId: string;
      message: { id: string; seq: number; bodyText: string; createdAt: string };
      receivedAt: string;
    };
    expect(created.conversationId).toBeTruthy();
    expect(created.message.id).toBeTruthy();
    expect(created.message.seq).toBe(1);
    expect(Date.parse(created.receivedAt)).toBeGreaterThan(0);

    const receipt = page.getByTestId('chat-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('Received, awaiting human handling');
    await expect(receipt).toHaveAttribute('data-conversation-id', created.conversationId);
    await expect(receipt).toHaveAttribute('data-message-id', created.message.id);
    await expect(receipt).toHaveAttribute('data-seq', '1');
    await expect(receipt).toHaveAttribute('data-received-at', created.receivedAt);

    const items = page.getByTestId('chat-message-item');
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toHaveAttribute('data-message-id', created.message.id);
    await expect(items.nth(0)).toHaveAttribute('data-seq', '1');
    await expect(items.nth(0)).toContainText(body1);

    // Verify real PostgreSQL persistence
    const dbConv = await prisma().chatConversation.findUnique({
      where: { id: created.conversationId },
      include: { messages: { orderBy: { seq: 'asc' } } },
    });
    expect(dbConv).not.toBeNull();
    expect(dbConv?.email).toBeNull();
    expect(dbConv?.messages.map((m) => [m.seq, m.bodyText])).toEqual([[1, body1]]);

    // Second message append uses /messages
    const body2 = `Follow-up question [${marker}-2]`;
    await page.getByLabel('Message').fill(body2);
    const appendResPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/chat/conversations/${created.conversationId}/messages`) &&
        res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const appendRes = await appendResPromise;
    expect([200, 201]).toContain(appendRes.status());
    const appended = (await appendRes.json()) as {
      message: { id: string; seq: number };
      receivedAt: string;
    };
    expect(appended.message.seq).toBe(2);
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toHaveAttribute('data-message-id', appended.message.id);
    await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
    await expect(items.nth(1)).toContainText(body2);

    // Insert real operator reply in DB and pull via explicit Refresh messages
    const opText = `Operator follow-up [${marker}-3]`;
    const now = new Date();
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `opmsg_${marker}`,
          conversationId: created.conversationId,
          seq: 3,
          sender: 'OPERATOR',
          authorId: null,
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: opText,
          createdAt: now,
        },
      }),
      prisma().chatConversation.update({
        where: { id: created.conversationId },
        data: { lastSeq: 3, updatedAt: now, lastActivityAt: now },
      }),
    ]);

    const syncResPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/chat/conversations/${created.conversationId}?`) &&
        res.request().method() === 'GET',
    );
    await page.getByTestId('chat-refresh').click();
    const syncRes = await syncResPromise;
    expect(syncRes.status()).toBe(200);
    await expect(items).toHaveCount(3);
    await expect(items.nth(2)).toHaveAttribute('data-sender', 'OPERATOR');
    await expect(items.nth(2)).toHaveAttribute('data-seq', '3');
    await expect(items.nth(2)).toContainText(opText);
    expect(analyticsRequests).toEqual([]);
    expect(external.urls).toEqual([]);
  });

  test('email validation preserves message, network outage retries idempotently, and closing drops unsent drafts', async ({
    page,
  }) => {
    await page.goto('/en/contact');
    await consent(page, 'none');
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const draftText = 'Keep this exact draft message intact across validation errors and network failure';
    const messageInput = page.getByLabel('Message');
    const emailInput = page.getByLabel('Email (optional)');

    await messageInput.fill(draftText);
    await emailInput.fill('Alice <alice@example.com>');
    await page.getByTestId('chat-send').click();

    await expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    await expect(messageInput).toHaveValue(draftText);
    await expect(page.getByTestId('chat-receipt')).toHaveCount(0);

    // Over-length email (> 254 chars) also preserves body
    const longEmail = `${'a'.repeat(245)}@example.com`;
    expect(longEmail.length).toBeGreaterThan(254);
    await emailInput.fill(longEmail);
    await page.getByTestId('chat-send').click();
    await expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    await expect(messageInput).toHaveValue(draftText);

    // Fix email and test network failure -> keeps draft in memory only, no received, offers fallback email
    await emailInput.fill('visitor@example.com');
    let failMode = true;
    const seenClientConvIds: string[] = [];
    await page.route('**/api/chat/conversations', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { clientConversationId?: string };
        if (body.clientConversationId) seenClientConvIds.push(body.clientConversationId);
        if (failMode) {
          await route.abort('failed');
          return;
        }
      }
      await route.continue();
    });

    await page.getByTestId('chat-send').click();
    const errBox = page.getByTestId('chat-send-error');
    await expect(errBox).toBeVisible({ timeout: 15_000 });
    await expect(errBox.getByTestId('chat-fallback-email')).toBeVisible();
    await expect(page.getByTestId('chat-receipt')).toHaveCount(0);
    await expect(page.getByTestId('chat-panel')).not.toContainText(/received/i);
    await expect(messageInput).toHaveValue(draftText);
    await expect(emailInput).toHaveValue('visitor@example.com');

    // No draft or email persisted to web storage
    const storageDump = await page.evaluate(() => ({
      ls: JSON.stringify(localStorage),
      ss: JSON.stringify(sessionStorage),
    }));
    expect(storageDump.ls).not.toContain(draftText);
    expect(storageDump.ss).not.toContain(draftText);
    expect(storageDump.ls).not.toContain('visitor@example.com');
    expect(storageDump.ss).not.toContain('visitor@example.com');

    // Restore network and retry: preserves identical clientConversationId
    failMode = false;
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling');
    expect(seenClientConvIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seenClientConvIds).size).toBe(1);

    // Unsent draft on a new page/tab is NOT persisted after closing chat drawer
    await page.goto('/en/contact');
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.getByLabel('Message').fill('Unsent ephemeral draft');
    await page.getByLabel('Email (optional)').fill('ephemeral@example.com');
    await page.getByTestId('chat-close').click();
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);

    const postCloseStorage = await page.evaluate(() => ({
      ls: JSON.stringify(localStorage),
      ss: JSON.stringify(sessionStorage),
    }));
    expect(postCloseStorage.ls).not.toContain('Unsent ephemeral draft');
    expect(postCloseStorage.ss).not.toContain('Unsent ephemeral draft');

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByLabel('Message')).toHaveValue('');
    await expect(page.getByLabel('Email (optional)')).toHaveValue('');
  });

  test('401/404 and CLOSED threads stop old submits and show Start a new conversation without auto-sending old drafts', async ({
    page,
  }) => {
    // 1) Initial session 401/404 recovery
    await page.goto('/en/contact');
    await consent(page, 'none');

    let rejectFirstSession = true;
    await page.route('**/api/chat/session', async (route) => {
      if (rejectFirstSession && route.request().method() === 'POST') {
        rejectFirstSession = false;
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unauthorized', requestId: randomUUID() }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-terminal-banner')).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    const startNewBtn = page.getByTestId('chat-start-new');
    await expect(startNewBtn).toBeVisible();
    await expect(startNewBtn).toHaveText('Start a new conversation');

    await page.unroute('**/api/chat/session');
    let autoCreateCalls = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/chat/conversations') && req.method() === 'POST') autoCreateCalls += 1;
    });
    await startNewBtn.click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    expect(autoCreateCalls).toBe(0);

    // 2) First message submit hits 404 -> stops submit, Start a new conversation does NOT send old draft
    let return404Once = true;
    await page.route('**/api/chat/conversations', async (route) => {
      if (return404Once && route.request().method() === 'POST') {
        return404Once = false;
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not_found', requestId: randomUUID() }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByLabel('Message').fill('Draft hit 404');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-terminal-banner')).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-start-new')).toBeVisible();

    await page.unroute('**/api/chat/conversations');
    const createCountBeforeReset = autoCreateCalls;
    await page.getByTestId('chat-start-new').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.waitForTimeout(300);
    expect(autoCreateCalls).toBe(createCountBeforeReset);

    // 3) Create real conversation C1, close it in DB, attempt append -> CLOSED stops old submit + E-85 same email does not reopen C1
    await page.getByLabel('Email (optional)').fill('same-email@example.com');
    await page.getByLabel('Message').fill('Initial message C1');
    const c1Promise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const c1Res = await c1Promise;
    expect([200, 201]).toContain(c1Res.status());
    const c1 = (await c1Res.json()) as { conversationId: string };

    await prisma().chatConversation.update({
      where: { id: c1.conversationId },
      data: { status: 'CLOSED' },
    });

    await page.getByLabel('Message').fill('Should not submit to closed C1');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-terminal-banner')).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-start-new')).toBeVisible();

    const createsBeforeNewConv = autoCreateCalls;
    await page.getByTestId('chat-start-new').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.waitForTimeout(300);
    expect(autoCreateCalls).toBe(createsBeforeNewConv);

    // Sending manually with same email starts brand new C2 (does not recover C1)
    await page.getByLabel('Email (optional)').fill('same-email@example.com');
    await page.getByLabel('Message').fill('Fresh message C2');
    const c2Promise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const c2Res = await c2Promise;
    expect([200, 201]).toContain(c2Res.status());
    await expect(page.getByTestId('chat-receipt')).toContainText('Received, awaiting human handling');
    const c2ConversationId = await page.getByTestId('chat-receipt').getAttribute('data-conversation-id');
    expect(c2ConversationId).toBeTruthy();
    expect(c2ConversationId).not.toBe(c1.conversationId);
    const dbC2 = await prisma().chatConversation.findUnique({
      where: { id: c2ConversationId! },
      include: { messages: true },
    });
    expect(dbC2).not.toBeNull();
    expect(dbC2?.messages.map((m) => m.bodyText)).toEqual(['Fresh message C2']);
    await expect(page.getByTestId('chat-message-item')).toHaveCount(1);
    await expect(page.getByTestId('chat-message-item').first()).toContainText('Fresh message C2');
  });

  test('minimalist-flat styles, responsive sizing, no overlap, keyboard focus and 44px targets at 1920/1440/390', async ({
    browser,
  }) => {
    for (const vp of [
      { width: 1920, height: 1080, isMobile: false },
      { width: 1440, height: 900, isMobile: false },
      { width: 390, height: 844, isMobile: true },
    ]) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.isMobile,
        isMobile: vp.isMobile,
      });
      const page = await context.newPage();
      await page.goto('/en/contact');
      await consent(page, 'none');
      await page.goto('/en/contact');

      const entryBtn = page.getByTestId('contact-human-chat');
      await expect(entryBtn).toBeVisible();
      const entryBox = await entryBtn.boundingBox();
      expect(entryBox).not.toBeNull();
      expect(entryBox!.height).toBeGreaterThanOrEqual(44);
      expect(entryBox!.width).toBeGreaterThanOrEqual(44);

      // Keyboard Tab/Enter open + Escape focus restoration
      await entryBtn.focus();
      await page.keyboard.press('Enter');

      const panel = page.getByTestId('chat-panel');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

      // Tab through close -> email -> message -> send
      await page.getByTestId('chat-close').focus();
      await expect(page.getByTestId('chat-close')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('chat-email')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('chat-message')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('chat-send')).toBeFocused();

      // Computed minimalist-flat styles
      const styles = await panel.evaluate((el) => {
        const panelStyle = getComputedStyle(el);
        const sendEl = el.querySelector('#chat-send') as HTMLElement;
        const sendStyle = getComputedStyle(sendEl);
        const accentToken = panelStyle.getPropertyValue('--pj-accent').trim();
        const docOverflow = document.documentElement.scrollWidth > window.innerWidth;
        return {
          accentToken,
          panelBorderWidth: panelStyle.borderTopWidth,
          panelBorderColor: panelStyle.borderTopColor,
          panelRadius: panelStyle.borderRadius,
          panelShadow: panelStyle.boxShadow,
          sendOutlineColor: sendStyle.outlineColor,
          sendBorderColor: sendStyle.borderTopColor,
          sendBorderWidth: sendStyle.borderTopWidth,
          sendRadius: sendStyle.borderRadius,
          sendShadow: sendStyle.boxShadow,
          docOverflow,
        };
      });
      expect(styles.accentToken).toBe('#b45700');
      expect(styles.panelBorderWidth).toBe('2px');
      expect(styles.panelBorderColor).toBe('rgb(0, 0, 0)');
      expect(styles.panelRadius).toBe('0px');
      expect(styles.panelShadow).toBe('none');
      expect(styles.sendOutlineColor).toBe('rgb(180, 87, 0)');
      expect(styles.sendBorderWidth).toBe('2px');
      expect(styles.sendBorderColor).toBe('rgb(0, 0, 0)');
      expect(styles.sendRadius).toBe('0px');
      expect(styles.sendShadow).toBe('none');
      expect(styles.docOverflow).toBe(false);

      const panelBox = await panel.boundingBox();
      expect(panelBox).not.toBeNull();

      if (!vp.isMobile) {
        expect(Math.abs(panelBox!.width - 400)).toBeLessThanOrEqual(1);
        const wizardAction = page.locator('.contact-form button:visible').first();
        const emailEntry = page.locator('#inquiry-email-entry');
        const entryAfterBox = await entryBtn.boundingBox();
        const wizardBox = await wizardAction.boundingBox();
        const emailBox = await emailEntry.boundingBox();
        expect(rectsOverlap(panelBox!, entryAfterBox!)).toBe(false);
        if (wizardBox) expect(rectsOverlap(panelBox!, wizardBox)).toBe(false);
        if (emailBox) expect(rectsOverlap(panelBox!, emailBox)).toBe(false);
      } else {
        expect(Math.abs(panelBox!.width - (vp.width - 32))).toBeLessThanOrEqual(1);
        expect(panelBox!.height).toBeLessThanOrEqual(vp.height - 32);

        for (const testId of ['chat-close', 'chat-email', 'chat-message', 'chat-send']) {
          const box = await page.getByTestId(testId).boundingBox();
          expect(box).not.toBeNull();
          expect(box!.height, `${testId} touch height`).toBeGreaterThanOrEqual(44);
          expect(box!.width, `${testId} touch width`).toBeGreaterThanOrEqual(44);
        }

        // Simulate visual viewport / soft keyboard height reduction (height 460px)
        await page.setViewportSize({ width: 390, height: 460 });
        const sendAfterShrink = await page.getByTestId('chat-send').boundingBox();
        const closeAfterShrink = await page.getByTestId('chat-close').boundingBox();
        expect(sendAfterShrink).not.toBeNull();
        expect(closeAfterShrink).not.toBeNull();
        expect(sendAfterShrink!.y + sendAfterShrink!.height).toBeLessThanOrEqual(460);
        expect(closeAfterShrink!.y).toBeGreaterThanOrEqual(0);
      }

      // Escape closes panel and restores focus to entry button
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(entryBtn).toBeFocused();

      if (vp.isMobile) {
        // Also verify /ru/contact at 390x844 has zero horizontal overflow and >= 44px controls
        await page.goto('/ru/contact');
        await consent(page, 'none');
        await page.goto('/ru/contact');
        const ruEntry = page.getByTestId('contact-human-chat');
        await ruEntry.click();
        await expect(page.getByTestId('chat-panel')).toBeVisible();
        await expect(page.getByTestId('chat-availability-status')).toBeVisible();
        const ruOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(ruOverflow).toBe(false);
        for (const testId of ['chat-close', 'chat-send']) {
          const box = await page.getByTestId(testId).boundingBox();
          expect(box).not.toBeNull();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      await context.close();
    }
  });
});
