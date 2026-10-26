import { AsyncLocalStorage } from 'node:async_hooks';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { decode, encode as defaultEncode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { LoginRequestSchema, type LoginRequest } from '@/lib/contracts/account';
import { ADMIN_SESSION_POLICY } from '@/lib/server/config';
import { clientIp } from '@/lib/server/security';
import { authorizeLogin } from '@/lib/server/admin/login';
import { stagedLoginCookies, withLoginCookies } from '@/lib/server/admin/login-challenge';
import { prisma } from '@/lib/server/db';
import {
  clearedSessionCookieHeaders,
  deviceServiceFor,
  sessionCookieNames,
  type AuthenticateResult,
  type DeviceSessionService,
} from '@/lib/server/admin/device-session';

/** Auth.js 自己的传输字段。登录契约只解析剩下的字段，未知登录字段仍由 strict schema 拒绝。 */
const AUTH_TRANSPORT_FIELDS = ['csrfToken', 'callbackUrl', 'redirect', 'json'] as const;
/** 默认登录页没填的可选框会提交成空字符串。default 只认 undefined，空字符串会让枚举和 rememberDevice 直接失败。 */
const BLANK_OPTIONAL_FIELDS = ['mode', 'rememberDevice', 'recoveryCode', 'totp'] as const;

function blankText(value: unknown) {
  return typeof value === 'string' && value.trim() === '';
}

function loginSource(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = { ...(raw as Record<string, unknown>) };
  for (const key of AUTH_TRANSPORT_FIELDS) delete source[key];
  // 空密码输入视为没带密码，totp 模式才能不填密码；password 模式仍由契约要求密码。
  if (source.password === '') delete source.password;
  // 只删这四个可选字段的空值。email 留空仍交给契约拒绝，未知字段也不删。
  for (const key of BLANK_OPTIONAL_FIELDS) {
    if (blankText(source[key])) delete source[key];
  }
  if (typeof source.totp === 'string') source.totp = source.totp.trim();
  return source;
}

export function parseLogin(raw: unknown) {
  const source = loginSource(raw);
  if (!source) return LoginRequestSchema.safeParse(raw);
  return LoginRequestSchema.safeParse(source);
}

export type LoginAttempt = {
  email?: string;
  password?: string;
  totp?: string;
  recoveryCode?: string;
  mode?: LoginRequest['mode'];
  rememberDevice: boolean;
};

/**
 * 契约要求密码模式带验证码或恢复码。第一步只有邮箱和密码，而且补一个验证码后契约就能通过时，
 * 当成密码步骤。其他校验失败仍拒绝。第二步只有验证码，由契约里的挑战形状放行。
 */
export function credentialsFromRaw(raw: unknown): LoginAttempt | null {
  const parsed = parseLogin(raw);
  if (parsed.success) {
    if (!parsed.data.email) {
      if (parsed.data.mode === 'password' && parsed.data.totp && parsed.data.password === undefined && parsed.data.recoveryCode === undefined) {
        return { totp: parsed.data.totp, mode: 'password', rememberDevice: parsed.data.rememberDevice };
      }
      return null;
    }
    return parsed.data;
  }
  const source = loginSource(raw);
  if (!source) return null;
  if ((source.mode ?? 'password') !== 'password') return null;
  if (source.totp !== undefined || source.recoveryCode !== undefined) return null;
  const probe = parseLogin({ ...source, totp: '000000' });
  if (!probe.success || !probe.data.email || probe.data.password === undefined) return null;
  return { email: probe.data.email, password: probe.data.password, mode: 'password', rememberDevice: probe.data.rememberDevice };
}

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

/** 鉴权失败丢掉 token。数据库暂时不可用或服务出错时原样退回，已有 cookie 继续有效。 */
export function jwtAfterAccess<T>(token: T, decision: AuthenticateResult): T | null {
  if (!decision.ok) return decision.reason === 'unavailable' || decision.reason === 'internal' ? token : null;
  return token;
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
  pages: { signIn: '/admin-login' },
  session: { strategy: 'jwt', maxAge: ABSOLUTE_MAX_AGE, updateAge: 15 * 60 },
  jwt: { maxAge: ABSOLUTE_MAX_AGE, encode: encodeCapped },
  useSecureCookies: USE_SECURE_COOKIES,
  cookies: { sessionToken: { name: SESSION_COOKIE_NAME, options: { httpOnly: true, sameSite: 'lax', path: '/', secure: USE_SECURE_COOKIES } } },
  providers: [
    Credentials({
      credentials: { email: {}, password: { type: 'password' }, totp: {}, recoveryCode: {}, rememberDevice: {}, mode: {} },
      async authorize(raw, request) {
        const attempt = credentialsFromRaw(raw);
        if (!attempt) throw new CredentialsSignin();
        const header = (name: string) => request?.headers?.get(name) ?? null;
        const user = await authorizeLogin(attempt, clientIp(request), { userAgent: header('user-agent'), cookie: header('cookie') });
        if (!user) throw new CredentialsSignin();
        try {
          const device = await devicesOf().open({
            userId: user.id,
            sessionVersion: user.sessionVersion,
            remembered: attempt.rememberDevice,
            userAgent: header('user-agent'),
          });
          return { id: user.id, email: user.email, name: user.name, role: user.role, sv: user.sessionVersion, sid: device.id };
        } catch (error) {
          if (error instanceof CredentialsSignin) throw error;
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
      if (!decision.ok) return jwtAfterAccess(token, decision);
      token.uid = decision.user.id;
      token.sid = decision.device.id;
      token.sv = decision.user.sessionVersion;
      token.role = decision.user.role;
      // authTime 只复制设备行的创建时间，给展示用。鉴权不读它；客户端 session.update 带上的值在这里被盖掉。
      token.authTime = decision.device.createdAt.toISOString();
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

/** 用当前设备期限重新签发会话 JWT。exp 仍走 encodeCapped，不把 maxAge 放到设备截止之后。 */
export async function sealSessionCookie(token: EncodeParams['token']): Promise<{ value: string; exp: number } | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !token) return null;
  try {
    const value = await encodeCapped({ token, secret, salt: SESSION_COOKIE_NAME });
    const decoded = await decode({ token: value, secret, salt: SESSION_COOKIE_NAME });
    if (!decoded || typeof decoded.exp !== 'number') return null;
    return { value, exp: decoded.exp };
  } catch {
    return null;
  }
}

/** 与 Auth.js 初始化时的 cookie 选项一致：HttpOnly、SameSite=Lax；生产再加 Secure 和 __Secure- 前缀。 */
export function sessionSetCookie(value: string, exp: number): string {
  const expires = new Date(exp * 1000).toUTCString();
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  const parts = [`${SESSION_COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${expires}`, `Max-Age=${maxAge}`];
  if (USE_SECURE_COOKIES) parts.push('Secure');
  return parts.join('; ');
}

export async function alignSessionCookies(response: Response): Promise<Response> {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const cookie of cookies) headers.append('set-cookie', await capSessionCookie(cookie));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withExtraCookies(response: Response, extra: readonly string[]): Response {
  if (extra.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of extra) headers.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Auth.js 路由入口。普通 signOut 只有在设备撤销提交之后才把清 cookie 的响应交出去。 */
export async function handleAuth(request: Request): Promise<Response> {
  const next = request instanceof NextRequest ? request : new NextRequest(request);
  const signingOut = next.method === 'POST' && new URL(next.url).pathname.endsWith('/signout');
  const box = { failed: false };
  const run = () => (next.method === 'GET' ? handlers.GET(next) : handlers.POST(next));
  const held = await withLoginCookies(async () => {
    const response = signingOut ? await signOutState.run(box, run) : await run();
    return { response, cookies: stagedLoginCookies() };
  });
  if (box.failed) return new Response(null, { status: 503, headers: { 'cache-control': 'private, no-store' } });
  return alignSessionCookies(withExtraCookies(held.response, held.cookies));
}
