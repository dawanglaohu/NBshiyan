/**
 * 数据保留期限（天）。都可用环境变量覆盖，超出范围时用默认值。说明见 docs/data-retention.md。
 * 注意：最终期限需与隐私政策对齐（待 Ryan 确认）。
 */
function intEnv(name: string, def: number, min: number, max: number) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

export const retention = {
  /** 方案短链接有效期 */
  get designTtlDays() { return intEnv('DESIGN_TTL_DAYS', 180, 1, 3650); },
  /** 方案过期后再保留多久（期间返回 410），之后删除 */
  get designGraceDays() { return intEnv('DESIGN_GRACE_DAYS', 90, 0, 3650); },
  /** 后台审计日志 */
  get auditDays() { return intEnv('AUDIT_RETAIN_DAYS', 365, 30, 3650); },
  /** 样品申请“每邮箱 30 天 1 次”用的规范化邮箱，超过后清空 */
  get sampleCounterDays() { return intEnv('SAMPLE_COUNTER_RETAIN_DAYS', 30, 30, 365); },
  /** 询盘 retainUntil（新询盘写入时计算） */
  get inquiryDays() { return intEnv('INQUIRY_RETAIN_DAYS', 730, 30, 3650); },
};

const DAY = 86_400_000;
export const daysAgo = (days: number, now = new Date()) => new Date(now.getTime() - days * DAY);

/** 每批处理条数和每次运行的总上限（避免首次运行或积压时一次性大删除导致超时/长时间锁表） */
export const BATCH_SIZE = 500;
export const maxPerRun = () => intEnv('RETENTION_MAX_PER_RUN', 20_000, BATCH_SIZE, 1_000_000);

/**
 * 整次清理共用一个截止时间（毫秒，从路由开始执行算起）：默认 270000（270s），范围 10000–280000，
 * 始终小于持锁事务超时 290s（LOCK_TX_TIMEOUT_MS）。路由开始时只算一次 deadline = start + 预算，传给每个步骤。
 * 步骤在每批开始前检查：已过截止时间就不再开始新批次（正在跑的那一批会跑完）；还没开始的步骤直接跳过并在结果里报告。
 * 旧变量 RETENTION_STEP_BUDGET_MS 已废弃，不再读取。
 */
export const runDeadlineMs = () => intEnv('RETENTION_RUN_DEADLINE_MS', 270_000, 10_000, 280_000);
export const NO_DEADLINE = Number.POSITIVE_INFINITY;

/**
 * 分批执行：每次取一批 id（≤ BATCH_SIZE），按 id 删除/更新，直到取完、达到本次运行上限或到了截止时间（deadline，绝对时间戳 ms）。
 * 截止时间只在每批开始前检查。没处理完的留给下次 cron。
 */
export async function inBatches(fetchIds: (take: number) => Promise<string[]>, apply: (ids: string[]) => Promise<number>, cap = maxPerRun(), deadline = NO_DEADLINE, clock: () => number = Date.now) {
  let total = 0;
  while (total < cap && clock() < deadline) {
    const ids = await fetchIds(Math.min(BATCH_SIZE, cap - total));
    if (!ids.length) break;
    total += await apply(ids);
    if (ids.length < BATCH_SIZE) break;
  }
  return total;
}

export type StepSummary = { result: Record<string, number>; failed: string[]; skipped: string[]; deadlineReached: boolean };
/**
 * 按顺序跑清理步骤，所有步骤共用同一个 deadline。到截止时间后还没开始的步骤跳过（skipped），
 * 每个步骤独立 try/catch，失败交给 onError，其余照常跑。deadlineReached：结束时已过截止时间（可能有步骤没跑完或被跳过）。
 */
export async function runCleanupSteps(steps: [string, (deadline: number) => Promise<number>][], deadline: number, onError: (name: string, e: unknown) => Promise<void>, clock: () => number = Date.now): Promise<StepSummary> {
  const s: StepSummary = { result: {}, failed: [], skipped: [], deadlineReached: false };
  for (const [name, run] of steps) {
    if (clock() >= deadline) { s.skipped.push(name); continue; }
    try { s.result[name] = await run(deadline); } catch (e) { s.failed.push(name); await onError(name, e); }
  }
  s.deadlineReached = clock() >= deadline;
  return s;
}

type IdRows = Promise<{ id: string }[]>;
type RetentionDb = {
  auditLog: {
    findMany(a: { where: { createdAt: { lt: Date } }; select: { id: true }; orderBy: { createdAt: 'asc' }; take: number }): IdRows;
    deleteMany(a: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
  sampleRequest: {
    findMany(a: { where: { normalizedEmail: { not: null }; createdAt: { lt: Date } }; select: { id: true }; orderBy: { createdAt: 'asc' }; take: number }): IdRows;
    updateMany(a: { where: { id: { in: string[] } }; data: { normalizedEmail: null } }): Promise<{ count: number }>;
  };
};

/** 删除超过 AUDIT_RETAIN_DAYS 的审计日志（分批） */
export const auditLogsWhere = (now = new Date()) => ({ createdAt: { lt: daysAgo(retention.auditDays, now) } });
export async function cleanupAuditLogs(db: RetentionDb, now = new Date(), cap = maxPerRun(), deadline = NO_DEADLINE) {
  const where = auditLogsWhere(now);
  return inBatches(
    async (take) => (await db.auditLog.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' }, take })).map((r) => r.id),
    async (ids) => (await db.auditLog.deleteMany({ where: { id: { in: ids } } })).count, cap, deadline);
}
/**
 * 样品申请计数：数据库里“每邮箱 30 天 1 次”靠 SampleRequest.normalizedEmail，超过期限后清空（分批）。
 * 每 IP 计数在限流存储里（内存 / Upstash），带 TTL 自动过期，不需要这里处理。
 */
export const sampleCountersWhere = (now = new Date()) => ({ normalizedEmail: { not: null }, createdAt: { lt: daysAgo(retention.sampleCounterDays, now) } } as const);
export async function clearSampleCounters(db: RetentionDb, now = new Date(), cap = maxPerRun(), deadline = NO_DEADLINE) {
  const where = sampleCountersWhere(now);
  return inBatches(
    async (take) => (await db.sampleRequest.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' }, take })).map((r) => r.id),
    async (ids) => (await db.sampleRequest.updateMany({ where: { id: { in: ids } }, data: { normalizedEmail: null } })).count, cap, deadline);
}
