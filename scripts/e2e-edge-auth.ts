/**
 * e2e 可信边缘入口密钥的唯一来源。
 * 放在未被 .dockerignore 排除的 scripts/ 下：根 playwright.config.ts 需要它，
 * 若从 e2e/ 取值，镜像构建上下文（COPY . .）会缺少该模块，scripts/check-image-context.ts 直接失败。
 * 密钥是 CI/本地 e2e 假值，不是生产密钥；client-ip.ts 对 <32 字节 fail-closed。
 */
export const E2E_EDGE_AUTH_SECRET =
  process.env.E2E_EDGE_AUTH_SECRET ?? 'ci-e2e-only-edge-auth-not-for-production-0001';

// 与 e2e/edge-test-ip.ts 原加载期断言同一语义：短密钥在 config/spec 加载时即失败，
// 而不是让服务端静默退回 untrusted。
if (new TextEncoder().encode(E2E_EDGE_AUTH_SECRET).length < 32) {
  throw new Error('E2E_EDGE_AUTH_SECRET must be at least 32 bytes; client-ip would treat every request as untrusted');
}
