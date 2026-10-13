import { adminMockEnabled } from '../mockFlags';
import type { AdminApi } from './types';
import { mockAdminApi } from './mock';
import { httpAdminApi } from './http';

/**
 * 后台数据层入口。页面只依赖 AdminApi 接口。
 * 后端 /api/admin/* 上线后，设置 NEXT_PUBLIC_ADMIN_API=http 切换到真实接口，页面不用改。
 */
export const usingMock = adminMockEnabled();
export const adminApi: AdminApi = usingMock ? mockAdminApi : httpAdminApi;
export * from './types';
