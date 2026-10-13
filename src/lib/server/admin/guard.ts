import { NextResponse } from 'next/server';
import type { Role, User } from '@prisma/client';
import { auth } from '@/auth';
import { prisma } from '../db';
import { clientIp } from '../security';

export const noStore = { 'Cache-Control': 'private, no-store' };
export const jsonErr = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

export type AdminCtx = { user: User; ip: string | null };

/** 改动类请求的同源校验：Origin 必须等于站点地址（AUTH_URL，没有则取请求自身 origin）。 */
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const expected = process.env.AUTH_URL ? new URL(process.env.AUTH_URL).origin : new URL(req.url).origin;
  return origin === expected;
}

/**
 * 后台接口统一入口：校验会话、账号状态（未禁用、未锁定、会话版本一致、已开 2FA）和角色。
 * 改动类方法（非 GET/HEAD）同时做同源校验。失败直接返回 Response。
 */
export async function requireAdmin(req: Request, roles: Role[] = ['ADMIN']): Promise<AdminCtx | Response> {
  if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return jsonErr('bad_origin', 403);
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  if (!uid) return jsonErr('unauthorized', 401);
  const user = await prisma.user.findUnique({ where: { id: uid } });
  const sv = (session as unknown as { sv?: number }).sv;
  if (!user || user.disabled || !user.totpEnabled || (user.lockedUntil && user.lockedUntil > new Date()) || sv !== user.sessionVersion) return jsonErr('unauthorized', 401);
  if (!roles.includes(user.role)) return jsonErr('forbidden', 403);
  return { user, ip: clientIp(req) };
}
