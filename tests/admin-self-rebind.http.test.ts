// M3-T20 本人换验证器：请求体判定 + SELF_REAUTH 受限重绑事务的服务级验收。
//
// 真实 PostgreSQL + 真实 HTTP 的端到端用例需要独立 loopback 库与一次性 schema；
// 本任务卡未授权建库/迁移，故该层以本文件的注入假件覆盖事务顺序与拒绝不改绑定，
// 真实库/HTTP 待拿到隔离 DB 运行卡后补跑（不在此文件冒充已跑）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/server/http/errors';
import {
  SELF_REBIND_PAGE,
  classifySelfResetBody,
  createSelfRebindService,
} from '../src/lib/server/admin/self-rebind';

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
      expiresAt: Date;
      tokenHash: string;
    };
    assert.equal(session.userId, 'user-1');
    assert.equal(session.source, 'SELF_REAUTH');
    assert.equal(session.sessionVersion, 4);
    assert.equal(session.pendingPasswordHash, null);
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
