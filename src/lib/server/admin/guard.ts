import { NextResponse } from 'next/server';
import type { Role, User } from '@prisma/client';
import { auth, readSessionToken } from '@/auth';
import { ADMIN_SESSION_POLICY } from '../config';
import { prisma } from '../db';
import { clientIp } from '../security';
import { clearedSessionCookieHeaders, decideAdminAccess, type SessionDenial, type BoundAccess } from './device-session';

export const noStore = { 'Cache-Control': 'private, no-store' };
export const jsonErr = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

export type AdminCtx = { user: User; ip: string | null };

/**
 * 后台接口统一入口：校验会话、账号状态（未禁用、未锁定、会话版本一致、已开 2FA）、当前设备和角色。
 * 同源校验和限流由 admin-guard.ts 的 assertSameOrigin / enforceAdminRateLimit 负责。
 * 失败直接返回 Response。设备是否有效每次读库，不在进程里记住上一次的结论。
 */
export type { SessionDenial } from './device-session';
export { classifySession } from './device-session';
export type SessionCheck = BoundAccess;

type AuthSession = { user?: { id?: string }; sv?: number; sid?: string } | null;

async function clearWritableSessionCookie() {
  try {
    const { cookies } = await import('next/headers');
    const jar = await cookies();
    for (const header of clearedSessionCookieHeaders()) {
      const name = header.split('=', 1)[0] ?? '';
      jar.set(name, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, expires: new Date(0), secure: name.startsWith('__') });
    }
  } catch {
    // 没有 Next 请求上下文时，由返回的 Response 自己带 Set-Cookie。
  }
}

/** 会话 + 账号 + 设备 + 角色。规则见 decideAdminAccess。拒绝时能写 cookie 就清掉。 */
export async function checkAdminSession(roles: Role[] = ['ADMIN'], request?: Request): Promise<SessionCheck> {
  let session: AuthSession = null;
  try {
    if (request) {
      const token = await readSessionToken(request);
      session = token ? { user: { id: typeof token.uid === 'string' ? token.uid : undefined }, sv: typeof token.sv === 'number' ? token.sv : undefined, sid: typeof token.sid === 'string' ? token.sid : undefined } : null;
    } else session = await auth() as AuthSession;
  } catch {
    await clearWritableSessionCookie();
    return { ok: false, reason: 'unauthenticated', status: 401 };
  }
  const userId = session?.user?.id;
  const sid = typeof session?.sid === 'string' ? session.sid : undefined;
  try {
    const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    const device = sid ? await prisma.adminDeviceSession.findUnique({ where: { id: sid } }) : null;
    const decision = decideAdminAccess({
      userId, sessionVersion: session?.sv, sid, user, device, roles, now: new Date(), policy: ADMIN_SESSION_POLICY,
    });
    if (!decision.ok && decision.reason !== 'forbidden') await clearWritableSessionCookie();
    if (!decision.ok) return { ok: false, reason: decision.reason, status: decision.status };
    return decision;
  } catch {
    await clearWritableSessionCookie();
    return { ok: false, reason: 'unauthenticated', status: 401 };
  }
}

const DENIAL_ERROR: Record<SessionDenial, string> = { unauthenticated: 'unauthorized', disabled: 'account_disabled', forbidden: 'forbidden' };
export const denialError = (r: SessionDenial) => DENIAL_ERROR[r];

export function withClearedSession(response: Response): Response {
  for (const cookie of clearedSessionCookieHeaders()) response.headers.append('set-cookie', cookie);
  return response;
}

export async function requireAdmin(req: Request, roles: Role[] = ['ADMIN']): Promise<(AdminCtx & Pick<Extract<BoundAccess, { ok: true }>, 'device' | 'bounds'>) | Response> {
  const c = await checkAdminSession(roles, req);
  if (!c.ok) {
    const response = jsonErr(denialError(c.reason), c.status);
    return c.reason === 'forbidden' ? response : withClearedSession(response);
  }
  return { user: c.user, device: c.device, bounds: c.bounds, ip: clientIp(req) };
}
