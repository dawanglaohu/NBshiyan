import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { E2E_EDGE_AUTH_SECRET } from '../scripts/e2e-edge-auth';
import { createChatConversation, validateVisitorComposer } from '../src/lib/client/chat';
import { consent, expect, test } from './fixtures';

const CHAT_COMPOSER_EDGE_IPS: Readonly<Record<string, string>> = {
  'home -> contact -> lazy session -> send/append/refresh with real DB receipt and no fake online indicators': '198.18.20.11',
  'email validation preserves message, network outage retries idempotently, and closing drops unsent drafts': '198.18.20.12',
  '401/404 and CLOSED threads stop old submits and show Start a new conversation without auto-sending old drafts': '198.18.20.13',
  'minimalist-flat styles, responsive sizing, no overlap, keyboard focus and 44px targets at 1920/1440/390': '198.18.20.14',
  'R1: sync cursor stops at contiguous seq when seq=3 arrives before Refresh, then pulls 2 and keeps 1,2,3 across reopen': '198.18.20.15',
  'R2: concurrent Refresh and Append stay consistent in panel & parent cache across both response orders and reopen': '198.18.20.16',
  'R4: email schema consistency — omitted/empty/spaces send cleanly; CRLF/display-name/oversize error with draft retained & zero submit': '198.18.20.17',
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
  test.beforeEach(async ({ context }, testInfo) => {
    const ip = CHAT_COMPOSER_EDGE_IPS[testInfo.title];
    if (!ip) throw new Error(`Missing edge IP mapping for test: ${testInfo.title}`);
    await context.setExtraHTTPHeaders({
      'x-edge-auth': E2E_EDGE_AUTH_SECRET,
      'cf-connecting-ip': ip,
    });
  });

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

    const receipt = page.getByTestId('chat-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('Received, awaiting human handling');
    await expect(receipt).toHaveAttribute('data-seq', '1');
    const convId1 = (await receipt.getAttribute('data-conversation-id'))!;
    const msg1Id = (await receipt.getAttribute('data-message-id'))!;
    const receivedAt1 = (await receipt.getAttribute('data-received-at'))!;
    expect(convId1).toBeTruthy();
    expect(msg1Id).toBeTruthy();
    expect(Date.parse(receivedAt1)).toBeGreaterThan(0);

    const items = page.getByTestId('chat-message-item');
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toHaveAttribute('data-message-id', msg1Id);
    await expect(items.nth(0)).toHaveAttribute('data-seq', '1');
    await expect(items.nth(0)).toContainText(body1);

    // Verify real PostgreSQL persistence
    const dbConv = await prisma().chatConversation.findUnique({
      where: { id: convId1 },
      include: { messages: { orderBy: { seq: 'asc' } } },
    });
    expect(dbConv).not.toBeNull();
    expect(dbConv?.email).toBeNull();
    expect(dbConv?.messages.map((m) => [m.id, m.seq, m.bodyText])).toEqual([[msg1Id, 1, body1]]);

    // Second message append uses /messages
    const body2 = `Follow-up question [${marker}-2]`;
    await page.getByLabel('Message').fill(body2);
    const appendResPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/chat/conversations/${convId1}/messages`) &&
        res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const appendRes = await appendResPromise;
    expect([200, 201]).toContain(appendRes.status());
    await expect(receipt).toHaveAttribute('data-seq', '2');
    const msg2Id = (await receipt.getAttribute('data-message-id'))!;
    expect(msg2Id).toBeTruthy();
    expect(msg2Id).not.toBe(msg1Id);
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toHaveAttribute('data-message-id', msg2Id);
    await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
    await expect(items.nth(1)).toContainText(body2);

    // Insert real operator reply in DB and pull via explicit Refresh messages
    const opText = `Operator follow-up [${marker}-3]`;
    const now = new Date();
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `opmsg_${marker}`,
          conversationId: convId1,
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
        where: { id: convId1 },
        data: { lastSeq: 3, updatedAt: now, lastActivityAt: now },
      }),
    ]);

    const syncResPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/chat/conversations/${convId1}?`) &&
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

    const appendPath = '**/api/chat/conversations/*/messages';
    const payloads: string[] = [];
    let resumeAppend = false;
    await page.route(appendPath, async (route) => {
      payloads.push(route.request().postData()!);
      if (!resumeAppend) {
        if (payloads.length === 1) expect((await route.fetch()).ok()).toBe(true);
        return route.abort('failed');
      }
      const response = await route.fetch();
      expect(await response.json()).toMatchObject({ duplicate: true, message: { seq: 2 } });
      await route.fulfill({ response });
    });
    await messageInput.fill('Original follow-up');
    await page.getByTestId('chat-send').click();
    await expect(errBox).toBeVisible({ timeout: 15_000 });
    await expect(messageInput).not.toBeEditable();
    await messageInput.press('End');
    await messageInput.press('X');
    await expect(messageInput).toHaveValue('Original follow-up');
    resumeAppend = true;
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '2');
    expect(new Set(payloads).size).toBe(1);
    await expect(messageInput).toBeEditable();
    await page.unroute(appendPath);

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
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
    const c1ConversationId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    expect(c1ConversationId).toBeTruthy();

    await prisma().chatConversation.update({
      where: { id: c1ConversationId },
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
    expect(c2ConversationId).not.toBe(c1ConversationId);
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
        extraHTTPHeaders: {
          'x-edge-auth': E2E_EDGE_AUTH_SECRET,
          'cf-connecting-ip': '198.18.20.14',
        },
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
        // A viewport resize can reach CSS before the visualViewport listener publishes its sample.
        const staleSampleTop = await panel.evaluate((el, previousHeight) => {
          const style = (el as HTMLElement).style;
          const sampled = style.getPropertyValue('--chat-vv-height');
          try {
            style.setProperty('--chat-vv-height', `${previousHeight}px`);
            return el.getBoundingClientRect().top;
          } finally {
            style.setProperty('--chat-vv-height', sampled);
          }
        }, vp.height);
        expect(staleSampleTop).toBeGreaterThanOrEqual(0);
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

  test('R1: sync cursor stops at contiguous seq when seq=3 arrives before Refresh, then pulls 2 and keeps 1,2,3 across reopen', async ({
    page,
  }) => {
    const marker = randomUUID().slice(0, 8);
    await page.goto('/en/contact');
    await consent(page, 'none');
    await page.goto('/en/contact');

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const body1 = `R1 msg1 [${marker}]`;
    await page.getByLabel('Message').fill(body1);
    const cResPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const cRes = await cResPromise;
    expect([200, 201]).toContain(cRes.status());
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
    const conversationId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    expect(conversationId).toBeTruthy();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '1');

    // Operator writes seq=2 directly in DB without visitor refreshing yet
    const opBody = `R1 op2 [${marker}]`;
    const t2 = new Date();
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `r1_op_${marker}`,
          conversationId,
          seq: 2,
          sender: 'OPERATOR',
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: opBody,
          createdAt: t2,
        },
      }),
      prisma().chatConversation.update({
        where: { id: conversationId },
        data: { lastSeq: 2, updatedAt: t2, lastActivityAt: t2 },
      }),
    ]);

    // Visitor appends seq=3 before refreshing; contiguous cursor must stay at 1 (never jump to 3)
    const body3 = `R1 msg3 [${marker}]`;
    await page.getByLabel('Message').fill(body3);
    const aResPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/chat/conversations/${conversationId}/messages`) &&
        res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const aRes = await aResPromise;
    expect([200, 201]).toContain(aRes.status());
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '3');

    const items = page.getByTestId('chat-message-item');
    await expect(items).toHaveCount(2);
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '1');

    // Explicit Refresh must request afterSeq=1 and fetch missing seq=2
    const seenAfterSeqs: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes(`/api/chat/conversations/${conversationId}?`) && req.method() === 'GET') {
        seenAfterSeqs.push(new URL(req.url()).searchParams.get('afterSeq') ?? '');
      }
    });
    await page.getByTestId('chat-refresh').click();
    await expect(items).toHaveCount(3);
    expect(seenAfterSeqs).toEqual(['1']);
    await expect(items.nth(0)).toHaveAttribute('data-seq', '1');
    await expect(items.nth(0)).toContainText(body1);
    await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
    await expect(items.nth(1)).toContainText(opBody);
    await expect(items.nth(2)).toHaveAttribute('data-seq', '3');
    await expect(items.nth(2)).toContainText(body3);
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '3');

    // Close and reopen preserves ordered 1,2,3 (once each) and cursor 3
    await page.getByTestId('chat-close').click();
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAttribute('data-seq', '1');
    await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
    await expect(items.nth(2)).toHaveAttribute('data-seq', '3');
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '3');

    await page.getByTestId('chat-refresh').click();
    await expect.poll(() => seenAfterSeqs.length).toBe(2);
    expect(seenAfterSeqs[1]).toBe('3');
    await expect(items).toHaveCount(3);
  });

  test('R2: concurrent Refresh and Append stay consistent in panel & parent cache across both response orders and reopen', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Order A: Refresh completes first with operator seq=2, late Append receipt seq=3 completes afterwards
    {
      const marker = randomUUID().slice(0, 8);
      await page.goto('/en/contact');
      await consent(page, 'none');
      await page.goto('/en/contact');
      await page.getByTestId('contact-human-chat').click();
      await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

      await page.getByLabel('Message').fill(`R2A msg1 [${marker}]`);
      const cResPromise = page.waitForResponse(
        (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
      );
      await page.getByTestId('chat-send').click();
      const cRes = await cResPromise;
      expect([200, 201]).toContain(cRes.status());
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
      const conversationId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
      expect(conversationId).toBeTruthy();

      const t2 = new Date();
      await prisma().$transaction([
        prisma().chatMessage.create({
          data: {
            id: `r2a_op_${marker}`,
            conversationId,
            seq: 2,
            sender: 'OPERATOR',
            clientMessageId: randomUUID(),
            payloadHash: randomUUID().replace(/-/g, ''),
            bodyText: `R2A op2 [${marker}]`,
            createdAt: t2,
          },
        }),
        prisma().chatConversation.update({
          where: { id: conversationId },
          data: { lastSeq: 2, updatedAt: t2, lastActivityAt: t2 },
        }),
      ]);

      let releaseAppend!: () => void;
      const appendHeld = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      let appendStartedResolve!: () => void;
      const appendStarted = new Promise<void>((resolve) => {
        appendStartedResolve = resolve;
      });

      await page.route(`**/api/chat/conversations/${conversationId}/messages`, async (route) => {
        if (route.request().method() === 'POST') {
          appendStartedResolve();
          await appendHeld;
          await route.continue();
          return;
        }
        await route.continue();
      });

      const appendResponsePromise = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/chat/conversations/${conversationId}/messages`) &&
          res.request().method() === 'POST',
      );
      await page.getByLabel('Message').fill(`R2A msg3 [${marker}]`);
      await page.getByTestId('chat-send').click();
      await appendStarted;

      // Refresh while append is in flight (server DB still has only seq 1..2) -> completes first with seq=2
      await page.getByTestId('chat-refresh').click();
      const items = page.getByTestId('chat-message-item');
      await expect(items).toHaveCount(2);
      await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '2');

      // Now release late append request/receipt (seq=3); must merge without overwriting seq=2
      releaseAppend();
      const appendRes = await appendResponsePromise;
      expect([200, 201]).toContain(appendRes.status());
      await page.unroute(`**/api/chat/conversations/${conversationId}/messages`);

      await expect(items).toHaveCount(3);
      await expect(items.nth(0)).toHaveAttribute('data-seq', '1');
      await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
      await expect(items.nth(2)).toHaveAttribute('data-seq', '3');
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '3');
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '3');

      // Reopen from parent cache must match identically
      await page.getByTestId('chat-close').click();
      await page.getByTestId('contact-human-chat').click();
      await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
      await expect(items).toHaveCount(3);
      await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
      await expect(items.nth(2)).toHaveAttribute('data-seq', '3');
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '3');
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '3');
    }

    // Order B: Append finishes first (receipt seq=3), earlier Refresh returns afterwards with seq=2;
    // then CLOSED status via Refresh persists across reopen too
    {
      const marker = randomUUID().slice(0, 8);
      await page.goto('/en/contact');
      await page.getByTestId('contact-human-chat').click();
      await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

      await page.getByLabel('Message').fill(`R2B msg1 [${marker}]`);
      const cResPromise = page.waitForResponse(
        (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
      );
      await page.getByTestId('chat-send').click();
      const cRes = await cResPromise;
      expect([200, 201]).toContain(cRes.status());
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
      const conversationId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
      expect(conversationId).toBeTruthy();

      const t2 = new Date();
      await prisma().$transaction([
        prisma().chatMessage.create({
          data: {
            id: `r2b_op_${marker}`,
            conversationId,
            seq: 2,
            sender: 'OPERATOR',
            clientMessageId: randomUUID(),
            payloadHash: randomUUID().replace(/-/g, ''),
            bodyText: `R2B op2 [${marker}]`,
            createdAt: t2,
          },
        }),
        prisma().chatConversation.update({
          where: { id: conversationId },
          data: { lastSeq: 2, updatedAt: t2, lastActivityAt: t2 },
        }),
      ]);

      let releaseRefresh!: () => void;
      const refreshHeld = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      let refreshStartedResolve!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        refreshStartedResolve = resolve;
      });
      let interceptOnce = true;

      await page.route(`**/api/chat/conversations/${conversationId}?*`, async (route) => {
        if (interceptOnce && route.request().method() === 'GET') {
          interceptOnce = false;
          const response = await route.fetch();
          refreshStartedResolve();
          await refreshHeld;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });

      // Start Refresh first (captured seq=2 before append) and hold it
      await page.getByTestId('chat-refresh').click();
      await refreshStarted;

      // Send append and let it succeed first -> sets receipt seq=3 and cursor=1
      await page.getByLabel('Message').fill(`R2B msg3 [${marker}]`);
      await page.getByTestId('chat-send').click();
      const items = page.getByTestId('chat-message-item');
      await expect(items).toHaveCount(2);
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '3');
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '1');

      // Release earlier Refresh -> must merge seq=2, advance cursor to 3, and KEEP receipt seq=3
      releaseRefresh();
      await page.unroute(`**/api/chat/conversations/${conversationId}?*`);
      await expect(items).toHaveCount(3);
      await expect(items.nth(1)).toHaveAttribute('data-seq', '2');
      await expect(items.nth(2)).toHaveAttribute('data-seq', '3');
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '3');
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '3');

      // Now close conversation in DB, refresh to observe CLOSED, then Close & Reopen -> still CLOSED with [1,2,3], cursor 3, receipt 3
      await prisma().chatConversation.update({
        where: { id: conversationId },
        data: { status: 'CLOSED' },
      });
      await page.getByTestId('chat-refresh').click();
      await expect(page.getByTestId('chat-terminal-banner')).toBeVisible();
      await expect(page.getByTestId('chat-send')).toBeDisabled();
      await expect(page.getByTestId('chat-start-new')).toBeVisible();

      await page.getByTestId('chat-close').click();
      await page.getByTestId('contact-human-chat').click();
      await expect(page.getByTestId('chat-terminal-banner')).toBeVisible();
      await expect(page.getByTestId('chat-send')).toBeDisabled();
      await expect(page.getByTestId('chat-start-new')).toBeVisible();
      await expect(items).toHaveCount(3);
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '3');
      await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '3');
    }
  });

  test('R4: email schema consistency — omitted/empty/spaces send cleanly; CRLF/display-name/oversize error with draft retained & zero submit', async ({
    page,
  }) => {
    // 1) UI tests for blank spaces ("   "), display-name, oversize, and omitted email
    await page.goto('/en/contact');
    await consent(page, 'none');
    await page.goto('/en/contact');

    let postCreateCount = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/chat/conversations') && req.method() === 'POST') {
        postCreateCount += 1;
      }
    });

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const draft = 'R4 preserved message draft';
    const messageInput = page.getByLabel('Message');
    const emailInput = page.getByLabel('Email (optional)');

    // Display name rejected client-side with zero network submit
    await messageInput.fill(draft);
    await emailInput.fill('Bob <bob@example.com>');
    await page.getByTestId('chat-send').click();
    await expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    await expect(messageInput).toHaveValue(draft);
    expect(postCreateCount).toBe(0);

    // Over 254 chars rejected client-side with zero network submit
    await emailInput.fill(`${'b'.repeat(246)}@example.com`);
    await page.getByTestId('chat-send').click();
    await expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    await expect(messageInput).toHaveValue(draft);
    expect(postCreateCount).toBe(0);

    // Plain spaces ("   ") treated as omitted and sends successfully with email=null in DB
    await emailInput.fill('   ');
    const spaceResPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const spaceRes = await spaceResPromise;
    expect([200, 201]).toContain(spaceRes.status());
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
    const spaceConvId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    expect(spaceConvId).toBeTruthy();
    const dbRow = await prisma().chatConversation.findUnique({ where: { id: spaceConvId } });
    expect(dbRow?.email).toBeNull();
    expect(postCreateCount).toBe(1);

    // 2) Client validation + serialization contract parity (CRLF vs omitted/empty/spaces)
    expect(validateVisitorComposer({ bodyText: 'Hello', email: undefined, includeEmail: true })).toEqual({
      valid: true,
      bodyText: 'Hello',
    });
    expect(validateVisitorComposer({ bodyText: 'Hello', email: '', includeEmail: true })).toEqual({
      valid: true,
      bodyText: 'Hello',
    });
    expect(validateVisitorComposer({ bodyText: 'Hello', email: '   ', includeEmail: true })).toEqual({
      valid: true,
      bodyText: 'Hello',
    });

    for (const badCrlf of ['\r\n', '\n', '\r', '  \r\n  ', 'Alice <a@b.com>', `${'c'.repeat(246)}@example.com`]) {
      const checked = validateVisitorComposer({ bodyText: draft, email: badCrlf, includeEmail: true });
      expect(checked.valid, `expected validation reject for ${JSON.stringify(badCrlf)}`).toBe(false);
      if (!checked.valid) expect(checked.errors.email).toBeTruthy();

      let calls = 0;
      await expect(
        createChatConversation(
          {
            clientConversationId: randomUUID(),
            clientMessageId: randomUUID(),
            locale: 'en',
            bodyText: draft,
            email: badCrlf,
          },
          {
            transport: async () => {
              calls += 1;
              return new Response('{}', { status: 200 });
            },
          },
        ),
      ).rejects.toThrow();
      expect(calls, `expected zero network calls for ${JSON.stringify(badCrlf)}`).toBe(0);
    }

    // Serialization omits email key when omitted / empty / plain spaces
    for (const blank of [undefined, '', '   ']) {
      let sentBody: Record<string, unknown> = {};
      const okRes = await createChatConversation(
        {
          clientConversationId: randomUUID(),
          clientMessageId: randomUUID(),
          locale: 'en',
          bodyText: 'Hello',
          email: blank,
        },
        {
          transport: async (_path, init) => {
            sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
            return new Response(
              JSON.stringify({
                conversationId: 'conv_mock_r4',
                receivedAt: new Date().toISOString(),
                duplicate: false,
                message: {
                  id: 'msg_mock_r4',
                  seq: 1,
                  sender: 'VISITOR',
                  bodyText: 'Hello',
                  createdAt: new Date().toISOString(),
                },
              }),
              { status: 201, headers: { 'content-type': 'application/json' } },
            );
          },
        },
      );
      expect(okRes.ok).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(sentBody, 'email')).toBe(false);
    }
  });
});
