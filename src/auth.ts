import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { clientIp } from '@/lib/server/security';
import { authorizeLogin } from '@/lib/server/admin/login';
import { prisma } from '@/lib/server/db';

const Login = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
  totp: z.string().trim().regex(/^\d{6}$/).optional().or(z.literal('').transform(() => undefined)),
  recoveryCode: z.string().trim().max(40).optional().or(z.literal('').transform(() => undefined)),
});

export const SESSION_MAX_AGE = 2 * 60 * 60; // 2 小时

export const { handlers, auth } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE, updateAge: 15 * 60 },
  jwt: { maxAge: SESSION_MAX_AGE },
  // 会话 cookie：HttpOnly + SameSite=Lax；生产强制 Secure（并带 __Secure- 前缀）。本地 http 开发时不加 Secure。
  useSecureCookies: process.env.NODE_ENV === 'production',
  cookies: { sessionToken: { options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' } } },
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, totp: {}, recoveryCode: {} },
      async authorize(raw, request) {
        const p = Login.safeParse(raw);
        if (!p.success) throw new CredentialsSignin();
        const user = await authorizeLogin(p.data, clientIp(request));
        if (!user) throw new CredentialsSignin(); // 统一错误，不区分哪一步失败
        return { id: user.id, email: user.email, name: user.name, role: user.role, sv: user.sessionVersion };
      },
    }),
  ],
  callbacks: {
    // 每次读会话都核对账号：sessionVersion 变了（改密码、重置/关闭 2FA）、被禁用或锁定，旧会话立即失效
    async jwt({ token, user }) {
      if (user) { token.uid = user.id; token.role = (user as { role: string }).role; token.sv = (user as { sv: number }).sv; return token; }
      if (!token.uid) return null;
      const u = await prisma.user.findUnique({ where: { id: token.uid as string }, select: { sessionVersion: true, disabled: true, totpEnabled: true, role: true } });
      if (!u || u.disabled || !u.totpEnabled || u.sessionVersion !== token.sv) return null;
      token.role = u.role;
      return token;
    },
    session({ session, token }) {
      return { ...session, sv: token.sv as number, user: { ...session.user, id: token.uid as string, role: token.role as string } };
    },
  },
});
