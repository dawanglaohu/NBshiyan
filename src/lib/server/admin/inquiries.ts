import type { Prisma, User } from '@prisma/client';
import { chatAndInquiryRetentionDays } from '../retention';

/** 最后活动规则：后台回信、改状态时把保留期顺延到 now + 询盘保留天数（默认 730 天） */
export const retainUntilFromNow = (now = new Date()) => new Date(now.getTime() + chatAndInquiryRetentionDays() * 86_400_000);

/** 顺延保留期；条件里固定带 anonymizedAt IS NULL，已匿名化的询盘永远不会被顺延。返回是否更新成功（false = 不存在或已匿名化） */
export async function extendInquiryRetention(db: { inquiry: { updateMany: (a: { where: Prisma.InquiryWhereInput; data: { retainUntil: Date } }) => Promise<{ count: number }> } }, id: string, now = new Date()) {
  const r = await db.inquiry.updateMany({ where: { id, anonymizedAt: null }, data: { retainUntil: retainUntilFromNow(now) } });
  return r.count > 0;
}

/** 业务员只能访问分配给自己的询盘；管理员不限 */
export function inquiryScope(user: User): Prisma.InquiryWhereInput {
  return user.role === 'ADMIN' ? {} : { assigneeId: user.id };
}

export async function readJson(req: Request, max = 20_000): Promise<unknown> {
  const { readBody } = await import('../security');
  const raw = await readBody(req, max);
  if (raw === null) return Symbol.for('too_large');
  try { return JSON.parse(raw); } catch { return null; }
}
export const TOO_LARGE = Symbol.for('too_large');
export const ID_RE = /^[a-z0-9]{20,40}$/;
