import { NextResponse } from 'next/server';
import { alertAnalyticsRollupIssue } from '@/lib/server/cron-alert';
import { audit } from '@/lib/server/admin/audit';
import { prisma } from '@/lib/server/db';
import { errorSummary, sendAdminAlert } from '@/lib/server/mail';
import { runAnalyticsRollup } from '@/lib/server/analytics/rollup';
import { secretMatches } from '@/lib/server/uploads';

export const runtime = 'nodejs';

/**
 * 统计按天汇总（Authorization: Bearer $CRON_SECRET）。
 * 只汇总已经结束的站点本地日，一次最多 7 天。deploy/cron.nbshiyan 每 5 分钟调用一次。
 * 另一个实例持有 analytics-aggregate 租约时返回 409。不删除原始事件。
 */
async function reportRollupFailure(input: { errorCode: string; days: number }) {
  await alertAnalyticsRollupIssue(input, sendAdminAlert);
  try {
    await audit({ action: 'cron.analytics_rollup.alert', meta: { errorCode: input.errorCode, days: input.days } });
  } catch (error) {
    console.error('[cron] analytics rollup alert audit failed', errorSummary(error));
  }
}

async function handle(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  let result: Awaited<ReturnType<typeof runAnalyticsRollup>>;
  try {
    result = await runAnalyticsRollup({ db: prisma });
  } catch (error) {
    console.error('[cron] analytics rollup failed', errorSummary(error));
    await reportRollupFailure({ errorCode: 'internal_error', days: 0 });
    return NextResponse.json({ error: 'rollup_failed', days: 0 }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  if (result.status === 'busy') {
    return NextResponse.json({ error: 'job_busy' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
  if (result.status === 'failed') {
    await reportRollupFailure({ errorCode: result.errorCode, days: result.days });
    return NextResponse.json(
      { error: 'rollup_failed', days: result.days },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  console.info('[cron] analytics rollup', { days: result.days, eventCount: result.eventCount });
  return NextResponse.json(
    { days: result.days, eventCount: result.eventCount, status: 'succeeded' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = handle;
export const POST = handle;
