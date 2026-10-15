import type { MailApi } from './types';
import { lazyApi } from '../lazyApi';
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
// #291：条件直接写 process.env（构建时内联成常量），生产包里 mock 分支是死代码，不打包 mock。
// 只有 mock 模式才用示例数据；off 模式邮件功能整体关闭、不会调用 mailApi，指向 http 实现即可。
export const mailApi: MailApi = process.env.NEXT_PUBLIC_ADMIN_MAIL !== 'mock' ? httpMailApi
  : lazyApi<MailApi>(() => import('./mock').then((m) => m.mockMailApi));
export * from './types';
