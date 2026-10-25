import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChatSessionDTO } from '../../contracts/chat';
import { isProdEnvFrom } from '../../site';
import { CHAT_VISITOR_POLICY, type ChatVisitorPolicy } from '../config';
import { DuplicateChatTokenError, createVisitorSessionRepo, type VisitorSessionRepo } from './visitor-session-repo';

/** HttpOnly 聊天必要 cookie。只在主动联系的 POST 上签发，普通页面不写它。 */
export const CHAT_VISITOR_COOKIE = 'pj_chat';
export const CHAT_VISITOR_COOKIE_PATH = '/api/chat';
export const CHAT_SESSION_BODY_MAX_BYTES = 16 * 1024;
export const CHAT_SESSION_COOKIE_LIMIT = 10;
export const CHAT_SESSION_IP_LIMIT = 20;
export const CHAT_SESSION_RATE_WINDOW_MS = 10 * 60 * 1000;
export const CHAT_SESSION_RETRY_AFTER_SECONDS = 600;
export const CHAT_SESSION_COOKIE_RATE_PREFIX = 'chat:session:cookie:';
export const CHAT_SESSION_IP_RATE_PREFIX = 'chat:session:ip:';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const CLEARED_EXPIRES = 'Thu, 01 Jan 1970 00:00:00 GMT';

export type ChatVisitorSessionRow = {
  id: string;
  tokenHash: string;
  createdAt: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
};

export type ChatCookieRead =
  | { kind: 'absent' }
  | { kind: 'one'; value: string }
  | { kind: 'ambiguous' };

export type EstablishedChatSession = {
  kind: 'issued' | 'reused';
  id: string;
  token: string;
  expiresAt: Date;
};

export type ChatSessionEstablishResult = EstablishedChatSession | { kind: 'rejected' };

export type VisitorSessionService = {
  establish(token: string | null): Promise<ChatSessionEstablishResult>;
};

/** 256bit 随机原值的 SHA-256。库里不存原值，也不用可逆密钥包装。 */
export function hashChatToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 生产始终 Secure。非生产只对 localhost、127.0.0.1、::1 省略 Secure，预览域名仍带 Secure。
 * 看请求 URL 的主机，不看调用方声称的 Origin。Path 不是 /，所以不能用 __Host- 前缀。
 */
export function chatVisitorCookieSecure(requestUrl: string, env: Record<string, string | undefined>): boolean {
  if (isProdEnvFrom(env)) return true;
  try {
    const host = new URL(requestUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return true;
  }
}

/** 同名 cookie 多张时无法判断该信哪一张，调用方必须拒绝，不能当成没有 cookie 再签发一张。 */
export function readChatVisitorCookie(header: string | null): ChatCookieRead {
  if (!header) return { kind: 'absent' };
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const segment = part.trim();
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    if (segment.slice(0, eq).trim() !== CHAT_VISITOR_COOKIE) continue;
    matches.push(segment.slice(eq + 1));
  }
  if (matches.length === 0 || matches.every((value) => value.length === 0)) return { kind: 'absent' };
  if (matches.length !== 1) return { kind: 'ambiguous' };
  return { kind: 'one', value: matches[0] };
}

/** 限流只用一张格式正确的 cookie。超长、畸形或多张都不进 cookie 桶。 */
export function chatVisitorRateToken(header: string | null): string | null {
  const read = readChatVisitorCookie(header);
  if (read.kind !== 'one' || !TOKEN_RE.test(read.value)) return null;
  return read.value;
}

/** 撤销、到达绝对期限或闲置期限（含等号）都拒绝。通过之后才允许 touch。 */
export function sessionAcceptsTouch(row: ChatVisitorSessionRow, now: Date, idleMs: number): boolean {
  if (row.revokedAt !== null) return false;
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) return false;
  if (row.lastActivityAt.getTime() + idleMs <= now.getTime()) return false;
  return true;
}

export function chatSessionExpiry(row: Pick<ChatVisitorSessionRow, 'lastActivityAt' | 'absoluteExpiresAt'>, idleMs: number): Date {
  return new Date(Math.min(row.lastActivityAt.getTime() + idleMs, row.absoluteExpiresAt.getTime()));
}

function cookieHeader(value: string, secure: boolean, extra: string[]): string {
  const parts = [`${CHAT_VISITOR_COOKIE}=${value}`, `Path=${CHAT_VISITOR_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', ...extra];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Max-Age 取闲置与绝对期限的较早者，回写不能超过首次签发后的 30 天。不写 Domain。 */
export function chatVisitorSetCookie(token: string, expiresAt: Date, now: Date, secure: boolean): string {
  const maxAge = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
  return cookieHeader(token, secure, [`Max-Age=${maxAge}`, `Expires=${expiresAt.toUTCString()}`]);
}

export function clearChatVisitorCookie(secure: boolean): string {
  return cookieHeader('', secure, ['Max-Age=0', `Expires=${CLEARED_EXPIRES}`]);
}

function hashesMatch(givenHex: string, storedHex: string): boolean {
  const given = Buffer.from(givenHex, 'hex');
  const stored = HASH_RE.test(storedHex) ? Buffer.from(storedHex, 'hex') : Buffer.alloc(32);
  if (given.length !== stored.length) return false;
  return timingSafeEqual(given, stored) && HASH_RE.test(storedHex);
}

function sessionDto(expiresAt: Date): ChatSessionDTO {
  return { available: true, expiresAt: expiresAt.toISOString() };
}

export function createVisitorSessionService(deps: {
  repo: VisitorSessionRepo;
  clock?: () => Date;
  policy?: ChatVisitorPolicy;
  randomBytes?: (size: number) => Buffer;
} = { repo: undefined as unknown as VisitorSessionRepo }): VisitorSessionService {
  const repo = deps.repo;
  const clock = deps.clock ?? (() => new Date());
  const policy = deps.policy ?? CHAT_VISITOR_POLICY;
  const nextBytes = deps.randomBytes ?? randomBytes;

  function nowOrThrow(): Date {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('chat session clock');
    return now;
  }

  async function insertFresh(now: Date): Promise<EstablishedChatSession> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = nextBytes(32).toString('base64url');
      if (!TOKEN_RE.test(token) || Buffer.from(token, 'base64url').length !== 32) throw new Error('chat token');
      const absoluteExpiresAt = new Date(now.getTime() + policy.absoluteMs);
      const row: ChatVisitorSessionRow = {
        id: nextBytes(16).toString('base64url'),
        tokenHash: hashChatToken(token),
        createdAt: now,
        lastActivityAt: now,
        absoluteExpiresAt,
        revokedAt: null,
      };
      try {
        await repo.insert(row);
        return { kind: 'issued', id: row.id, token, expiresAt: chatSessionExpiry(row, policy.idleMs) };
      } catch (error) {
        if (error instanceof DuplicateChatTokenError && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error('chat token');
  }

  return {
    async establish(token) {
      const now = nowOrThrow();
      if (token === null) return insertFresh(now);
      if (!TOKEN_RE.test(token)) return { kind: 'rejected' };
      const given = hashChatToken(token);
      const row = await repo.findByTokenHash(given);
      // 没有这张会话时也对等长哑值做一次比较，避免用返回快慢区分「库里没有」。
      const stored = row?.tokenHash ?? '';
      if (!row || !hashesMatch(given, stored)) return { kind: 'rejected' };
      if (!sessionAcceptsTouch(row, now, policy.idleMs)) return { kind: 'rejected' };
      const touched = await repo.touchIfValid(row.tokenHash, now, policy.idleMs);
      if (!touched || !sessionAcceptsTouch(touched, now, policy.idleMs)) return { kind: 'rejected' };
      return { kind: 'reused', id: touched.id, token, expiresAt: chatSessionExpiry(touched, policy.idleMs) };
    },
  };
}

export { createVisitorSessionRepo, sessionDto };
