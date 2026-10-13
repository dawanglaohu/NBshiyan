import { NextResponse } from 'next/server';
import type { Role, User } from '@prisma/client';
import { auth } from '@/auth';
import { prisma } from '../db';
import { clientIp } from '../security';

export const noStore = { 'Cache-Control': 'private, no-store' };
export const jsonErr = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

export type AdminCtx = { user: User; ip: string | null };

/**
 * 后台接口统一入口：校验会话、账号状态（未禁用、未锁定、会话版本一致、已开 2FA）和角色。
 * 只管登录、会话和角色。同源校验和限流由 admin-guard.ts 的 assertSameOrigin / adminRateLimit 负责，
 * 路由里按 requireAdmin → assertSameOrigin → adminRateLimit 的顺序调用。失败直接返回 Response。
 */
export async function requireAdmin(req: Request, roles: Role[] = ['ADMIN']): Promise<AdminCtx | Response> {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  if (!uid) return jsonErr('unauthorized', 401);
  const user = await prisma.user.findUnique({ where: { id: uid } });
  const sv = (session as unknown as { sv?: number }).sv;
  if (!user || user.disabled || !user.totpEnabled || (user.lockedUntil && user.lockedUntil > new Date()) || sv !== user.sessionVersion) return jsonErr('unauthorized', 401);
  if (!roles.includes(user.role)) return jsonErr('forbidden', 403);
  return { user, ip: clientIp(req) };
}
