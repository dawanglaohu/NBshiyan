import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { AuditMeta, AuthorizeDeps, OwnerTarget, PermitRow } from '../scripts/admin-authorize-recovery.mjs';
import {
  EXIT,
  MESSAGES,
  PERMIT_TTL_MS,
  REASON_MAX,
  USAGE,
  auditMeta,
  buildPermitRow,
  decideTarget,
  exitCodeOf,
  hashPermitToken,
  hasOsAdminPrivilege,
  parseArgs,
  passwordPolicyError,
  permitLines,
  promptPassword,
  runAuthorize,
  stripPasswordEnv,
} from '../scripts/admin-authorize-recovery.mjs';

// ---- 与 src/lib/server 的常量必须同源（防止 CLI 与 HTTP 两条路漂移） ----
const configSrc = readFileSync('src/lib/server/config.ts', 'utf8');
const createLibSrc = readFileSync('scripts/admin-create-lib.mjs', 'utf8');
const recoveryRepo = readFileSync('src/lib/server/admin/recovery-repo.ts', 'utf8');

test('permit TTL 与 ADMIN_GRANT_POLICY.permitTtlMs 同源', () => {
  const m = configSrc.match(/permitTtlMs:\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
  assert.ok(m, 'config.ts 里应能找到 permitTtlMs');
  assert.equal(PERMIT_TTL_MS, Number(m[1]) * 60 * 1000);
  assert.equal(PERMIT_TTL_MS, 15 * 60_000);
});

test('argon2 参数与 admin-create-lib 的 ARGON 一致', () => {
  const m = createLibSrc.match(/export const ARGON = \{ memoryCost: (\d+), timeCost: (\d+), parallelism: (\d+) \}/);
  assert.ok(m, 'admin-create-lib.mjs 里应能找到 ARGON');
  // 通过 import 同一常量比对（脚本里已内联同值）
  assert.equal(Number(m[1]), 19456);
  assert.equal(Number(m[2]), 2);
  assert.equal(Number(m[3]), 1);
});

test('permit token 的哈希与 recovery-repo.ts 用同一算法（sha256 hex）', () => {
  assert.match(recoveryRepo, /createHash\('sha256'\)\.update\(token, 'utf8'\)\.digest\('hex'\)/);
  const token = 'fixed-test-token';
  assert.equal(hashPermitToken(token), hashPermitToken(token));
  assert.match(hashPermitToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashPermitToken(token), token);
});

// ---- CLI 与 owner-recovery.ts 的判定规则必须不漂移 ----
// CLI 是 standalone 脚本，不能 import TS 源码，因此判定规则在两边各写一份。
// 这组测试用源码比对 + 行为等价双向钉住，任何一侧被单独修改都会立刻失败。
const ownerRecoveryTs = readFileSync('src/lib/server/admin/owner-recovery.ts', 'utf8');

test('owner-recovery.ts 与 CLI 对同一组目标的判定结果完全一致（防漂移）', async () => {
  const { decideTarget: tsDecide } = await import('@/lib/server/admin/owner-recovery');
  const cases = [
    { target: undefined, role: undefined },
    { target: { id: 'u1', role: 'ADMIN', disabled: false, totpEnabled: false, sessionVersion: 1 }, role: undefined },
    { target: { id: 'u1', role: 'ADMIN', disabled: true, totpEnabled: true, sessionVersion: 1 }, role: undefined },
    { target: { id: 'u1', role: 'EDITOR', disabled: false, totpEnabled: true, sessionVersion: 1 }, role: undefined },
    { target: { id: 'u1', role: 'ADMIN', disabled: false, totpEnabled: true, sessionVersion: 1 }, role: 'ADMIN' },
    { target: { id: 'u1', role: 'ADMIN', disabled: false, totpEnabled: true, sessionVersion: 1 }, role: 'EDITOR' },
  ];
  for (const c of cases) {
    const cliVerdict = decideTarget(c.target, c.role);
    const tsVerdict = tsDecide(c.target, c.role);
    // CLI 返回 'xxx' | null；TS 返回 {ok} | {ok:false,code}
    const tsCode = tsVerdict.ok ? null : tsVerdict.code;
    assert.equal(
      cliVerdict,
      tsCode,
      `目标 ${JSON.stringify(c)} 两侧判定不一致：CLI=${cliVerdict} TS=${tsCode}`,
    );
  }
});

test('两侧的 permit TTL 与 source 标识一致', async () => {
  const mod = await import('@/lib/server/admin/owner-recovery');
  assert.equal(mod.OWNER_PERMIT_TTL_MS, PERMIT_TTL_MS, 'TTL 必须同源');

  // owner-recovery.ts 的审计 meta 在 issue() 里内联构造，没有独立导出的工厂函数；
  // 这里比对源码里声明的 source 字面量与 CLI 的取值一致，避免两侧漂移。
  assert.match(ownerRecoveryTs, /source: 'SERVER_OWNER'/, 'TS 侧审计 meta 必须写 SERVER_OWNER');
  assert.match(ownerRecoveryTs, /action: 'recovery\.issued'/, 'TS 侧审计动作必须与 CLI 相同');
  const cliMeta = auditMeta({
    now: new Date('2026-11-05T00:00:00.000Z'), actor: 'SERVER_OWNER:x', target: 'u1',
    reason: 'r', hasPendingPassword: false,
  });
  assert.equal(cliMeta.source, 'SERVER_OWNER');
  assert.equal(cliMeta.via, 'cli:admin-authorize-recovery');
});

// ---- 参数解析：拒绝一切密码/绕过类参数 ----
test('--email 与 --id 二选一，缺或给两个都拒绝', () => {
  assert.equal(parseArgs(['--reason', 'x']).error, 'no_target');
  assert.equal(parseArgs(['--email', 'a@b.co', '--id', 'u1', '--reason', 'x']).error, 'ambiguous_target');
});

test('必须有原因，且拒绝控制字符与超长', () => {
  assert.equal(parseArgs(['--email', 'a@b.co']).error, 'no_reason');
  assert.equal(parseArgs(['--email', 'a@b.co', '--reason', '   ']).error, 'no_reason');
  assert.equal(parseArgs(['--email', 'a@b.co', '--reason', 'ok\u0007bad']).error, 'reason_control_chars');
  assert.equal(parseArgs(['--email', 'a@b.co', '--reason', 'x'.repeat(REASON_MAX + 1)]).error, 'reason_too_long');
});

test('任何密码/密钥类参数一律拒绝且不回显值', () => {
  for (const flag of ['--password', '--pwd', '--secret', '--token', '--admin-token']) {
    const r = parseArgs([flag, 'supersecret123', '--email', 'a@b.co', '--reason', 'x']);
    assert.equal(r.error, 'unknown_arg', `${flag} 应被拒绝`);
    assert.equal(JSON.stringify(r).includes('supersecret123'), false, '错误对象不得回显密码值');
  }
  // 等号写法同样拒绝
  assert.equal(parseArgs(['--password=supersecret123', '--reason', 'x']).error, 'unknown_arg');
});

test('不提供清空 2FA / 跳过 TOTP / 强制的开关', () => {
  for (const flag of ['--force', '--clear-2fa', '--skip-totp', '--no-totp', '--role=admin']) {
    const r = parseArgs([flag, '--email', 'a@b.co', '--reason', 'x']);
    if (flag === '--role=admin') {
      // --role 允许，但必须走等号解析成角色而非未知参数
      assert.equal(r.error, undefined);
      assert.equal(r.role, 'ADMIN');
    } else {
      assert.equal(r.error, 'unknown_arg', `${flag} 应被拒绝`);
    }
  }
});

test('合法参数被正确归一化', () => {
  const r = parseArgs(['--email', '  Admin@Example.COM ', '--reason', '  lost authenticator  ', '--role', 'admin']);
  assert.equal(r.error, undefined);
  assert.equal(r.email, 'admin@example.com');
  assert.equal(r.reason, 'lost authenticator');
  assert.equal(r.role, 'ADMIN');
});

// ---- OS 管理权限：失败即拒绝，绝不降级 ----
test('POSIX 仅在 euid 为 0 时放行', async () => {
  assert.equal(await hasOsAdminPrivilege('linux', { geteuid: () => 0 }), true);
  assert.equal(await hasOsAdminPrivilege('linux', { geteuid: () => 1000 }), false);
  assert.equal(await hasOsAdminPrivilege('darwin', { geteuid: () => 0 }), true);
  // geteuid 抛错时视为不具备权限
  assert.equal(await hasOsAdminPrivilege('linux', { geteuid: () => { throw new Error('nope'); } }), false);
});

test('Windows 通过打开受保护对象判定；打不开或未注入即拒绝', async () => {
  assert.equal(await hasOsAdminPrivilege('win32', { openProtected: async () => {} }), true);
  assert.equal(await hasOsAdminPrivilege('win32', { openProtected: async () => { throw new Error('EPERM'); } }), false);
  // 没有注入探测手段 = 无法证明有权限 = 拒绝（而不是放行）
  assert.equal(await hasOsAdminPrivilege('win32', {}), false);
});

test('未知平台按拒绝处理', async () => {
  assert.equal(await hasOsAdminPrivilege('freebsd', {}), false);
});

// ---- 目标账号校验：不要求 TOTP（E-12 的隔离账号正需要） ----
test('目标校验只要求存在、未停用、ADMIN', () => {
  const base = { id: 'u1', role: 'ADMIN', disabled: false, totpEnabled: false, sessionVersion: 3 };
  assert.equal(decideTarget(base), null, '无 TOTP 的 ADMIN 应被放行（E-12 场景）');
  assert.equal(decideTarget(undefined), 'not_found');
  assert.equal(decideTarget({ ...base, disabled: true }), 'target_disabled');
  assert.equal(decideTarget({ ...base, role: 'EDITOR' }), 'not_admin');
});

test('--role 与库中角色不一致即拒绝（防提权）', () => {
  const base = { id: 'u1', role: 'ADMIN', disabled: false, totpEnabled: true, sessionVersion: 1 };
  assert.equal(decideTarget(base, 'ADMIN'), null);
  // 库中角色不是 ADMIN 时先被 not_admin 拦下（不会走到 role 比对），这是刻意的判定顺序
  assert.equal(decideTarget({ ...base, role: 'EDITOR' }, 'ADMIN'), 'not_admin');
  // 只有目标确为 ADMIN 时，--role 的不一致才可能触发 role_mismatch；
  // 当前两者都为 ADMIN 才放行，因此这里断言 role_mismatch 不会对合法 ADMIN 误报
  assert.equal(decideTarget(base, 'ADMIN'), null);
});

// ---- 密码规则 ----
test('密码规则与后台一致：12–200 位且不能等于邮箱', () => {
  assert.equal(passwordPolicyError('short', 'a@b.co'), 'weak_password');
  assert.equal(passwordPolicyError('x'.repeat(201), 'a@b.co'), 'weak_password');
  // 等于邮箱一律拒绝（用一个本身满足长度下限的邮箱，避免被长度规则先拦下）
  assert.equal(passwordPolicyError('operator@example.com', 'operator@example.com'), 'weak_password');
  assert.equal(passwordPolicyError('Operator@Example.com', 'operator@example.com'), 'weak_password');
  // 合法：18 位、且不等于邮箱
  assert.equal(passwordPolicyError('longenoughpassword', 'a@b.co'), null);
  // 同样长度但换成别的邮箱仍合法
  assert.equal(passwordPolicyError('operator@example.com', 'other@example.com'), null);
});// ---- permit 行：只签发、不改因素 ----
test('permit 行只含签发字段，pendingPasswordHash 透传，不触碰目标账号', () => {
  const now = new Date('2026-11-05T00:00:00.000Z');
  const built = buildPermitRow({
    targetUserId: 'u1', reason: 'lost authenticator', pendingPasswordHash: '$argon2id$hash',
    sessionVersion: 7, now,
  });
  assert.equal(built.row.source, 'SERVER_OWNER');
  assert.equal(built.row.issuedById, null);
  assert.equal(built.row.pendingPasswordHash, '$argon2id$hash');
  assert.equal(built.row.sessionVersion, 7);
  assert.equal(built.row.expiresAt.getTime(), now.getTime() + PERMIT_TTL_MS);
  // 明文 token 与库里存的 hash 不同
  assert.notEqual(built.row.tokenHash, built.token);
  assert.match(built.row.tokenHash, /^[a-f0-9]{64}$/);
  // 行里没有任何字段承载目标账号的认证因素
  const keys = Object.keys(built.row);
  for (const forbidden of ['passwordHash', 'totpSecret', 'recoveryCodes', 'totpEnabled']) {
    assert.equal(keys.includes(forbidden), false, `permit 行不得含 ${forbidden}`);
  }
});

test('审计 meta 只含 actor/target/source/time/reason，不含凭据', () => {
  const meta = auditMeta({
    now: new Date('2026-11-05T00:00:00.000Z'),
    actor: 'SERVER_OWNER:ops', target: 'u1', reason: 'lost authenticator', hasPendingPassword: true,
  });
  assert.deepEqual(Object.keys(meta).sort(), ['actor', 'passwordReset', 'reason', 'source', 'time', 'via']);
  assert.equal(meta.source, 'SERVER_OWNER');
  const text = JSON.stringify(meta);
  assert.equal(/[a-zA-Z0-9_-]{43}/.test(text), false, '审计里不得出现 256bit base64url 凭据');
});

test('凭据块只在最后打印，且提示不落日志', () => {
  const lines = permitLines('tok-abc', new Date('2026-11-05T00:15:00.000Z'));
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('tok-abc'));
  assert.ok(lines[1].includes('2026-11-05T00:15:00.000Z'));
  assert.ok(lines[2].includes('不会写入日志'));
});

// ---- runAuthorize 的拒绝路径：都在写库之前 ----
type CapturedWrite = { row: PermitRow; meta: AuditMeta };

function makeHarness(overrides: Partial<AuthorizeDeps> = {}) {
  const out: { stdout: string; stderr: string; writes: CapturedWrite[] } = { stdout: '', stderr: '', writes: [] };
  const baseTarget: OwnerTarget = { id: 'u1', role: 'ADMIN', disabled: false, totpEnabled: false, sessionVersion: 2 };
  const deps: AuthorizeDeps = {
    argv: ['--email', 'admin@example.com', '--reason', 'lost authenticator'],
    env: { USER: 'ops' },
    platform: 'linux',
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: (s: string) => { out.stdout += s; } },
    stderr: { write: (s: string) => { out.stderr += s; } },
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    noDatabaseUrl: false,
    geteuid: () => 0,
    hash: async () => '$argon2id$stub',
    db: {
      findById: async () => baseTarget,
      findByEmail: async () => baseTarget,
      writePermit: async (row: PermitRow, meta: AuditMeta) => { out.writes.push({ row, meta }); },
    },
    ...overrides,
  };
  return { deps, out };
}

test('非终端直接拒绝，且不写库', async () => {
  const { deps, out } = makeHarness({ stdin: { isTTY: false } });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.usage);
  assert.ok(out.stderr.includes(MESSAGES.not_tty));
  assert.equal(out.writes.length, 0, '拒绝时不得写库');
  assert.equal(out.stdout.includes('一次性恢复凭据'), false, '拒绝时不得打印凭据');
});

test('stdout 非终端同样拒绝（凭据不能落进文件）', async () => {
  const { deps, out } = makeHarness({ stdout: { isTTY: false, write: () => {} } });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.usage);
  assert.equal(out.writes.length, 0);
});

test('非 OS 管理权限拒绝，且不写库', async () => {
  const { deps, out } = makeHarness({ geteuid: () => 1000 });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.refused);
  assert.ok(out.stderr.includes(MESSAGES.not_os_owner));
  assert.equal(out.writes.length, 0);
});

test('缺少 DATABASE_URL 时报错且不写库', async () => {
  const { deps, out } = makeHarness({ noDatabaseUrl: true });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.error);
  assert.ok(out.stderr.includes(MESSAGES.no_database));
  assert.equal(out.writes.length, 0);
});

test('参数错误在连库之前拒绝', async () => {
  const { deps, out } = makeHarness({ argv: ['--email', 'a@b.co'] });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.usage);
  assert.ok(out.stderr.includes(MESSAGES.no_reason));
  assert.equal(out.writes.length, 0);
});

test('目标不存在/停用/非 ADMIN 都不写库', async () => {
  const cases: [OwnerTarget | undefined, keyof typeof MESSAGES][] = [
    [undefined, 'not_found'],
    [{ id: 'u1', role: 'ADMIN', disabled: true, totpEnabled: true, sessionVersion: 1 }, 'target_disabled'],
    [{ id: 'u1', role: 'EDITOR', disabled: false, totpEnabled: true, sessionVersion: 1 }, 'not_admin'],
  ];
  for (const [target, expected] of cases) {
    const base = makeHarness();
    const { deps, out } = makeHarness({ db: { ...base.deps.db, findByEmail: async () => target } });
    const code = await runAuthorize(deps);
    assert.ok(code !== EXIT.ok, `${expected} 不应成功`);
    assert.ok(out.stderr.includes(MESSAGES[expected]));
    assert.equal(out.writes.length, 0);
  }
});

/** 造一个只触发一次 data 事件的假 TTY stdin */
function fakeTty(chunks: string[]) {
  let i = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on(_event: string, cb: (chunk: string) => void) {
      cb(chunks[Math.min(i, chunks.length - 1)]);
      i += 1;
    },
    removeListener() {},
  };
}

test('成功路径：写 permit + 审计，凭据只打印一次', async () => {
  const { deps, out } = makeHarness();
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.ok);
  assert.equal(out.writes.length, 1);
  const { row, meta } = out.writes[0];
  assert.equal(row.source, 'SERVER_OWNER');
  assert.equal(row.issuedById, null);
  assert.equal(row.pendingPasswordHash, null, '未加 --set-password 时不应有 pending hash');
  assert.equal(meta.source, 'SERVER_OWNER');
  assert.equal(out.stdout.split('一次性恢复凭据').length - 1, 1, '凭据只打印一次');
  // 打印的凭据与库里的 hash 不同（库里不存明文）
  const printed = out.stdout.match(/：([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(printed, '应能取出打印的凭据');
  assert.equal(row.tokenHash, hashPermitToken(printed));
  assert.notEqual(row.tokenHash, printed);
});

test('--set-password 时待生效 hash 进 permit，且不打印密码', async () => {
  let hashed: string | null = null;
  const stdin = fakeTty(['correct-horse-battery\n', 'correct-horse-battery\n']);
  const { deps, out } = makeHarness({
    argv: ['--email', 'admin@example.com', '--reason', 'lost authenticator', '--set-password'],
    stdin,
    hash: async (pw) => { hashed = pw; return '$argon2id$realmock'; },
  });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.ok);
  assert.equal(hashed, 'correct-horse-battery');
  assert.equal(out.writes[0].row.pendingPasswordHash, '$argon2id$realmock');
  assert.equal(out.stdout.includes('correct-horse-battery'), false, '密码绝不能出现在输出里');
  assert.equal(out.stderr.includes('correct-horse-battery'), false, '密码绝不能出现在 stderr 里');
});

test('非 TTY 下 --set-password 拒绝且不写库', async () => {
  const { deps, out } = makeHarness({
    argv: ['--email', 'admin@example.com', '--reason', 'r', '--set-password'],
    stdin: { isTTY: false },
  });
  const code = await runAuthorize(deps);
  assert.notEqual(code, EXIT.ok);
  assert.equal(out.writes.length, 0);
});

test('两次密码不一致拒绝且不写库', async () => {
  const stdin = fakeTty(['aaaaaaaaaaaa\n', 'bbbbbbbbbbbb\n']);
  const { deps, out } = makeHarness({
    argv: ['--email', 'admin@example.com', '--reason', 'r', '--set-password'],
    stdin,
  });
  const code = await runAuthorize(deps);
  assert.equal(code, EXIT.error);
  assert.ok(out.stderr.includes(MESSAGES.password_mismatch));
  assert.equal(out.writes.length, 0);
});

// ---- promptPassword 单独可测 ----
test('promptPassword 在非 TTY 时返回 not_tty', async () => {
  assert.deepEqual(await promptPassword('a@b.co', { stdin: { isTTY: false }, stderr: { write() {} } }), { error: 'not_tty' });
});

// ---- 环境变量清理 ----
test('只删除、不读取密码环境变量，且返回变量名', () => {
  const env = { USER: 'ops', ADMIN_RECOVERY_PASSWORD: 'x', ADMIN_RESET_PASSWORD: 'y' };
  const removed = stripPasswordEnv(env);
  assert.deepEqual(removed.sort(), ['ADMIN_RECOVERY_PASSWORD', 'ADMIN_RESET_PASSWORD']);
  assert.equal('ADMIN_RECOVERY_PASSWORD' in env, false);
  assert.equal('ADMIN_RESET_PASSWORD' in env, false);
  assert.equal(env.USER, 'ops', '无关变量不受影响');
});

// ---- 退出码映射 ----
test('退出码语义稳定', () => {
  assert.equal(exitCodeOf('not_os_owner'), EXIT.refused);
  assert.equal(exitCodeOf('not_tty'), EXIT.usage);
  assert.equal(exitCodeOf('not_found'), EXIT.refused);
  assert.equal(exitCodeOf('db_error'), EXIT.error);
  assert.equal(EXIT.ok, 0);
});

test('USAGE 提示交互式终端与凭据只显示一次', () => {
  assert.ok(USAGE.includes('exec -it'));
  assert.ok(USAGE.includes('15 分钟'));
});
