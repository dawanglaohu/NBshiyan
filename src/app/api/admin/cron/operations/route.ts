import { NextResponse } from 'next/server';
import { createJobServices } from '@/lib/server/composition';
import { createOperationsHandler } from '@/lib/server/jobs/registry';
import { secretMatches } from '@/lib/server/uploads';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * 固定作业入口。Bearer CRON_SECRET 在 route 层先拒绝一次（常量时间比较），
 * 处理器内保留同一校验作为纵深防御；jobKey 白名单与期限都在处理器里。
 * 这个模块只导出 HTTP 方法，Next 的 route 校验不接受其它导出。
 */
export const POST = (req: Request) => {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  return createOperationsHandler({
    services: createJobServices().jobs,
    secret: process.env.CRON_SECRET,
  })(req);
};
