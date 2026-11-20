import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const root = process.env.B4_ROOT;
if (process.platform !== 'linux' || !root || !/^\/tmp\/packjoyu-b4\.[A-Za-z0-9]+$/.test(root)) {
  throw new Error('B4_PRIVATE_RUNNER_REQUIRED');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'b4-pg17.spec.ts',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 35 * 60_000,
  globalTimeout: 36 * 60_000,
  outputDir: join(root, 'playwright-output'),
  reporter: [['json', { outputFile: join(root, 'playwright.json') }]],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
