import { Prisma, type PrismaClient } from '@prisma/client';
import { ANALYTICS_SETTINGS_KEY } from '../jobs/types';

/** 一条待重算记录。不写进 analytics.settings：计数器按五个字段严格解析，多一个字段会把整行当成不可读。 */
export const ANALYTICS_RECOMPUTE_KEY = 'analytics.recompute';

export const ANALYTICS_TIMEZONE_CHANGE_ACTION = 'analytics.timezone_change';

export type SettingsQuery = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export type SettingsAuditWrite = {
  id: string;
  actorId: string;
  action: string;
  target: string;
  meta: unknown;
  at: Date;
};

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

async function readValue(query: SettingsQuery, key: string): Promise<unknown | null> {
  const rows = await query.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = ${key}
  `;
  return rows.length === 0 ? null : rows[0].value;
}

/**
 * 单语句同快照读取 settings 与重算待办。作业与 GET 共用。
 * 读取入口没有事务隔离前提，不能把两条 SELECT 当成同一快照；PostgreSQL RepeatableRead
 * 事务内的多条 SELECT 可以共用快照，但这里不依赖那个前提，仍用一条语句。
 */
export async function readSettingsAndBacklog(query: SettingsQuery): Promise<{
  settings: unknown | null;
  backlog: unknown | null;
}> {
  const rows = await query.$queryRaw<{ key: string; value: unknown }[]>`
    SELECT "key", "value" FROM "SiteSetting"
    WHERE "key" IN (${ANALYTICS_SETTINGS_KEY}, ${ANALYTICS_RECOMPUTE_KEY})
  `;
  let settings: unknown | null = null;
  let backlog: unknown | null = null;
  for (const row of rows) {
    if (row.key === ANALYTICS_SETTINGS_KEY) settings = row.value;
    else if (row.key === ANALYTICS_RECOMPUTE_KEY) backlog = row.value;
  }
  return { settings, backlog };
}

/**
 * 完整值 jsonb 等值 CAS 删除。expected 必须来自 strict 解析后的六字段对象，
 * 不做 `->>`/`::int` 字段谓词：坏值、额外字段、同 revision 的其它字段改写都匹配不到。
 * 返回受影响行数；0 行只记 consume_miss，不推断原因。
 */
export async function consumeRecomputeBacklog(query: SettingsQuery, expected: unknown): Promise<number> {
  return query.$executeRaw`
    DELETE FROM "SiteSetting"
    WHERE "key" = ${ANALYTICS_RECOMPUTE_KEY}
      AND "value" = ${JSON.stringify(expected)}::jsonb
  `;
}

/**
 * 时区设置的行锁读写。调用方先锁当前 User，再进这里。
 * 表锁与作业完成使用的 SHARE ROW EXCLUSIVE 相同，缺行时也能和并发插入串行。
 */
export function createAnalyticsSettingsRepo() {
  return {
    readValue,
    async readRole(query: SettingsQuery, userId: string): Promise<string | null> {
      const rows = await query.$queryRaw<{ role: string | null }[]>`
        SELECT "role"::text AS "role" FROM "User" WHERE "id" = ${userId}
      `;
      const role = rows.length === 1 ? rows[0].role : null;
      return typeof role === 'string' && role.length > 0 ? role : null;
    },
    async lockRole(query: SettingsQuery, userId: string): Promise<string | null> {
      const rows = await query.$queryRaw<{ role: string | null }[]>`
        SELECT "role"::text AS "role" FROM "User" WHERE "id" = ${userId} FOR UPDATE
      `;
      const role = rows.length === 1 ? rows[0].role : null;
      return typeof role === 'string' && role.length > 0 ? role : null;
    },
    async lockSettingsValue(query: SettingsQuery): Promise<unknown | null> {
      await query.$executeRaw`LOCK TABLE "SiteSetting" IN SHARE ROW EXCLUSIVE MODE`;
      const rows = await query.$queryRaw<{ value: unknown }[]>`
        SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY} FOR UPDATE
      `;
      return rows.length === 0 ? null : rows[0].value;
    },
    async writeValue(query: SettingsQuery, key: string, value: unknown): Promise<void> {
      const json = JSON.stringify(value);
      await query.$executeRaw`
        INSERT INTO "SiteSetting" ("key", "value")
        VALUES (${key}, ${json}::jsonb)
        ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
      `;
    },
    async insertAudit(query: SettingsQuery, input: SettingsAuditWrite): Promise<void> {
      const meta = JSON.stringify(input.meta);
      await query.$executeRaw`
        INSERT INTO "AuditLog" ("id", "actorId", "action", "target", "meta", "ip", "createdAt")
        VALUES (
          ${input.id},
          ${input.actorId},
          ${input.action},
          ${input.target},
          ${meta}::jsonb,
          NULL,
          ${utc(input.at)}
        )
      `;
    },
  };
}

export type AnalyticsSettingsRepo = ReturnType<typeof createAnalyticsSettingsRepo>;
