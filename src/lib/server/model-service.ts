import type { Model3D, Prisma } from '@prisma/client';
import { prisma } from './db';
import { storage } from './storage';
import { GLB_PARSE_DETAIL, inspectGlb, modelLogText } from './models';

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
    // 库里只留固定码。原始异常进日志（截断、去掉控制字符），不回给后台页面。
    const raw = e instanceof Error ? e.message : String(e);
    console.error('[model-upload] process failed:', modelLogText(raw));
    return prisma.model3D.update({ where: { id }, data: { status: 'FAILED', published: false, error: 'process_failed' } });
  }
}

/** 以「GLB 解析失败」开头的 detail 收成定稿固定句。只改返回值，不写数据库。 */
function viewChecks(checks: Model3D['checks']): Model3D['checks'] {
  if (!Array.isArray(checks)) return checks;
  return checks.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('detail' in item)) return item;
    const detail = item.detail;
    if (typeof detail !== 'string' || !detail.startsWith(GLB_PARSE_DETAIL) || detail === GLB_PARSE_DETAIL) return item;
    return { ...item, detail: GLB_PARSE_DETAIL };
  }) as Model3D['checks'];
}

/** 后台返回的字段（不含存储 key） */
export function adminView(m: Model3D) {
  const { sourceKey: _s, glbKey: _g, lodKey, posterKey, checks, ...rest } = m; void _s; void _g;
  return { ...rest, checks: viewChecks(checks), hasLod: !!lodKey, hasPoster: !!posterKey };
}

export async function deleteModelFiles(m: Model3D) {
  for (const k of new Set([m.sourceKey, m.glbKey, m.lodKey, m.posterKey].filter(Boolean) as string[])) await storage.delete(k);
}
