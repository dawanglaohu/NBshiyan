import type { ModelApi } from './models';
import { httpModelApi } from './models-http';
/** 与询盘一致：NEXT_PUBLIC_ADMIN_API=http 时走真实接口 */
// 生产构建：条件内联为 false，mock 不进包
export const modelApi: ModelApi = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_ADMIN_API !== 'http'
  ? new Proxy({} as ModelApi, { get: (_t, k) => (...a: unknown[]) => import('./models-mock').then((m) => (m.mockModelApi as unknown as Record<PropertyKey, (...x: unknown[]) => unknown>)[k](...a)) })
  : httpModelApi;
export * from './models';
