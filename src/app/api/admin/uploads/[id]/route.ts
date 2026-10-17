import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { LOGO_ID_RE } from '@/lib/server/uploads';
import { requireAdmin, enforceAdminRateLimit } from '@/lib/server/auth';
import { audit } from '@/lib/server/admin/audit';
import { fileRoute, storedFileResponse } from '@/lib/server/file-response';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };

// #323：fileRoute 让 401 / 404 / 429 / 500 等错误响应也带 FILE_CSP + nosniff
export const GET = fileRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
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
  // Content-Type 由存储 key 决定（写入时按文件头检测），不用数据库里的 mime 字段
  return storedFileResponse(data, u.path, `logo-${u.id}`, { access: 'private' });
});
