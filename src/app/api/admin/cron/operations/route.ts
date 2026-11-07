import { createJobServices } from '@/lib/server/composition';
import { createOperationsHandler } from '@/lib/server/jobs/registry';

export const runtime = 'nodejs';

/**
 * 固定作业入口。Bearer CRON_SECRET 校验、jobKey 白名单与期限都在处理器里；
 * 这个模块只导出 HTTP 方法，Next 的 route 校验不接受其它导出。
 */
export const POST = (req: Request) =>
  createOperationsHandler({
    services: createJobServices().jobs,
    secret: process.env.CRON_SECRET,
  })(req);
