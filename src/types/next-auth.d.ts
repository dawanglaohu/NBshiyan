import type { DefaultSession } from 'next-auth';
import type { AccountDTO, AuthSessionMetadata } from '../lib/contracts';

declare module 'next-auth' {
  interface Session extends AuthSessionMetadata {
    user: DefaultSession['user'] & { id?: AccountDTO['id']; role?: AccountDTO['role'] };
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends AuthSessionMetadata {
    uid?: AccountDTO['id'];
    /** 首次登录时间，ISO8601 UTC。只供展示，不参与鉴权；续期原样带上，不从客户端 session.update 采纳。 */
    authTime?: string;
  }
}
