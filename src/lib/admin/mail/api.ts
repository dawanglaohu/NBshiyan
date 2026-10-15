import type { MailApi } from './types';
import { mockMailApi } from './mock';
import { httpMailApi } from './http';

/**
 * #74 邮件数据层入口。单独的开关 NEXT_PUBLIC_ADMIN_MAIL（和询盘的 NEXT_PUBLIC_ADMIN_API 分开，因为询盘接口已上线、邮件接口还没有）：
 * - 未设置（默认）→ 邮件功能关闭：详情页保持原来的往来记录和回复框，侧栏没有「未归类邮件」，/admin/mail/* 返回 404
 * - `mock` → 示例数据（只用于本地 / 预览；prod-env-check 在生产环境拒绝这个值）
 * - `http` → 真实接口（backend-plan v4 §8），后端上线后切换，组件不用改
 * mock 只替换数据，不绕过页面鉴权：/admin 页面照常走 layout + enforceAdminPage 的服务端会话检查。
 */
const raw = process.env.NEXT_PUBLIC_ADMIN_MAIL;
export const mailMode: 'off' | 'mock' | 'http' = raw === 'http' ? 'http' : raw === 'mock' ? 'mock' : 'off';
export const mailEnabled = mailMode !== 'off';
export const usingMailMock = mailMode === 'mock';
export const mailApi: MailApi = mailMode === 'http' ? httpMailApi : mockMailApi;
export * from './types';
