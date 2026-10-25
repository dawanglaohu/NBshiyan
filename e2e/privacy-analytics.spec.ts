import { expect, test } from './fixtures';

test('页脚隐私链接打开 en/ru 的统计同意说明', async ({ page }) => {
  await page.goto('/en');
  await page.locator('#privacy-link').click();
  await expect(page).toHaveURL(/\/en\/privacy$/);
  await expect(page.locator('#privacy-analytics-consent')).toBeVisible();
  await expect(page.locator('#privacy-analytics-consent')).toContainText('anonymous browsers that consented to analytics');
  await expect(page.locator('#privacy-analytics-consent')).toContainText('30');
  await expect(page.locator('#privacy-analytics-consent')).toContainText('13');
  const en = await page.locator('main').innerText();
  if (/unique real person|cross-device identification/i.test(en)) throw new Error('unexpected identification claim');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

  await page.goto('/ru');
  await page.locator('#privacy-link').click();
  await expect(page).toHaveURL(/\/ru\/privacy$/);
  await expect(page.locator('#privacy-analytics-consent')).toContainText('анонимных браузеров, разрешивших аналитику');
  const ru = await page.locator('#privacy-analytics-consent').innerText();
  if (ru.includes('уникального человека') || ru.includes('между устройствами')) throw new Error('unexpected identification claim');
});
