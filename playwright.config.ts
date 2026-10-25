import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE = `http://localhost:${PORT}`;

/** 真实构建产物：next build 只产出 server.js 与被 trace 的依赖，static 与 public 要另行就位 */
const STANDALONE_DIR = path.join('.next', 'standalone');
const SERVER_ENTRY = path.join(STANDALONE_DIR, 'server.js');
/** standalone 的 stdout 落盘在这里，e2e 从同一份文件核对 /api/rum 的脱敏日志 */
const SERVER_LOG = path.join('.next', 'standalone-server.log');

function prepareStandaloneAssets() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`找不到 ${SERVER_ENTRY}：e2e 跑真实构建产物，先执行 pnpm build`);
  }
  cpSync(path.join('.next', 'static'), path.join(STANDALONE_DIR, '.next', 'static'), { recursive: true, force: true });
  cpSync('public', path.join(STANDALONE_DIR, 'public'), { recursive: true, force: true });
}

prepareStandaloneAssets();

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
    {
      // 全部 e2e 用例共用的唯一应用服务：.next/standalone/server.js（不是 next start）
      command: `node ${SERVER_ENTRY} > ${SERVER_LOG} 2>&1`,
      url: `${BASE}/en`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(PORT), HOSTNAME: '0.0.0.0', E2E_SITE_REVALIDATE: '1' }
    }
  ]
});
