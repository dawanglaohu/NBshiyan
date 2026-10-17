import { z } from 'zod';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope, readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { audit } from '@/lib/server/admin/audit';
import { sendAdminAlert } from '@/lib/server/mail';
import { defaultAdapter, enforceMailRateLimit, mailSwitchGate, sendResponse } from '@/lib/server/mail/http';
import { sendingEnabled } from '@/lib/server/mail/config';
import { sendInquiryMail } from '@/lib/server/mail/send';

export const runtime = 'nodejs';

/** 请求体：没有 to / cc / bcc / from / headers 字段（.strict()，多传 400）；收件人只从库里的询盘联系人取 */
const Body = z.object({
  subject: z.string().trim().min(1).max(200).refine((s) => !/[\r\n\0]/.test(s), 'newline'),
  body: z.string().trim().min(1).max(20_000),
  inReplyToId: z.string().regex(ID_RE).optional(),
}).strict();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 8.0：400 { error:"invalid", fields, limits? } */
function invalid(issues: z.ZodIssue[]) {
  const fields: Record<string, string> = {}, limits: Record<string, number> = {};
  for (const i of issues) {
    const f = i.code === 'unrecognized_keys' ? String(i.keys[0]) : String(i.path[0] ?? 'request');
    if (fields[f]) continue;
    if (i.code === 'unrecognized_keys') fields[f] = 'unknown_field';
    else if (i.code === 'too_big') { fields[f] = 'too_long'; limits[f] = Number(i.maximum); }
    else if (i.code === 'too_small') fields[f] = 'required';
    else if (i.code === 'custom' && i.message === 'newline') fields[f] = 'newline';
    else fields[f] = 'bad_format';
  }
  return NextResponse.json({ error: 'invalid', fields, ...(Object.keys(limits).length ? { limits } : {}) }, { status: 400, headers: noStore });
}

/** 8.1 发送回复（§16 Gmail SMTP；§17 每日上限 → 202 QUEUED + deferredUntil） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = mailSwitchGate();
  if (off) return off;
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req);
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  if ((req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/')) return jsonErr('unsupported_media_type', 415);
  const json = await readJson(req, 51_200);
  if (json === TOO_LARGE) return NextResponse.json({ error: 'too_large', field: 'request', limit: 51_200, unit: 'bytes' }, { status: 413, headers: noStore });
  if (json && typeof json === 'object' && typeof (json as { body?: unknown }).body === 'string' && (json as { body: string }).body.trim().length > 20_000) {
    return NextResponse.json({ error: 'too_large', field: 'body', limit: 20_000, unit: 'chars' }, { status: 413, headers: noStore });
  }
  const p = Body.safeParse(json);
  if (!p.success) return invalid(p.error.issues);
  if (!sendingEnabled()) return jsonErr('sending_disabled', 409);
  const key = req.headers.get('idempotency-key');
  const limited = await enforceMailRateLimit(ctx.user.id);
  if (limited) return limited;
  const adapter = await defaultAdapter();
  if (!adapter) return jsonErr('sending_disabled', 409);
  const r = await sendInquiryMail(
    { db: prisma, adapter, alert: sendAdminAlert, audit: (e) => audit({ ...e, ip: ctx.ip }) },
    { userId: ctx.user.id, inquiryId: id, scope: inquiryScope(ctx.user), subject: p.data.subject, body: p.data.body, inReplyToId: p.data.inReplyToId, idempotencyKey: key && UUID_RE.test(key) ? key : null },
  );
  return sendResponse(r);
}
