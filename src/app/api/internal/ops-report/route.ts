import { createOpsReportServices } from '@/lib/server/composition';
import { handlePostOpsReport } from '@/lib/server/ops/ops-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 受控内部运维报告入口（M6-T3）。
 * 仅接受 Authorization: Bearer $CRON_SECRET，绝不接受后台 session cookie 替代。
 * 只接受 STORAGE/BACKUP 严格白名单摘要，拒任意路径或内容。
 */
export function POST(request: Request) {
  return handlePostOpsReport(request, createOpsReportServices(), {
    secret: process.env.CRON_SECRET,
  });
}
