import { timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export type NewAnalyticsEvent = {
  eventId: string;
  semanticKey: string;
  payloadHash: string;
  browserHash: string;
  kind: 'page_view' | 'product_view' | 'model_view_start' | 'model_load_success' | 'model_load_failure' | 'chat_start';
  occurredAt: Date;
  receivedAt: Date;
  locale: string;
  path: string | null;
  productSlug: string | null;
  navigationId: string | null;
  viewId: string | null;
  durationMs: number | null;
  failureReason: string | null;
};

/** 同一 eventId 或 semanticKey 已经落了不同载荷。事务回滚，不保留本批新行。 */
export class AnalyticsPayloadConflict extends Error {
  constructor() {
    super('analytics_payload_conflict');
    this.name = 'AnalyticsPayloadConflict';
  }
}

export type AnalyticsEventRepo = {
  publishedSlugs(slugs: readonly string[]): Promise<Set<string>>;
  saveAll(rows: readonly NewAnalyticsEvent[]): Promise<Array<'created' | 'duplicate'>>;
};

const identity = { eventId: true, semanticKey: true, payloadHash: true, browserHash: true } as const;
type Identity = { eventId: string; semanticKey: string; payloadHash: string; browserHash: string };

export function createAnalyticsEventRepo(db: PrismaClient): AnalyticsEventRepo {
  return {
    async publishedSlugs(slugs) {
      if (slugs.length === 0) return new Set();
      const rows = await db.model3D.findMany({
        where: { productSlug: { in: [...slugs] }, published: true, status: 'READY' },
        select: { productSlug: true },
      });
      return new Set(rows.map((row) => row.productSlug));
    },
    async saveAll(rows) {
      const outcomes: Array<'created' | 'duplicate'> = [];
      await db.$transaction(async (tx) => {
        for (const row of rows) {
          const byId = await tx.analyticsEvent.findUnique({ where: { eventId: row.eventId }, select: identity });
          const byKey = await tx.analyticsEvent.findUnique({ where: { semanticKey: row.semanticKey }, select: identity });
          const decision = classify(byId, byKey, row);
          if (decision === 'conflict') throw new AnalyticsPayloadConflict();
          if (decision === 'duplicate') {
            outcomes.push('duplicate');
            continue;
          }
          try {
            await tx.analyticsEvent.create({ data: row });
          } catch (error) {
            if (!isUniqueConflict(error)) throw error;
            const againId = await tx.analyticsEvent.findUnique({ where: { eventId: row.eventId }, select: identity });
            const againKey = await tx.analyticsEvent.findUnique({ where: { semanticKey: row.semanticKey }, select: identity });
            const again = classify(againId, againKey, row);
            if (again === 'conflict' || again === 'create') throw new AnalyticsPayloadConflict();
            outcomes.push('duplicate');
            continue;
          }
          outcomes.push('created');
        }
      }, { maxWait: 2_000, timeout: 5_000 });
      return outcomes;
    },
  };
}

function classify(byId: Identity | null, byKey: Identity | null, row: NewAnalyticsEvent): 'create' | 'duplicate' | 'conflict' {
  if (byId && byKey && byId.eventId !== byKey.eventId) return 'conflict';
  const existing = byId ?? byKey;
  if (!existing) return 'create';
  const same = hashEqual(existing.payloadHash, row.payloadHash)
    && existing.semanticKey === row.semanticKey
    && existing.browserHash === row.browserHash;
  return same ? 'duplicate' : 'conflict';
}

function hashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
