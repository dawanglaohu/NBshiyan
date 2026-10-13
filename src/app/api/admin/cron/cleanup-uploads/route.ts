import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { cleanupOrphanLogos, secretMatches } from '@/lib/server/uploads';
import { sendAdminAlert, errorSummary } from '@/lib/server/mail';
import { cleanupExpiredDesigns } from '@/lib/server/designs';
import { cleanupAuditLogs, clearSampleCounters } from '@/lib/server/retention';
import { anonymizeExpiredInquiries, disableInactiveUsers } from '@/lib/server/retention-enforce';
import { audit } from '@/lib/server/admin/audit';
import { isRetentionDryRun, retentionDryRunCounts } from '@/lib/server/retention-dry-run';
import { withCleanupLock } from '@/lib/server/cleanup-lock';

export const runtime = 'nodejs';
/** 函数最长运行时间（秒）。持锁事务超时 290s（LOCK_TX_TIMEOUT_MS），比这里短 10s。Vercel 各套餐上限见 launch-runbook.md；单次处理量由 RETENTION_MAX_PER_RUN 控制。 */
export const maxDuration = 300;

/**
 * 定时清理（保留期限见 docs/data-retention.md）：
 * 过期方案 → 孤儿 logo → 样品申请邮箱计数 → 到期询盘匿名化 → 闲置后台账号停用 → 过期审计日志。日志只记条数和 errorSummary，不含个人信息。每步独立执行，任一步失败都发告警（只含步骤名和错误类型/码），其余步骤照常跑。
 * RETENTION_DRY_RUN=1 时只返回各步骤待处理条数（见 retention-dry-run.ts），不做任何修改。
 * 同一时间只跑一次（含 dry run）：advisory lock 拿不到返回 409。
 * 需 Authorization: Bearer $CRON_SECRET（Vercel Cron 会自动带上）。
 */
async function handle(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return withCleanupLock(async () => {
    // RETENTION_DRY_RUN=1：只统计，不调用任何清理步骤（不写库、不删文件、不写审计）
    if (isRetentionDryRun()) {
      try {
        const counts = await retentionDryRunCounts(prisma);
        console.info('[cron] retention dry run', counts);
        return NextResponse.json({ dryRun: true, ...counts });
      } catch (e) {
        console.error('[cron] retention dry run failed', errorSummary(e));
        return NextResponse.json({ error: 'dry_run_failed' }, { status: 500 });
      }
    }
    const steps: [string, () => Promise<number>][] = [
      ['designs', () => cleanupExpiredDesigns()], // 先删过期方案，它们引用的 logo 随后才会被当作孤儿清理
      ['deleted', () => cleanupOrphanLogos()],
      ['sampleCounters', () => clearSampleCounters(prisma)],
      ['inquiries', () => anonymizeExpiredInquiries(prisma)],
      ['inactiveUsers', () => disableInactiveUsers(prisma, (e) => audit(e))],
      ['auditLogs', () => cleanupAuditLogs(prisma)],
    ];
    const result: Record<string, number> = {};
    const failed: string[] = [];
    for (const [name, run] of steps) {
      try { result[name] = await run(); } catch (e) {
        failed.push(name);
        console.error(`[cron] cleanup step ${name} failed`, errorSummary(e));
        await sendAdminAlert('定时清理失败', { 任务: `cleanup-uploads/${name}`, ...errorSummary(e) }, `cron:cleanup:${name}`);
      }
    }
    if (failed.length) return NextResponse.json({ error: 'cleanup_failed', failed, ...result }, { status: 500 });
    return NextResponse.json(result);
  });
}
export { handle as GET, handle as POST };
