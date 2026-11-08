import { NextResponse } from 'next/server';
import { secretMatches } from '@/lib/server/uploads';

export const runtime = 'nodejs';

/**
 * 已退役：统计按天汇总的旧写入入口。
 *
 * 新调度链是 `POST /api/admin/cron/operations`（jobKey `analytics-aggregate`，
 * 见 deploy/cron.nbshiyan）。本路由保留 Bearer 鉴权，让旧调用方得到明确答复，
 * 但**不再执行任何聚合、数据库、邮件或审计操作**：鉴权通过后直接返回 410 Gone
 * 并指向新入口。这样即使有人手工调用或旧配置仍在，也不会写入日聚合或水位。
 */
const RETIRED_BODY = {
  error: 'route_retired',
  replacement: 'POST /api/admin/cron/operations',
  jobKey: 'analytics-aggregate',
} as const;

function retired(): NextResponse {
  return NextResponse.json(RETIRED_BODY, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}

async function handle(req: Request): Promise<NextResponse> {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return retired();
}

export const GET = handle;
export const POST = handle;
