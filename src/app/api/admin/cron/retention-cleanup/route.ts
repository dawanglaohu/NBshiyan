import { NextResponse } from 'next/server';
import { alertRetentionCleanupIssue } from '@/lib/server/cron-alert';
import { audit } from '@/lib/server/admin/audit';
import { prisma } from '@/lib/server/db';
import { errorSummary, sendAdminAlert } from '@/lib/server/mail';
import { runRetentionCleanup } from '@/lib/server/analytics/retention-cleanup';
import { secretMatches } from '@/lib/server/uploads';

export const runtime = 'nodejs';
/** 与 cleanup-uploads 相同的平台上限。真正停手的是分批上限和 cron 里的 AbortSignal。 */
export const maxDuration = 300;

/**
 * 分析数据保留清理（Authorization: Bearer $CRON_SECRET）。
 * 默认 dry-run：只统计会删的行并写审计。RETENTION_CLEANUP_MODE=delete 才删行。
 * 与按天汇总共用 analytics-aggregate 租约；租约被占用时返回 409。不删除询盘。
 */
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)) return error.name;
  return 'Error';
}

async function reportRetentionFailure(errorCode: string) {
  await alertRetentionCleanupIssue({ errorCode }, sendAdminAlert);
  try {
    await audit({ action: 'cron.retention_cleanup.alert', meta: { errorCode } });
  } catch (error) {
    console.error('[cron] retention cleanup alert audit failed', errorSummary(error));
  }
}

async function handle(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return json({ error: 'unauthorized' }, 401);
  try {
    const result = await runRetentionCleanup({ db: prisma });
    if (result.status === 'busy') return json({ error: 'job_busy' }, 409);
    if (result.status === 'failed') {
      console.error('[cron] retention-cleanup failed', result.errorCode);
      await reportRetentionFailure(result.errorCode);
      return json({ error: 'retention_cleanup_failed' }, 500);
    }
    console.info('[cron] retention-cleanup', {
      mode: result.mode,
      candidateEvents: result.candidateEvents,
      deletedEvents: result.deletedEvents,
      candidateRollupRows: result.candidateRollupRows,
      deletedRollupRows: result.deletedRollupRows,
      skippedUnrolledDays: result.skippedUnrolledDays,
      skippedRevisionMismatchDays: result.skippedRevisionMismatchDays,
      skippedAfterGapDays: result.skippedAfterGapDays,
      keptExpiredEvents: result.keptExpiredEvents,
      batches: result.batches,
    });
    return json({
      mode: result.mode,
      status: 'succeeded',
      candidateEvents: result.candidateEvents,
      deletedEvents: result.deletedEvents,
      candidateRollupRows: result.candidateRollupRows,
      deletedRollupRows: result.deletedRollupRows,
      skippedUnrolledDays: result.skippedUnrolledDays,
      skippedRevisionMismatchDays: result.skippedRevisionMismatchDays,
      skippedAfterGapDays: result.skippedAfterGapDays,
      keptExpiredEvents: result.keptExpiredEvents,
      batches: result.batches,
      batchSize: result.batchSize,
      maxPerRun: result.maxPerRun,
    });
  } catch (error) {
    console.error('[cron] retention-cleanup failed', errorName(error));
    await reportRetentionFailure('internal_error');
    return json({ error: 'retention_cleanup_failed' }, 500);
  }
}

export const GET = handle;
export const POST = handle;
