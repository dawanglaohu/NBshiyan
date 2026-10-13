import { createHmac } from 'crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeEmail } from './sample';
import { storage as defaultStorage, type PrivateStorage } from './storage';
import { isLogoKey } from './uploads';
import { randomId } from './security';
import { errorSummary } from './mail';

export const PrivacyExportBody = z.object({ email: z.string().trim().email().max(200) }).strict();
export const PrivacyDeleteBody = z.object({ email: z.string().trim().email().max(200), confirmEmail: z.string().trim().max(200) }).strict()
  .refine((b) => normalizeEmail(b.email) === normalizeEmail(b.confirmEmail), { message: 'confirm_mismatch', path: ['confirmEmail'] });

const isProd = (env: NodeJS.ProcessEnv = process.env) => env.VERCEL_ENV === 'production' || (env.NODE_ENV === 'production' && !env.CI && env.VERCEL_ENV !== 'preview');

/**
 * 邮箱哈希密钥：独立的 PRIVACY_HASH_SECRET（≥ 32 字节），轮换 AUTH_SECRET 不影响历史审计哈希。
 * 生产环境未设置时返回 null（接口 503，拒绝执行）；非生产环境回退到由 AUTH_SECRET 派生的密钥，方便本地开发。
 */
export function privacyHashKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const s = env.PRIVACY_HASH_SECRET;
  if (s && Buffer.byteLength(s) >= 32) return createHmac('sha256', s).update('privacy-email-hash:v1').digest();
  if (isProd(env) || !env.AUTH_SECRET) return null;
  return createHmac('sha256', env.AUTH_SECRET).update('privacy-email-hash:dev-fallback:v1').digest();
}
export const privacyHashReady = (env: NodeJS.ProcessEnv = process.env) => privacyHashKey(env) !== null;

/** 审计日志里只存邮箱的 HMAC，不存明文 */
export function emailHash(email: string, env: NodeJS.ProcessEnv = process.env) {
  const key = privacyHashKey(env);
  if (!key) throw new Error('PRIVACY_HASH_SECRET missing');
  return createHmac('sha256', key).update(normalizeEmail(email)).digest('hex');
}

/** 规范化邮箱匹配的联系人 id：按 Contact.normalizedEmail 精确查询（有索引），没有条数上限 */
export async function contactIdsFor(db: Pick<PrismaClient, 'contact'>, email: string) {
  const rows = await db.contact.findMany({ where: { normalizedEmail: normalizeEmail(email) }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** 导出：询盘（含样品、询价清单产品）、往来邮件、logo 元数据。不含内部备注、评分细节、回信 token。 */
export async function exportCustomer(db: PrismaClient, email: string) {
  const ids = await contactIdsFor(db, email);
  const contacts = await db.contact.findMany({
    where: { id: { in: ids } },
    select: {
      name: true, email: true, company: true, phone: true, region: true, createdAt: true,
      inquiries: {
        orderBy: { createdAt: 'asc' },
        select: {
          ref: true, source: true, locale: true, status: true, message: true, createdAt: true,
          items: { select: { productSlug: true, quantity: true, config: true, notes: true, designId: true } },
          sample: { select: { status: true, shippingAddress: true, trackingNo: true, createdAt: true } },
          messages: { orderBy: { createdAt: 'asc' }, select: { direction: true, subject: true, bodyHtml: true, createdAt: true } },
          logoUploads: { select: { width: true, height: true, bytes: true, createdAt: true } },
        },
      },
    },
  });
  const inquiries = contacts.flatMap((c) => c.inquiries);
  return {
    exportedAt: new Date().toISOString(),
    contacts: contacts.map(({ inquiries: _i, ...c }) => { void _i; return c; }),
    inquiries: inquiries.filter((i) => i.source !== 'SAMPLE' && i.source !== 'CART'),
    quoteLists: inquiries.filter((i) => i.source === 'CART'),
    samples: inquiries.filter((i) => i.source === 'SAMPLE'),
  };
}

const DELETED = '[deleted]';
/** 匿名化后的联系人字段（地区保留用于统计） */
export const anonymizedContact = (hash: string): Prisma.ContactUpdateInput => ({ name: DELETED, email: `deleted+${hash.slice(0, 16)}@invalid.invalid`, normalizedEmail: null, company: null, phone: null });

/**
 * 删除个人信息：联系人姓名/邮箱/电话/公司、留言、产品备注、往来邮件正文和主题、样品收货地址和规范化邮箱清空；
 * logo 上传记录和文件删除。保留询盘条数、来源/状态/产品 slug/数量/日期/地区用于统计。
 */
export async function deleteCustomer(db: PrismaClient, email: string, storage: PrivateStorage = defaultStorage) {
  const ids = await contactIdsFor(db, email);
  if (!ids.length) return { contacts: 0, inquiries: 0, logos: 0 };
  const hash = emailHash(email);
  const inquiryIds = (await db.inquiry.findMany({ where: { contactId: { in: ids } }, select: { id: true } })).map((i) => i.id);
  const logos = await db.logoUpload.findMany({ where: { inquiryId: { in: inquiryIds } }, select: { id: true, path: true } });
  await db.$transaction([
    db.contact.updateMany({ where: { id: { in: ids } }, data: anonymizedContact(hash) as Prisma.ContactUpdateManyMutationInput }),
    ...(await anonymizeInquiryOps(db, inquiryIds, logos.map((l) => l.id))),
  ]);
  await deleteLogoFiles(logos, storage);
  return { contacts: ids.length, inquiries: inquiryIds.length, logos: logos.length };
}

/** 去掉产品配置里 logo 开头的键（如 logo 文件 key）；其余白名单字段（尺寸、颜色等）保留用于统计 */
export function stripLogoKeys(config: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return Prisma.DbNull;
  const out = Object.fromEntries(Object.entries(config as Record<string, unknown>).filter(([k]) => !/^logo/i.test(k)));
  return out as Prisma.InputJsonValue;
}

/**
 * 询盘级匿名化（手动删除和保留期到期 cron 共用），返回要放进同一个 $transaction 的操作：
 * 留言、来源归因、评分理由清空；回信 token 换成新的随机值（旧的回信地址失效）；产品备注清空、配置去掉 logo 键；
 * 往来邮件主题正文、内部备注改为 [deleted]；样品收货地址、规范化邮箱、物流单号清空；绑定的 logo 记录删除；标记 anonymizedAt。
 */
export async function anonymizeInquiryOps(db: PrismaClient, inquiryIds: string[], logoIds: string[], now = new Date()) {
  const items = await db.inquiryItem.findMany({ where: { inquiryId: { in: inquiryIds }, NOT: { config: { equals: Prisma.DbNull } } }, select: { id: true, config: true } });
  return [
    db.inquiry.updateMany({ where: { id: { in: inquiryIds } }, data: { message: null, attribution: Prisma.DbNull, trustReasons: Prisma.DbNull, anonymizedAt: now } }),
    // replyToken 有唯一约束，每条单独换
    ...inquiryIds.map((id) => db.inquiry.update({ where: { id }, data: { replyToken: randomId(24) } })),
    db.inquiryItem.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { notes: null } }),
    ...items.map((it) => db.inquiryItem.update({ where: { id: it.id }, data: { config: stripLogoKeys(it.config) } })),
    db.inquiryMessage.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { subject: DELETED, bodyHtml: DELETED } }),
    db.inquiryNote.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { body: DELETED } }),
    db.sampleRequest.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { shippingAddress: Prisma.DbNull, normalizedEmail: null, trackingNo: null } }),
    db.logoUpload.deleteMany({ where: { id: { in: logoIds } } }),
  ];
}

/**
 * 客户回信（发到 reply+<token>@REPLY_DOMAIN）找询盘时必须用这个：已匿名化的询盘一律当作不存在。
 * 注意：目前代码里还没有处理客户回信的接口，以后加的时候必须用它。
 */
export async function findInquiryForReply(db: Pick<PrismaClient, 'inquiry'>, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return db.inquiry.findFirst({ where: { replyToken: token, anonymizedAt: null }, select: { id: true, ref: true, locale: true } });
}

/** 记录已删再删文件；只删合法 logo key；失败只记错误类型（文件私有，孤儿文件无记录可访问） */
export async function deleteLogoFiles(logos: { path: string }[], storage: PrivateStorage = defaultStorage) {
  for (const l of logos) {
    if (!isLogoKey(l.path)) { console.error('[privacy] skip non-logo key'); continue; }
    await storage.delete(l.path).catch((e) => console.error('[privacy] logo file delete failed', errorSummary(e)));
  }
}
