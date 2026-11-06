import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const mode = process.env.SMTP_EVIDENCE_MODE;
if (!['http-real', 'http-disabled', 'off'].includes(mode || '')) throw new Error('MAIL_RUNTIME_MODE_REQUIRED');
const sourceRoot = process.cwd();
const active = path.join('/tmp/mail-evidence-artifacts', mode!);
if (realpathSync(active) !== active) throw new Error('MAIL_RUNTIME_ARTIFACT_PROVENANCE');
const receipt = JSON.parse(readFileSync(path.join(active, 'runtime-provenance.json'), 'utf8')) as {
  sourceCommit: string; sourceTree: string; runtimeMode: string; buildMode: string; businessCredentialsUsedInBuild: boolean;
};
if (receipt.sourceCommit !== process.env.GITHUB_SHA || receipt.runtimeMode !== mode || receipt.buildMode !== (mode === 'off' ? 'off' : 'http') || receipt.businessCredentialsUsedInBuild !== false) throw new Error('MAIL_ARTIFACT_MODE_MISMATCH');
const viewport = { width: 1440, height: 900 };
const baseURL = 'http://localhost:3100';
export default defineConfig({
  testDir: path.join(sourceRoot, 'tests/evidence'),
  testMatch: 'admin-legacy-inquiries-mail.spec.ts',
  globalSetup: path.join(sourceRoot, 'e2e/global-setup.ts'),
  outputDir: path.join(sourceRoot, `test-results/mail-evidence-${mode}`),
  preserveOutput: 'always', reporter: [['github'], ['list']],
  fullyParallel: false, workers: 1, retries: 0, timeout: 180_000, globalTimeout: 300_000,
  use: { baseURL, viewport, locale: 'en-US', video: { mode: 'on', size: viewport }, trace: 'off', screenshot: 'off' },
  projects: [{ name: `mail-${mode}`, use: { viewport, video: { mode: 'on', size: viewport }, screenshot: 'off', trace: 'off' } }],
  webServer: [
    { command: 'node e2e/turnstile-mock.mjs', url: 'http://127.0.0.1:3999/health', reuseExistingServer: false },
    { command: `cd "${active}" && node server.js > /tmp/mail-evidence-server-${mode}.log 2>&1`,
      url: `${baseURL}/en`, timeout: 120_000, reuseExistingServer: false,
      env: { PORT: '3100', HOSTNAME: '127.0.0.1', E2E_SITE_REVALIDATE: '1', AUTH_URL: baseURL, APP_ORIGIN: baseURL } },
  ],
});
