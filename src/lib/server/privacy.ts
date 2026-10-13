import { createHmac } from 'crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeEmail } from './sample';
import { storage } from './storage';

export const PrivacyExportBody = z.object({ email: z.string().trim().email().max(200) }).strict();
export const PrivacyDeleteBody = z.object({ email: z.string().trim().email().max(200), confirmEmail: z.string().trim().max(200) }).strict()
  .refine((b) => normalizeEmail(b.email) === normalizeEmail(b.confirmEmail), { message: 'confirm_mismatch', path: ['confirmEmail'] });

/** 审计日志里只存邮箱的 HMAC（key 由 AUTH_SECRET 派生），不存明文 */
export function emailHash(email: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET missing');
  const key = createHmac('sha256', secret).update('privacy-email-hash:v1').digest();
  return createHmac('sha256', key).update(normalizeEmail(email)).digest('hex');
}

/** 规范化邮箱匹配的联系人 id：先按域名缩小（Gmail 两个域名），再在内存里比对规范化结果 */
export async function contactIdsFor(db: Pick<PrismaClient, 'contact'>, email: string) {
  const key = normalizeEmail(email);
  const domain = key.slice(key.lastIndexOf('@') + 1);
  const domains = domain === 'gmail.com' ? ['gmail.com', 'googlemail.com'] : [domain];
  const rows = await db.contact.findMany({ where: { OR: domains.map((d) => ({ email: { endsWith: `@${d}`, mode: 'insensitive' as const } })) }, select: { id: true, email: true }, take: 5000 });
  return rows.filter((r) => normalizeEmail(r.email) === key).map((r) => r.id);
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
export const anonymizedContact = (hash: string): Prisma.ContactUpdateInput => ({ name: DELETED, email: `deleted+${hash.slice(0, 16)}@invalid.invalid`, company: null, phone: null });

/**
 * 删除个人信息：联系人姓名/邮箱/电话/公司、留言、产品备注、往来邮件正文和主题、样品收货地址和规范化邮箱清空；
 * logo 上传记录和文件删除。保留询盘条数、来源/状态/产品 slug/数量/日期/地区用于统计。
 */
export async function deleteCustomer(db: PrismaClient, email: string) {
  const ids = await contactIdsFor(db, email);
  if (!ids.length) return { contacts: 0, inquiries: 0, logos: 0 };
  const hash = emailHash(email);
  const inquiryIds = (await db.inquiry.findMany({ where: { contactId: { in: ids } }, select: { id: true } })).map((i) => i.id);
  const logos = await db.logoUpload.findMany({ where: { inquiryId: { in: inquiryIds } }, select: { id: true, path: true } });
  await db.$transaction([
    db.contact.updateMany({ where: { id: { in: ids } }, data: anonymizedContact(hash) as Prisma.ContactUpdateManyMutationInput }),
    db.inquiry.updateMany({ where: { id: { in: inquiryIds } }, data: { message: null } }),
    db.inquiryItem.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { notes: null } }),
    db.inquiryMessage.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { subject: DELETED, bodyHtml: DELETED } }),
    db.sampleRequest.updateMany({ where: { inquiryId: { in: inquiryIds } }, data: { shippingAddress: Prisma.DbNull, normalizedEmail: null } }),
    db.logoUpload.deleteMany({ where: { id: { in: logos.map((l) => l.id) } } }),
  ]);
  // 记录已删再删文件；文件删除失败只记日志（文件私有，孤儿文件无记录可访问）
  for (const l of logos) await storage.delete(l.path).catch((e) => console.error('[privacy] logo file delete failed', (e as Error).name));
  return { contacts: ids.length, inquiries: inquiryIds.length, logos: logos.length };
}
