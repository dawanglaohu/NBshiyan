import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 公开：只列出已上架且检查通过的模型 */
export async function GET() {
  const rows = await prisma.model3D.findMany({
    where: { published: true, status: 'READY' },
    orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
    select: { id: true, productSlug: true, category: true, sortOrder: true, animated: true, customizable: true, lodKey: true, posterKey: true, updatedAt: true },
  });
  const items = rows.map((m) => {
    const v = m.updatedAt.getTime().toString(36); // 版本参数，换模型后 URL 变化
    return {
      id: m.id, productSlug: m.productSlug, category: m.category, sortOrder: m.sortOrder, animated: m.animated, customizable: m.customizable,
      glbUrl: `/api/models/${m.id}/glb?v=${v}`,
      lodUrl: m.lodKey ? `/api/models/${m.id}/lod?v=${v}` : null,
      posterUrl: m.posterKey ? `/api/models/${m.id}/poster?v=${v}` : null,
    };
  });
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } });
}
