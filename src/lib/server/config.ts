import { z } from 'zod';
import { isProdEnvFrom } from '../site';

/** 普通会话 2h 滑动。记住设备 7d 闲置、签发后 30d 绝对。真实活动 15min 才续一次。 */
export const ADMIN_SESSION_POLICY = {
  idleMs: 2 * 60 * 60 * 1000,
  rememberedIdleMs: 7 * 24 * 60 * 60 * 1000,
  absoluteMs: 30 * 24 * 60 * 60 * 1000,
  activityThrottleMs: 15 * 60 * 1000,
} as const;

/** 单用途 grant 5min，目标恢复 permit 15min，受限重绑会话 10min。 */
export const ADMIN_GRANT_POLICY = {
  ttlMs: 5 * 60 * 1000,
  permitTtlMs: 15 * 60 * 1000,
  restrictedTtlMs: 10 * 60 * 1000,
} as const;

const DurationMsSchema = z.number().int().positive();

const ServerPolicySchema = z.object({
  session: z.object({
    idleMs: DurationMsSchema,
    rememberedIdleMs: DurationMsSchema,
    absoluteMs: DurationMsSchema,
    activityThrottleMs: DurationMsSchema,
  }).strict(),
  grant: z.object({
    ttlMs: DurationMsSchema,
    permitTtlMs: DurationMsSchema,
    restrictedTtlMs: DurationMsSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.session.activityThrottleMs >= value.session.idleMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['session', 'activityThrottleMs'] });
  }
  if (value.session.idleMs >= value.session.rememberedIdleMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['session', 'rememberedIdleMs'] });
  }
  if (value.session.rememberedIdleMs >= value.session.absoluteMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['session', 'absoluteMs'] });
  }
});

export type ServerPolicy = z.infer<typeof ServerPolicySchema>;

export type ServerConfig = ServerPolicy & { readonly production: boolean };

const DEFAULT_POLICY = {
  session: ADMIN_SESSION_POLICY,
  grant: ADMIN_GRANT_POLICY,
} as const;

const PRODUCTION_SECRET_NAMES = [
  'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL', 'APP_ORIGIN',
  'ADMIN_TOTP_KEY', 'PRIVACY_HASH_SECRET', 'CRON_SECRET',
] as const;

export class ServerConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'ServerConfigError';
    this.problems = problems;
  }
}

function issueText(issue: z.ZodIssue): string {
  const path = issue.path.filter((part) => typeof part === 'string' || typeof part === 'number').join('.');
  const name = path || 'server config';
  if (issue.code === 'invalid_type' && issue.received === 'undefined') return `${name} 未设置`;
  return `${name} 无效`;
}

function problemsFromUnknown(error: unknown): string[] {
  if (error instanceof z.ZodError) return error.issues.map(issueText);
  return ['server config rejected'];
}

/** 校验调用方给出的策略对象。缺字段或非法期限拒绝，错误文本不含原始异常和输入值。 */
export function parseServerPolicy(input: unknown): ServerPolicy {
  try {
    const parsed = ServerPolicySchema.safeParse(input);
    if (!parsed.success) throw new ServerConfigError(problemsFromUnknown(parsed.error));
    return deepFreeze(parsed.data);
  } catch (error) {
    if (error instanceof ServerConfigError) throw error;
    throw new ServerConfigError(problemsFromUnknown(error));
  }
}

export function policyConfigProblems(): string[] {
  const parsed = ServerPolicySchema.safeParse(DEFAULT_POLICY);
  return parsed.success ? [] : problemsFromUnknown(parsed.error);
}

function productionSecurityProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const name of PRODUCTION_SECRET_NAMES) {
    if (!env[name]?.trim()) problems.push(`${name} 未设置`);
  }
  const totp = env.ADMIN_TOTP_KEY?.trim();
  if (totp && Buffer.from(totp, 'base64').length !== 32) problems.push('ADMIN_TOTP_KEY 必须是 base64 解码后 32 字节');
  const privacy = env.PRIVACY_HASH_SECRET;
  if (privacy && Buffer.byteLength(privacy) < 32) problems.push('PRIVACY_HASH_SECRET 至少 32 字节');
  const cron = env.CRON_SECRET;
  if (cron && cron.length < 32) problems.push('CRON_SECRET 至少 32 个字符');
  return problems;
}

/** 非生产只冻结内置策略。生产再核对本轮要交给新代码的既有秘密，缺必需值拒绝。 */
export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  try {
    const policy = parseServerPolicy(DEFAULT_POLICY);
    if (isProdEnvFrom(env)) {
      const problems = productionSecurityProblems(env);
      if (problems.length) throw new ServerConfigError(problems);
    }
    return deepFreeze({ ...policy, production: isProdEnvFrom(env) });
  } catch (error) {
    if (error instanceof ServerConfigError) throw error;
    throw new ServerConfigError(problemsFromUnknown(error));
  }
}

let frozen: ServerConfig | undefined;

/** 进程内只解析一次。改环境后要重启，不能热改已经冻结的策略。 */
export function freezeServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  if (!frozen) frozen = loadServerConfig(env);
  return frozen;
}

export function getServerConfig(): ServerConfig {
  return freezeServerConfig();
}

export function serverConfigFailureText(error: unknown): string {
  const problems = error instanceof ServerConfigError ? error.problems : ['server config rejected'];
  return `生产环境配置检查未通过，拒绝启动：\n- ${problems.join('\n- ')}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * 分析同意 cookie 的根密钥。同意服务再用固定标签派生 MAC 和 browserHash，避免和邮箱哈希互通。
 * 生产已经要求 PRIVACY_HASH_SECRET 至少 32 字节，这里不另增变量，也不在缺省时使用开发回退密钥。
 * 冻结的 ServerConfig 不复制这个值。
 */
export function analyticsConsentSecret(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.PRIVACY_HASH_SECRET;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) < 32) return null;
  return Buffer.from(raw, 'utf8');
}
