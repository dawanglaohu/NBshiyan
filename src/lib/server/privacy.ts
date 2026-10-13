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
  const hash = emailHash(email);
  // 读（联系人、询盘、logo、产品配置）和写都在同一个事务里，避免读完到写之前有新 logo / 配置写入而漏删
  const out = await db.$transaction(async (tx) => {
    const ids = await contactIdsFor(tx, email);
    if (!ids.length) return { contacts: 0, inquiries: 0, logos: [] as { id: string; path: string }[] };
    const inquiryIds = (await tx.inquiry.findMany({ where: { contactId: { in: ids } }, select: { id: true } })).map((i) => i.id);
    await tx.contact.updateMany({ where: { id: { in: ids } }, data: anonymizedContact(hash) as Prisma.ContactUpdateManyMutationInput });
    const logos = await anonymizeInquiriesTx(tx, inquiryIds);
    return { contacts: ids.length, inquiries: inquiryIds.length, logos };
  }, { timeout: ANON_TX_TIMEOUT_MS });
  await deleteLogoFiles(out.logos, storage); // 文件删除在事务提交之后（删不掉只留无记录的私有孤儿文件）
  return { contacts: out.contacts, inquiries: out.inquiries, logos: out.logos.length };
}

/** 去掉产品配置里 logo 开头的键（如 logo 文件 key）；其余白名单字段（尺寸、颜色等）保留用于统计 */
export function stripLogoKeys(config: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return Prisma.DbNull;
  const out = Object.fromEntries(Object.entries(config as Record<string, unknown>).filter(([k]) => !/^logo/i.test(k)));
  return out as Prisma.InputJsonValue;
}

/** 单批匿名化事务的超时（500 条一批实测见 launch-runbook.md） */
export const ANON_TX_TIMEOUT_MS = 60_000;

/**
 * 询盘级匿名化（手动删除和保留期到期 cron 共用），必须在调用方的交互式事务 tx 里执行：
 * 绑定的 logo 记录和产品配置都在 tx 里读，再在同一个 tx 里写，事务外不做任何读取。返回被删的 logo 记录（id、path），调用方在提交后删文件。
 * 留言、来源归因、评分理由清空；回信 token 换成新的随机值（旧的回信地址失效）；产品备注清空、配置去掉 logo 键；
 * 往来邮件主题正文、内部备注改为 [deleted]；样品收货地址、规范化邮箱、物流单号清空；绑定的 logo 记录删除；标记 anonymizedAt。
 */
export async function anonymizeInquiriesTx(tx: Prisma.TransactionClient, inquiryIds: string[], now = new Date()) {
  if (!inquiryIds.length) return [];
  const logos = await tx.logoUpload.findMany({ where: { inquiryId: { in: inquiryIds } }, select: { id: true, path: true } });
  const items = await tx.inquiryItem.findMany({ where: { inquiryId: { in: inquiryIds }, NOT: { config: { equals: Prisma.DbNull } } }, select: { id: true, config: true } });
  await tx.inquiry.updateMany({ where: { id: { in: inquiryIds } }, data: { message: null, attribution: Prisma.DbNull, trustReasons: Prisma.DbNull, anonymizedAt: now } });
  // replyToken 有唯一约束，每条单独换
  for (const id of inquiryIds) await tx.inquiry.update({ where: { id }, data: { replyToken: randomId(24) } });
  await tx.inquiryItem.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { notes: null } });
  for (const it of items) await tx.inquiryItem.update({ where: { id: it.id }, data: { config: stripLogoKeys(it.config) } });
  await tx.inquiryMessage.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { subject: DELETED, bodyHtml: DELETED } });
  await tx.inquiryNote.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { body: DELETED } });
  await tx.sampleRequest.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { shippingAddress: Prisma.DbNull, normalizedEmail: null, trackingNo: null } });
  if (logos.length) await tx.logoUpload.deleteMany({ where: { id: { in: logos.map((l) => l.id) } } });
  return logos;
}

/**
 * ⚠️ 安全规则（必须遵守）⚠️
 * 以后任何处理客户回信（inbound reply，发到 reply+<token>@REPLY_DOMAIN）的接口：
 *   1. **必须**通过本函数按 token 查找询盘，不能自己写 findUnique/findFirst 查 replyToken。
 *      本函数会拒绝已匿名化（anonymizedAt 不为 null）的询盘，一律当作不存在。
 *   2. **绝不能**对 anonymizedAt 不为 null 的询盘做任何写入（不能新增 InquiryMessage、改状态、存附件等），
 *      否则匿名化后的询盘会重新出现个人信息。
 * 目前代码里还没有处理客户回信的接口；新增时安全审查要核对这两条。见 docs/data-retention.md。
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
