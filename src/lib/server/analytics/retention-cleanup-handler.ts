import { NextResponse } from 'next/server';
import type { RetentionCleanupResult } from '@/lib/server/analytics/retention-cleanup';
import { secretMatches } from '@/lib/server/uploads';

/**
 * cron 路由的 HTTP 分支处理。
 *
 * 放在 server 内部模块而不是 `route.ts`：Next 只接受路由文件导出约定集合
 * （GET/POST/runtime/maxDuration 等），从那里再导出构造器会破坏构建期校验。
 * 也不放进 `retention-cleanup.ts`：Response 编排不属于保留清理域服务。
 *
 * 生产依赖由 `route.ts` 绑定真实 prisma、清理服务与既有告警去重；测试注入假服务，
 * 跑的是同一份分支。鉴权仍走真实 `CRON_SECRET`/`secretMatches`，没有旁路。
 */
export type RetentionCleanupHandlerDeps = {
  /** 生产为 `() => runRetentionCleanup({ db: prisma })`。 */
  runCleanup: () => Promise<RetentionCleanupResult>;
  /** 生产为既有告警通道 + 审计（`cron-alert` 自带按日去重）。 */
  reportFailure: (errorCode: string) => Promise<void>;
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)) return error.name;
  return 'Error';
}

export function createRetentionCleanupHandler(deps: RetentionCleanupHandlerDeps) {
  const { runCleanup, reportFailure } = deps;

  return async function handle(req: Request): Promise<Response> {
    const auth = req.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    // 未授权不触达清理服务，也不发告警。
    if (!secretMatches(token, process.env.CRON_SECRET)) return json({ error: 'unauthorized' }, 401);
    try {
      const result = await runCleanup();
      // 租约被占用是正常运行里的跳过，不告警。
      if (result.status === 'busy') return json({ error: 'job_busy' }, 409);
      if (result.status === 'unknown') {
        // COMMIT 答复未知：沿用既有 500 形状与告警通道，但明确分类为 commit_unknown。
        // HTTP 500/告警都不等于「事务已回滚」；不写成功、不写假 FAILED、不补 gap。
        console.error('[cron] retention-cleanup commit_unknown', {
          phase: result.phase,
          targets: result.targets.length,
          confirmedDeletedEvents: result.deletedEvents,
          confirmedDeletedRollupRows: result.deletedRollupRows,
        });
        await reportFailure('commit_unknown');
        return json({ error: 'retention_cleanup_failed' }, 500);
      }
      if (result.status === 'failed') {
        console.error('[cron] retention-cleanup failed', result.errorCode);
        await reportFailure(result.errorCode);
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
      await reportFailure('internal_error');
      return json({ error: 'retention_cleanup_failed' }, 500);
    }
  };
}
