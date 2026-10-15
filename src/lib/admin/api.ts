import type { AdminApi } from './types';
import { httpAdminApi } from './http';

/**
 * 后台数据层入口。页面只依赖 AdminApi 接口。
 * 后端 /api/admin/* 上线后，设置 NEXT_PUBLIC_ADMIN_API=http 切换到真实接口，页面不用改。
 */
// 生产构建里该条件被内联为 false，mock 模块的动态 import 被整体删除，不进生产包
export const usingMock = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_ADMIN_API !== 'http';

function lazy<T extends object>(load: () => Promise<T>): T {
  return new Proxy({} as T, { get: (_t, k) => (...a: unknown[]) => load().then((m) => (m as Record<PropertyKey, (...x: unknown[]) => unknown>)[k](...a)) });
}

export const adminApi: AdminApi = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_ADMIN_API !== 'http'
  ? lazy(() => import('./mock').then((m) => m.mockAdminApi))
  : httpAdminApi;
export * from './types';
