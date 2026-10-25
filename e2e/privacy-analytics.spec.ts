import { PrismaClient } from '@prisma/client';
import { TimezoneSchema } from '../src/lib/contracts/common';
import { expect, test } from './fixtures';

let db: PrismaClient | undefined;

function timezoneOf(value: unknown): string {
  let data = value;
  if (typeof data === 'string') {
    try { data = JSON.parse(data) as unknown; } catch { return 'UTC'; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'UTC';
  const parsed = TimezoneSchema.safeParse((data as { timezone?: unknown }).timezone);
  return parsed.success ? parsed.data : 'UTC';
}

async function siteTimezone(): Promise<string> {
  if (!process.env.DATABASE_URL) throw new Error('expected the isolated test database');
  db ??= new PrismaClient();
  try {
    const row = await db.siteSetting.findUnique({ where: { key: 'analytics.settings' } });
    return timezoneOf(row?.value);
  } catch {
    return 'UTC';
  }
}

test.afterAll(async () => {
  await db?.$disconnect();
});

test('页脚隐私链接打开 en/ru 说明，期限、时区和清理状态可见', async ({ page }) => {
  await page.goto('/en');
  await page.locator('#privacy-link').click();
  await expect(page).toHaveURL(/\/en\/privacy$/);
  await expect(page.locator('#privacy-necessary-chat')).toBeVisible();
  await expect(page.locator('#privacy-analytics-consent')).toBeVisible();
  await expect(page.locator('#privacy-cleanup-status')).toBeVisible();
  await expect(page.locator('#privacy-analytics-consent')).toContainText('anonymous browsers that consented to analytics');
  await expect(page.locator('#privacy-necessary-chat')).toContainText('7');
  await expect(page.locator('#privacy-necessary-chat')).toContainText('30');
  await expect(page.locator('#privacy-analytics-consent')).toContainText('90');
  await expect(page.locator('#privacy-analytics-consent')).toContainText('30');
  await expect(page.locator('#privacy-analytics-consent')).toContainText('13');
  await expect(page.locator('#privacy-cleanup-status')).toContainText('not enabled');
  await expect(page.locator('#privacy-cleanup-status')).toContainText('dry-run');
  await expect(page.locator('#privacy-cleanup-status')).toContainText('separate authorization');
  await expect(page.locator('#privacy-cleanup-status')).toContainText('Documentation and task dispatch are not that authorization');
  const en = await page.locator('main').innerText();
  if (/unique real person|cross-device identification/i.test(en)) throw new Error('unexpected identification claim');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('#privacy-site-timezone')).toHaveText(await siteTimezone());

  await page.goto('/ru');
  await page.locator('#privacy-link').click();
  await expect(page).toHaveURL(/\/ru\/privacy$/);
  await expect(page.locator('#privacy-analytics-consent')).toContainText('анонимных браузеров, разрешивших аналитику');
  const ru = await page.locator('#privacy-analytics-consent').innerText();
  if (ru.includes('уникального человека') || ru.includes('между устройствами')) throw new Error('unexpected identification claim');
  await expect(page.locator('#privacy-site-timezone')).toHaveText(await siteTimezone());
});
