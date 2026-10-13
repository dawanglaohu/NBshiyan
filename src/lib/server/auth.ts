/**
 * 后台鉴权统一出口。每个 /api/admin/* 路由都必须调用 requireAdmin()，改动类请求随后调用 assertSameOrigin、enforceAdminRateLimit。
 * 例外：cron 路由用 CRON_SECRET；登录前的 2FA 绑定在 /api/auth-admin/enroll（不在 /api/admin 下）。
 */
export { requireAdmin, type AdminCtx } from './admin/guard';
export { assertSameOrigin, enforceAdminRateLimit } from './admin-guard';
export { revokeSessions } from './admin/login';
export { auth } from '@/auth';
