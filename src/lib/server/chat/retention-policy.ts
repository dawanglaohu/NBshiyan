import {
  CHAT_RETENTION_POLICY,
  CHAT_RETENTION_POLICY_VERSION,
  CHAT_VISITOR_POLICY,
  type ChatRetentionPolicy,
  type ChatVisitorPolicy,
} from '../config';
import { AppError } from '../http/errors';

/** 聊天保留作业在固定 registry 里的 key（与 src/lib/server/jobs/registry.ts 一致，避免纯策略模块引入运行时注册表/DB）。 */
export { CHAT_RETENTION_JOB_KEY } from '../config';

export {
  CHAT_RETENTION_POLICY,
  CHAT_RETENTION_POLICY_VERSION,
  type ChatRetentionPolicy,
};

/**
 * 明确拒绝充当聊天生产清理授权的非授权来源（E-88）：
 * 文档、任务派发、模型输出、代理结论及既有分析/旧清理环境变量开关均不能授予聊天删除权限。
 */
export const NON_AUTHORITATIVE_CHAT_RETENTION_SOURCES = [
  'docs',
  'documentation',
  'task_dispatch',
  'dispatch',
  'model',
  'agent',
  'prompt',
  'retention_cleanup_mode',
] as const;

export type ChatRetentionMode = 'dry-run' | 'delete';

export type ChatRetentionGateReason =
  | 'dry_run_default'
  | 'policy_cleanup_disabled'
  | 'authorization_missing'
  | 'policy_version_mismatch'
  | 'non_authoritative_source_rejected'
  | 'authorized';

export type ChatRetentionGateDecision = {
  /** 本轮实际执行模式；未同时满足开关与明确授权时强制落回 dry-run。 */
  mode: ChatRetentionMode;
  dryRun: boolean;
  requestedDelete: boolean;
  cleanupEnabled: boolean;
  authorized: boolean;
  /** 请求了真实删除但被授权门禁拒绝（deletedCount 必须保持 0）。 */
  rejected: boolean;
  reason: ChatRetentionGateReason;
  policyVersion: number;
};

/**
 * 纯授权门禁（E-88）：
 * 1) 缺省或任何非字面 `false` 的 dryRun 一律视作 dry-run；
 * 2) 仅当请求明确 `dryRun: false`、策略 `cleanupEnabled === true`、容器显式授予
 *    `deleteAuthorized === true`、策略版本匹配（若指定），且来源不属于文档/派发/模型/代理/旧开关时
 *    才判定为 `delete`，否则一律拒绝真实删除。
 */
export function evaluateChatRetentionGate(input: {
  dryRun?: boolean;
  deleteAuthorized?: boolean;
  policy?: ChatRetentionPolicy;
  expectedPolicyVersion?: number;
  authorizationSource?: string;
} = {}): ChatRetentionGateDecision {
  const policy = input.policy ?? CHAT_RETENTION_POLICY;
  const requestedDelete = input.dryRun === false;

  if (!requestedDelete) {
    return {
      mode: 'dry-run',
      dryRun: true,
      requestedDelete: false,
      cleanupEnabled: policy.cleanupEnabled,
      authorized: false,
      rejected: false,
      reason: 'dry_run_default',
      policyVersion: policy.policyVersion,
    };
  }

  if (input.expectedPolicyVersion !== undefined && input.expectedPolicyVersion !== policy.policyVersion) {
    return {
      mode: 'dry-run',
      dryRun: true,
      requestedDelete: true,
      cleanupEnabled: policy.cleanupEnabled,
      authorized: false,
      rejected: true,
      reason: 'policy_version_mismatch',
      policyVersion: policy.policyVersion,
    };
  }

  const source = typeof input.authorizationSource === 'string'
    ? input.authorizationSource.trim().toLowerCase()
    : null;
  if (source !== null && (NON_AUTHORITATIVE_CHAT_RETENTION_SOURCES as readonly string[]).includes(source)) {
    return {
      mode: 'dry-run',
      dryRun: true,
      requestedDelete: true,
      cleanupEnabled: policy.cleanupEnabled,
      authorized: false,
      rejected: true,
      reason: 'non_authoritative_source_rejected',
      policyVersion: policy.policyVersion,
    };
  }

  if (policy.cleanupEnabled !== true) {
    return {
      mode: 'dry-run',
      dryRun: true,
      requestedDelete: true,
      cleanupEnabled: false,
      authorized: false,
      rejected: true,
      reason: 'policy_cleanup_disabled',
      policyVersion: policy.policyVersion,
    };
  }

  if (input.deleteAuthorized !== true) {
    return {
      mode: 'dry-run',
      dryRun: true,
      requestedDelete: true,
      cleanupEnabled: true,
      authorized: false,
      rejected: true,
      reason: 'authorization_missing',
      policyVersion: policy.policyVersion,
    };
  }

  return {
    mode: 'delete',
    dryRun: false,
    requestedDelete: true,
    cleanupEnabled: true,
    authorized: true,
    rejected: false,
    reason: 'authorized',
    policyVersion: policy.policyVersion,
  };
}

/** 未通过授权门禁时显式抛出领域拒绝错误，阻断任何真实清理分支。 */
export function assertChatRetentionDeleteAuthorized(decision: ChatRetentionGateDecision): void {
  if (decision.mode !== 'delete' || !decision.authorized || decision.rejected) {
    throw new AppError('forbidden');
  }
}

export function assertRetentionInstant(instant: Date): Date {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new Error('invalid_instant');
  }
  return instant;
}

/** 90 天内容保留上界：最后成功消息活动时间 <= 此瞬时时达到 90 天（与 retainUntil <= now 等价）。 */
export function chatContentExpiryCutoff(
  now: Date,
  policy: Pick<ChatRetentionPolicy, 'retainMs'> = CHAT_RETENTION_POLICY,
): Date {
  return new Date(assertRetentionInstant(now).getTime() - policy.retainMs);
}

/** 访客必要 cookie 7 天闲置上界：lastActivityAt <= 此瞬时时达到闲置过期（等号即过期）。 */
export function visitorIdleExpiryCutoff(
  now: Date,
  visitorPolicy: Pick<ChatVisitorPolicy, 'idleMs'> = CHAT_VISITOR_POLICY,
): Date {
  return new Date(assertRetentionInstant(now).getTime() - visitorPolicy.idleMs);
}

/** 咨询是否满足 90 天保留到期条件：未匿名化且 retainUntil <= now（等号即到期）。 */
export function isChatConversationExpired(
  conversation: { retainUntil: Date; anonymizedAt: Date | null },
  now: Date,
): boolean {
  if (conversation.anonymizedAt !== null) return false;
  return assertRetentionInstant(conversation.retainUntil).getTime() <= assertRetentionInstant(now).getTime();
}
