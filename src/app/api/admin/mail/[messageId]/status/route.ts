import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope } from '@/lib/server/admin/inquiries';
import { mailSwitchGate } from '@/lib/server/mail/http';
import { statusBody, type MailRow } from '@/lib/server/mail/send';

export const runtime = 'nodejs';

/** 8.3a 单条状态（轮询用）。只限出站、询盘在权限范围内；已匿名化 409 */
export async function GET(req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const off = mailSwitchGate();
  if (off) return off;
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const { messageId } = await params;
  if (!ID_RE.test(messageId)) return jsonErr('not_found', 404);
  const row = await prisma.mailMessage.findFirst({ where: { id: messageId, direction: 'OUTBOUND', inquiry: { is: inquiryScope(ctx.user) } }, include: { inquiry: { select: { anonymizedAt: true } } } });
  if (!row) return jsonErr('not_found', 404);
  if (row.inquiry?.anonymizedAt) return jsonErr('anonymized', 409);
  return NextResponse.json(statusBody(row as unknown as MailRow), { headers: noStore });
}
