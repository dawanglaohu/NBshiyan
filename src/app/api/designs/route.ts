import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { randomId, hitRateLimit, clientIp, readBody, verifyTurnstile, tooManyRequests } from '@/lib/server/security';
import { DesignBody, DESIGN_ID_LEN, DESIGN_MAX_BODY, DESIGN_MAX_CONFIG } from '@/lib/server/designs';
import { retention } from '@/lib/server/retention';

export const runtime = 'nodejs';

/** 公开：保存定制方案，返回短链接 /{locale}/s/:id。限流 + Turnstile + 白名单 schema + 体积上限，180 天后过期（被询盘引用后不过期）。 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const ok = ip ? await hitRateLimit(`design:${ip}`, 30) : await hitRateLimit('design:noip:all', 200);
  if (!ok) return tooManyRequests(600);
  const raw = await readBody(req, DESIGN_MAX_BODY);
  if (raw === null) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch {}
  const p = DesignBody.safeParse(json);
  if (!p.success) return NextResponse.json({ error: 'invalid', issues: p.error.flatten() }, { status: 400 });
  if (JSON.stringify(p.data.config).length > DESIGN_MAX_CONFIG) return NextResponse.json({ error: 'too_large' }, { status: 413 });

  const captcha = await verifyTurnstile(p.data.turnstileToken, ip);
  if (captcha === 'unavailable') return NextResponse.json({ error: 'captcha_unavailable' }, { status: 503, headers: { 'Retry-After': '30' } });
  if (captcha === 'fail') return NextResponse.json({ error: 'captcha' }, { status: 403 });

  const { productSlug, category, locale, config, logoUploadId } = p.data;
  if (logoUploadId) {
    // logo 必须是还能绑定的上传（未过期、未绑定询盘）；之后由方案引用保活，不会被 24 小时清理删掉
    const logo = await prisma.logoUpload.findFirst({ where: { id: logoUploadId, inquiryId: null, expiresAt: { gt: new Date() } }, select: { id: true } });
    if (!logo) return NextResponse.json({ error: 'logo_invalid' }, { status: 422 });
  }
  const id = randomId(DESIGN_ID_LEN);
  const expiresAt = new Date(Date.now() + retention.designTtlDays * 86_400_000);
  await prisma.sharedDesign.create({ data: { id, productSlug, category, locale, config, logoUploadId, expiresAt } });
  return NextResponse.json({ id, url: `/${locale}/s/${id}`, expiresAt }, { status: 201 });
}
