import { Prisma } from '@prisma/client';
import { AppError } from '../http/errors';
import type { ChatVisitorSessionRow } from './visitor-session';

export class DuplicateChatTokenError extends Error {
  constructor() {
    super('duplicate chat token');
    this.name = 'DuplicateChatTokenError';
  }
}

export type VisitorSessionStore = {
  chatVisitorSession: {
    create(args: { data: ChatVisitorSessionRow }): Promise<ChatVisitorSessionRow>;
    findUnique(args: { where: { tokenHash: string } }): Promise<ChatVisitorSessionRow | null>;
  };
  $queryRaw(query: Prisma.Sql): Promise<unknown>;
};

const UNAVAILABLE = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

/** 数据库不可用变成 service_unavailable。唯一冲突交给签发方重试一次。不把驱动的 message 放进错误文本。 */
export function translateVisitorSessionError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientInitializationError) throw new AppError('service_unavailable');
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new DuplicateChatTokenError();
    if (UNAVAILABLE.has(error.code)) throw new AppError('service_unavailable');
  }
  throw error;
}

/**
 * 先验期限再更新。等号拒绝：absoluteExpiresAt、lastActivityAt + idle 都必须严格晚于 now。
 * 参数顺序固定为 now、tokenHash、now、cutoff，供调用方和测试核对。
 */
export function visitorSessionTouchSql(tokenHash: string, now: Date, idleMs: number): Prisma.Sql {
  const cutoff = new Date(now.getTime() - idleMs);
  return Prisma.sql`
    UPDATE "ChatVisitorSession" AS session
    SET "lastActivityAt" = ${now}
    WHERE session."tokenHash" = ${tokenHash}
      AND session."revokedAt" IS NULL
      AND session."absoluteExpiresAt" > ${now}
      AND session."lastActivityAt" > ${cutoff}
    RETURNING
      session."id" AS "id",
      session."tokenHash" AS "tokenHash",
      session."createdAt" AS "createdAt",
      session."lastActivityAt" AS "lastActivityAt",
      session."absoluteExpiresAt" AS "absoluteExpiresAt",
      session."revokedAt" AS "revokedAt"
  `;
}

function asDate(value: unknown, label: string): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  throw new Error(`chat session ${label}`);
}

function mapRow(raw: unknown): ChatVisitorSessionRow {
  if (!raw || typeof raw !== 'object') throw new Error('chat session row');
  const row = raw as Record<string, unknown>;
  return {
    id: typeof row.id === 'string' ? row.id : '',
    tokenHash: typeof row.tokenHash === 'string' ? row.tokenHash : '',
    createdAt: asDate(row.createdAt, 'createdAt'),
    lastActivityAt: asDate(row.lastActivityAt, 'lastActivityAt'),
    absoluteExpiresAt: asDate(row.absoluteExpiresAt, 'absoluteExpiresAt'),
    revokedAt: row.revokedAt == null ? null : asDate(row.revokedAt, 'revokedAt'),
  };
}

export type VisitorSessionRepo = {
  insert(row: ChatVisitorSessionRow): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<ChatVisitorSessionRow | null>;
  touchIfValid(tokenHash: string, now: Date, idleMs: number): Promise<ChatVisitorSessionRow | null>;
};

export function createVisitorSessionRepo(db: VisitorSessionStore): VisitorSessionRepo {
  return {
    async insert(row) {
      try {
        await db.chatVisitorSession.create({ data: row });
      } catch (error) {
        translateVisitorSessionError(error);
      }
    },
    async findByTokenHash(tokenHash) {
      try {
        const row = await db.chatVisitorSession.findUnique({ where: { tokenHash } });
        return row ? mapRow(row) : null;
      } catch (error) {
        translateVisitorSessionError(error);
      }
    },
    async touchIfValid(tokenHash, now, idleMs) {
      try {
        const raw = await db.$queryRaw(visitorSessionTouchSql(tokenHash, now, idleMs));
        if (!Array.isArray(raw) || raw.length > 1) throw new Error('chat session touch');
        return raw.length === 1 ? mapRow(raw[0]) : null;
      } catch (error) {
        translateVisitorSessionError(error);
      }
    },
  };
}
