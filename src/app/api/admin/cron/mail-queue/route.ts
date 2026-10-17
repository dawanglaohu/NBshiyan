import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { secretMatches } from '@/lib/server/uploads';
import { audit } from '@/lib/server/admin/audit';
import { sendAdminAlert } from '@/lib/server/mail';
import { defaultAdapter, mailSwitchGate } from '@/lib/server/mail/http';
import { processMailQueue } from '@/lib/server/mail/send';
import { mailLog } from '@/lib/server/mail/adapter';

export const runtime = 'nodejs';

/**
 * 邮件队列 cron（Authorization: Bearer $CRON_SECRET）：租约过期的 SENDING → unknown_delivery；
 * 到了 deferredUntil 的 daily_cap_deferred 信自动发送（§17）。返回只有条数。
 */
async function handle(req: Request) {
  const off = mailSwitchGate();
  if (off) return off;
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const adapter = await defaultAdapter();
  const out = adapter
    ? await processMailQueue({ db: prisma, adapter, alert: sendAdminAlert, audit })
    : { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 };
  mailLog('info', 'mail.queue_run', { count: out.sent, status: adapter ? 'ok' : 'sending_disabled' });
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = handle;
export const POST = handle;
