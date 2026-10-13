import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { cleanupOrphanLogos, secretMatches } from '@/lib/server/uploads';
import { sendAdminAlert, errorSummary } from '@/lib/server/mail';
import { cleanupExpiredDesigns } from '@/lib/server/designs';
import { cleanupAuditLogs, clearSampleCounters } from '@/lib/server/retention';
import { anonymizeExpiredInquiries, disableInactiveUsers } from '@/lib/server/retention-enforce';
import { audit } from '@/lib/server/admin/audit';

export const runtime = 'nodejs';

/**
 * 定时清理（保留期限见 docs/data-retention.md）：
 * 过期方案 → 孤儿 logo → 样品申请邮箱计数 → 到期询盘匿名化 → 闲置后台账号停用 → 过期审计日志。日志只记条数和 errorSummary，不含个人信息。每步独立执行，任一步失败都发告警（只含步骤名和错误类型/码），其余步骤照常跑。
 * 需 Authorization: Bearer $CRON_SECRET（Vercel Cron 会自动带上）。
 */
async function handle(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
}
export { handle as GET, handle as POST };
