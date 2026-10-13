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

type RetentionDb = {
  auditLog: { deleteMany(a: { where: { createdAt: { lt: Date } } }): Promise<{ count: number }> };
  sampleRequest: { updateMany(a: { where: { normalizedEmail: { not: null }; createdAt: { lt: Date } }; data: { normalizedEmail: null } }): Promise<{ count: number }> };
};

/** 删除超过 AUDIT_RETAIN_DAYS 的审计日志 */
export async function cleanupAuditLogs(db: RetentionDb, now = new Date()) {
  return (await db.auditLog.deleteMany({ where: { createdAt: { lt: daysAgo(retention.auditDays, now) } } })).count;
}
/**
 * 样品申请计数：数据库里“每邮箱 30 天 1 次”靠 SampleRequest.normalizedEmail，超过期限后清空。
 * 每 IP 计数在限流存储里（内存 / Upstash），带 TTL 自动过期，不需要这里处理。
 */
export async function clearSampleCounters(db: RetentionDb, now = new Date()) {
  return (await db.sampleRequest.updateMany({ where: { normalizedEmail: { not: null }, createdAt: { lt: daysAgo(retention.sampleCounterDays, now) } }, data: { normalizedEmail: null } })).count;
}
