import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PlaywrightTestArgs } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { E2E_EDGE_AUTH_SECRET } from '../scripts/e2e-edge-auth';
import { createChatPoller } from '../src/lib/client/chat-poller';
import { resolveChatSendFailure } from '../src/lib/client/chat-retry';
import {
  AdminChatSyncDTOSchema,
  ConversationReceivedDTOSchema,
  MessageReceivedDTOSchema,
  type ChatSyncDTO,
} from '../src/lib/contracts/chat';
import { AppErrorDTOSchema } from '../src/lib/contracts/errors';
import { BASE } from './base-url';
import { consent, expect, test } from './fixtures';
import { RUN_AUTH_TOTP, loadRunAuth } from './run-auth';

const CHAT_POLLING_EDGE_IPS: Readonly<Record<string, string>> = {
  '3s visible polling, zero polling when hidden, immediate catch-up on restore, single in-flight, and 1/2/4/8/16/30s backoff':
    '198.18.21.11',
  'out-of-order and cross-page inserts keep each ID once, never regress seq, keep scroll/focus on New messages, and report read only for visible contiguous seq':
    '198.18.21.12',
  'truncated server-saved responses retry via chat-retry with identical payload returning original receipt (single admin msg + outbox), and offline drafts stay tab-memory only':
    '198.18.21.13',
  'visitor expiry/revocation and operator role revocation reject next poll & send with no body/write, keep draft, stop timers/UUID swap, and block tampered threadId/seq/email':
    '198.18.21.14',
  'minimalist-flat styles, focus, zero overflow, labels and 44px touch targets for retry and new-messages controls across 1920/1440/390':
    '198.18.21.15',
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

async function createSalesSessionContext(
  playwright: PlaywrightTestArgs['playwright'],
) {
  const email = `e2e-chat-revoke-${randomUUID().slice(0, 8)}@example.test`.toLowerCase();
  const password = 'e2e-chat-Revoke!Pass9';
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ADMIN_SEED_EMAIL: email,
      ADMIN_SEED_PASSWORD: password,
      ADMIN_SEED_NAME: 'E2E Revoke Sales',
      ADMIN_SEED_ROLE: 'SALES',
      ADMIN_SEED_TOTP_SECRET: RUN_AUTH_TOTP,
    },
  });

  const ctx = await playwright.request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: {
      'x-edge-auth': E2E_EDGE_AUTH_SECRET,
      'cf-connecting-ip': '198.18.21.14',
    },
  });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const login = await ctx.post('/api/auth/callback/credentials', {
    maxRedirects: 0,
    headers: { Origin: BASE },
    form: {
      csrfToken,
      email,
      password,
      totp: authenticator.generate(RUN_AUTH_TOTP),
    },
  });
  expect(login.status()).toBe(302);
  const user = await prisma().user.findUniqueOrThrow({ where: { email } });
  expect(user.role).toBe('SALES');
  return { email, userId: user.id, context: ctx };
}

test.describe('M4-T9 chat polling, offline retry, and revocation stop', () => {
  test.beforeEach(async ({ context }, testInfo) => {
    const ip = CHAT_POLLING_EDGE_IPS[testInfo.title];
    if (!ip) throw new Error(`Missing edge IP mapping for test: ${testInfo.title}`);
    await context.setExtraHTTPHeaders({
      'x-edge-auth': E2E_EDGE_AUTH_SECRET,
      'cf-connecting-ip': ip,
    });
  });

  test('3s visible polling, zero polling when hidden, immediate catch-up on restore, single in-flight, and 1/2/4/8/16/30s backoff', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const origFetch = window.fetch.bind(window);
      const timestamps: number[] = [];
      (window as unknown as { __pollFetchLog?: number[] }).__pollFetchLog = timestamps;
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'GET' && url.includes('/api/chat/conversations/')) {
          timestamps.push(Date.now());
        }
        return origFetch(input, init);
      }) as typeof window.fetch;
    });
    await page.clock.install();

    await page.goto('/en');
    const banner = page.getByRole('region', { name: 'Cookie consent' });
    await banner.getByRole('button', { name: 'Reject all', exact: true }).click();
    await expect(banner).toBeHidden();

    // Navigate from home visible entry control to /en/contact
    const homeQuote = page.locator('.hero a[href*="/contact"]').first();
    await expect(homeQuote).toBeVisible();
    await homeQuote.click();
    await expect(page).toHaveURL(/\/en\/contact(?:\?.*)?$/);

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const marker = randomUUID().slice(0, 8);
    await page.getByLabel('Message').fill(`Poll baseline [${marker}]`);
    const createResPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const createRes = await createResPromise;
    expect([200, 201]).toContain(createRes.status());
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
    const conversationId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    expect(conversationId).toBeTruthy();

    // Wait briefly for initial visible POST /read on seq=1 to settle before pausing clock
    await expect.poll(async () => {
      const conv = await prisma().chatConversation.findUnique({ where: { id: conversationId } });
      return conv?.visitorReadSeq ?? 0;
    }).toBe(1);

    // Pause clock slightly ahead of live renderer time to avoid Windows timer quantization / IPC skew
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 50);

    // Override visibilityState dynamically in browser tab
    await page.evaluate(() => {
      let state: 'visible' | 'hidden' = 'visible';
      Object.defineProperty(document, '__testVisibility', {
        configurable: true,
        set(next: 'visible' | 'hidden') {
          state = next;
        },
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() {
          return state;
        },
      });
    });

    const syncGetTimes: Array<{ at: number; afterSeq: string }> = [];
    page.on('request', (req) => {
      if (req.url().includes(`/api/chat/conversations/${conversationId}?`) && req.method() === 'GET') {
        syncGetTimes.push({
          at: Date.now(),
          afterSeq: new URL(req.url()).searchParams.get('afterSeq') ?? '',
        });
      }
    });

    // Insert seq=2 directly in DB; after 3,000ms visible poll must fetch it automatically
    const t2 = new Date();
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `poll_op2_${marker}`,
          conversationId,
          seq: 2,
          sender: 'OPERATOR',
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: `Auto-polled reply [${marker}]`,
          createdAt: t2,
        },
      }),
      prisma().chatConversation.update({
        where: { id: conversationId },
        data: { lastSeq: 2, updatedAt: t2, lastActivityAt: t2 },
      }),
    ]);

    await page.clock.runFor(2_500);
    expect(syncGetTimes).toHaveLength(0);

    await page.clock.runFor(600);
    await expect(page.getByTestId('chat-message-item')).toHaveCount(2);
    await expect(page.getByTestId('chat-message-item').nth(1)).toContainText(`Auto-polled reply [${marker}]`);
    expect(syncGetTimes.map((x) => x.afterSeq)).toEqual(['1']);

    // Hide tab -> zero polling even across 20s; operator inserts seq=3 while hidden
    await page.evaluate(() => {
      (document as unknown as { __testVisibility: 'visible' | 'hidden' }).__testVisibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const t3 = new Date();
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `poll_op3_${marker}`,
          conversationId,
          seq: 3,
          sender: 'OPERATOR',
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: `Hidden-gap reply [${marker}]`,
          createdAt: t3,
        },
      }),
      prisma().chatConversation.update({
        where: { id: conversationId },
        data: { lastSeq: 3, updatedAt: t3, lastActivityAt: t3 },
      }),
    ]);

    await page.clock.runFor(20_000);
    expect(syncGetTimes).toHaveLength(1);

    // Restore visibility -> immediate catch-up from confirmed afterSeq=2
    await page.evaluate(() => {
      (document as unknown as { __testVisibility: 'visible' | 'hidden' }).__testVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(50);
    await expect(page.getByTestId('chat-message-item')).toHaveCount(3);
    await expect(page.getByTestId('chat-message-item').nth(2)).toContainText(`Hidden-gap reply [${marker}]`);
    expect(syncGetTimes.map((x) => x.afterSeq)).toEqual(['1', '2']);

    // Test single in-flight while slow poll hangs + bounded 1/2/4/8/16/30s failure backoff
    let activeSyncGets = 0;
    let maxConcurrentSyncGets = 0;
    let holdFirstPoll = true;
    let releaseFirstPoll!: () => void;
    const firstPollHeld = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    let failPolls = false;

    await page.route(`**/api/chat/conversations/${conversationId}?*`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      activeSyncGets += 1;
      maxConcurrentSyncGets = Math.max(maxConcurrentSyncGets, activeSyncGets);
      try {
        if (holdFirstPoll) {
          holdFirstPoll = false;
          await firstPollHeld;
          failPolls = true;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'service_unavailable', requestId: randomUUID() }),
          });
          return;
        }
        if (failPolls) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'service_unavailable', requestId: randomUUID() }),
          });
          return;
        }
        await route.continue();
      } finally {
        activeSyncGets -= 1;
      }
    });

    // Advance 3s so a single poll starts and hangs; clicking Refresh while in flight must NOT stack a 2nd request
    await page.clock.runFor(3_000);
    await page.getByTestId('chat-refresh').click();
    await page.clock.runFor(5_000);
    expect(maxConcurrentSyncGets).toBe(1);

    const firstFailPromise = page.waitForResponse(
      (res) => res.url().includes(`/api/chat/conversations/${conversationId}?`) && res.status() === 503,
    );
    await page.evaluate(() => {
      const log = (window as unknown as { __pollFetchLog?: number[] }).__pollFetchLog;
      if (log) log.length = 0;
    });
    releaseFirstPoll();
    await firstFailPromise;
    const syncStatus = page.getByTestId('chat-sync-status');
    await expect(syncStatus).toBeVisible();
    await expect(syncStatus).toHaveAttribute('data-failures', '1');
    const backoffBaselineMs = await page.evaluate(() => Date.now());

    // Observe the full 1s -> 2s -> 4s -> 8s -> 16s -> 30s -> 30s backoff progression
    const scheduledIntervals = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [idx, stepMs] of scheduledIntervals.entries()) {
      const failResp = page.waitForResponse(
        (res) => res.url().includes(`/api/chat/conversations/${conversationId}?`) && res.status() === 503,
      );
      await page.clock.runFor(stepMs);
      await failResp;
      await expect(syncStatus).toHaveAttribute('data-failures', String(idx + 2));
    }
    const recordedFetchTimes = await page.evaluate(
      () => (window as unknown as { __pollFetchLog?: number[] }).__pollFetchLog ?? [],
    );
    const series = [backoffBaselineMs, ...recordedFetchTimes];
    const gaps: number[] = [];
    for (let i = 1; i < series.length; i += 1) {
      gaps.push(series[i]! - series[i - 1]!);
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    // Recover network -> backoff resets cleanly and sync status clears
    failPolls = false;
    await page.unroute(`**/api/chat/conversations/${conversationId}?*`);
    await page.clock.runFor(30_000);
    await expect(page.getByTestId('chat-sync-status')).toHaveCount(0);
  });

  test('out-of-order and cross-page inserts keep each ID once, never regress seq, keep scroll/focus on New messages, and report read only for visible contiguous seq', async ({
    page,
  }) => {
    const marker = randomUUID().slice(0, 8);
    await page.goto('/en/contact');
    await consent(page, 'none');
    await page.goto('/en/contact');

    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    await page.getByLabel('Message').fill(`Msg #1 [${marker}]`);
    const cResPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const cRes = await cResPromise;
    expect([200, 201]).toContain(cRes.status());
    const conversationId = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    expect(conversationId).toBeTruthy();

    // Seed messages seq=2..14 directly so the body clearly overflows its 460px max-height
    const baseTime = Date.now();
    await prisma().$transaction([
      ...Array.from({ length: 13 }, (_, idx) => {
        const seq = idx + 2;
        return prisma().chatMessage.create({
          data: {
            id: `page_seed_${seq}_${marker}`,
            conversationId,
            seq,
            sender: seq % 2 === 0 ? 'OPERATOR' : 'VISITOR',
            clientMessageId: randomUUID(),
            payloadHash: randomUUID().replace(/-/g, ''),
            bodyText: `Seed message #${seq} [${marker}] line padding for vertical overflow readability`,
            createdAt: new Date(baseTime + seq * 1_000),
          },
        });
      }),
      prisma().chatConversation.update({
        where: { id: conversationId },
        data: { lastSeq: 14, updatedAt: new Date(baseTime + 14_000), lastActivityAt: new Date(baseTime + 14_000) },
      }),
    ]);

    // Trigger cross-page fetch with limit=5 simulation + check contiguous merge
    await page.getByTestId('chat-refresh').click();
    await expect(page.getByTestId('chat-message-item')).toHaveCount(14);
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '14');
    await expect.poll(async () => {
      const conv = await prisma().chatConversation.findUnique({ where: { id: conversationId } });
      return conv?.visitorReadSeq ?? 0;
    }).toBe(14);

    // Scroll up to the top and focus composer textarea while inspecting history
    const bodyMetricsBefore = await page.evaluate(() => {
      const body = document.querySelector('.pj-chat-body') as HTMLElement;
      body.scrollTop = 0;
      body.dispatchEvent(new Event('scroll'));
      const textarea = document.getElementById('chat-message') as HTMLTextAreaElement;
      textarea.focus();
      return {
        scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        activeId: document.activeElement?.id ?? '',
      };
    });
    expect(bodyMetricsBefore.scrollHeight).toBeGreaterThan(bodyMetricsBefore.clientHeight + 40);
    expect(bodyMetricsBefore.scrollTop).toBe(0);

    // Now test out-of-order + cross-page arrival for seq=15 and seq=16
    const t15 = new Date(baseTime + 15_000);
    const t16 = new Date(baseTime + 16_000);
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `op_15_${marker}`,
          conversationId,
          seq: 15,
          sender: 'OPERATOR',
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: `Paged reply #15 [${marker}]`,
          createdAt: t15,
        },
      }),
      prisma().chatMessage.create({
        data: {
          id: `op_16_${marker}`,
          conversationId,
          seq: 16,
          sender: 'OPERATOR',
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: `Paged reply #16 [${marker}]`,
          createdAt: t16,
        },
      }),
      prisma().chatConversation.update({
        where: { id: conversationId },
        data: { lastSeq: 16, updatedAt: t16, lastActivityAt: t16 },
      }),
    ]);

    const readPosts: number[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith(`/api/chat/conversations/${conversationId}/read`) && req.method() === 'POST') {
        const parsed = req.postDataJSON() as { lastReadSeq?: number };
        if (typeof parsed.lastReadSeq === 'number') readPosts.push(parsed.lastReadSeq);
      }
    });

    // Force paginated response split (15 on page 1, 16 on page 2) AND verify older stale GET doesn't regress seq
    let serveStale = false;
    await page.route(`**/api/chat/conversations/${conversationId}?*`, async (route) => {
      const url = new URL(route.request().url());
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      if (serveStale) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            conversation: {
              id: conversationId,
              locale: 'en',
              productSlug: null,
              sourcePath: '/en/contact',
              status: 'OPEN',
              version: 1,
              createdAt: new Date(baseTime).toISOString(),
              updatedAt: t15.toISOString(),
              lastActivityAt: t15.toISOString(),
              retainUntil: new Date(baseTime + 90 * 86_400_000).toISOString(),
              anonymizedAt: null,
            },
            messages: [
              {
                id: `op_15_${marker}`,
                seq: 15,
                sender: 'OPERATOR',
                bodyText: `Paged reply #15 [${marker}]`,
                createdAt: t15.toISOString(),
              },
            ],
            authors: [{ messageId: `op_15_${marker}`, authorRef: 'op-ref' }],
            lastSeq: 15,
            nextAfterSeq: 15,
            hasMore: false,
            read: { lastReadSeq: 14 },
          } satisfies ChatSyncDTO),
        });
        return;
      }

      const response = await route.fetch();
      const body = (await response.json()) as ChatSyncDTO;
      if (afterSeq === 14 && body.messages.length === 2) {
        // Split into 2 pages manually to test cross-page pagination & dedupe
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...body,
            messages: [body.messages[0]!],
            authors: body.authors.filter((a) => a.messageId === body.messages[0]!.id),
            nextAfterSeq: 15,
            hasMore: true,
          }),
        });
        return;
      }
      await route.fulfill({ response });
    });

    // Wait for automatic 3s polling to pull paged seq=15 and seq=16 without stealing focus from composer
    await expect(page.getByTestId('chat-message-item')).toHaveCount(16, { timeout: 10_000 });

    // Every ID appears strictly once, cursor is 16, scrollTop stayed near 0, focus remained on textarea, New messages shown
    const afterArrival = await page.evaluate(() => {
      const body = document.querySelector('.pj-chat-body') as HTMLElement;
      const items = Array.from(document.querySelectorAll('[data-testid="chat-message-item"]'));
      return {
        scrollTop: body.scrollTop,
        activeId: document.activeElement?.id ?? '',
        ids: items.map((el) => el.getAttribute('data-message-id')),
        seqs: items.map((el) => Number(el.getAttribute('data-seq'))),
      };
    });
    expect(afterArrival.ids).toHaveLength(16);
    expect(new Set(afterArrival.ids).size).toBe(16);
    expect(afterArrival.seqs).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(afterArrival.scrollTop).toBe(0);
    expect(afterArrival.activeId).toBe('chat-message');

    const newMsgBtn = page.getByTestId('chat-new-messages');
    await expect(newMsgBtn).toBeVisible();
    // Critical: because visitor is scrolled at top, seq=15/16 are NOT visible yet -> read cursor must NOT jump to 16!
    expect(readPosts.every((seq) => seq < 16)).toBe(true);
    const dbConvWhileScrolledUp = await prisma().chatConversation.findUnique({ where: { id: conversationId } });
    expect(dbConvWhileScrolledUp?.visitorReadSeq).toBe(14);

    // Late stale response must NOT regress seq or duplicate items
    serveStale = true;
    const staleResPromise = page.waitForResponse(
      (res) => res.url().includes(`/api/chat/conversations/${conversationId}?`) && res.status() === 200,
    );
    await page.getByTestId('chat-refresh').click();
    await staleResPromise;
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '16');
    await expect(page.getByTestId('chat-message-item')).toHaveCount(16);
    await page.unroute(`**/api/chat/conversations/${conversationId}?*`);

    // Click New messages -> jumps to bottom and reports actual visible contiguous seq=16
    await newMsgBtn.click();
    await expect(newMsgBtn).toHaveCount(0);
    await expect.poll(async () => {
      const conv = await prisma().chatConversation.findUnique({ where: { id: conversationId } });
      return conv?.visitorReadSeq ?? 0;
    }).toBe(16);

    // Insert gap seq=17 then append seq=18 -> contiguous lastSeq stays 16 and read NEVER advances past 16
    const t17 = new Date(baseTime + 17_000);
    await prisma().$transaction([
      prisma().chatMessage.create({
        data: {
          id: `op_gap17_${marker}`,
          conversationId,
          seq: 17,
          sender: 'OPERATOR',
          clientMessageId: randomUUID(),
          payloadHash: randomUUID().replace(/-/g, ''),
          bodyText: `Gap message #17 [${marker}]`,
          createdAt: t17,
        },
      }),
      prisma().chatConversation.update({
        where: { id: conversationId },
        data: { lastSeq: 17, updatedAt: t17, lastActivityAt: t17 },
      }),
    ]);

    await page.getByLabel('Message').fill(`Visitor seq18 [${marker}]`);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '18');
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-last-seq', '16');
    const dbWhileGap = await prisma().chatConversation.findUnique({ where: { id: conversationId } });
    expect(dbWhileGap?.visitorReadSeq).toBe(16);
  });

  test('truncated server-saved responses retry via chat-retry with identical payload returning original receipt (single admin msg + outbox), and offline drafts stay tab-memory only', async ({
    page,
    playwright,
  }) => {
    test.setTimeout(60_000);
    const marker = randomUUID().slice(0, 8);
    await page.goto('/en/contact');
    await consent(page, 'none');
    await page.goto('/en/contact');
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const msgInput = page.getByLabel('Message');
    const emailInput = page.getByLabel('Email (optional)');
    const firstDraft = `Truncated-first [${marker}]`;
    const firstEmail = `retry-${marker}@example.com`;
    await emailInput.fill(firstEmail);
    await msgInput.fill(firstDraft);

    // Let real server commit the first conversation, then drop the HTTP response before client sees it
    const createPayloads: string[] = [];
    let dropCreateResponse = true;
    await page.route('**/api/chat/conversations', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      createPayloads.push(route.request().postData()!);
      if (dropCreateResponse) {
        if (createPayloads.length === 1) {
          const saved = await route.fetch();
          expect([200, 201]).toContain(saved.status());
        }
        await route.abort('failed');
        return;
      }
      const res = await route.fetch();
      const json = ConversationReceivedDTOSchema.parse(await res.json());
      expect(json.duplicate).toBe(true);
      await route.fulfill({ response: res });
    });

    await page.getByTestId('chat-send').click();
    const errBox = page.getByTestId('chat-send-error');
    await expect(errBox).toBeVisible({ timeout: 15_000 });
    await expect(errBox).toContainText(/Pending confirmation/);
    await expect(page.getByTestId('chat-panel')).not.toContainText(/received/i);
    await expect(msgInput).toHaveValue(firstDraft);
    await expect(emailInput).toHaveValue(firstEmail);
    await expect(msgInput).not.toBeEditable();

    // Retry via dedicated chat-retry button -> exact same payload returns original receipt
    dropCreateResponse = false;
    const retryBtn = page.getByTestId('chat-retry');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    const receipt = page.getByTestId('chat-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveAttribute('data-seq', '1');
    const convId = (await receipt.getAttribute('data-conversation-id'))!;
    const msg1Id = (await receipt.getAttribute('data-message-id'))!;
    expect(new Set(createPayloads).size).toBe(1);
    await page.unroute('**/api/chat/conversations');

    // Now test truncated follow-up append + chat-retry
    const appendPayloads: string[] = [];
    let dropAppendResponse = true;
    await page.route(`**/api/chat/conversations/${convId}/messages`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      appendPayloads.push(route.request().postData()!);
      if (dropAppendResponse) {
        if (appendPayloads.length === 1) {
          const saved = await route.fetch();
          expect([200, 201]).toContain(saved.status());
        }
        await route.abort('failed');
        return;
      }
      const res = await route.fetch();
      const json = MessageReceivedDTOSchema.parse(await res.json());
      expect(json.duplicate).toBe(true);
      await route.fulfill({ response: res });
    });

    await msgInput.fill(`Truncated-append [${marker}]`);
    await page.getByTestId('chat-send').click();
    await expect(errBox).toBeVisible({ timeout: 15_000 });
    await expect(errBox).toContainText(/Pending confirmation/);
    await expect(msgInput).not.toBeEditable();

    dropAppendResponse = false;
    await page.getByTestId('chat-retry').click();
    await expect(receipt).toHaveAttribute('data-seq', '2');
    const msg2Id = (await receipt.getAttribute('data-message-id'))!;
    expect(new Set(appendPayloads).size).toBe(1);
    await page.unroute(`**/api/chat/conversations/${convId}/messages`);

    // Verify via real SALES GET & DB outbox that each message & notification exists strictly once
    const salesState = await loadRunAuth('sales', BASE, playwright.request);
    const salesCtx = await playwright.request.newContext({ baseURL: BASE, storageState: salesState });
    try {
      const adminRes = await salesCtx.get(`/api/admin/chat/conversations/${convId}`);
      expect(adminRes.status()).toBe(200);
      const adminDto = AdminChatSyncDTOSchema.parse(await adminRes.json());
      expect(adminDto.messages.map((m) => [m.id, m.seq, m.bodyText])).toEqual([
        [msg1Id, 1, firstDraft],
        [msg2Id, 2, `Truncated-append [${marker}]`],
      ]);
      expect(adminDto.notifications.map((n) => n.messageId)).toEqual([msg1Id, msg2Id]);
    } finally {
      await salesCtx.dispose();
    }

    const dbNotifications = await prisma().chatNotification.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'asc' },
    });
    expect(dbNotifications.map((n) => n.messageId)).toEqual([msg1Id, msg2Id]);

    // Verify unsaved offline draft stays only in tab memory, never web storage, and is not promised after reload
    await page.goto('/en/contact');
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const offlineMsg = `Unsaved offline draft [${marker}]`;
    const offlineMail = `offline-${marker}@example.com`;
    await page.getByLabel('Email (optional)').fill(offlineMail);
    await page.getByLabel('Message').fill(offlineMsg);

    await page.context().setOffline(true);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-send-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('chat-retry')).toBeVisible();
    await expect(page.getByTestId('chat-fallback-email')).toBeVisible();
    await expect(page.getByLabel('Message')).toHaveValue(offlineMsg);
    await expect(page.getByLabel('Email (optional)')).toHaveValue(offlineMail);
    // Offline before saving keeps draft editable in memory
    await expect(page.getByLabel('Message')).toBeEditable();

    const storageDump = await page.evaluate(() => ({
      ls: JSON.stringify(localStorage),
      ss: JSON.stringify(sessionStorage),
      cookie: document.cookie,
    }));
    expect(storageDump.ls).not.toContain(offlineMsg);
    expect(storageDump.ls).not.toContain(offlineMail);
    expect(storageDump.ss).not.toContain(offlineMsg);
    expect(storageDump.ss).not.toContain(offlineMail);
    expect(storageDump.cookie).not.toContain(offlineMsg);
    expect(storageDump.cookie).not.toContain(offlineMail);

    await page.context().setOffline(false);
    await page.reload();
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByLabel('Message')).toHaveValue('');
    await expect(page.getByLabel('Email (optional)')).toHaveValue('');
  });

  test('visitor expiry/revocation and operator role revocation reject next poll & send with no body/write, keep draft, stop timers/UUID swap, and block tampered threadId/seq/email', async ({
    page,
    playwright,
  }) => {
    const marker = randomUUID().slice(0, 8);
    await page.goto('/en/contact');
    await consent(page, 'none');
    await page.goto('/en/contact');
    await page.getByTestId('contact-human-chat').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

    const retainedEmail = `same-${marker}@example.com`;
    await page.getByLabel('Email (optional)').fill(retainedEmail);
    await page.getByLabel('Message').fill(`C1 open message [${marker}]`);
    const c1Promise = page.waitForResponse(
      (res) => res.url().endsWith('/api/chat/conversations') && res.request().method() === 'POST',
    );
    await page.getByTestId('chat-send').click();
    const c1Res = await c1Promise;
    expect([200, 201]).toContain(c1Res.status());
    const c1Id = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    const c1Conv = await prisma().chatConversation.findUniqueOrThrow({ where: { id: c1Id } });

    // Create an unsent draft in the composer before visitor session expires
    const unsentDraft = `Keep my unsent draft [${marker}]`;
    await page.getByLabel('Message').fill(unsentDraft);

    // Expire & revoke visitor session in DB (7-day idle & 30-day hard ceiling / revokedAt)
    const past = new Date(Date.now() - 60_000);
    await prisma().chatVisitorSession.update({
      where: { id: c1Conv.visitorSessionId },
      data: { lastActivityAt: past, absoluteExpiresAt: past, revokedAt: past },
    });

    const getStatuses: number[] = [];
    const postStatuses: number[] = [];
    page.on('response', (res) => {
      if (res.url().includes(`/api/chat/conversations/${c1Id}`)) {
        if (res.request().method() === 'GET') getStatuses.push(res.status());
        if (res.request().method() === 'POST' && res.url().endsWith('/messages')) postStatuses.push(res.status());
      }
    });

    // Next poll detects 401 -> stops timers, keeps draft, shows Start a new conversation
    await page.getByTestId('chat-refresh').click();
    await expect(page.getByTestId('chat-terminal-banner')).toBeVisible();
    await expect(page.getByTestId('chat-start-new')).toHaveText('Start a new conversation');
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByLabel('Message')).toHaveValue(unsentDraft);
    expect(getStatuses).toEqual([401]);

    // Wait 3.5s -> zero further background polls after terminal stop
    await page.waitForTimeout(3_500);
    expect(getStatuses).toEqual([401]);

    // Verify direct HTTP send after expiry returns 401 with zero messages written and zero body leaked
    const rejectedSend = await page.evaluate(
      async ({ id, clientMsgId }) => {
        const res = await fetch(`/api/chat/conversations/${id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientMessageId: clientMsgId, bodyText: 'Should be rejected after revocation' }),
        });
        return { status: res.status, json: await res.json() };
      },
      { id: c1Id, clientMsgId: randomUUID() },
    );
    expect(rejectedSend.status).toBe(401);
    expect(AppErrorDTOSchema.parse(rejectedSend.json).error).toBe('unauthorized');

    const c1MsgsAfter = await prisma().chatMessage.findMany({ where: { conversationId: c1Id } });
    expect(c1MsgsAfter).toHaveLength(1);

    // Start brand new session/conversation C2 -> must not reuse C1 even with same email, and tampering threadId/seq is rejected
    await page.getByTestId('chat-start-new').click();
    await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');
    await page.getByLabel('Email (optional)').fill(retainedEmail);
    await page.getByLabel('Message').fill(`C2 fresh thread [${marker}]`);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-receipt')).toHaveAttribute('data-seq', '1');
    const c2Id = (await page.getByTestId('chat-panel').getAttribute('data-conversation-id'))!;
    expect(c2Id).not.toBe(c1Id);

    const tamperProbe = await page.evaluate(
      async ({ targetId, body }) => {
        const g = await fetch(`/api/chat/conversations/${targetId}?afterSeq=0`);
        const p = await fetch(`/api/chat/conversations/${targetId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientMessageId: crypto.randomUUID(), bodyText: body }),
        });
        const r = await fetch(`/api/chat/conversations/${targetId}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lastReadSeq: 99 }),
        });
        return { gStatus: g.status, gBody: await g.json(), pStatus: p.status, rStatus: r.status };
      },
      { targetId: c1Id, body: 'Cross-thread tamper attempt' },
    );
    expect(tamperProbe.gStatus).toBe(404);
    expect(AppErrorDTOSchema.parse(tamperProbe.gBody).error).toBe('not_found');
    expect(tamperProbe.gBody.messages).toBeUndefined();
    expect(tamperProbe.pStatus).toBe(404);
    expect(tamperProbe.rStatus).toBe(404);

    // Operator role revocation (SALES -> EDITOR): real API + shared poller/retry stop without leaking body or writing
    const salesOp = await createSalesSessionContext(playwright);
    try {
      const okRead = await salesCtxGetAndParse(salesOp.context, c2Id);
      expect(okRead.messages).toHaveLength(1);

      const okReply = await salesOp.context.post(`/api/admin/chat/conversations/${c2Id}/messages`, {
        headers: { Origin: BASE },
        data: { clientMessageId: randomUUID(), bodyText: `Operator before revoke [${marker}]` },
      });
      expect([200, 201]).toContain(okReply.status());

      // Demote role to EDITOR (no chat permissions)
      await prisma().user.update({ where: { id: salesOp.userId }, data: { role: 'EDITOR' } });

      // Next operator poll & send via shared chat-poller + real HTTP must be rejected (403 forbidden) with no body/write
      let pollerStoppedReason: string | null = null;
      let pollHttpStatus = 0;
      let pollBodyJson: unknown = null;
      const opPoller = createChatPoller<unknown>({
        audience: 'admin',
        getTarget: () => ({ conversationId: c2Id, afterSeq: 0 }),
        fetchUpdates: async (target) => {
          const res = await salesOp.context.get(`/api/admin/chat/conversations/${target.conversationId}?afterSeq=${target.afterSeq}&limit=50`);
          pollHttpStatus = res.status();
          pollBodyJson = await res.json();
          const parsedErr = AppErrorDTOSchema.parse(pollBodyJson);
          return {
            ok: false,
            text: 'Forbidden',
            action: 'stop',
            envelope: 'app',
            code: parsedErr.error,
            status: pollHttpStatus,
            retryable: false,
            attempts: 1,
            transient: false,
          };
        },
        onUpdates: () => {
          throw new Error('Operator poller should not emit updates after role revocation');
        },
        onTerminal: (reason) => {
          pollerStoppedReason = reason;
        },
      });
      opPoller.start();
      await opPoller.refreshNow();
      expect(pollHttpStatus).toBe(403);
      expect(AppErrorDTOSchema.parse(pollBodyJson).error).toBe('forbidden');
      expect((pollBodyJson as { messages?: unknown }).messages).toBeUndefined();
      expect(pollerStoppedReason).toBe('forbidden');
      expect(opPoller.getSnapshot().phase).toBe('stopped');
      opPoller.dispose();

      const opSendAfterRevoke = await salesOp.context.post(`/api/admin/chat/conversations/${c2Id}/messages`, {
        headers: { Origin: BASE },
        data: { clientMessageId: randomUUID(), bodyText: `Should not write after revoke [${marker}]` },
      });
      expect(opSendAfterRevoke.status()).toBe(403);
      const sendErrDto = AppErrorDTOSchema.parse(await opSendAfterRevoke.json());
      expect(sendErrDto.error).toBe('forbidden');

      const retryResolution = resolveChatSendFailure({
        failure: {
          ok: false,
          text: 'Forbidden',
          action: 'stop',
          envelope: 'app',
          code: sendErrDto.error,
          status: 403,
          retryable: false,
          attempts: 1,
          transient: false,
        },
        submission: {
          conversationId: c2Id,
          clientMessageId: randomUUID(),
          locale: 'en',
          bodyText: 'Operator draft to preserve',
        },
        hadPendingRetry: true,
        audience: 'admin',
        offline: false,
      });
      expect(retryResolution).toEqual({
        kind: 'terminal',
        terminalReason: 'forbidden',
        preserveDraft: true,
        clearPendingRetry: true,
      });

      const c2MsgsFinal = await prisma().chatMessage.findMany({ where: { conversationId: c2Id } });
      expect(c2MsgsFinal).toHaveLength(2);
    } finally {
      await salesOp.context.dispose();
    }
  });

  test('minimalist-flat styles, focus, zero overflow, labels and 44px touch targets for retry and new-messages controls across 1920/1440/390', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
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
          'cf-connecting-ip': '198.18.21.15',
        },
      });
      const page = await context.newPage();
      await page.goto('/en/contact');
      await consent(page, 'none');
      await page.goto('/en/contact');

      await page.getByTestId('contact-human-chat').click();
      await expect(page.getByTestId('chat-availability-status')).toHaveText('Offline message');

      // Force a single quick 500 -> show chat-retry cleanly with minimalist-flat controls
      await page.route('**/api/chat/conversations', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'internal_error', requestId: randomUUID() }),
          });
          return;
        }
        await route.continue();
      });

      await page.getByLabel('Message').fill(`Visual probe [${vp.width}]`);
      await page.getByTestId('chat-send').click();

      const retryBtn = page.getByTestId('chat-retry');
      await expect(retryBtn).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('chat-close').focus();
      for (let step = 0; step < 8; step += 1) {
        if ((await page.evaluate(() => document.activeElement?.id ?? '')) === 'chat-retry') break;
        await page.keyboard.press('Tab');
      }
      await expect(retryBtn).toBeFocused();

      const measured = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="chat-panel"]') as HTMLElement;
        const retry = document.getElementById('chat-retry') as HTMLElement;
        const panelStyle = getComputedStyle(panel);
        const retryStyle = getComputedStyle(retry);
        const retryRect = retry.getBoundingClientRect();
        return {
          accentToken: panelStyle.getPropertyValue('--pj-accent').trim(),
          borderW: retryStyle.borderTopWidth,
          borderColor: retryStyle.borderTopColor,
          radius: retryStyle.borderRadius,
          shadow: retryStyle.boxShadow,
          outlineColor: retryStyle.outlineColor,
          width: retryRect.width,
          height: retryRect.height,
          docOverflow: document.documentElement.scrollWidth > window.innerWidth,
          hasRetryLabel: retry.getAttribute('aria-label') || retry.textContent?.trim(),
        };
      });

      expect(measured.accentToken).toBe('#b45700');
      expect(measured.borderW).toBe('2px');
      expect(measured.borderColor).toBe('rgb(0, 0, 0)');
      expect(measured.radius).toBe('0px');
      expect(measured.shadow).toBe('none');
      expect(measured.outlineColor).toBe('rgb(180, 87, 0)');
      expect(measured.width).toBeGreaterThanOrEqual(44);
      expect(measured.height).toBeGreaterThanOrEqual(44);
      expect(measured.docOverflow).toBe(false);
      expect(Boolean(measured.hasRetryLabel)).toBe(true);

      await context.close();
    }
  });
});

async function salesCtxGetAndParse(ctx: import('@playwright/test').APIRequestContext, conversationId: string) {
  const res = await ctx.get(`/api/admin/chat/conversations/${conversationId}`);
  expect(res.status()).toBe(200);
  return AdminChatSyncDTOSchema.parse(await res.json());
}
