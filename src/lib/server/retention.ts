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
 * 每个清理步骤的时间预算（毫秒）：超过后不再开始新批次，剩下的留给下次 cron。
 * 默认 40s：6 个步骤最坏 6×40s + 每步最多再跑完一批，仍在持锁事务 290s / maxDuration 300s 之内。
 * 平台上限更低时（例如未开 Fluid compute 的 Hobby 为 60s）要调小，见 launch-runbook.md。
 */
export const stepBudgetMs = () => intEnv('RETENTION_STEP_BUDGET_MS', 40_000, 1_000, 280_000);

/**
 * 分批执行：每次取一批 id（≤ BATCH_SIZE），按 id 删除/更新，直到取完、达到本次运行上限或用完本步骤时间预算。
 * 没处理完的留给下次 cron。
 */
export async function inBatches(fetchIds: (take: number) => Promise<string[]>, apply: (ids: string[]) => Promise<number>, cap = maxPerRun(), budgetMs = stepBudgetMs(), clock: () => number = Date.now) {
  let total = 0;
  const deadline = clock() + budgetMs;
  while (total < cap && clock() < deadline) {
    const ids = await fetchIds(Math.min(BATCH_SIZE, cap - total));
    if (!ids.length) break;
    total += await apply(ids);
    if (ids.length < BATCH_SIZE) break;
  }
  return total;
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
export async function cleanupAuditLogs(db: RetentionDb, now = new Date(), cap = maxPerRun()) {
  const where = auditLogsWhere(now);
  return inBatches(
    async (take) => (await db.auditLog.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' }, take })).map((r) => r.id),
    async (ids) => (await db.auditLog.deleteMany({ where: { id: { in: ids } } })).count, cap);
}
/**
 * 样品申请计数：数据库里“每邮箱 30 天 1 次”靠 SampleRequest.normalizedEmail，超过期限后清空（分批）。
 * 每 IP 计数在限流存储里（内存 / Upstash），带 TTL 自动过期，不需要这里处理。
 */
export const sampleCountersWhere = (now = new Date()) => ({ normalizedEmail: { not: null }, createdAt: { lt: daysAgo(retention.sampleCounterDays, now) } } as const);
export async function clearSampleCounters(db: RetentionDb, now = new Date(), cap = maxPerRun()) {
  const where = sampleCountersWhere(now);
  return inBatches(
    async (take) => (await db.sampleRequest.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' }, take })).map((r) => r.id),
    async (ids) => (await db.sampleRequest.updateMany({ where: { id: { in: ids } }, data: { normalizedEmail: null } })).count, cap);
}
