import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { fileRoute, storedFileResponse } from '@/lib/server/file-response';

export const runtime = 'nodejs';
const VARIANTS = ['glb', 'lod', 'poster'] as const;
type Variant = (typeof VARIANTS)[number];
const nf = () => new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/** 公开模型文件，只对已上架且 READY 的模型返回 */
// #323：fileRoute 让 401 / 404 / 429 / 500 等错误响应也带 FILE_CSP + nosniff
export const GET = fileRoute(async (_req: Request, { params }: { params: Promise<{ id: string; variant: string }> }) => {
  const { id, variant } = await params;
  // gltf-progressive 按主 GLB 里记录的相对路径（如 gift-box.3cc28f83.lod0.glb）加载高精度层，这里映射到 lod
  const v: Variant | null = (VARIANTS as readonly string[]).includes(variant) ? (variant as Variant)
    : /^[a-z0-9-]+(\.anim)?\.[0-9a-f]{8}\.lod0\.glb$/.test(variant) ? 'lod'
    : /^[a-z0-9-]+(\.anim)?\.[0-9a-f]{8}\.glb$/.test(variant) ? 'glb' : null;
  if (!/^[a-z0-9]{20,40}$/.test(id) || !v) return nf();
  const m = await prisma.model3D.findFirst({ where: { id, published: true, status: 'READY' } });
  const key = m && (v === 'glb' ? m.sourceKey : v === 'lod' ? m.lodKey : m.posterKey);
  const data = key ? await storage.get(key) : null;
  if (!data) return nf();
  // 公开（已上架）模型：Content-Type 由存储 key 决定；GLB 非图片 → attachment（fetch 加载不受影响）
  return storedFileResponse(data, key!, `${id}-${v}`, { access: 'public', cacheControl: 'public, max-age=300' });
});
