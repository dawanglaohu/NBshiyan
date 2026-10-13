import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { requireAdmin, adminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE } from '@/lib/server/admin/inquiries';

export const runtime = 'nodejs';
const TYPES = { glb: 'model/gltf-binary', lod: 'model/gltf-binary', poster: 'image/webp' } as const;

/** 第 3 步：预览。后台加载未上架的模型文件：?variant=glb|lod|poster */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const limited = adminRateLimit(req, 'model.file', 240);
  if (limited) return limited;
  const { id } = await params;
  const variant = (new URL(req.url).searchParams.get('variant') ?? 'glb') as keyof typeof TYPES;
  if (!ID_RE.test(id) || !(variant in TYPES)) return jsonErr('not_found', 404);
  const m = await prisma.model3D.findUnique({ where: { id } });
  const key = m && (variant === 'glb' ? m.sourceKey : variant === 'lod' ? m.lodKey : m.posterKey);
  const data = key ? await storage.get(key) : null;
  if (!data) return jsonErr('not_found', 404);
  return new Response(new Uint8Array(data), {
    headers: { ...noStore, 'Content-Type': TYPES[variant], 'Content-Length': String(data.length), 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${id}-${variant}.${variant === 'poster' ? 'webp' : 'glb'}"` },
  });
}
