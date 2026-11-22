import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from '@playwright/test';
import { initializeRunAuth, reportRunAuthPermissionDiagnostic } from './run-auth';
/** Run the initialization at the real globalSetup boundary: log at most one closed-set PERMISSIONS line, then rethrow the same error. */
export async function runGlobalSetupInitialization<T>(run: () => Promise<T>, log?: (line: string) => void): Promise<T> {
  try {
    return await run();
  } catch (error) {
    reportRunAuthPermissionDiagnostic(error, log);
    throw error;
  }
}
function recordJ6Setup(checkpoint: 'setup-entered' | 'seed-accepted' | 'setup-complete') {
  const root = process.env.J6_SEAM_EVIDENCE_ROOT;
  const directory = process.env.J6_PW_PROGRESS_DIR;
  if (process.env.J6_SEAM_EVIDENCE !== '1' || !root || directory !== join(root, 'pw-progress')) return;
  try {
    writeFileSync(join(directory, checkpoint), '', { flag: 'wx' });
  } catch {
    // Missing observations do not change setup or teardown.
  }
}

// 用 scripts/create-admin.mjs（pnpm admin:seed）创建测试管理员（仅 E2E 数据库）。已存在则忽略。
export default async function globalSetup() {
  recordJ6Setup('setup-entered');
  if (!process.env.DATABASE_URL) throw new Error('E2E 需要 DATABASE_URL（测试库）');
  try {
    const out = execFileSync('node', ['scripts/create-admin.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, ADMIN_SEED_EMAIL: E2E_ADMIN.email, ADMIN_SEED_PASSWORD: E2E_ADMIN.password, ADMIN_SEED_NAME: 'E2E', ADMIN_SEED_ROLE: 'ADMIN' }
    });
    // #347：新建的未绑定账号会在 stdout 打印一次性绑定链接；令牌只放进本进程环境，给 admin.spec.ts 绑定用（worker 继承 process.env），不打印
    const t = /#t=([A-Za-z0-9_-]{43})/.exec(String(out))?.[1];
    if (t) process.env.E2E_ADMIN_ENROLL_TOKEN = t;
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? e);
    if (!msg.includes('已存在')) throw new Error('E2E global administrator seed failed');
  }
  recordJ6Setup('seed-accepted');
  const cleanup = await runGlobalSetupInitialization(() => initializeRunAuth(`http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`, request));
  recordJ6Setup('setup-complete');
  return cleanup;
}
export const E2E_ADMIN = { email: 'e2e-admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-only-Passw0rd!' };
