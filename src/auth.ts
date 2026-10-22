import { AsyncLocalStorage } from 'node:async_hooks';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { decode, encode as defaultEncode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { RememberDeviceSchema } from '@/lib/contracts/account';
import { ADMIN_SESSION_POLICY } from '@/lib/server/config';
import { clientIp } from '@/lib/server/security';
import { authorizeLogin } from '@/lib/server/admin/login';
import { prisma } from '@/lib/server/db';
import {
  clearedSessionCookieHeaders,
  deviceServiceFor,
  sessionCookieNames,
  type DeviceSessionService,
} from '@/lib/server/admin/device-session';

const Login = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
  totp: z.string().trim().regex(/^\d{6}$/).optional().or(z.literal('').transform(() => undefined)),
  recoveryCode: z.string().trim().max(40).optional().or(z.literal('').transform(() => undefined)),
  rememberDevice: RememberDeviceSchema,
});

/** 普通会话的闲置窗口。Auth.js 的 maxAge 只用绝对上限当天花板，真正的截止由设备行裁定。 */
export const SESSION_MAX_AGE = 2 * 60 * 60;
const ABSOLUTE_MAX_AGE = Math.floor(ADMIN_SESSION_POLICY.absoluteMs / 1000);
const AREA = ['ADMIN', 'SALES', 'EDITOR'] as const;
const USE_SECURE_COOKIES = process.env.NODE_ENV === 'production';
const SESSION_COOKIE_NAME = USE_SECURE_COOKIES ? '__Secure-authjs.session-token' : 'authjs.session-token';

let devices: DeviceSessionService | undefined;
function devicesOf() {
  devices ??= deviceServiceFor(prisma, () => new Date(), ADMIN_SESSION_POLICY);
  return devices;
}

type EncodeParams = Parameters<typeof defaultEncode>[0];

/** JWT 的 exp 取设备截止前一整秒，不使用 Auth.js 传入的全局 maxAge。 */
async function encodeCapped(params: EncodeParams) {
  const stamp = (params.token as { effectiveExpiresAt?: unknown } | undefined)?.effectiveExpiresAt;
  const deadline = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  const nowSec = Math.floor(Date.now() / 1000);
  const deadlineSec = Number.isFinite(deadline) ? Math.floor(deadline / 1000) : nowSec;
  const slack = deadlineSec - nowSec - 1;
  const ceiling = params.maxAge ?? slack;
  return defaultEncode({ ...params, maxAge: Math.max(0, Math.min(ceiling, slack)) });
}

const signOutState = new AsyncLocalStorage<{ failed: boolean }>();

export const { handlers, auth } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt', maxAge: ABSOLUTE_MAX_AGE, updateAge: 15 * 60 },
  jwt: { maxAge: ABSOLUTE_MAX_AGE, encode: encodeCapped },
  useSecureCookies: USE_SECURE_COOKIES,
  cookies: { sessionToken: { name: SESSION_COOKIE_NAME, options: { httpOnly: true, sameSite: 'lax', path: '/', secure: USE_SECURE_COOKIES } } },
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, totp: {}, recoveryCode: {}, rememberDevice: {} },
      async authorize(raw, request) {
        const parsed = Login.safeParse(raw);
        if (!parsed.success) throw new CredentialsSignin();
        const user = await authorizeLogin(parsed.data, clientIp(request));
        if (!user) throw new CredentialsSignin();
        try {
          const device = await devicesOf().open({
            userId: user.id,
            sessionVersion: user.sessionVersion,
            remembered: parsed.data.rememberDevice,
            userAgent: request.headers.get('user-agent'),
          });
          return { id: user.id, email: user.email, name: user.name, role: user.role, sv: user.sessionVersion, sid: device.id };
        } catch {
          throw new CredentialsSignin();
        }
      },
    }),
  ],
  events: {
    async signOut(message) {
      const box = signOutState.getStore();
      try {
        const sid = 'token' in message && typeof message.token?.sid === 'string' ? message.token.sid : undefined;
        if (sid) await devicesOf().revokeSid(sid, 'sign_out');
      } catch {
        if (box) box.failed = true;
        throw new Error('device revoke failed');
      }
    },
  },
  callbacks: {
    // 客户端 session.update 的字段不读。角色、sv、sid 和期限都以这次数据库结果为准。
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.sid = (user as { sid?: string }).sid;
        token.sv = (user as { sv?: number }).sv;
      }
      const decision = await devicesOf().authenticate({
        userId: typeof token.uid === 'string' ? token.uid : undefined,
        sessionVersion: typeof token.sv === 'number' ? token.sv : undefined,
        sid: typeof token.sid === 'string' ? token.sid : undefined,
        roles: AREA,
      });
      if (!decision.ok) return null;
      token.uid = decision.user.id;
      token.sid = decision.device.id;
      token.sv = decision.user.sessionVersion;
      token.role = decision.user.role;
      token.effectiveExpiresAt = decision.bounds.effectiveExpiresAt.toISOString();
      token.absoluteExpiresAt = decision.bounds.absoluteExpiresAt?.toISOString() ?? null;
      return token;
    },
    session({ session, token }) {
      const effective = typeof token.effectiveExpiresAt === 'string' ? token.effectiveExpiresAt : undefined;
      const absolute = token.absoluteExpiresAt === null || typeof token.absoluteExpiresAt === 'string' ? token.absoluteExpiresAt : undefined;
      return {
        ...session,
        expires: effective ?? session.expires,
        sid: typeof token.sid === 'string' ? token.sid : undefined,
        sv: typeof token.sv === 'number' ? token.sv : undefined,
        effectiveExpiresAt: effective,
        absoluteExpiresAt: absolute,
        user: {
          ...session.user,
          id: typeof token.uid === 'string' ? token.uid : undefined,
          role: typeof token.role === 'string' ? token.role : undefined,
        },
      };
    },
  },
});

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const raw = trimmed.slice(name.length + 1);
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

/** 与 Auth.js 使用同一个 cookie 命名空间，不降级到另一个账号遗留的 cookie。 */
export async function readSessionToken(request: Request) {
  const token = cookieValue(request.headers.get('cookie') ?? '', SESSION_COOKIE_NAME);
  const secret = process.env.AUTH_SECRET;
  if (!token || !secret) return null;
  try {
    return await decode({ token, secret, salt: SESSION_COOKIE_NAME });
  } catch {
    return null;
  }
}

function clearedNamed(name: string): string {
  return clearedSessionCookieHeaders().find((header) => header.startsWith(`${name}=`)) ?? `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function rewriteExpiry(cookie: string, exp: number): string {
  const expires = new Date(exp * 1000).toUTCString();
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  const withExpires = /Expires=/i.test(cookie) ? cookie.replace(/Expires=[^;]*/i, `Expires=${expires}`) : `${cookie}; Expires=${expires}`;
  return /Max-Age=/i.test(withExpires) ? withExpires.replace(/Max-Age=[^;]*/i, `Max-Age=${maxAge}`) : `${withExpires}; Max-Age=${maxAge}`;
}

async function capSessionCookie(cookie: string): Promise<string> {
  const name = cookie.split('=', 1)[0] ?? '';
  if (!sessionCookieNames().includes(name)) return cookie;
  const value = cookie.slice(name.length + 1).split(';', 1)[0] ?? '';
  if (!value) return cookie;
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return clearedNamed(name);
    const token = await decode({ token: value, secret, salt: name });
    const exp = token && typeof token.exp === 'number' ? token.exp : 0;
    if (exp <= Math.floor(Date.now() / 1000)) return clearedNamed(name);
    return rewriteExpiry(cookie, exp);
  } catch {
    return clearedNamed(name);
  }
}

export async function alignSessionCookies(response: Response): Promise<Response> {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const cookie of cookies) headers.append('set-cookie', await capSessionCookie(cookie));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Auth.js 路由入口。普通 signOut 只有在设备撤销提交之后才把清 cookie 的响应交出去。 */
export async function handleAuth(request: Request): Promise<Response> {
  const next = request instanceof NextRequest ? request : new NextRequest(request);
  const signingOut = next.method === 'POST' && new URL(next.url).pathname.endsWith('/signout');
  const box = { failed: false };
  const run = () => (next.method === 'GET' ? handlers.GET(next) : handlers.POST(next));
  const response = signingOut ? await signOutState.run(box, run) : await run();
  if (box.failed) return new Response(null, { status: 503, headers: { 'cache-control': 'private, no-store' } });
  return alignSessionCookies(response);
}
