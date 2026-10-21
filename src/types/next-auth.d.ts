import type { DefaultSession } from 'next-auth';
import type { AccountDTO, AuthSessionMetadata } from '../lib/contracts';

declare module 'next-auth' {
  interface Session extends AuthSessionMetadata {
    user: DefaultSession['user'] & { id?: AccountDTO['id']; role?: AccountDTO['role'] };
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends AuthSessionMetadata { uid?: AccountDTO['id'] }
}
