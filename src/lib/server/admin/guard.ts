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
 * 只管登录、会话和角色。同源校验和限流由 admin-guard.ts 的 assertSameOrigin / enforceAdminRateLimit 负责，
 * 路由里按 requireAdmin → assertSameOrigin → await enforceAdminRateLimit 的顺序调用。失败直接返回 Response。
 */
export type SessionDenial = 'unauthenticated' | 'disabled' | 'forbidden';
export type SessionCheck =
  | { ok: true; user: User }
  | { ok: false; reason: SessionDenial; status: 401 | 403 };

type SessionUser = Pick<User, 'disabled' | 'totpEnabled' | 'lockedUntil' | 'sessionVersion' | 'role'>;
/**
 * 纯判断（便于测试）：
 * - 未登录 / 用户不存在 / 锁定 / 会话版本不一致 / 未开 2FA → unauthenticated 401（需重新登录）
 * - 账号已停用 → disabled 403（重新登录也没用，与未登录区分）
 * - 角色不在 roles 里 → forbidden 403
 */
export function classifySession<U extends SessionUser>(uid: string | undefined, user: U | null, sv: number | undefined, roles: readonly Role[], now = new Date()):
  { ok: true; user: U } | { ok: false; reason: SessionDenial; status: 401 | 403 } {
  if (!uid || !user) return { ok: false, reason: 'unauthenticated', status: 401 };
  if (user.disabled) return { ok: false, reason: 'disabled', status: 403 };
  if (!user.totpEnabled || (user.lockedUntil && user.lockedUntil > now) || sv !== user.sessionVersion) return { ok: false, reason: 'unauthenticated', status: 401 };
  if (!roles.includes(user.role)) return { ok: false, reason: 'forbidden', status: 403 };
  return { ok: true, user };
}

/** 会话 + 账号状态 + 角色检查（接口和后台页面共用同一套规则），规则见 classifySession */
export async function checkAdminSession(roles: Role[] = ['ADMIN']): Promise<SessionCheck> {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const user = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  const sv = (session as unknown as { sv?: number } | null)?.sv;
  return classifySession(uid, user, sv, roles);
}

const DENIAL_ERROR: Record<SessionDenial, string> = { unauthenticated: 'unauthorized', disabled: 'account_disabled', forbidden: 'forbidden' };
export const denialError = (r: SessionDenial) => DENIAL_ERROR[r];

export async function requireAdmin(req: Request, roles: Role[] = ['ADMIN']): Promise<AdminCtx | Response> {
  const c = await checkAdminSession(roles);
  if (!c.ok) return jsonErr(denialError(c.reason), c.status);
  return { user: c.user, ip: clientIp(req) };
}
