import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { isDbUnavailable } from '@/lib/server/designs';
import { AppError } from '@/lib/server/http/errors';
import { verifySecret } from './crypto';
import { consumeTotpStep } from './login';
import { createAccountRepo, type AccountRepo } from './account-repo';
import type { ActionGrantService } from './action-grant';

export type LoginModeInput = {
  userId: string;
  sid: string;
  passwordlessEnabled: boolean;
  grantToken: string;
  ip?: string | null;
};

export type PasswordChangeInput = {
  userId: string;
  sid: string;
  newPasswordHash: string;
  /** 新密码明文只用于「不得等于当前密码」策略校验，不入库、不入日志。 */
  newPasswordPlain: string;
  /** grant 路径：PASSWORD actionGrant；legacy 路径：当前密码 + 未用 TOTP。二者互斥。 */
  grantToken?: string;
  currentPassword?: string;
  totp?: string;
  ip?: string | null;
};

export type AccountSecurityService = {
  changeLoginMode(input: LoginModeInput): Promise<{ changedAt: Date }>;
  changePassword(input: PasswordChangeInput): Promise<void>;
};

/**
 * 本人登录方式 / 密码的原子变更。
 * grant 的消费与最终动作在同一事务；非 grant 的兼容路径先做因子校验（consumeTotpStep 走独立连接，
 * 不能持 User 行锁再调，否则死锁），再进事务复核当前 sv 后提交。
 */
export function createAccountSecurityService(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  actionGrants: ActionGrantService;
  repo?: AccountRepo;
  verifyPassword?: (hash: string, plain: string) => Promise<boolean>;
}): AccountSecurityService {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const repo = deps.repo ?? createAccountRepo();
  const verifyPassword = deps.verifyPassword ?? verifySecret;

  async function changeLoginMode(input: LoginModeInput): Promise<{ changedAt: Date }> {
    const now = clock();
    try {
      return await db.$transaction(async (tx) => {
        // LOGIN_MODE 严格：PASSWORD / RECOVERY_AUTHORIZE 等 grant 的 purpose 不符，consume 返回 false。
        const consumed = await deps.actionGrants.consume({
          token: input.grantToken,
          purpose: 'LOGIN_MODE',
          targetId: null,
          userId: input.userId,
          sid: input.sid,
        }, tx);
        if (!consumed) throw new AppError('action_grant_invalid');

        const user = await repo.readCurrentUser(tx, input.userId);
        if (!user || user.disabled) throw new AppError('unauthorized');
        // E-07/E-08：启用无密码登录要求账号确有已验证的可用方式（已绑定且开启 TOTP）。
        // 否则 totp 模式不可用，这次切换不产生可用方式，拒绝且状态不变。
        if (input.passwordlessEnabled && (!user.totpEnabled || !user.totpSecret)) {
          throw new AppError('version_conflict', { fieldErrors: { passwordlessEnabled: 'No verified authenticator is bound.' } });
        }
        // 关闭无密码后密码方式（password+TOTP）仍在，不会失去所有可用方式。
        const updated = await repo.applySensitiveChange(tx, user.id, user.sessionVersion, {
          passwordlessEnabled: input.passwordlessEnabled,
        });
        if (updated !== 1) throw new AppError('version_conflict');
        const newVersion = user.sessionVersion + 1;
        await repo.revokeDevices(tx, user.id, newVersion, 'login_mode_change', now);
        await repo.createAudit(tx, {
          actorId: user.id,
          action: 'account.mode_change',
          target: user.id,
          meta: { passwordlessEnabled: input.passwordlessEnabled },
          ip: input.ip || 'unknown',
        });
        return { changedAt: now };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
  }

  async function changePassword(input: PasswordChangeInput): Promise<void> {
    const now = clock();
    // legacy 兼容路径：因子校验必须在事务外完成（consumeTotpStep 走独立连接）。
    // 非空 recoveryCode 已在 Zod strict 层拒绝；这里只接 currentPassword+totp。
    if (!input.grantToken) {
      const user = await db.user.findUnique({ where: { id: input.userId } });
      if (!user || user.disabled) throw new AppError('unauthorized');
      if (!(await verifyPassword(user.passwordHash, input.currentPassword ?? ''))) throw new AppError('bad_credentials');
      if (!(await consumeTotpStep(user, input.totp))) throw new AppError('bad_credentials');
    }
    try {
      await db.$transaction(async (tx) => {
        if (input.grantToken) {
          // PASSWORD 严格：用 LOGIN_MODE 等其它 purpose 的 grant 改密码一律拒绝（E-73）。
          const consumed = await deps.actionGrants.consume({
            token: input.grantToken,
            purpose: 'PASSWORD',
            targetId: null,
            userId: input.userId,
            sid: input.sid,
          }, tx);
          if (!consumed) throw new AppError('action_grant_invalid');
        }
        // 最终事务重查当前账号与 sv：旧 sv / 撤销设备 / 过期授权都不提交。
        const user = await repo.readCurrentUser(tx, input.userId);
        if (!user || user.disabled) throw new AppError('unauthorized');
        if (await verifyPassword(user.passwordHash, input.newPasswordPlain)) {
          throw new AppError('invalid', { fieldErrors: { newPassword: 'Choose a different password.' } });
        }
        const updated = await repo.applySensitiveChange(tx, user.id, user.sessionVersion, {
          passwordHash: input.newPasswordHash,
        });
        if (updated !== 1) throw new AppError('version_conflict');
        const newVersion = user.sessionVersion + 1;
        await repo.revokeDevices(tx, user.id, newVersion, 'password_change', now);
        await repo.createAudit(tx, {
          actorId: user.id,
          action: 'account.password_change',
          target: user.id,
          meta: input.grantToken ? { method: 'action_grant' } : { method: 'legacy_credentials' },
          ip: input.ip || 'unknown',
        });
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
  }

  return { changeLoginMode, changePassword };
}
