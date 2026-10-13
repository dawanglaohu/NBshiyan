import { prisma } from '@/lib/server/db';
import { categorySlugs, type CategorySlugs } from '@/lib/seo/categorySlugs';

export type PublishedModel = {
  id: string; productSlug: string; category: string; sortOrder: number; animated: boolean; customizable: unknown;
  slugs: CategorySlugs | null; glbUrl: string; lodUrl: string | null; posterUrl: string | null;
};

/** 已上架（published 且 READY）的模型。/api/models 和 3D 页服务端组件共用，页面不再通过 HTTP 请求自己的接口 */
export async function listPublishedModels(): Promise<PublishedModel[]> {
  const rows = await prisma.model3D.findMany({
    where: { published: true, status: 'READY' },
    orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
    select: { id: true, productSlug: true, category: true, sortOrder: true, animated: true, customizable: true, lodKey: true, posterKey: true, updatedAt: true },
  });
  return rows.map((m) => {
    const v = m.updatedAt.getTime().toString(36); // 版本参数，换模型后 URL 变化
    return {
      id: m.id, productSlug: m.productSlug, category: m.category, sortOrder: m.sortOrder, animated: m.animated, customizable: m.customizable,
      slugs: categorySlugs(m.category),
      glbUrl: `/api/models/${m.id}/glb?v=${v}`,
      lodUrl: m.lodKey ? `/api/models/${m.id}/lod?v=${v}` : null,
      posterUrl: m.posterKey ? `/api/models/${m.id}/poster?v=${v}` : null,
    };
  });
}
