import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { PrivacyDeleteBody, emailHash, deleteCustomer, privacyHashReady } from '@/lib/server/privacy';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * 仅 ADMIN：删除某客户的个人信息（匿名化，保留统计用的条数/类别/日期），并删除其 logo 上传。
 * body { email, confirmEmail }，两者规范化后必须一致，否则 400。审计只记邮箱 HMAC。
 */
export async function POST(req: Request) {
  // 与其他后台路由一致：requireAdmin → assertSameOrigin → 限流
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const limited = await enforceAdminRateLimit(req, 'privacy.delete', 5);
  if (limited) return limited;
  if (!privacyHashReady()) return jsonErr('privacy_hash_secret_missing', 503);
  const raw = await readJson(req, 2_000);
  if (raw === TOO_LARGE) return jsonErr('too_large', 413);
  const p = PrivacyDeleteBody.safeParse(raw);
  if (!p.success) {
    const mismatch = p.error.issues.some((i) => i.message === 'confirm_mismatch');
    return NextResponse.json({ error: mismatch ? 'confirm_mismatch' : 'invalid' }, { status: 400, headers: NO_STORE });
  }
  const result = await deleteCustomer(prisma, p.data.email);
  await audit({ actorId: ctx.user.id, action: 'privacy.delete', target: emailHash(p.data.email), meta: result, ip: ctx.ip });
  return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
}
