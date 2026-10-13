import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { LOGO_ID_RE } from '@/lib/server/uploads';
import { requireAdmin, enforceAdminRateLimit } from '@/lib/server/auth';
import { audit } from '@/lib/server/admin/audit';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'upload.view');
  if (limited) return limited;
  const { id } = await params;
  if (!LOGO_ID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  const u = await prisma.logoUpload.findUnique({ where: { id }, include: { inquiry: { select: { assigneeId: true } } } });
  // SALES 只能看分配给自己的询盘上的 logo；未绑定询盘的上传只有 ADMIN 能看。无权限按 404 处理，不暴露是否存在
  if (u && ctx.user.role !== 'ADMIN' && u.inquiry?.assigneeId !== ctx.user.id) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  const data = u && (await storage.get(u.path));
  if (!u || !data) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  await audit({ actorId: ctx.user.id, action: 'upload.view', target: u.id, ip: ctx.ip });
  return new Response(new Uint8Array(data), {
    headers: {
      ...noStore,
      'Content-Type': u.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `inline; filename="logo-${u.id}.png"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
