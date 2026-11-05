import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ADMIN_GRANT_POLICY } from '@/lib/server/config';
import { createRecoveryRepo, hashRecoveryPermitToken } from './recovery-repo';

/**
 * 服务器所有者本地恢复预授权（M3-T18）。
 *
 * 与 `recovery-authorizations.ts` 的 ADMIN 路径共用同一个 `RecoveryRepo`：
 * permit 的落库形状、审计字段、到期语义只有一套，避免本地 CLI 与 HTTP 两条路各自漂移。
 *
 * 三条硬约束（09/10 节、E-12、E-75）：
 * 1. 只在服务器操作系统管理权限 + 交互式终端下签发；任一不满足都在**开事务之前**拒绝，不落库。
 * 2. 只签发 permit，**不改目标账号任何认证因素**（passwordHash / totpSecret / recoveryCodes / sessionVersion 原样）。
 * 3. 可选改密只写 `pendingPasswordHash`（已按既有 Argon 参数哈希过），由 M3-T19 核销时转入受限会话；
 *    HTTP 层永不写该字段。
 */

/** permit 有效期与 HTTP 的 ADMIN 路径同源，测试断言两者相等。 */
export const OWNER_PERMIT_TTL_MS = ADMIN_GRANT_POLICY.permitTtlMs;

/** 与既有脚本一致的退出码语义：0 成功；1 运行错误；2 参数/终端错误；3 账号或权限拒绝。 */
export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 } as const;

export type OwnerRecoveryErrorCode =
  | 'not_os_owner'
  | 'not_tty'
  | 'ambiguous_target'
  | 'no_target'
  | 'invalid_reason'
  | 'role_mismatch'
  | 'password_mismatch'
  | 'not_found'
  | 'target_disabled'
  | 'not_admin'
  | 'db_error';

/** 面向运维的固定文案：不含凭据、哈希、密钥或邮箱明文。 */
export const MESSAGES: Record<OwnerRecoveryErrorCode, string> = {
  not_os_owner:
    '当前进程不具备服务器操作系统管理权限，拒绝签发恢复凭据。请在服务器本机以系统管理员身份运行。',
  not_tty:
    '标准输入或标准输出不是终端，拒绝运行：凭据不能落进文件、管道或日志。请用交互式终端（docker compose exec -it）。',
  ambiguous_target: '--email 与 --id 只能给一个。',
  no_target: '必须用 --email 或 --id 明确指定目标账号，不接受模糊匹配。',
  invalid_reason: '必须用 --reason 说明本次恢复原因（写入审计，不含凭据）。',
  role_mismatch: '--role 与目标账号当前角色不一致，拒绝签发：不允许借本地恢复越权改角色。',
  password_mismatch: '两次输入的密码不一致。',
  not_found: '没有找到这个账号，未做任何修改。',
  target_disabled: '目标账号已停用，未做任何修改。',
  not_admin: '目标账号不是 ADMIN 角色，本命令只用于后台账号的本地恢复。',
  db_error: '数据库操作失败（详细原因未输出，以免带出敏感信息）。',
};

const EXIT_OF: Partial<Record<OwnerRecoveryErrorCode, number>> = {
  not_os_owner: EXIT.refused,
  not_tty: EXIT.usage,
  ambiguous_target: EXIT.usage,
  no_target: EXIT.usage,
  invalid_reason: EXIT.usage,
  role_mismatch: EXIT.refused,
  password_mismatch: EXIT.error,
  not_found: EXIT.refused,
  target_disabled: EXIT.refused,
  not_admin: EXIT.refused,
};

export function exitCodeOf(code: OwnerRecoveryErrorCode): number {
  return EXIT_OF[code] ?? EXIT.error;
}

export type OwnerRecoveryTarget = {
  id: string;
  role: string;
  disabled: boolean;
  totpEnabled: boolean;
  sessionVersion: number;
};

export type OwnerPreflightInput = {
  isOsOwner: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  hasEmail: boolean;
  hasId: boolean;
  reason: string | undefined;
};

/**
 * 落库前的准入判定。任何一项不满足都在**开事务之前**返回，因此不产生任何行、不写审计。
 * 顺序刻意固定，便于测试逐项断言：权限 → 终端 → 目标唯一 → 原因。
 */
export function decidePreflight(
  input: OwnerPreflightInput,
): { ok: true; reason: string } | { ok: false; code: OwnerRecoveryErrorCode } {
  if (!input.isOsOwner) return { ok: false, code: 'not_os_owner' };
  if (!input.stdinIsTTY || !input.stdoutIsTTY) return { ok: false, code: 'not_tty' };
  if (input.hasEmail && input.hasId) return { ok: false, code: 'ambiguous_target' };
  if (!input.hasEmail && !input.hasId) return { ok: false, code: 'no_target' };
  const reason = (input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'invalid_reason' };
  return { ok: true, reason };
}

/**
 * 目标账号校验。**只读**。
 *
 * E-12 的隔离场景正是本命令存在的理由：目标可以没有 TOTP、没有恢复码、也没有第二管理员，
 * 所以这里**不要求** totpEnabled，只要求存在、未停用、角色为 ADMIN；
 * 若显式传了 --role，必须与库中当前角色一致，否则拒绝（防止借恢复提权）。
 */
export function decideTarget(
  target: OwnerRecoveryTarget | undefined,
  declaredRole?: string,
): { ok: true } | { ok: false; code: OwnerRecoveryErrorCode } {
  if (!target) return { ok: false, code: 'not_found' };
  if (target.disabled) return { ok: false, code: 'target_disabled' };
  if (target.role !== 'ADMIN') return { ok: false, code: 'not_admin' };
  if (declaredRole !== undefined && declaredRole !== target.role) return { ok: false, code: 'role_mismatch' };
  return { ok: true };
}

export function newOwnerPermitToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newOwnerPermitId(): string {
  return randomBytes(16).toString('hex');
}

export type IssueOwnerPermitInput = {
  targetUserId: string;
  reason: string;
  /** 已按既有 Argon 参数哈希过的待生效密码；纯预授权（不改密）时为 null。 */
  pendingPasswordHash: string | null;
};

export type IssuedOwnerPermit = { token: string; expiresAt: Date };

export type OwnerRecoveryService = {
  issue(input: IssueOwnerPermitInput): Promise<IssuedOwnerPermit>;
};

/**
 * 签发 SERVER_OWNER 预授权 permit。
 *
 * 与 ADMIN 路径的差别：不发 actionGrant（没有第二个管理员可授权）、`issuedById` 为 null
 * （actor 是操作系统所有者，不是某个 User 行），`source` 固定 SERVER_OWNER。
 * 相同之处：读目标当前 sessionVersion 绑定、写审计、明文只返回一次。
 */
export function createOwnerRecoveryService(deps: {
  db: { $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };
  clock?: () => Date;
  permitTtlMs?: number;
  repo?: ReturnType<typeof createRecoveryRepo>;
}): OwnerRecoveryService {
  const clock = deps.clock ?? (() => new Date());
  const permitTtlMs = deps.permitTtlMs ?? OWNER_PERMIT_TTL_MS;
  const repo = deps.repo ?? createRecoveryRepo();

  async function issue(input: IssueOwnerPermitInput): Promise<IssuedOwnerPermit> {
    const now = clock();
    const token = newOwnerPermitToken();
    const tokenHash = hashRecoveryPermitToken(token);
    const expiresAt = new Date(now.getTime() + permitTtlMs);
    const actor = `SERVER_OWNER:${process.env.USER ?? process.env.USERNAME ?? 'unknown'}`;

    await deps.db.$transaction(async (tx) => {
      // 本地恢复需要 role 才能判断目标是否为 ADMIN，而 readTargetUser 是 ADMIN 路径的
      // 共用查询、不返回 role（那条路的角色校验在 readActorRole）。这里单独读一次，
      // 不改共用查询的形状，避免影响 M3-T4/M3-T19 已验收的行为。
      const target = await repo.readOwnerTarget(tx, input.targetUserId);
      const verdict = decideTarget(target);
      if (!verdict.ok) throw new OwnerRecoveryRefusal(verdict.code);

      await repo.createPermit(tx, {
        id: newOwnerPermitId(),
        tokenHash,
        targetUserId: target!.id,
        source: 'SERVER_OWNER',
        issuedById: null,
        reason: input.reason,
        pendingPasswordHash: input.pendingPasswordHash,
        sessionVersion: target!.sessionVersion,
        createdAt: now,
        expiresAt,
      });

      // 审计只记 actor/target/source/time/reason，凭据与哈希一律不进。
      await repo.createAudit(tx, {
        actorId: null,
        action: 'recovery.issued',
        target: target!.id,
        meta: {
          source: 'SERVER_OWNER',
          reason: input.reason,
          time: now.toISOString(),
          actor,
          passwordReset: input.pendingPasswordHash !== null,
        },
        ip: 'local-cli',
      });
    });

    return { token, expiresAt };
  }

  return { issue };
}

/** 事务内的拒绝：由 CLI 层映射成固定文案与退出码，不向调用方抛数据库细节。 */
export class OwnerRecoveryRefusal extends Error {
  constructor(readonly code: OwnerRecoveryErrorCode) {
    super(code);
    this.name = 'OwnerRecoveryRefusal';
  }
}

/** 凭据块：只含凭据与到期时刻，不含账号信息；调用方只打印一次。 */
export function permitLines(token: string, expiresAt: Date): string[] {
  return [
    `一次性恢复凭据（只显示这一次）：${token}`,
    `有效至：${expiresAt.toISOString()}（15 分钟内、单次使用）`,
    '该凭据不会写入日志或审计。若已泄露，请重新运行本命令签发新凭据。',
  ];
}
