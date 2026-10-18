import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { clientIp, readBody } from '@/lib/server/security';
import { checkPassword, checkSecondFactor, hashCodes, newRecoveryCodes } from '@/lib/server/admin/login';
import { audit } from '@/lib/server/admin/audit';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { enrollIpRateOk, enrollWindowOpen, pendingSecretUsable, recordBadEnrollTotp } from '@/lib/server/admin/enroll-guard';

export const runtime = 'nodejs';
const Body = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/) });

/**
 * 第二步：提交验证器上的 6 位码确认绑定，开启 2FA，返回 10 个恢复码（只显示这一次）。
 * #348：密码正确但码错，按账号计数；同一个待确认密钥错满 5 次就作废，返回 401 enroll_reset（之后再 confirm 也是 enroll_reset），
 * 冷却 10 分钟后可重新 enroll（冷却期内 enroll 返回 429 rate_limited）。密码错不计入这个计数。
 * 新错误码 enroll_reset 只有密码正确才会出现，不泄露账号是否存在；#353 页面暂时显示通用兜底文案。
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const ip = clientIp(req);
  if (!(await enrollIpRateOk('confirm', ip))) return jsonErr('rate_limited', 429);
  const raw = await readBody(req, 4_000);
  let json: unknown = null; try { json = JSON.parse(raw ?? ''); } catch {}
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const user = await checkPassword(p.data.email, p.data.password, ip);
  if (user === 'rate_limited') return jsonErr('rate_limited', 429);
  if (typeof user === 'string' || user.totpEnabled) return jsonErr('bad_credentials', 401);
  // 以下分支都已通过密码校验
  if (!enrollWindowOpen(user)) {
    await audit({ actorId: user.id, action: 'auth.totp_enroll_blocked', target: user.id, meta: { reason: 'window_expired' }, ip });
    return jsonErr('bad_credentials', 401);
  }
  if (!user.totpSecret) {
    // 待确认密钥因错码过多已被作废（totpPendingUntil 留着作标记，直到下次 enroll）→ enroll_reset：请从第一步重新 enroll
    if (user.totpPendingUntil) return jsonErr('enroll_reset', 401);
    return jsonErr('bad_credentials', 401); // 从没调过 enroll（与原来一致）
  }
  if (!pendingSecretUsable(user)) return jsonErr('bad_totp', 401); // 待确认密钥已过期（或是加固前留下的），需重新 enroll
  if (!(await checkSecondFactor(user, p.data.totp, undefined))) {
    return (await recordBadEnrollTotp(user, ip)) ? jsonErr('enroll_reset', 401) : jsonErr('bad_totp', 401);
  }
  const codes = newRecoveryCodes();
  const r = await prisma.user.updateMany({
    // 只确认当前这个密钥：并发作废或换了新密钥后，旧密钥的码不能再确认
    where: { id: user.id, totpEnabled: false, totpSecret: user.totpSecret },
    data: { totpEnabled: true, recoveryCodes: await hashCodes(codes), sessionVersion: { increment: 1 }, failedLogins: 0, totpEnrollFails: 0, totpPendingUntil: null },
  });
  if (r.count !== 1) return jsonErr('bad_credentials', 401);
  await audit({ actorId: user.id, action: 'auth.totp_enabled', ip });
  return NextResponse.json({ recoveryCodes: codes }, { headers: noStore });
}
