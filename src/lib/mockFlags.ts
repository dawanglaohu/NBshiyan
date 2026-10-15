/**
 * 生产环境（NODE_ENV=production）一律忽略前端 mock 开关：
 * - NEXT_PUBLIC_LOGO_UPLOAD_MOCK：logo 上传始终走真实接口
 * - NEXT_PUBLIC_ADMIN_API：后台始终走真实 /api/admin/*，从不使用 mock 数据
 * 非生产环境行为不变。
 */
type Env = { NODE_ENV?: string; NEXT_PUBLIC_LOGO_UPLOAD_MOCK?: string; NEXT_PUBLIC_ADMIN_API?: string };

// 逐个字面量读取，保证 Next 在构建时内联
const currentEnv = (): Env => ({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_LOGO_UPLOAD_MOCK: process.env.NEXT_PUBLIC_LOGO_UPLOAD_MOCK,
  NEXT_PUBLIC_ADMIN_API: process.env.NEXT_PUBLIC_ADMIN_API
});

export function logoUploadMockEnabled(env: Env = currentEnv()): boolean {
  return env.NODE_ENV !== 'production' && env.NEXT_PUBLIC_LOGO_UPLOAD_MOCK === '1';
}

export function adminMockEnabled(env: Env = currentEnv()): boolean {
  return env.NODE_ENV !== 'production' && env.NEXT_PUBLIC_ADMIN_API !== 'http';
}
