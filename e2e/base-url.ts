/** e2e 服务地址：真实 Playwright 配置与只读收集共用同一来源，避免为取一个常量而 import 带启动副作用的配置。 */
export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE = `http://localhost:${PORT}`;
