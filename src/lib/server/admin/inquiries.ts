import type { Prisma, User } from '@prisma/client';

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
