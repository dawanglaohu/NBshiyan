import { timingSafeEqual } from 'crypto';
import { prisma } from './db';
import { storage } from './storage';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_DIM = 4096;
export const LOGO_BIND_TTL_MS = 60 * 60_000; // 1 小时内可绑定询盘
export const LOGO_ORPHAN_TTL_MS = 24 * 60 * 60_000; // 未绑定 24 小时后删除
export const LOGO_ID_RE = /^[A-Za-z0-9]{24}$/;

/** 只认文件头，不看扩展名和 Content-Type */
export function sniffImage(b: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** 删除未绑定询盘、创建超过 24 小时的上传（文件和记录）。返回删除条数。 */
/** 未过期或已被询盘引用（expiresAt=null）的方案 */
const liveDesign = (now: Date) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/** 可删除的未绑定 logo（cleanupOrphanLogos 和 dry run 共用条件） */
export const orphanLogoWhere = (now = new Date()) => ({ inquiryId: null, createdAt: { lt: new Date(now.getTime() - LOGO_ORPHAN_TTL_MS) }, designs: { none: liveDesign(now) } });
type OrphanDb = { logoUpload: { findMany(a: { where: ReturnType<typeof orphanLogoWhere>; select: { id: true; path: true }; take: number }): Promise<{ id: string; path: string }[]>; deleteMany(a: { where: object }): Promise<{ count: number }> } };
export const ORPHAN_BATCH = 200;
/**
 * 删除未绑定询盘、创建超过 24 小时、且没被未过期方案引用的上传（记录和文件）。每批 200 条，每批开始前检查 deadline。返回删除条数。
 * 只删“这次看到并确认删除了记录”的文件；跳过的行（并发下刚被绑定）不会被再次取到，所以循环一定结束。
 */
export async function cleanupOrphanLogos(now = new Date(), deadline = Number.POSITIVE_INFINITY, deps: { db?: OrphanDb; storage?: { delete(k: string): Promise<unknown> }; clock?: () => number } = {}) {
  const db = deps.db ?? (prisma as unknown as OrphanDb);
  const store = deps.storage ?? storage;
  const clock = deps.clock ?? Date.now;
  const where = orphanLogoWhere(now);
  let deleted = 0;
  while (clock() < deadline) {
    const batch = await db.logoUpload.findMany({ where, select: { id: true, path: true }, take: ORPHAN_BATCH });
    if (!batch.length) break;
    for (const u of batch) {
      // 先删记录（条件里再确认未绑定），再删文件，避免删掉刚被绑定的文件
      const r = await db.logoUpload.deleteMany({ where: { id: u.id, ...where } });
      if (r.count === 1) { if (isLogoKey(u.path)) await store.delete(u.path); else console.error('[uploads] skip non-logo key'); deleted++; }
    }
    if (batch.length < ORPHAN_BATCH) break;
  }
  return deleted;
}

/** logo 文件 key 只能是 logos/YYYY-MM/<id>.png（上传接口生成的格式）；删除前再校验一次，防止误删其他文件 */
export const isLogoKey = (k: string) => /^logos\/\d{4}-\d{2}\/[A-Za-z0-9_-]{8,64}\.png$/.test(k);

/** 常量时间比较密钥；未配置密钥时一律拒绝 */
export function secretMatches(given: string | null, expected: string | undefined) {
  if (!expected || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
