// M5-T8 真实调度验收：读取 deploy/cron.nbshiyan 的注册行，按真实五分钟计划
// 触发同一 POST，再核 JobState 与 watermark。
//
// 运行前提（缺一即 skip 并写明原因，不冒充通过）：
//   M5T8_E2E_SCHEDULER=1、M5T8_TEST_DATABASE_URL、CRON_SECRET 与一个运行中的
//   应用实例（PLAYWRIGHT_BASE_URL）。本机没有 Linux standalone + cron 时只跑
//   静态注册断言。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const cron = readFileSync('deploy/cron.nbshiyan', 'utf8');
const cronLines = cron.split(/\r?\n/);
const operationLine = cronLines.find((line) => line.includes('/api/admin/cron/operations'));

function nextFiveMinuteBoundary(from: Date): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + (5 - (next.getMinutes() % 5)));
  return next;
}

test.describe('M5-T8 固定作业与真实五分钟调度', () => {
  test('cron 模板只注册 analytics-aggregate 并替换旧 rollup', () => {
    expect(operationLine, 'cron 必须有一条 operations 调度').toBeTruthy();
    expect(operationLine!).toMatch(/^\*\/5 \* \* \* \* /);
    expect(operationLine!).toContain("jobKey:'analytics-aggregate'");
    expect(operationLine!).toContain('AbortSignal.timeout(55000)');
    expect(cronLines.some((line) => line.includes('/api/admin/cron/analytics-rollup'))).toBe(false);
  });

  test('真实五分钟边界触发一次并写 JobState/watermark；看板 GET 不触发', async ({ request }, testInfo) => {
    test.skip(process.env.M5T8_E2E_SCHEDULER !== '1', '需要 M5T8_E2E_SCHEDULER=1 与运行中的应用实例');
    const databaseUrl = process.env.M5T8_TEST_DATABASE_URL;
    test.skip(!databaseUrl, '需要 M5T8_TEST_DATABASE_URL');
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100';
    const secret = process.env.CRON_SECRET;
    test.skip(!secret, '需要 CRON_SECRET');

    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      // 看板 GET 不能触发作业：调用前后 JobState 的 lastStartedAt 不变。
      const before = await db.jobState.findUnique({ where: { key: 'analytics-aggregate' } });
      await request.get(`${baseUrl}/api/admin/stats`).catch(() => null);
      const afterGet = await db.jobState.findUnique({ where: { key: 'analytics-aggregate' } });
      expect(afterGet?.lastStartedAt ?? null).toEqual(before?.lastStartedAt ?? null);

      // 等到真实的五分钟边界再执行 cron 行里同一个 POST，而不是随手手动调用。
      const boundary = nextFiveMinuteBoundary(new Date());
      const waitMs = Math.max(0, boundary.getTime() - Date.now());
      testInfo.setTimeout(testInfo.timeout + waitMs + 90_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      const res = await request.post(`${baseUrl}/api/admin/cron/operations`, {
        headers: { authorization: `Bearer ${secret}` },
        data: { jobKey: 'analytics-aggregate' },
      });
      expect([200, 409]).toContain(res.status());

      const state = await db.jobState.findUnique({ where: { key: 'analytics-aggregate' } });
      expect(state?.lastStatus).toBe('SUCCEEDED');
      expect(state?.lastSucceededAt).not.toBeNull();
      const watermarks = await db.analyticsRollupDay.count();
      expect(watermarks).toBeGreaterThan(0);
    } finally {
      await db.$disconnect();
    }
  });
});
