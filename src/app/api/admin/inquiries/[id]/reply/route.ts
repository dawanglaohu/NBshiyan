import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { escapeHtml, oneLine } from '@/lib/server/security';
import { sendMail } from '@/lib/server/mail';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope, readJson, extendInquiryRetention, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { audit } from '@/lib/server/admin/audit';

export const runtime = 'nodejs';
const Body = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000) }).strict();

/** 纯文本转安全 HTML：全部转义，换行变 <br> */
const textToHtml = (t: string) => t.split(/\r?\n/).map(escapeHtml).join('<br>');

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'inquiry.reply', 20));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const json = await readJson(req, 50_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const inq = await prisma.inquiry.findFirst({ where: { AND: [{ id }, inquiryScope(ctx.user)] }, select: { id: true, ref: true, replyToken: true, anonymizedAt: true, contact: { select: { email: true } } } });
  if (!inq) return jsonErr('not_found', 404);
  if (inq.anonymizedAt) return jsonErr('anonymized', 409); // 已匿名化的询盘不能再写入（见 data-retention.md）
  const subject = oneLine(p.data.subject);
  const bodyHtml = textToHtml(p.data.body);
  const domain = process.env.REPLY_DOMAIN; // 配置后客户回信进入 reply+token@域名，便于归档
  try {
    await sendMail({ to: inq.contact.email, subject, html: bodyHtml, replyTo: domain ? `reply+${inq.replyToken}@${domain}` : undefined });
  } catch (e) {
    await audit({ actorId: ctx.user.id, action: 'inquiry.reply_fail', target: id, meta: { error: String((e as Error).message).slice(0, 200) }, ip: ctx.ip });
    return jsonErr('mail_failed', 502);
  }
  // 同一事务：先在 anonymizedAt IS NULL 条件下顺延保留期（最后活动规则），期间若已被匿名化则不写往来邮件
  const msg = await prisma.$transaction(async (tx) => {
    if (!(await extendInquiryRetention(tx, id))) return null;
    return tx.inquiryMessage.create({ data: { inquiryId: id, direction: 'OUTBOUND', subject, bodyHtml, authorId: ctx.user.id } });
  });
  if (!msg) return jsonErr('anonymized', 409);
  await audit({ actorId: ctx.user.id, action: 'inquiry.reply', target: id, meta: { messageId: msg.id }, ip: ctx.ip });
  return NextResponse.json(msg, { status: 201, headers: noStore });
}
