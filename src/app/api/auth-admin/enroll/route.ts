import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticator } from 'otplib';
import { prisma } from '@/lib/server/db';
import { clientIp, readBody } from '@/lib/server/security';
import { LOGIN_WINDOW_MS, checkPassword, refundLoginRate } from '@/lib/server/admin/login';
import { encrypt } from '@/lib/server/admin/crypto';
import { audit } from '@/lib/server/admin/audit';
import { jsonErr, noStore, rateLimited } from '@/lib/server/admin/guard';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { enrollCoolingDown, enrollIpRateOk, enrollWindowOpen, pendingSecretData } from '@/lib/server/admin/enroll-guard';
import { checkEnrollToken, rejectEnrollToken } from '@/lib/server/admin/enroll-token';

export const runtime = 'nodejs';
const Body = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200), token: z.string().max(200).optional() });

/**
 * 第一步：用邮箱+密码换取 otpauth URI。仅限尚未开启 2FA、且还在绑定窗口内的账号（#347）。
 * 待确认密钥 10 分钟内有效，这期间不能再次 enroll（返回 429，不会覆盖正在扫的密钥）；过期后再调会换新密钥，旧的作废。
 * 顺序：同源检查 → 限流（本接口按 IP 单独计数，不退回；再加 checkPassword 里的登录限流）→ 校验 → 密码 → 一次性绑定令牌（#347 方案 A）
 * → 密码和令牌都对才退回 IP+账号、单账号两个登录桶。令牌缺失 / 错误 / 过期 / 已用过与密码错一样返回 401 bad_credentials、不退桶。
 * 本接口成功不消耗令牌（有效期内可以重新扫码，#361 的 10 分钟冷却照旧）；confirm 成功才消耗。
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const ip = clientIp(req);
  if (!(await enrollIpRateOk('enroll', ip))) return jsonErr('rate_limited', 429);
  const raw = await readBody(req, 4_000);
  let json: unknown = null; try { json = JSON.parse(raw ?? ''); } catch {}
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const user = await checkPassword(p.data.email, p.data.password, ip);
  if (user === 'rate_limited') return rateLimited(LOGIN_WINDOW_MS / 1000);
  if (typeof user === 'string') return jsonErr('bad_credentials', 401);
  const tk = checkEnrollToken(user, p.data.token);
  if (tk !== 'ok') { await rejectEnrollToken(user, p.data.email, 'enroll', tk, ip); return jsonErr('bad_credentials', 401); } // 不退登录桶，见上
  await refundLoginRate(ip, p.data.email); // 密码和令牌都正确：退回登录桶（单 IP 桶不退）
  if (user.totpEnabled) return jsonErr('bad_credentials', 401); // 已开启的不能重新绑定，统一报错
  // 以下分支都已通过密码校验，不会向不知道密码的人暴露账号是否存在
  if (!enrollWindowOpen(user)) {
    await audit({ actorId: user.id, action: 'auth.totp_enroll_blocked', target: user.id, meta: { reason: 'window_expired' }, ip });
    return jsonErr('bad_credentials', 401);
  }
  const now = Date.now();
  if (enrollCoolingDown(user, now)) {
    await audit({ actorId: user.id, action: 'auth.totp_enroll_blocked', target: user.id, meta: { reason: user.totpSecret ? 'pending' : 'cooldown' }, ip });
    return jsonErr('rate_limited', 429);
  }
  const secret = authenticator.generateSecret(20);
  // 条件更新：两个并发 enroll 只有一个能拿到密钥
  const r = await prisma.user.updateMany({
    where: { id: user.id, totpEnabled: false, OR: [{ totpPendingUntil: null }, { totpPendingUntil: { lte: new Date(now) } }] },
    data: pendingSecretData(encrypt(secret), now),
  });
  if (r.count !== 1) {
    await audit({ actorId: user.id, action: 'auth.totp_enroll_blocked', target: user.id, meta: { reason: 'pending' }, ip });
    return jsonErr('rate_limited', 429);
  }
  await audit({ actorId: user.id, action: 'auth.totp_enroll_start', ip });
  const otpauthUri = authenticator.keyuri(user.email, 'PackJoyU Admin', secret);
  return NextResponse.json({ otpauthUri }, { headers: noStore });
}
