/**
 * 后台鉴权统一出口。每个 /api/admin/* 路由都必须调用 requireAdmin()（cron 路由除外，用 CRON_SECRET）。
 */
export { requireAdmin, sameOrigin, type AdminCtx } from './admin/guard';
export { revokeSessions } from './admin/login';
export { auth } from '@/auth';
