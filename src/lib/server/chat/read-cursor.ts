/**
 * 访客消息页与读位置的纯规则（无 IO、无时钟、无 Prisma）。
 *
 * 依据 10 节:78：afterSeq / lastReadSeq / lastSeq 为非负整数且 ≤ 2147483647，messages 按 seq 升序，
 * 读游标不得超过服务端 lastSeq；09 节：读标记只允许前进到已存在的 seq（MAX），不能回退或越过 lastSeq。
 * 分页只推进到已完整接收的连续范围（E-34 / E-77 / E-79）。
 */

/** 10 节:78 的序列上限。 */
export const CHAT_SEQ_MAX = 2_147_483_647;

/** 数据层发现会话的 seq 不连续：宁可失败也不跳过缺号或谎报已收齐。 */
export class ChatSequenceGap extends Error {
  constructor() {
    super('chat_sequence_gap');
    this.name = 'ChatSequenceGap';
  }
}

function assertSeq(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > CHAT_SEQ_MAX) throw new Error(`chat seq ${label}`);
  return value;
}

/** 请求的 afterSeq 可能落在 lastSeq 之后（旧响应、回滚后的游标）；分页从 min(afterSeq,lastSeq) 起算。 */
export function pageStartSeq(afterSeq: number, lastSeq: number): number {
  assertSeq(afterSeq, 'afterSeq');
  assertSeq(lastSeq, 'lastSeq');
  return Math.min(afterSeq, lastSeq);
}

/**
 * read 采用 MAX：取「已记录」与「本次请求」的较大者，再夹到 [0, lastSeq]。
 * 因此乱序或重试不会回退读位置，请求越过 lastSeq 只推进到服务端已存在的最大 seq，
 * 新到且 seq 更大的消息仍保持未读。
 */
export function nextVisitorReadSeq(current: number, requested: number, lastSeq: number): number {
  assertSeq(current, 'current');
  assertSeq(requested, 'requested');
  assertSeq(lastSeq, 'lastSeq');
  return Math.min(Math.max(current, Math.min(requested, lastSeq)), lastSeq);
}

export type SeqMessage = { seq: number };

/**
 * 只取从 afterSeq+1 开始连续的一段。遇到缺号（或 seq 超过 lastSeq）立即截断，游标停在已完整接收的范围，
 * 不越过缺号去返回后面的消息；下一页由调用方按 nextAfterSeq 补齐。
 */
export function consecutivePage<T extends SeqMessage>(
  rows: readonly T[],
  afterSeq: number,
  lastSeq: number,
): { messages: T[]; nextAfterSeq: number; hasMore: boolean } {
  assertSeq(afterSeq, 'afterSeq');
  assertSeq(lastSeq, 'lastSeq');
  const messages: T[] = [];
  let expected = afterSeq + 1;
  for (const row of rows) {
    if (row.seq !== expected || row.seq > lastSeq) break;
    messages.push(row);
    expected += 1;
  }
  const nextAfterSeq = messages.length > 0 ? messages[messages.length - 1]!.seq : Math.min(afterSeq, lastSeq);
  return { messages, nextAfterSeq, hasMore: nextAfterSeq < lastSeq };
}
