import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { requireAdmin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr } from '@/lib/server/admin/guard';
import { storedFileResponse } from '@/lib/server/file-response';
import { ID_RE } from '@/lib/server/admin/inquiries';

export const runtime = 'nodejs';
const VARIANTS = ['glb', 'lod', 'poster'] as const;

/** 第 3 步：预览。后台加载未上架的模型文件：?variant=glb|lod|poster */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'model.file', 240);
  if (limited) return limited;
  const { id } = await params;
  const variant = (new URL(req.url).searchParams.get('variant') ?? 'glb') as (typeof VARIANTS)[number];
  if (!ID_RE.test(id) || !VARIANTS.includes(variant)) return jsonErr('not_found', 404);
  const m = await prisma.model3D.findUnique({ where: { id } });
  const key = m && (variant === 'glb' ? m.sourceKey : variant === 'lod' ? m.lodKey : m.posterKey);
  const data = key ? await storage.get(key) : null;
  if (!data) return jsonErr('not_found', 404);
  return storedFileResponse(data, key!, `${id}-${variant}`, { access: 'private' });
}
