import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ADMIN_GRANT_POLICY } from '@/lib/server/config';
import { prisma } from '@/lib/server/db';
import { AppError } from '@/lib/server/http/errors';
import { hashRecoverySessionToken, createRecoveryRepo, type RecoveryRepo } from './recovery-repo';
import type { ActionGrantService } from './action-grant';

/** 10 节:20 本人换验证器：受限重绑页；旧 TOTP/密码保留到 confirm。 */
export const SELF_REBIND_PAGE = '/admin-recovery';
export const SELF_REBIND_ROUTE_ID = 'POST /api/admin/account/2fa/reset';

const TOTP_RE = /^\d{6}$/;

/**
 * 请求体：TOTP_RESET actionGrant，或兼容旧的 currentPassword+totp。
 * 恢复码在此入口一律拒绝（E-75：不得把恢复码当换验证器捷径），且不消耗任何凭据。
 */
export const SelfResetBodySchema = z.object({
  actionGrant: z.string().min(20).max(200).optional(),
  currentPassword: z.string().min(1).max(200).optional(),
  totp: z.string().regex(TOTP_RE).optional(),
  recoveryCode: z.string().max(40).optional(),
}).strict();

export type SelfResetMode =
  | { mode: 'grant'; actionGrant: string }
  | { mode: 'password'; currentPassword: string; totp: string };

/**
 * 纯判定：只决定走 grant 还是旧密码+TOTP，并在此拒绝恢复码与不完整输入。
 * 不读时钟、不连库——路由与服务测试共用同一判定。
 */
export function classifySelfResetBody(input: unknown): SelfResetMode {
  const parsed = SelfResetBodySchema.safeParse(input);
  if (!parsed.success) throw new AppError('invalid');
  const body = parsed.data;
  if (body.recoveryCode !== undefined && body.recoveryCode.trim() !== '') {
    throw new AppError('invalid', { fieldErrors: { recoveryCode: 'Recovery codes cannot be used here.' } });
  }
  if (body.actionGrant !== undefined) {
    if (body.currentPassword !== undefined || body.totp !== undefined) throw new AppError('invalid');
    return { mode: 'grant', actionGrant: body.actionGrant };
  }
  if (body.currentPassword !== undefined && body.totp !== undefined) {
    return { mode: 'password', currentPassword: body.currentPassword, totp: body.totp };
  }
  // 仅登录会话、仅一枚 TOTP 或空体都不够强：拒绝且不改绑定（E-75）。
  throw new AppError('invalid');
}

export type SelfRebindInput =
  | { kind: 'grant'; userId: string; sid: string; actionGrant: string; ip: string | null }
  | { kind: 'password'; userId: string; sid: string; ip: string | null };

export type SelfRebindResult = { token: string; expiresAt: Date; page: string };

export type SelfRebindService = {
  /**
   * 在一个事务里完成：TOTP_RESET grant 消费（若有）→ 递增 sv 撤销旧设备与旧恢复会话 →
   * 建 SELF_REAUTH 受限 session → 审计。失败整笔回滚，grant 不被消费、绑定与 sv 不变。
   */
  rebind(input: SelfRebindInput): Promise<SelfRebindResult>;
};

/**
 * 本人换验证器的受限重绑。
 *
 * - 原因素（TOTP/密码/defaultMode/recoveryCodes）**不在本入口清除**：只有受限 confirm 才原子发布新绑定。
 * - 旧后台会话在本事务里失效（sv+1、设备撤销），受限 cookie 走独立凭据族，不能访问后台（E-14）。
 * - grant 与 sv 递增同事务：任一步失败整笔回滚，不出现「grant 已用但没进受限」。
 */
export function createSelfRebindService(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  restrictedTtlMs?: number;
  repo?: RecoveryRepo;
  grants: Pick<ActionGrantService, 'consume'>;
}): SelfRebindService {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const restrictedTtlMs = deps.restrictedTtlMs ?? ADMIN_GRANT_POLICY.restrictedTtlMs;
  const repo = deps.repo ?? createRecoveryRepo();

  return {
    async rebind(input) {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('self rebind clock');
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashRecoverySessionToken(token);
      const expiresAt = new Date(now.getTime() + restrictedTtlMs);

      await db.$transaction(async (tx) => {
        const account = await repo.lockActiveAccountForSelfRebind(tx, input.userId, input.sid);
        if (!account) throw new AppError('unauthorized');

        if (input.kind === 'grant') {
          const consumed = await deps.grants.consume(
            { token: input.actionGrant, purpose: 'TOTP_RESET', targetId: null, userId: input.userId, sid: input.sid },
            tx,
          );
          if (!consumed) throw new AppError('action_grant_invalid');
        }

        const sessionVersion = await repo.bumpSessionVersion(tx, input.userId, now);
        await repo.revokeOldDevices(tx, input.userId, sessionVersion, now, 'self_reauth');
        await repo.revokeOldRecoverySessions(tx, input.userId, now);
        await repo.createRecoverySession(tx, {
          id: randomBytes(16).toString('hex'),
          tokenHash,
          userId: input.userId,
          sessionVersion,
          source: 'SELF_REAUTH',
          createdAt: now,
          expiresAt,
          pendingPasswordHash: null,
        });
        await repo.createAudit(tx, {
          actorId: input.userId,
          action: 'account.2fa_reset',
          target: input.userId,
          meta: { via: input.kind === 'grant' ? 'action_grant' : 'password_totp', restricted: true },
          ip: input.ip || 'unknown',
        });
      });

      return { token, expiresAt, page: SELF_REBIND_PAGE };
    },
  };
}
