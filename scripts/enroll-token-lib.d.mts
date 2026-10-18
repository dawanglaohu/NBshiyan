export const ENROLL_TOKEN_TTL_MS: number;
export const ENROLL_WINDOW_MS: number;
export const ENROLL_PAGE: '/admin-enroll';
export function hashEnrollToken(token: string): string;
export function newEnrollToken(now?: number, windowStart?: number): {
  token: string; data: { enrollTokenHash: string; enrollTokenExpiresAt: Date }; expiresAt: Date; expiresTruncated: boolean;
};
export function enrollLink(token: string, env?: Record<string, string | undefined>): string;
