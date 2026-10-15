import type { MailApi } from './types';
import { mockMailApi } from './mock';
import { httpMailApi } from './http';

/**
 * #74 邮件数据层入口，和 lib/admin/api.ts 用同一个开关：
 * NEXT_PUBLIC_ADMIN_API=http → 真实接口（backend-plan v4 §8）；否则用 mock（示例数据，后台页面顶部有「示例数据」提示）。
 * 页面只依赖 MailApi，后端接口上线后切换开关即可，组件不用改。
 * 注意：mock 只替换数据，不绕过页面鉴权——/admin 页面照常走 layout + enforceAdminPage 的服务端会话检查。
 */
export const usingMailMock = process.env.NEXT_PUBLIC_ADMIN_API !== 'http';
export const mailApi: MailApi = usingMailMock ? mockMailApi : httpMailApi;
export * from './types';
