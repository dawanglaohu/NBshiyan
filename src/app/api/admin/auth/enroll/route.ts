import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticator } from 'otplib';
import { prisma } from '@/lib/server/db';
import { clientIp, readBody } from '@/lib/server/security';
import { checkPassword } from '@/lib/server/admin/login';
import { encrypt } from '@/lib/server/admin/crypto';
import { audit } from '@/lib/server/admin/audit';
import { jsonErr, noStore, sameOrigin } from '@/lib/server/admin/guard';

export const runtime = 'nodejs';
const Body = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

/** 第一步：用邮箱+密码换取 otpauth URI。仅限尚未开启 2FA 的账号；每次调用都会换新密钥，旧的作废。 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonErr('bad_origin', 403);
  const ip = clientIp(req);
  const raw = await readBody(req, 4_000);
  let json: unknown = null; try { json = JSON.parse(raw ?? ''); } catch {}
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const user = await checkPassword(p.data.email, p.data.password, ip);
  if (user === 'rate_limited') return jsonErr('rate_limited', 429);
  if (typeof user === 'string') return jsonErr('bad_credentials', 401);
  if (user.totpEnabled) return jsonErr('bad_credentials', 401); // 已开启的不能重新绑定，统一报错
  const secret = authenticator.generateSecret(20);
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: encrypt(secret), totpLastStep: null } });
  await audit({ actorId: user.id, action: 'auth.totp_enroll_start', ip });
  const otpauthUri = authenticator.keyuri(user.email, 'PackJoyU Admin', secret);
  return NextResponse.json({ otpauthUri }, { headers: noStore });
}
