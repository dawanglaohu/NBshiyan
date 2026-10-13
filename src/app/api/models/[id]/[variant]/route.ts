import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';

export const runtime = 'nodejs';
const TYPES = { glb: 'model/gltf-binary', lod: 'model/gltf-binary', poster: 'image/webp' } as const;
const nf = () => new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/** 公开模型文件，只对已上架且 READY 的模型返回 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; variant: string }> }) {
  const { id, variant } = await params;
  // gltf-progressive 按主 GLB 里记录的相对路径（如 gift-box.3cc28f83.lod0.glb）加载高精度层，这里映射到 lod
  const v: keyof typeof TYPES | null = variant in TYPES ? (variant as keyof typeof TYPES)
    : /^[a-z0-9-]+(\.anim)?\.[0-9a-f]{8}\.lod0\.glb$/.test(variant) ? 'lod'
    : /^[a-z0-9-]+(\.anim)?\.[0-9a-f]{8}\.glb$/.test(variant) ? 'glb' : null;
  if (!/^[a-z0-9]{20,40}$/.test(id) || !v) return nf();
  const m = await prisma.model3D.findFirst({ where: { id, published: true, status: 'READY' } });
  const key = m && (v === 'glb' ? m.sourceKey : v === 'lod' ? m.lodKey : m.posterKey);
  const data = key ? await storage.get(key) : null;
  if (!data) return nf();
  return new Response(new Uint8Array(data), {
    headers: { 'Content-Type': TYPES[v], 'Content-Length': String(data.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' },
  });
}
