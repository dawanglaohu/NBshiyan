import type { AdminApi } from './types';
import { lazyApi } from './lazyApi';
import { httpAdminApi } from './http';

/**
 * 后台数据层入口。页面只依赖 AdminApi 接口。
 * 后端 /api/admin/* 上线后，设置 NEXT_PUBLIC_ADMIN_API=http 切换到真实接口，页面不用改。
 */
export const adminApi: AdminApi = process.env.NEXT_PUBLIC_ADMIN_API === 'http' ? httpAdminApi
  : lazyApi<AdminApi>(() => import('./mock').then((m) => m.mockAdminApi));
export const usingMock = process.env.NEXT_PUBLIC_ADMIN_API !== 'http';
export * from './types';
