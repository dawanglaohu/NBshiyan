import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { cleanupOrphanLogos, secretMatches } from '@/lib/server/uploads';
import { sendAdminAlert, errorSummary } from '@/lib/server/mail';
import { cleanupExpiredDesigns } from '@/lib/server/designs';
import { cleanupAuditLogs, clearSampleCounters, maxPerRun, runCleanupSteps, runDeadlineMs } from '@/lib/server/retention';
import { anonymizeExpiredInquiries, disableInactiveUsers } from '@/lib/server/retention-enforce';
import { audit } from '@/lib/server/admin/audit';
import { isRetentionDryRun, retentionDryRunCounts } from '@/lib/server/retention-dry-run';
import { alertCleanupIssues } from '@/lib/server/cron-alert';
import { withCleanupLock } from '@/lib/server/cleanup-lock';

export const runtime = 'nodejs';
/** 函数最长运行时间（秒）。持锁事务超时 290s（LOCK_TX_TIMEOUT_MS）；所有步骤共用的截止时间 RETENTION_RUN_DEADLINE_MS 默认 270s、最大 280s。Vercel 各套餐上限见 launch-runbook.md。 */
export const maxDuration = 300;

/**
 * 定时清理（保留期限见 docs/data-retention.md）：
 * 过期方案 → 孤儿 logo → 样品申请邮箱计数 → 到期询盘匿名化 → 闲置后台账号停用 → 过期审计日志。日志只记条数和 errorSummary，不含个人信息。每步独立执行，其余步骤照常跑；有步骤失败或因截止时间跳过时，跑完发一封汇总告警（只含步骤名、错误类型/码和条数，按天去重，告警失败不影响响应），并写审计 cron.cleanup.alert。
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
    // 整次运行只算一次截止时间，所有步骤共用（见 runDeadlineMs）
    const deadline = Date.now() + runDeadlineMs();
    const steps: [string, (deadline: number) => Promise<number>][] = [
      ['designs', (d) => cleanupExpiredDesigns(new Date(), d)], // 先删过期方案，它们引用的 logo 随后才会被当作孤儿清理
      ['deleted', (d) => cleanupOrphanLogos(new Date(), d)],
      ['sampleCounters', (d) => clearSampleCounters(prisma, new Date(), maxPerRun(), d)],
      ['inquiries', (d) => anonymizeExpiredInquiries(prisma, new Date(), maxPerRun(), undefined, d)],
      ['inactiveUsers', (d) => disableInactiveUsers(prisma, (e) => audit(e), new Date(), d)],
      ['auditLogs', (d) => cleanupAuditLogs(prisma, new Date(), maxPerRun(), d)],
    ];
    const errors: Record<string, string> = {};
    const s = await runCleanupSteps(steps, deadline, async (name, e) => {
      const sum = errorSummary(e);
      errors[name] = `${sum['错误类型']}:${sum['错误码']}`;
      console.error(`[cron] cleanup step ${name} failed`, sum);
    });
    // 有失败或跳过时发一封汇总告警（按天去重）；告警自身失败不影响响应
    await alertCleanupIssues(s, errors, sendAdminAlert, (e) => audit(e));
    const summary = { ...s.result, skipped: s.skipped, deadlineReached: s.deadlineReached };
    if (s.deadlineReached) console.warn('[cron] cleanup deadline reached', { skipped: s.skipped, counts: s.result });
    if (s.failed.length) return NextResponse.json({ error: 'cleanup_failed', failed: s.failed, ...summary }, { status: 500 });
    return NextResponse.json(summary);
  });
}
export { handle as GET, handle as POST };
