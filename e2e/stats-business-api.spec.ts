import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { BASE } from './base-url';
import { loadRunAuth } from './run-auth';
import { E2E_EDGE_AUTH_SECRET } from '../scripts/e2e-edge-auth';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { AccountDTOSchema } from '../src/lib/contracts/account';
import { AnalyticsSettingsDTOSchema } from '../src/lib/contracts/analytics';
import { ConversationReceivedDTOSchema, MessageReceivedDTOSchema } from '../src/lib/contracts/chat';
import { StatsDTOSchema, type StatsSource } from '../src/lib/contracts/ops';

const BUSINESS_SOURCES = ['inquiries', 'chat_conversations', 'chat_messages'] as const satisfies readonly StatsSource[];
type Counts = Record<(typeof BUSINESS_SOURCES)[number], number>;

// 198.18.0.0/15 测试网段独立调用点，与 e2e/edge-test-ip.ts 中 198.18.10.1..12 不重叠，避免共享主段 untrusted 限流桶。
const INQUIRY_EDGE_HEADERS = { 'x-edge-auth': E2E_EDGE_AUTH_SECRET, 'cf-connecting-ip': '198.18.10.20' };
const CHAT_EDGE_HEADERS = { origin: BASE, 'x-edge-auth': E2E_EDGE_AUTH_SECRET, 'cf-connecting-ip': '198.18.10.21' };

async function readCounts(request: APIRequestContext, day: string): Promise<{ counts: Counts; text: string }> {
  const response = await request.get(`/api/admin/stats?from=${day}&to=${day}&sources=${BUSINESS_SOURCES.join(',')}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const text = await response.text();
  const dto = StatsDTOSchema.parse(JSON.parse(text));
  expect(dto.sources.map((item) => item.source)).toEqual([...BUSINESS_SOURCES]);
  const counts = Object.fromEntries(dto.sources.map((item) => {
    expect(['ok', 'zero']).toContain(item.state);
    expect(item.coverage).toBe('full');
    return [item.source, item.value ?? 0];
  })) as Counts;
  return { counts, text };
}

test.describe('M6-T2 business statistics source', () => {
  test.describe.configure({ timeout: 120_000 });

  test('M6-T2 E-62/E-66: 真实询盘与聊天提交 -> 角色限制的业务计数，重试与垃圾不加计数，EDITOR/匿名被拒', async ({ playwright }) => {
    const adminAuth = await loadRunAuth('shell-main', BASE, playwright.request);
    const salesAuth = await loadRunAuth('sales', BASE, playwright.request);
    const editorAuth = await loadRunAuth('editor', BASE, playwright.request);

    const anon = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: INQUIRY_EDGE_HEADERS });
    const admin = await playwright.request.newContext({ baseURL: BASE, storageState: adminAuth });
    const sales = await playwright.request.newContext({ baseURL: BASE, storageState: salesAuth });
    const editor = await playwright.request.newContext({ baseURL: BASE, storageState: editorAuth });
    const visitor = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: CHAT_EDGE_HEADERS });

    try {
      const settings = await admin.get('/api/admin/settings/analytics');
      expect(settings.status()).toBe(200);
      const day = siteLocalDate(new Date(), AnalyticsSettingsDTOSchema.parse(await settings.json()).timezone);

      const salesAccountRes = await sales.get('/api/admin/account');
      expect(salesAccountRes.status()).toBe(200);
      const salesUserId = AccountDTOSchema.parse(await salesAccountRes.json()).id;

      const adminBefore = (await readCounts(admin, day)).counts;
      const salesBefore = (await readCounts(sales, day)).counts;

      // 询盘：一条合法提交（落库）、蜜罐与非法邮箱（不落库）。
      const marker = randomUUID().slice(0, 8);
      const email = `m6t2-${marker}@example.test`;
      const message = `M6-T2 synthetic inquiry ${marker}`;
      const accepted = await anon.post('/api/inquiries', {
        data: {
          source: 'FORM', locale: 'en', message, turnstileToken: 'XXXX.DUMMY.TOKEN.1',
          contact: { name: 'M6-T2 Synthetic', email, region: 'DE' },
        },
      });
      expect(accepted.status()).toBe(201);
      const { ref } = (await accepted.json()) as { ref: string };
      const honeypot = await anon.post('/api/inquiries', {
        data: {
          source: 'FORM', locale: 'en', website: 'https://spam.example', turnstileToken: 'XXXX.DUMMY.TOKEN.1',
          contact: { name: 'Spam', email: `spam-${marker}@example.test`, region: 'DE' },
        },
      });
      expect(((await honeypot.json()) as { ref: string }).ref).toBe('PJ-OK');
      const invalid = await anon.post('/api/inquiries', {
        data: { source: 'FORM', locale: 'en', turnstileToken: 'XXXX.DUMMY.TOKEN.1', contact: { name: 'x', email: 'not-an-email', region: 'DE' } },
      });
      expect(invalid.status()).toBe(400);

      // 聊天：首条消息、同 UUID 重试、追加消息及其重试、被拒绝的非法提交。
      const session = await visitor.post('/api/chat/session', { data: { locale: 'en' } });
      expect(session.status()).toBe(200);
      const payload = {
        clientConversationId: randomUUID(), clientMessageId: randomUUID(), locale: 'en',
        bodyText: `M6-T2 synthetic chat ${marker}`, email: `chat-${marker}@example.test`,
      };
      const createRes = await visitor.post('/api/chat/conversations', { data: payload });
      expect(createRes.status()).toBe(200);
      const created = ConversationReceivedDTOSchema.parse(await createRes.json());
      expect(created.duplicate).toBe(false);
      const retryRes = await visitor.post('/api/chat/conversations', { data: payload });
      expect(retryRes.status()).toBe(200);
      const retried = ConversationReceivedDTOSchema.parse(await retryRes.json());
      expect(retried).toMatchObject({ duplicate: true, conversationId: created.conversationId });

      const followUp = { clientMessageId: randomUUID(), bodyText: `M6-T2 second chat ${marker}` };
      const appendPath = `/api/chat/conversations/${created.conversationId}/messages`;
      const first = MessageReceivedDTOSchema.parse(await (await visitor.post(appendPath, { data: followUp })).json());
      const second = MessageReceivedDTOSchema.parse(await (await visitor.post(appendPath, { data: followUp })).json());
      expect([first.duplicate, second.duplicate]).toEqual([false, true]);
      const rejected = await visitor.post('/api/chat/conversations', { data: { ...payload, clientConversationId: randomUUID(), bodyText: '' } });
      expect(rejected.status()).toBe(400);

      // ADMIN 看到 +1 询盘、+1 会话、+2 消息；SALES 的询盘 scope 只含分配给自己的，未分配的新询盘不计入。
      const adminAfter = await readCounts(admin, day);
      expect(adminAfter.counts.inquiries).toBe(adminBefore.inquiries + 1);
      expect(adminAfter.counts.chat_conversations).toBe(adminBefore.chat_conversations + 1);
      expect(adminAfter.counts.chat_messages).toBe(adminBefore.chat_messages + 2);
      const salesUnassigned = await readCounts(sales, day);
      expect(salesUnassigned.counts.inquiries).toBe(salesBefore.inquiries);
      expect(salesUnassigned.counts.chat_conversations).toBe(salesBefore.chat_conversations + 1);
      expect(salesUnassigned.counts.chat_messages).toBe(salesBefore.chat_messages + 2);

      // ADMIN 将该合成询盘指派给 SALES 后，SALES 按既有 inquiryScope 读到 +1。
      const listRes = await admin.get(`/api/admin/inquiries?q=${encodeURIComponent(ref)}`);
      expect(listRes.status()).toBe(200);
      const listed = (await listRes.json()) as { items: Array<{ id: string; ref: string }> };
      const targetInquiry = listed.items.find((item) => item.ref === ref);
      expect(targetInquiry).toBeTruthy();
      const assignRes = await admin.patch(`/api/admin/inquiries/${targetInquiry!.id}`, {
        headers: { origin: BASE },
        data: { assigneeId: salesUserId },
      });
      expect(assignRes.status()).toBe(200);

      const salesAssigned = await readCounts(sales, day);
      expect(salesAssigned.counts.inquiries).toBe(salesBefore.inquiries + 1);

      // 响应不含邮箱、正文、询盘编号或会话标识。
      for (const text of [adminAfter.text, salesUnassigned.text, salesAssigned.text]) {
        for (const leak of [email, `chat-${marker}`, message, payload.bodyText, followUp.bodyText, ref, created.conversationId, created.message.id]) {
          expect(text).not.toContain(leak);
        }
      }

      // 匿名 401；EDITOR 直接请求业务来源 403，混合请求在查询前裁剪。
      expect((await anon.get('/api/admin/stats?sources=inquiries')).status()).toBe(401);
      for (const source of BUSINESS_SOURCES) {
        expect((await editor.get(`/api/admin/stats?sources=${source}`)).status()).toBe(403);
      }
      const mixed = await editor.get(`/api/admin/stats?from=${day}&to=${day}&sources=visitors,${BUSINESS_SOURCES.join(',')}`);
      expect(mixed.status()).toBe(200);
      const mixedText = await mixed.text();
      expect(StatsDTOSchema.parse(JSON.parse(mixedText)).sources.map((item) => item.source)).toEqual(['visitors']);
      for (const source of BUSINESS_SOURCES) expect(mixedText).not.toContain(source);
    } finally {
      await Promise.all([anon, admin, sales, editor, visitor].map((context) => context.dispose()));
    }
  });
});
