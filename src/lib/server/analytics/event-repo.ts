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
  /** 产品内部 key（`products[].slug`），或已发布且 READY 的 Model3D slug。不是本地化 URL slug。 */
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
          // 交互事务里 create 撞上唯一约束会进入 aborted，随后的查找也会失败。
          // ON CONFLICT DO NOTHING 不中止事务，插不进再读已有行。
          const inserted = Number(await tx.$executeRaw(insertAnalyticsEvent(row)));
          if (inserted === 1) {
            outcomes.push('created');
            continue;
          }
          const againId = await tx.analyticsEvent.findUnique({ where: { eventId: row.eventId }, select: identity });
          const againKey = await tx.analyticsEvent.findUnique({ where: { semanticKey: row.semanticKey }, select: identity });
          const again = classify(againId, againKey, row);
          if (again === 'conflict' || again === 'create') throw new AnalyticsPayloadConflict();
          outcomes.push('duplicate');
        }
      }, { maxWait: 2_000, timeout: 5_000 });
      return outcomes;
    },
  };
}

/** timestamp(3) 用 UTC 墙钟写入，不把 JS Date 直接绑到该列。与 settings-repo 的 utc 相同。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function insertAnalyticsEvent(row: NewAnalyticsEvent): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "AnalyticsEvent" (
      "eventId", "semanticKey", "payloadHash", "browserHash", "kind",
      "occurredAt", "receivedAt", "locale", "path", "productSlug",
      "navigationId", "viewId", "durationMs", "failureReason"
    ) VALUES (
      ${row.eventId},
      ${row.semanticKey},
      ${row.payloadHash},
      ${row.browserHash},
      ${row.kind}::"AnalyticsEventKind",
      ${utc(row.occurredAt)},
      ${utc(row.receivedAt)},
      ${row.locale},
      ${row.path},
      ${row.productSlug},
      ${row.navigationId},
      ${row.viewId},
      ${row.durationMs},
      ${row.failureReason}
    )
    ON CONFLICT DO NOTHING
  `;
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
