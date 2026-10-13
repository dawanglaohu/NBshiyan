import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0, // #144 要求稳定，不靠重试掩盖偶发失败
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: BASE, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off', locale: 'en-US' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'node e2e/turnstile-mock.mjs', url: 'http://127.0.0.1:3999/health', reuseExistingServer: !process.env.CI },
    { command: `pnpm start -p ${PORT}`, url: `${BASE}/en`, timeout: 120_000, reuseExistingServer: !process.env.CI }
  ]
});
