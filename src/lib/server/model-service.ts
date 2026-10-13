import type { Model3D, Prisma } from '@prisma/client';
import { prisma } from './db';
import { storage } from './storage';
import { inspectGlb } from './models';

/** 重新读取已存文件并跑检查，更新 status/checks。返回更新后的记录。 */
export async function processModel(id: string): Promise<Model3D> {
  const m = await prisma.model3D.update({ where: { id }, data: { status: 'PROCESSING', error: null } });
  try {
    const glb = await storage.get(m.sourceKey);
    if (!glb) throw new Error('源文件丢失');
    const lod = m.lodKey ? await storage.get(m.lodKey) : null;
    const r = await inspectGlb(glb, { animated: m.animated, lod });
    return await prisma.model3D.update({
      where: { id },
      data: {
        status: r.ok ? 'READY' : 'FAILED', checks: r.checks as unknown as Prisma.InputJsonValue, triangles: r.triangles,
        animations: r.animations, sizeBytes: glb.length, glbKey: m.sourceKey,
        error: r.ok ? null : r.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.key).join(','),
        // 检查不通过的模型不能保持上架
        ...(r.ok ? {} : { published: false }),
      },
    });
  } catch (e) {
    return prisma.model3D.update({ where: { id }, data: { status: 'FAILED', published: false, error: String((e as Error).message).slice(0, 200) } });
  }
}

/** 后台返回的字段（不含存储 key） */
export function adminView(m: Model3D) {
  const { sourceKey: _s, glbKey: _g, lodKey, posterKey, ...rest } = m; void _s; void _g;
  return { ...rest, hasLod: !!lodKey, hasPoster: !!posterKey };
}

export async function deleteModelFiles(m: Model3D) {
  for (const k of new Set([m.sourceKey, m.glbKey, m.lodKey, m.posterKey].filter(Boolean) as string[])) await storage.delete(k);
}
