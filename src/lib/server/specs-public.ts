import { unstable_cache } from 'next/cache';
import { prisma } from './db';
import { SPECS_TAG, isCategoryKey } from './specs';

/** 公开读：按 tag 缓存 1 小时，后台保存时 revalidateTag(SPECS_TAG) 立即失效 */
export const loadSpecs = unstable_cache(
  async () => (await prisma.categorySpec.findMany()).filter((r) => isCategoryKey(r.category)),
  ['category-specs:v1'], { tags: [SPECS_TAG], revalidate: 3600 },
);
