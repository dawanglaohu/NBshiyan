import type { PrismaClient, Prisma, Role, User } from '@prisma/client';
import type { StatsSource } from '../../contracts/ops';
import { inquiryScope } from '../admin/inquiries';
import { AppError } from '../http/errors';
import { toStatsSourceDTO } from './source-dto';
import type { NonCoreSourceReader } from './stats-service';

/** 询盘与聊天的只读业务计数来源（E-62）。chat_notifications 属于投递状态，不在这里计数。 */
export const BUSINESS_SOURCES = ['inquiries', 'chat_conversations', 'chat_messages'] as const satisfies readonly StatsSource[];
export type BusinessSource = (typeof BUSINESS_SOURCES)[number];

export type BusinessDb = Pick<PrismaClient, '$transaction'>;

const READ_OPTIONS = { maxWait: 2_000, timeout: 5_000 } as const;

type BusinessRead = {
  role: Role;
  userId?: string;
  from: Date;
  toExclusive: Date;
  productSlug?: string;
};

type BusinessCounter = (tx: Prisma.TransactionClient, read: BusinessRead) => Promise<number>;

/**
 * 每个来源只数已持久化行的主键：Inquiry.id、ChatConversation.id、ChatMessage.id。
 * 同一 clientMessageId 的重试命中原行，被拒绝的垃圾提交没有行，所以都不增加计数。
 * 只返回整数，不选取 email、bodyText 或 message 等个人字段。
 */
const COUNTERS: Record<BusinessSource, BusinessCounter> = {
  inquiries: (tx, { role, userId, from, toExclusive, productSlug }) => tx.inquiry.count({
    where: {
      AND: [
        // 既有询盘 scope：ADMIN 不限，SALES 只数分配给自己的询盘；与 GET /api/admin/inquiries 同一函数。
        inquiryScope({ id: userId ?? '', role } as User),
        { createdAt: { gte: from, lt: toExclusive } },
        productSlug === undefined ? {} : { items: { some: { productSlug } } },
      ],
    },
  }),
  // 聊天没有按人分配的 scope：运营接口对 ADMIN 与 SALES 同样开放全部咨询（CHAT_OPERATOR_ROLES）。
  chat_conversations: (tx, { from, toExclusive, productSlug }) => tx.chatConversation.count({
    where: {
      createdAt: { gte: from, lt: toExclusive },
      ...(productSlug === undefined ? {} : { productSlug }),
    },
  }),
  chat_messages: (tx, { from, toExclusive, productSlug }) => tx.chatMessage.count({
    where: {
      createdAt: { gte: from, lt: toExclusive },
      ...(productSlug === undefined ? {} : { conversation: { productSlug } }),
    },
  }),
};

function readerFor(db: BusinessDb, source: BusinessSource): NonCoreSourceReader {
  return async ({ role, userId, scope, context, now }) => {
    // 查询前裁剪已经挡掉 EDITOR；这里再拒一次，防止适配器被别处直接调用。
    if (role !== 'ADMIN' && role !== 'SALES') throw new AppError('forbidden');

    const from = new Date(scope.startUtc);
    const toExclusive = new Date(scope.endUtc);
    if (from.getTime() > now.getTime()) {
      return toStatsSourceDTO(context, source);
    }
    try {
      // SALES 没有可用的用户标识时不退化成全站计数：按失败处理，不返回任何数字。
      if (role === 'SALES' && !userId) throw new Error('SALES scope requires a user id');
      const value = await db.$transaction(async (tx) => {
        // 只读事务：统计读取不可能写入、锁住或回滚询盘与聊天的保存。
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return COUNTERS[source](tx, { role, userId, from, toExclusive, productSlug: scope.productSlug });
      }, READ_OPTIONS);
      // 实时读取：数据覆盖到查询时刻；已经结束的日期窗口覆盖到窗口末。
      const dataThrough = new Date(Math.min(now.getTime(), toExclusive.getTime()));
      return toStatsSourceDTO(context, source, { value, coverage: 'full', dataThrough, lastSucceededAt: now });
    } catch {
      return toStatsSourceDTO(context, source, { unavailableState: 'query_failed' });
    }
  };
}

/** 询盘、聊天会话、聊天消息三个业务来源，供统计入口的非核心来源槽位注入。 */
export function createBusinessSourceReaders(db: BusinessDb): Record<BusinessSource, NonCoreSourceReader> {
  return {
    inquiries: readerFor(db, 'inquiries'),
    chat_conversations: readerFor(db, 'chat_conversations'),
    chat_messages: readerFor(db, 'chat_messages'),
  };
}
