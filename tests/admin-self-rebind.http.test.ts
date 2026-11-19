// M3-T20 本人换验证器：请求体判定 + SELF_REAUTH 受限重绑事务的服务级验收。
//
// 真实 PostgreSQL + 真实 HTTP 的端到端用例需要独立 loopback 库与一次性 schema；
// 本任务卡未授权建库/迁移，故该层以本文件的注入假件覆盖事务顺序与拒绝不改绑定，
// 真实库/HTTP 待拿到隔离 DB 运行卡后补跑（不在此文件冒充已跑）。
// SELF_REAUTH enroll/confirm（B1）同样以 fake repo + fake tx 覆盖，见文件末的 describe。
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import { AppError } from '../src/lib/server/http/errors';
import { decrypt, encrypt } from '../src/lib/server/admin/crypto';
import { createRecoveryEnrollmentService } from '../src/lib/server/admin/recovery-enrollment';
import type { CommitRecoveredFactors, RecoveryAudit } from '../src/lib/server/admin/recovery-repo';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import { ADMIN_GRANT_POLICY } from '../src/lib/server/config';
import {
  SELF_REBIND_PAGE,
  classifySelfResetBody,
  createSelfRebindService,
} from '../src/lib/server/admin/self-rebind';

process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 7).toString('base64');

before(() => setRateLimitStore(new MemoryStore()));

const NOW = new Date('2026-11-12T08:00:00.000Z');
const TTL = 600_000;

type Call = { name: string; args: unknown[] };

function fakeRepo(options: {
  account?: { sessionVersion: number } | null;
  failOn?: string;
} = {}) {
  const calls: Call[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
    if (options.failOn === name) throw new Error(`${name} failed`);
  };
  const repo = {
    lockActiveAccountForSelfRebind: async () => {
      calls.push({ name: 'lockActiveAccountForSelfRebind', args: [] });
      if (options.failOn === 'lockActiveAccountForSelfRebind') throw new Error('lock failed');
      return 'account' in options ? options.account : { sessionVersion: 3 };
    },
    bumpSessionVersion: async (...args: unknown[]) => {
      calls.push({ name: 'bumpSessionVersion', args });
      return 4;
    },
    revokeOldDevices: record('revokeOldDevices'),
    revokeOldRecoverySessions: record('revokeOldRecoverySessions'),
    createRecoverySession: record('createRecoverySession'),
    createAudit: record('createAudit'),
  };
  return { repo, calls };
}

function fakeGrants(result: boolean) {
  const calls: unknown[] = [];
  const grants = {
    consume: async (input: unknown) => {
      calls.push(input);
      return result;
    },
  };
  return { grants, calls };
}

function serviceFor(repo: unknown, grants: unknown) {
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  };
  return createSelfRebindService({
    db: db as never,
    clock: () => NOW,
    restrictedTtlMs: TTL,
    repo: repo as never,
    grants: grants as never,
  });
}

function appErrorCode(error: unknown): string {
  assert.ok(error instanceof AppError, 'expected AppError');
  return error.code;
}

describe('M3-T20 请求体判定：grant 或旧密码+totp，恢复码拒绝', () => {
  test('TOTP_RESET grant 走主路径', () => {
    const mode = classifySelfResetBody({ actionGrant: 'g'.repeat(43) });
    assert.equal(mode.mode, 'grant');
  });

  test('兼容 currentPassword+totp，两者缺一不可', () => {
    const mode = classifySelfResetBody({ currentPassword: 'pw', totp: '123456' });
    assert.equal(mode.mode, 'password');
    assert.throws(() => classifySelfResetBody({ currentPassword: 'pw' }), (error) => appErrorCode(error) === 'invalid');
    assert.throws(() => classifySelfResetBody({ totp: '123456' }), (error) => appErrorCode(error) === 'invalid');
    assert.throws(() => classifySelfResetBody({}), (error) => appErrorCode(error) === 'invalid');
  });

  test('recoveryCode 一律拒绝且带字段错误（E-75 捷径）', () => {
    assert.throws(
      () => classifySelfResetBody({ actionGrant: 'g'.repeat(43), recoveryCode: 'abc1234567' }),
      (error) => error instanceof AppError && error.code === 'invalid' && error.fieldErrors?.recoveryCode !== undefined,
    );
    assert.throws(
      () => classifySelfResetBody({ currentPassword: 'pw', totp: '123456', recoveryCode: 'abc1234567' }),
      (error) => error instanceof AppError && error.fieldErrors?.recoveryCode !== undefined,
    );
  });

  test('grant 与旧密码混用拒绝；未知字段拒绝', () => {
    assert.throws(
      () => classifySelfResetBody({ actionGrant: 'g'.repeat(43), currentPassword: 'pw' }),
      (error) => appErrorCode(error) === 'invalid',
    );
    assert.throws(
      () => classifySelfResetBody({ actionGrant: 'g'.repeat(43), extra: true }),
      (error) => appErrorCode(error) === 'invalid',
    );
  });
});

describe('M3-T20 SELF_REAUTH 受限重绑事务', () => {
  test('grant 路径：消费 TOTP_RESET → sv+1 → 撤销设备/旧恢复会话 → 建受限 session → 审计', async () => {
    const { repo, calls } = fakeRepo();
    const { grants, calls: grantCalls } = fakeGrants(true);
    const service = serviceFor(repo, grants);

    const result = await service.rebind({
      kind: 'grant',
      userId: 'user-1',
      sid: 'device-1',
      actionGrant: 'grant-token',
      ip: '203.0.113.9',
    });

    assert.equal(grantCalls.length, 1);
    assert.deepEqual(grantCalls[0], {
      token: 'grant-token',
      purpose: 'TOTP_RESET',
      targetId: null,
      userId: 'user-1',
      sid: 'device-1',
    });

    const order = calls.map((call) => call.name);
    assert.deepEqual(order, [
      'lockActiveAccountForSelfRebind',
      'bumpSessionVersion',
      'revokeOldDevices',
      'revokeOldRecoverySessions',
      'createRecoverySession',
      'createAudit',
    ]);

    const session = calls.find((call) => call.name === 'createRecoverySession')?.args[1] as {
      userId: string;
      sessionVersion: number;
      source: string;
      pendingPasswordHash: string | null;
      passwordResetSource?: string | null;
      expiresAt: Date;
      tokenHash: string;
    };
    assert.equal(session.userId, 'user-1');
    assert.equal(session.source, 'SELF_REAUTH');
    assert.equal(session.sessionVersion, 4);
    assert.equal(session.pendingPasswordHash, null);
    assert.equal(session.passwordResetSource, undefined, 'SELF_REAUTH 不带密码重置来源');
    assert.equal(session.expiresAt.toISOString(), new Date(NOW.getTime() + TTL).toISOString());
    assert.match(session.tokenHash, /^[0-9a-f]{64}$/);

    const audit = calls.find((call) => call.name === 'createAudit')?.args[1] as { action: string; meta: { restricted: boolean } };
    assert.equal(audit.action, 'account.2fa_reset');
    assert.equal(audit.meta.restricted, true);

    assert.equal(result.page, SELF_REBIND_PAGE);
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/, '受限令牌为 32 字节 base64url');
    assert.equal(result.expiresAt.toISOString(), new Date(NOW.getTime() + TTL).toISOString());
  });

  test('grant 无效：拒绝且不递增 sv、不建会话、不审计（绑定与凭据保持）', async () => {
    const { repo, calls } = fakeRepo();
    const { grants } = fakeGrants(false);
    const service = serviceFor(repo, grants);

    await assert.rejects(
      service.rebind({ kind: 'grant', userId: 'user-1', sid: 'device-1', actionGrant: 'bad', ip: null }),
      (error) => appErrorCode(error) === 'action_grant_invalid',
    );
    assert.deepEqual(calls.map((call) => call.name), ['lockActiveAccountForSelfRebind']);
  });

  test('当前设备已不可用：拒绝且不消费 grant', async () => {
    const { repo, calls } = fakeRepo({ account: null });
    const { grants, calls: grantCalls } = fakeGrants(true);
    const service = serviceFor(repo, grants);

    await assert.rejects(
      service.rebind({ kind: 'grant', userId: 'user-1', sid: 'device-gone', actionGrant: 'grant-token', ip: null }),
      (error) => appErrorCode(error) === 'unauthorized',
    );
    assert.equal(grantCalls.length, 0, '设备不可用时不得消费 grant');
    assert.equal(calls.some((call) => call.name === 'bumpSessionVersion'), false);
  });

  test('旧密码+totp 路径：不消费 grant，但同样只建受限会话', async () => {
    const { repo, calls } = fakeRepo();
    const { grants, calls: grantCalls } = fakeGrants(true);
    const service = serviceFor(repo, grants);

    const result = await service.rebind({ kind: 'password', userId: 'user-1', sid: 'device-1', ip: null });
    assert.equal(grantCalls.length, 0);
    assert.ok(calls.some((call) => call.name === 'createRecoverySession'));
    assert.ok(result.token.length === 43);
  });

  test('事务内后续失败：错误向上抛，调用方整笔回滚（不出现半提交）', async () => {
    const { repo } = fakeRepo({ failOn: 'createRecoverySession' });
    const { grants } = fakeGrants(true);
    const service = serviceFor(repo, grants);

    await assert.rejects(
      service.rebind({ kind: 'grant', userId: 'user-1', sid: 'device-1', actionGrant: 'grant-token', ip: null }),
      /createRecoverySession failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// B1：SELF_REAUTH 必须与其它受限来源共用同一 enroll/confirm 状态机
// ---------------------------------------------------------------------------

const ENROLL_NOW = new Date('2026-11-12T09:00:00.000Z');
const ENROLL_TTL = ADMIN_GRANT_POLICY.restrictedTtlMs;
let harnessSeq = 0;

type RecoverySource = 'RECOVERY_CODE' | 'ADMIN' | 'SERVER_OWNER' | 'SELF_REAUTH';

type EnrollmentHarnessOptions = {
  source?: RecoverySource;
  userVersion?: number;
  sessionVersion?: number;
  expiresAt?: Date;
  pendingSecret?: string;
  pendingUntil?: Date;
  pendingPasswordHash?: string | null;
  passwordResetSource?: string | null;
  failedAttempts?: number;
  revokedAt?: Date | null;
  completedAt?: Date | null;
  completeOk?: boolean;
  commitVersion?: number;
};

function enrollmentHarness(options: EnrollmentHarnessOptions = {}) {
  const email = `m3t20-enroll-${++harnessSeq}@example.test`;
  const userVersion = options.userVersion ?? 3;
  const initialPending = options.pendingSecret ? encrypt(options.pendingSecret) : null;
  const session = {
    id: 'recovery-session-1',
    userId: 'user-1',
    sessionVersion: options.sessionVersion ?? userVersion,
    source: options.source ?? ('SELF_REAUTH' as RecoverySource),
    expiresAt: options.expiresAt ?? new Date(ENROLL_NOW.getTime() + ENROLL_TTL),
    pendingSecretEncrypted: initialPending,
    pendingUntil: options.pendingUntil ?? (initialPending ? new Date(ENROLL_NOW.getTime() + ENROLL_TTL) : null),
    pendingPasswordHash: options.pendingPasswordHash ?? null,
    passwordResetSource: options.passwordResetSource ?? null,
    failedAttempts: options.failedAttempts ?? 0,
    completedAt: options.completedAt ?? null,
    revokedAt: options.revokedAt ?? null,
  };
  const user = {
    id: 'user-1',
    email,
    disabled: false,
    totpEnabled: true,
    totpSecret: 'old-encrypted-secret',
    recoveryCodes: ['old-recovery-hash'],
    sessionVersion: userVersion,
    passwordHash: 'old-hash',
  };
  const calls: { name: string; args: unknown[] }[] = [];
  const commitInputs: CommitRecoveredFactors[] = [];
  const audits: RecoveryAudit[] = [];
  const repo = {
    readRecoverySessionHint: async () => ({ userId: user.id, email: user.email }),
    lockRecoveryFactors: async () => user,
    lockRecoverySession: async () => session,
    setPendingSecret: async (
      _tx: unknown, _id: string, encrypted: string, until: Date, _now: Date, _sessionVersion: number,
    ) => {
      void _tx; void _id; void _now; void _sessionVersion;
      calls.push({ name: 'setPendingSecret', args: [encrypted, until] });
      session.pendingSecretEncrypted = encrypted;
      session.pendingUntil = until;
      return true;
    },
    revokeRecoverySession: async (_tx: unknown, _id: string, now: Date) => {
      calls.push({ name: 'revokeRecoverySession', args: [now] });
      session.revokedAt = now;
      session.pendingSecretEncrypted = null;
      session.pendingUntil = null;
    },
    recordConfirmFailure: async (_tx: unknown, _id: string, now: Date) => {
      calls.push({ name: 'recordConfirmFailure', args: [now] });
      session.failedAttempts += 1;
      return session.failedAttempts;
    },
    completeRecoverySession: async (
      _tx: unknown, _id: string, _now: Date, _expectedPendingSecret: string, _sessionVersion: number,
    ) => {
      void _tx; void _id; void _now; void _expectedPendingSecret; void _sessionVersion;
      calls.push({ name: 'completeRecoverySession', args: [] });
      return options.completeOk ?? true;
    },
    commitRecoveredFactors: async (_tx: unknown, input: CommitRecoveredFactors) => {
      calls.push({ name: 'commitRecoveredFactors', args: [input] });
      commitInputs.push(input);
      return options.commitVersion ?? session.sessionVersion + 1;
    },
    revokeOldDevices: async (...args: unknown[]) => { calls.push({ name: 'revokeOldDevices', args }); },
    revokeOtherRecoverySessions: async (...args: unknown[]) => { calls.push({ name: 'revokeOtherRecoverySessions', args }); },
    createAudit: async (_tx: unknown, entry: RecoveryAudit) => {
      calls.push({ name: 'createAudit', args: [entry] });
      audits.push(entry);
    },
  };
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) };
  const service = createRecoveryEnrollmentService({
    db: db as never,
    clock: () => ENROLL_NOW,
    repo: repo as never,
  });
  return { service, session, user, calls, commitInputs, audits };
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof AppError, 'expected AppError');
  return error.code;
}

function totpAt(secret: string): string {
  return authenticator.clone({ epoch: ENROLL_NOW.getTime() }).generate(secret);
}

describe('M3-T20 SELF_REAUTH enroll/confirm（B1：与其它受限来源共用状态机）', () => {
  test('enroll 首次：SELF_REAUTH 写 pending 并返回 URI，不动 sv/旧因素', async () => {
    const h = enrollmentHarness();
    const result = await h.service.enroll({ token: 'restricted-token', ip: '203.0.113.5' });
    const secret = new URL(result.otpauthUri).searchParams.get('secret');
    assert.ok(secret && secret.length >= 16);
    assert.equal(decrypt(h.session.pendingSecretEncrypted as string), secret);
    assert.equal(result.expiresAt.getTime(), ENROLL_NOW.getTime() + ENROLL_TTL);
    assert.equal(h.calls.filter((call) => call.name === 'setPendingSecret').length, 1);
    assert.equal(h.user.sessionVersion, h.session.sessionVersion, 'enroll never bumps sv');
    assert.equal(h.user.totpSecret, 'old-encrypted-secret');
    assert.deepEqual(h.user.recoveryCodes, ['old-recovery-hash']);
  });

  test('enroll 重入：已有 pending 返回同一 URI/原 expiry，不旋转不续时', async () => {
    const secret = authenticator.generateSecret();
    const pendingUntil = new Date(ENROLL_NOW.getTime() + 300_000);
    const h = enrollmentHarness({ pendingSecret: secret, pendingUntil });
    const result = await h.service.enroll({ token: 'restricted-token' });
    assert.equal(new URL(result.otpauthUri).searchParams.get('secret'), secret);
    assert.equal(result.expiresAt.getTime(), pendingUntil.getTime());
    assert.equal(h.calls.filter((call) => call.name === 'setPendingSecret').length, 0);
  });

  test('enroll 到期：recovery_expired，持久撤销且不写 pending', async () => {
    const h = enrollmentHarness({ expiresAt: ENROLL_NOW });
    await assert.rejects(
      h.service.enroll({ token: 'restricted-token' }),
      (error) => codeOf(error) === 'recovery_expired',
    );
    assert.equal(h.session.revokedAt?.getTime(), ENROLL_NOW.getTime());
    assert.equal(h.session.pendingSecretEncrypted, null);
    assert.equal(h.calls.filter((call) => call.name === 'setPendingSecret').length, 0);
  });

  test('enroll sv 已被其它事务推进：bad_credentials 且不写 pending', async () => {
    const h = enrollmentHarness({ sessionVersion: 3, userVersion: 4 });
    await assert.rejects(
      h.service.enroll({ token: 'restricted-token' }),
      (error) => codeOf(error) === 'bad_credentials',
    );
    assert.equal(h.calls.filter((call) => call.name === 'setPendingSecret').length, 0);
  });

  test('confirm 正向：原子发布新 TOTP+10 恢复码，密码材料传 null', async () => {
    const secret = authenticator.generateSecret();
    const h = enrollmentHarness({ pendingSecret: secret });
    const result = await h.service.confirm({ token: 'restricted-token', totp: totpAt(secret), ip: '203.0.113.6' });
    assert.equal(result.recoveryCodes.length, 10);
    assert.equal(h.commitInputs.length, 1);
    const commit = h.commitInputs[0];
    assert.equal(commit.pendingPasswordHash, null, 'SELF_REAUTH 永不写密码');
    assert.equal(commit.expectedSessionVersion, 3);
    assert.equal(commit.expectedTotpSecret, 'old-encrypted-secret');
    assert.equal(commit.recoveryCodeHashes.length, 10);
    assert.equal(decrypt(commit.newTotpSecretEncrypted), secret);
    assert.equal(commit.totpLastStep, Math.floor(ENROLL_NOW.getTime() / 30_000));
    assert.equal(h.calls.filter((call) => call.name === 'completeRecoverySession').length, 1);
    assert.equal(h.calls.filter((call) => call.name === 'revokeOldDevices').length, 1);
    assert.equal(h.calls.filter((call) => call.name === 'revokeOtherRecoverySessions').length, 1);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].action, 'recovery.completed');
    const meta = h.audits[0].meta as unknown as { source?: string; passwordReset?: boolean };
    assert.equal(meta.source, 'SELF_REAUTH');
    assert.equal(meta.passwordReset, false);
  });

  test('confirm 错码：只记一次失败，不提交新绑定', async () => {
    const secret = authenticator.generateSecret();
    const h = enrollmentHarness({ pendingSecret: secret });
    const wrong = totpAt(authenticator.generateSecret());
    await assert.rejects(
      h.service.confirm({ token: 'restricted-token', totp: wrong }),
      (error) => codeOf(error) === 'bad_credentials',
    );
    assert.equal(h.calls.filter((call) => call.name === 'recordConfirmFailure').length, 1);
    assert.equal(h.calls.filter((call) => call.name === 'completeRecoverySession').length, 0);
    assert.equal(h.commitInputs.length, 0);
    assert.equal(h.audits.length, 0);
  });

  test('SELF_REAUTH 携带密码重置材料：enroll/confirm 都拒绝（E-75）', async () => {
    const secret = authenticator.generateSecret();
    const cases: EnrollmentHarnessOptions[] = [
      { pendingPasswordHash: 'preauth-hash' },
      { passwordResetSource: 'SERVER_OWNER' },
    ];
    for (const over of cases) {
      const enrollHarness = enrollmentHarness(over);
      await assert.rejects(
        enrollHarness.service.enroll({ token: 'restricted-token' }),
        (error) => codeOf(error) === 'bad_credentials',
      );
      assert.equal(enrollHarness.calls.filter((call) => call.name === 'setPendingSecret').length, 0);

      const confirmHarness = enrollmentHarness({ pendingSecret: secret, ...over });
      await assert.rejects(
        confirmHarness.service.confirm({ token: 'restricted-token', totp: totpAt(secret) }),
        (error) => codeOf(error) === 'bad_credentials',
      );
      assert.equal(confirmHarness.commitInputs.length, 0);
    }
  });

  test('旧来源回归：RECOVERY_CODE 仍可 confirm，密码材料仍为 null', async () => {
    const secret = authenticator.generateSecret();
    const h = enrollmentHarness({ source: 'RECOVERY_CODE', pendingSecret: secret });
    const result = await h.service.confirm({ token: 'restricted-token', totp: totpAt(secret) });
    assert.equal(result.recoveryCodes.length, 10);
    assert.equal(h.commitInputs[0].pendingPasswordHash, null);
    const meta = h.audits[0].meta as unknown as { source?: string };
    assert.equal(meta.source, 'RECOVERY_CODE');
  });

  test('SERVER_OWNER 回归：本地预授权密码材料仍只在最终事务提交', async () => {
    const secret = authenticator.generateSecret();
    const h = enrollmentHarness({
      source: 'SERVER_OWNER',
      pendingSecret: secret,
      pendingPasswordHash: 'preauth-hash',
      passwordResetSource: 'SERVER_OWNER',
    });
    await h.service.confirm({ token: 'restricted-token', totp: totpAt(secret) });
    assert.equal(h.commitInputs[0].pendingPasswordHash, 'preauth-hash');
    const meta = h.audits[0].meta as unknown as { passwordReset?: boolean };
    assert.equal(meta.passwordReset, true);
  });

  test('confirm 完成后 CAS 失败（并发已领取）：bad_credentials，不提交因素', async () => {
    const secret = authenticator.generateSecret();
    const h = enrollmentHarness({ pendingSecret: secret, completeOk: false });
    await assert.rejects(
      h.service.confirm({ token: 'restricted-token', totp: totpAt(secret) }),
      (error) => codeOf(error) === 'bad_credentials',
    );
    assert.equal(h.commitInputs.length, 0);
    assert.equal(h.audits.length, 0);
  });
});
