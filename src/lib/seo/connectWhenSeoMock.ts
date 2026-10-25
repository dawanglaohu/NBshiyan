import { seoMockEnabled } from './mock';

/**
 * 产品目录和品类壳默认保持静态 / ISR，不调用 connection()。
 * 只有 SEO 审计 mock 要按当前请求读开关时，才 opt-in 动态渲染。
 * 测试可传入 connect，避免默认路径碰到 next/server。
 */
export async function connectWhenSeoMock(
  env: Record<string, string | undefined> = process.env,
  connect?: () => Promise<void>,
): Promise<void> {
  if (!seoMockEnabled(env)) return;
  if (connect) {
    await connect();
    return;
  }
  const { connection } = await import('next/server');
  await connection();
}
