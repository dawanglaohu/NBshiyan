import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin } from '@/lib/server/auth';
import { jsonErr } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope } from '@/lib/server/admin/inquiries';
import { audit } from '@/lib/server/admin/audit';
import { sendAdminAlert } from '@/lib/server/mail';
import { defaultAdapter, enforceMailRateLimit, mailSwitchGate, sendResponse } from '@/lib/server/mail/http';
import { sendingEnabled } from '@/lib/server/mail/config';
import { retryMail } from '@/lib/server/mail/send';

export const runtime = 'nodejs';

/** 8.2 重试：仅 FAILED 且 retryable（不含 unknown_delivery），最多 5 次，计入限流，同样受每日上限约束 */
export async function POST(req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const off = mailSwitchGate();
  if (off) return off;
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req);
  if (blocked) return blocked;
  const { messageId } = await params;
  if (!ID_RE.test(messageId)) return jsonErr('not_found', 404);
  if (!sendingEnabled()) return jsonErr('sending_disabled', 409);
  const limited = await enforceMailRateLimit(ctx.user.id);
  if (limited) return limited;
  const adapter = await defaultAdapter();
  if (!adapter) return jsonErr('sending_disabled', 409);
  const r = await retryMail({ db: prisma, adapter, alert: sendAdminAlert, audit: (e) => audit({ ...e, ip: ctx.ip }) }, { userId: ctx.user.id, messageId, scope: inquiryScope(ctx.user) });
  return sendResponse(r);
}
