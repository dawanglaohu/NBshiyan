import { unstable_cache } from 'next/cache';
import { Prisma, type CategorySpec } from '@prisma/client';
import { prisma } from './db';
import { SPECS_TAG, isCategoryKey } from './specs';

/**
 * unstable_cache 把结果按 JSON 存储：命中缓存时 Date 变成字符串、Decimal 变成字符串。
 * 读出后统一还原成 Prisma 的类型，冷/热两条路径拿到的行一致（见 #239）。
 */
export const reviveSpecRow = (r: CategorySpec): CategorySpec => ({
  ...r,
  updatedAt: new Date(r.updatedAt),
  sampleFeeAmount: r.sampleFeeAmount == null ? null : new Prisma.Decimal(r.sampleFeeAmount),
});

/** 公开读：按 tag 缓存 1 小时，后台保存时 revalidateTag(SPECS_TAG) 立即失效 */
const loadSpecsCached = unstable_cache(
  async () => (await prisma.categorySpec.findMany()).filter((r) => isCategoryKey(r.category)),
  ['category-specs:v1'], { tags: [SPECS_TAG], revalidate: 3600 },
);

export const loadSpecs = async () => (await loadSpecsCached()).map(reviveSpecRow);
