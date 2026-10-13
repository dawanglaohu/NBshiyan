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
export async function cleanupOrphanLogos(now = new Date()) {
  const cutoff = new Date(now.getTime() - LOGO_ORPHAN_TTL_MS);
  let deleted = 0;
  for (;;) {
    const batch = await prisma.logoUpload.findMany({ where: { inquiryId: null, createdAt: { lt: cutoff } }, select: { id: true, path: true }, take: 200 });
    if (!batch.length) break;
    for (const u of batch) {
      // 先删记录（条件里再确认未绑定），再删文件，避免删掉刚被绑定的文件
      const r = await prisma.logoUpload.deleteMany({ where: { id: u.id, inquiryId: null } });
      if (r.count === 1) { await storage.delete(u.path); deleted++; }
    }
    if (batch.length < 200) break;
  }
  return deleted;
}

/** 常量时间比较密钥；未配置密钥时一律拒绝 */
export function secretMatches(given: string | null, expected: string | undefined) {
  if (!expected || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 临时管理员校验。TODO(auth): 后台 Auth.js（含双重验证）上线后改为校验会话和 ADMIN/SALES 角色。
 * 现在：生产环境一律拒绝；开发环境仅当设置 ADMIN_DEV_TOKEN 且请求头 x-admin-dev-token 相同时放行，便于本地测试。
 */
export async function isAdminPlaceholder(req: Request) {
  if (process.env.NODE_ENV === 'production') return false;
  return secretMatches(req.headers.get('x-admin-dev-token'), process.env.ADMIN_DEV_TOKEN);
}
