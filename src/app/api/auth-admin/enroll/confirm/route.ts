import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { clientIp, readBody } from '@/lib/server/security';
import { checkPassword, checkSecondFactor, hashCodes, newRecoveryCodes } from '@/lib/server/admin/login';
import { audit } from '@/lib/server/admin/audit';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { assertSameOrigin } from '@/lib/server/admin-guard';

export const runtime = 'nodejs';
const Body = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/) });

/** 第二步：提交验证器上的 6 位码确认绑定，开启 2FA，返回 10 个恢复码（只显示这一次）。 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const ip = clientIp(req);
  const raw = await readBody(req, 4_000);
  let json: unknown = null; try { json = JSON.parse(raw ?? ''); } catch {}
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const user = await checkPassword(p.data.email, p.data.password, ip);
  if (user === 'rate_limited') return jsonErr('rate_limited', 429);
  if (typeof user === 'string' || user.totpEnabled || !user.totpSecret) return jsonErr('bad_credentials', 401);
  if (!(await checkSecondFactor(user, p.data.totp, undefined))) return jsonErr('bad_totp', 401);
  const codes = newRecoveryCodes();
  const r = await prisma.user.updateMany({
    where: { id: user.id, totpEnabled: false },
    data: { totpEnabled: true, recoveryCodes: await hashCodes(codes), sessionVersion: { increment: 1 }, failedLogins: 0 },
  });
  if (r.count !== 1) return jsonErr('bad_credentials', 401);
  await audit({ actorId: user.id, action: 'auth.totp_enabled', ip });
  return NextResponse.json({ recoveryCodes: codes }, { headers: noStore });
}
