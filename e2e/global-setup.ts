import { execFileSync } from 'node:child_process';
// 用 scripts/create-admin.mjs（pnpm admin:seed）创建测试管理员（仅 E2E 数据库）。已存在则忽略。
export default function globalSetup() {
  if (!process.env.DATABASE_URL) throw new Error('E2E 需要 DATABASE_URL（测试库）');
  try {
    const out = execFileSync('node', ['scripts/create-admin.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, ADMIN_SEED_EMAIL: E2E_ADMIN.email, ADMIN_SEED_PASSWORD: E2E_ADMIN.password, ADMIN_SEED_NAME: 'E2E', ADMIN_SEED_ROLE: 'ADMIN' }
    });
    // #347：新建的未绑定账号会在 stdout 打印一次性绑定链接；令牌只放进本进程环境，给 admin.spec.ts 绑定用（worker 继承 process.env），不打印
    const t = /[?&]t=([A-Za-z0-9_-]{43})/.exec(String(out))?.[1];
    if (t) process.env.E2E_ADMIN_ENROLL_TOKEN = t;
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? e);
    if (!msg.includes('已存在')) throw e;
  }
}
export const E2E_ADMIN = { email: 'e2e-admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-only-Passw0rd!' };
