import { execFileSync } from 'node:child_process';
// 用 scripts/create-admin.mjs（pnpm admin:seed）创建测试管理员（仅 E2E 数据库）。已存在则忽略。
export default function globalSetup() {
  if (!process.env.DATABASE_URL) throw new Error('E2E 需要 DATABASE_URL（测试库）');
  try {
    execFileSync('node', ['scripts/create-admin.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, ADMIN_SEED_EMAIL: E2E_ADMIN.email, ADMIN_SEED_PASSWORD: E2E_ADMIN.password, ADMIN_SEED_NAME: 'E2E', ADMIN_SEED_ROLE: 'ADMIN' }
    });
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? e);
    if (!msg.includes('已存在')) throw e;
  }
}
export const E2E_ADMIN = { email: 'e2e-admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-only-Passw0rd!' };
