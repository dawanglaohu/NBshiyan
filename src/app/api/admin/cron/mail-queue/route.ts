import { NextResponse } from 'next/server';
import { secretMatches } from '@/lib/server/uploads';
import { createJobServices } from '@/lib/server/composition';
import { executeJobRequest } from '@/lib/server/jobs/registry';
import { mailSwitchGate } from '@/lib/server/mail/http';
import { mailLog } from '@/lib/server/mail/adapter';

export const runtime = 'nodejs';

/**
 * 邮件队列 cron（Authorization: Bearer $CRON_SECRET）：租约过期的 SENDING → unknown_delivery；
 * 到了 deferredUntil 的 daily_cap_deferred 信自动发送（§17）。返回只有条数。
 * GET/POST 共享同一个 JobState 租约与摘要；cron 只用 POST。409 = 另一轮持租约，正常跳过。
 */
async function handle(req: Request) {
  const off = mailSwitchGate();
  if (off) return off;
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const outcome = await executeJobRequest({ services: createJobServices().jobs }, 'mail-queue');
  if (outcome.kind === 'busy') return NextResponse.json({ error: 'job_busy' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  if (outcome.kind === 'timeout') return NextResponse.json({ error: 'job_timeout' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  if (outcome.kind === 'failed') return NextResponse.json({ error: 'job_failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  const counts = outcome.counts;
  const out = {
    stale: counts.stale ?? 0,
    sent: counts.sent ?? 0,
    failed: counts.failed ?? 0,
    deferred: counts.deferred ?? 0,
    dropped: counts.dropped ?? 0,
  };
  mailLog('info', 'mail.queue_run', { count: out.sent, status: 'ok' });
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = handle;
export const POST = handle;
