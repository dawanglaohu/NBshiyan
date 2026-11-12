import { alertRetentionCleanupIssue } from '@/lib/server/cron-alert';
import { audit } from '@/lib/server/admin/audit';
import { prisma } from '@/lib/server/db';
import { errorSummary, sendAdminAlert } from '@/lib/server/mail';
import { runRetentionCleanup } from '@/lib/server/analytics/retention-cleanup';
import { createRetentionCleanupHandler, unauthorizedResponse } from '@/lib/server/analytics/retention-cleanup-handler';
import { secretMatches } from '@/lib/server/uploads';

export const runtime = 'nodejs';
/** 与 cleanup-uploads 相同的平台上限。真正停手的是分批上限和 cron 里的 AbortSignal。 */
export const maxDuration = 300;

/** 失败告警只带错误码，按日去重；审计写失败不改变响应。 */
async function reportRetentionFailure(errorCode: string) {
  await alertRetentionCleanupIssue({ errorCode }, sendAdminAlert);
  try {
    await audit({ action: 'cron.retention_cleanup.alert', meta: { errorCode } });
  } catch (error) {
    console.error('[cron] retention cleanup alert audit failed', errorSummary(error));
  }
}

/**
 * 分析数据保留清理（Authorization: Bearer $CRON_SECRET）。
 * 默认 dry-run：只统计会删的行并写审计。RETENTION_CLEANUP_MODE=delete 才删行。
 * 与按天汇总共用 analytics-aggregate 租约；租约被占用时返回 409。不删除询盘。
 *
 * 分支处理在 `retention-cleanup-handler.ts`（server 内部模块），此处只绑定真实依赖。
 */
const handle = createRetentionCleanupHandler({
  runCleanup: () => runRetentionCleanup({ db: prisma }),
  reportFailure: reportRetentionFailure,
});

/**
 * 入口防线：与 handler 内同一 `secretMatches` 比较，未授权直接 401 且不触达业务编排。
 * handler 内保留同一判定，作为内部调用方（含测试）的防线；业务清理/告警/status 分支
 * 仍然只有 handler 一份。
 */
function guarded(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return Promise.resolve(unauthorizedResponse());
  return handle(req);
}

export const GET = guarded;
export const POST = guarded;
