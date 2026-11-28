import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { BASE } from './base-url';
import { loadRunAuth } from './run-auth';
import { E2E_EDGE_AUTH_SECRET } from '../scripts/e2e-edge-auth';
import { shiftLocalDate } from '../src/lib/analytics/aggregate-plan';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { AnalyticsSettingsDTOSchema } from '../src/lib/contracts/analytics';
import { ConversationReceivedDTOSchema } from '../src/lib/contracts/chat';
import { StatsDTOSchema, type StatsDTO, type StatsSource } from '../src/lib/contracts/ops';

const RELIABILITY_SOURCES = ['api_requests', 'api_errors', 'chat_notifications', 'mail'] as const satisfies readonly StatsSource[];

// 198.18.0.0/15 专用测试 IP，与 edge-test-ip.ts (1..12)、stats-business-api (20..21) 隔离限流桶。
const INQUIRY_EDGE_HEADERS = { 'x-edge-auth': E2E_EDGE_AUTH_SECRET, 'cf-connecting-ip': '198.18.10.22' };
const CHAT_EDGE_HEADERS = { origin: BASE, 'x-edge-auth': E2E_EDGE_AUTH_SECRET, 'cf-connecting-ip': '198.18.10.23' };

function findSource(dto: StatsDTO, source: StatsSource) {
  const hit = dto.sources.find((item) => item.source === source);
  if (!hit) throw new Error(`Missing source ${source} in StatsDTO`);
  return hit;
}

test.describe('M6-T5 HTTP and mail reliability statistics sources', () => {
  test.describe.configure({ timeout: 120_000 });

  test('M6-T5 E-51/E-52/E-53/E-64/E-67: 已接线API计数与错误率覆盖边界、未配置SMTP不把排队或咨询received算投递及角色裁剪', async ({
    playwright,
  }) => {
    const adminAuth = await loadRunAuth('shell-main', BASE, playwright.request);
    const salesAuth = await loadRunAuth('sales', BASE, playwright.request);
    const editorAuth = await loadRunAuth('editor', BASE, playwright.request);

    const anon = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: INQUIRY_EDGE_HEADERS });
    const admin = await playwright.request.newContext({ baseURL: BASE, storageState: adminAuth });
    const sales = await playwright.request.newContext({ baseURL: BASE, storageState: salesAuth });
    const editor = await playwright.request.newContext({ baseURL: BASE, storageState: editorAuth });
    const visitor = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: CHAT_EDGE_HEADERS });

    try {
      // 1. 匿名请求可靠性来源必须 401 且 private, no-store
      const unauth = await anon.get('/api/admin/stats?sources=api_requests,mail');
      expect(unauth.status()).toBe(401);
      expect(unauth.headers()['cache-control']).toContain('no-store');

      // 2. 读取当前站点时区与自然日，并校验无流量历史日“无分母为 null”且 scope 固定为 instrumented_routes（AC1、E-64）
      const settingsRes = await admin.get('/api/admin/settings/analytics');
      expect(settingsRes.status()).toBe(200);
      const settings = AnalyticsSettingsDTOSchema.parse(await settingsRes.json());
      const today = siteLocalDate(new Date(), settings.timezone);
      const emptyPastDay = shiftLocalDate(today, -15);

      const emptyDayRes = await admin.get(
        `/api/admin/stats?from=${emptyPastDay}&to=${emptyPastDay}&timezoneRevision=${settings.timezoneRevision}&sources=api_requests,api_errors`,
      );
      expect(emptyDayRes.status()).toBe(200);
      expect(emptyDayRes.headers()['cache-control']).toContain('no-store');
      const emptyDayDto = StatsDTOSchema.parse(await emptyDayRes.json());
      expect(findSource(emptyDayDto, 'api_requests')).toMatchObject({
        state: 'no_data',
        value: null,
        coverage: 'unavailable',
      });
      expect(findSource(emptyDayDto, 'api_errors')).toMatchObject({
        state: 'no_data',
        value: null,
        coverage: 'unavailable',
      });
      expect(emptyDayDto.apiErrorRate).toEqual({
        value: null,
        coverage: 'unavailable',
        scope: 'instrumented_routes',
      });

      // 3. 记录当日已接线 HTTP 计数基线（注意：baselineRes 本身在返回时作为 +1 计入 ApiDailyCounter）
      const baselineRes = await admin.get(
        `/api/admin/stats?from=${today}&to=${today}&sources=${RELIABILITY_SOURCES.join(',')}`,
      );
      expect(baselineRes.status()).toBe(200);
      const baselineDto = StatsDTOSchema.parse(await baselineRes.json());
      const beforeReq = findSource(baselineDto, 'api_requests').value ?? 0;
      const beforeErr = findSource(baselineDto, 'api_errors').value ?? 0;

      // 4. 触发本轮已接线 API 的真实 2xx 与 4xx 响应，以及未接线旧 API 响应
      // 已接线 #1: GET /api/admin/account -> 200
      expect((await admin.get('/api/admin/account')).status()).toBe(200);
      // 已接线 #2: POST /api/chat/session -> 200
      expect((await visitor.post('/api/chat/session', { data: { locale: 'en' } })).status()).toBe(200);
      // 已接线 #3: POST /api/chat/conversations -> 200（产生真实咨询 received 与 QUEUED 通知出箱）
      const marker = randomUUID().slice(0, 8);
      const chatEmail = `m6t5-chat-${marker}@example.test`;
      const chatBody = `M6-T5 reliability synthetic chat ${marker}`;
      const chatCreateRes = await visitor.post('/api/chat/conversations', {
        data: {
          clientConversationId: randomUUID(),
          clientMessageId: randomUUID(),
          locale: 'en',
          email: chatEmail,
          bodyText: chatBody,
        },
      });
      expect(chatCreateRes.status()).toBe(200);
      const createdConv = ConversationReceivedDTOSchema.parse(await chatCreateRes.json());
      expect(createdConv.duplicate).toBe(false);

      // 已接线 #4: GET /api/admin/stats?unknownKey=1 -> 400（计入分母 requestCount，不计入 5xx errorCount）
      expect((await admin.get('/api/admin/stats?unknownKey=1')).status()).toBe(400);

      // 未接线既有路由：POST /api/inquiries (201) 与 POST /api/rum (204) —— 不得混入 instrumented_routes 分母！
      const inqEmail = `m6t5-inq-${marker}@example.test`;
      const inqMsg = `M6-T5 synthetic inquiry ${marker}`;
      const inqRes = await anon.post('/api/inquiries', {
        data: {
          source: 'FORM',
          locale: 'en',
          message: inqMsg,
          turnstileToken: 'XXXX.DUMMY.TOKEN.1',
          contact: { name: 'M6-T5 Buyer', email: inqEmail, region: 'DE' },
        },
      });
      expect(inqRes.status()).toBe(201);
      const { ref } = (await inqRes.json()) as { ref: string };
      expect((await anon.post('/api/rum', { data: {} })).status()).toBeLessThan(500);

      // 若环境提供 CRON_SECRET，触发真实 chat-notifications 作业（当前 /api/admin/cron/operations 未接入 ApiDailyCounter）；
      // 因 E2E 默认未配 SMTP，通知出箱置 DISABLED 且来源仍保持 not_connected（不把咨询 received 或空跑伪报为已投递）
      if (process.env.CRON_SECRET) {
        const cronRes = await anon.post('/api/admin/cron/operations', {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
          data: { jobKey: 'chat-notifications' },
        });
        expect([200, 409]).toContain(cronRes.status());
      }

      // 5. 再次读取可靠性来源：baselineRes(+1) + 4 次实际已接线路由请求；未写 ApiDailyCounter 的 /api/inquiries、/api/rum 与 /api/admin/cron/operations 均不计入
      const afterRes = await admin.get(
        `/api/admin/stats?from=${today}&to=${today}&sources=inquiries,${RELIABILITY_SOURCES.join(',')}`,
      );
      expect(afterRes.status()).toBe(200);
      const afterText = await afterRes.text();
      const afterDto = StatsDTOSchema.parse(JSON.parse(afterText));

      const afterReq = findSource(afterDto, 'api_requests');
      const afterErr = findSource(afterDto, 'api_errors');
      expect(afterReq.state).toBe('ok');
      expect(afterReq.coverage).toBe('partial');
      expect(afterReq.value).toBe(beforeReq + 1 + 4);
      expect(afterErr.coverage).toBe('partial');
      expect(afterErr.value).toBe(beforeErr);
      expect(afterDto.apiErrorRate).toEqual({
        value: (afterErr.value ?? 0) / (afterReq.value ?? 1),
        coverage: 'partial',
        scope: 'instrumented_routes',
      });

      // E2E 共享服务未配置 SMTP：chat_notifications 与 mail 独立报告 not_connected，不阻断 inquiries 与 api_*（E-64、E-67）
      expect(findSource(afterDto, 'inquiries').state).toBe('ok');
      expect(findSource(afterDto, 'chat_notifications')).toMatchObject({ state: 'not_connected', value: null });
      expect(findSource(afterDto, 'mail')).toMatchObject({ state: 'not_connected', value: null });

      for (const leak of [chatEmail, chatBody, inqEmail, inqMsg, ref, createdConv.conversationId, createdConv.message.id]) {
        expect(afterText).not.toContain(leak);
      }

      // 6. 角色权限裁剪（E-66）：SALES 拒绝 api_requests / api_errors / mail，混合查询仅保留授权源；EDITOR 全部拒绝
      for (const forbidden of ['api_requests', 'api_errors', 'mail'] as const) {
        expect((await sales.get(`/api/admin/stats?sources=${forbidden}`)).status()).toBe(403);
      }
      const salesMixed = await sales.get(
        `/api/admin/stats?from=${today}&to=${today}&sources=inquiries,chat_notifications,api_requests,api_errors,mail`,
      );
      expect(salesMixed.status()).toBe(200);
      const salesMixedText = await salesMixed.text();
      const salesMixedDto = StatsDTOSchema.parse(JSON.parse(salesMixedText));
      expect(salesMixedDto.sources.map((item) => item.source)).toEqual(['inquiries', 'chat_notifications']);
      expect(salesMixedDto.apiErrorRate).toBeNull();
      expect(salesMixedText).not.toContain('"mail"');
      expect(salesMixedText).not.toContain('"api_requests"');
      expect(salesMixedText).not.toContain('"api_errors"');

      for (const source of RELIABILITY_SOURCES) {
        expect((await editor.get(`/api/admin/stats?sources=${source}`)).status()).toBe(403);
      }
      const editorMixed = await editor.get(
        `/api/admin/stats?from=${today}&to=${today}&sources=visitors,${RELIABILITY_SOURCES.join(',')}`,
      );
      expect(editorMixed.status()).toBe(200);
      const editorMixedText = await editorMixed.text();
      const editorMixedDto = StatsDTOSchema.parse(JSON.parse(editorMixedText));
      expect(editorMixedDto.sources.map((item) => item.source)).toEqual(['visitors']);
      expect(editorMixedDto.apiErrorRate).toBeNull();
      expect(editorMixedDto.notificationCounts).toBeNull();
      for (const source of RELIABILITY_SOURCES) {
        expect(editorMixedText).not.toContain(source);
      }
    } finally {
      await Promise.all([anon, admin, sales, editor, visitor].map((ctx) => ctx.dispose()));
    }
  });
});
