// deploy-readiness：生产首个管理员 CLI（scripts/admin-create.mjs）。见 PR 正文安全审查清单第 4 项。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs, passwordPolicyError, passwordSource, takeEnvPassword, firstLine, adminGateError, normalizeAccountEmail, validEmail, ARGON, MESSAGES } from '../scripts/admin-create-lib.mjs';
import { passwordPolicyError as appPolicy } from '../src/lib/server/admin/accounts';
import { normalizeAccountEmail as appNormalize } from '../src/lib/server/admin/user-policy';

const PW = 'Correct-Horse-Battery-9';

test('密码规则与后台新建账号（passwordPolicyError）完全一致', () => {
  const email = 'admin@example.com';
  for (const pw of ['', 'short', 'x'.repeat(11), 'x'.repeat(12), 'x'.repeat(200), 'x'.repeat(201), email, ` ${email.toUpperCase()} `, PW, '密码密码密码密码密码密码'])
    assert.equal(passwordPolicyError(pw, email), appPolicy(pw, email), JSON.stringify(pw));
});

test('邮箱规范化与后台一致；argon2id 参数与 crypto.ts 一致', () => {
  for (const e of [' Admin@Example.COM ', 'ＡＤＭＩＮ@example.com']) assert.equal(normalizeAccountEmail(e), appNormalize(e));
  assert.match(readFileSync('src/lib/server/admin/crypto.ts', 'utf8'), new RegExp(`memoryCost: ${ARGON.memoryCost}, timeCost: ${ARGON.timeCost}, parallelism: ${ARGON.parallelism}`));
  assert.ok(validEmail('a@example.com')); for (const e of ['', 'a', 'a@b', 'a b@c.de', `${'x'.repeat(200)}@a.de`]) assert.ok(!validEmail(e), e);
});

test('参数：密码不能出现在命令行参数里（任何写法），未知参数拒绝，错误码里不带参数值', () => {
  for (const argv of [['--password', PW], [`--password=${PW}`], ['--pass', PW], ['-p', PW], ['--admin-pwd', PW], ['--email', 'a@b.de', '--secret', PW]]) {
    const r = parseArgs(argv);
    assert.deepEqual(r, { error: 'password_in_argv' }, argv.join(' '));
  }
  assert.deepEqual(parseArgs(['--email', 'a@b.de', PW]), { error: 'unknown_arg' });
  assert.deepEqual(parseArgs(['--email', 'nope']), { error: 'invalid_email' });
  assert.deepEqual(parseArgs(['--email', ' A@Example.com ', '--name', ' Ryan ']), { email: 'a@example.com', name: 'Ryan', allowAdditionalAdmin: false, help: false });
  assert.deepEqual(parseArgs([], { ADMIN_CREATE_EMAIL: 'b@example.com' }), { email: 'b@example.com', name: 'Admin', allowAdditionalAdmin: false, help: false });
  assert.equal((parseArgs(['--email=a@b.de', '--allow-additional-admin']) as { allowAdditionalAdmin: boolean }).allowAdditionalAdmin, true);
});

test('密码来源：有 TTY → 终端；无 TTY → 环境变量，否则标准输入；环境变量读出后立即删除', () => {
  assert.equal(passwordSource({ isTTY: true, envPassword: PW }), 'tty');
  assert.equal(passwordSource({ isTTY: false, envPassword: PW }), 'env');
  assert.equal(passwordSource({ isTTY: false, envPassword: '' }), 'stdin');
  assert.equal(passwordSource({ isTTY: false, envPassword: undefined }), 'stdin');
  const env: Record<string, string | undefined> = { ADMIN_CREATE_PASSWORD: PW, OTHER: '1' };
  assert.equal(takeEnvPassword(env), PW);
  assert.ok(!('ADMIN_CREATE_PASSWORD' in env)); assert.equal(env.OTHER, '1');
  assert.equal(firstLine(`${PW}\r\nignored`), PW); assert.equal(firstLine(` a b \n`), ' a b ');
});

test('已有账号 / 已有管理员：邮箱已存在一律失败（不覆盖）；已有管理员需显式 --allow-additional-admin', () => {
  assert.equal(adminGateError({ existingAdmins: 0, emailTaken: false, allowAdditionalAdmin: false }), null);
  assert.equal(adminGateError({ existingAdmins: 1, emailTaken: false, allowAdditionalAdmin: false }), 'admin_exists');
  assert.equal(adminGateError({ existingAdmins: 1, emailTaken: false, allowAdditionalAdmin: true }), null);
  assert.equal(adminGateError({ existingAdmins: 0, emailTaken: true, allowAdditionalAdmin: true }), 'email_taken');
  for (const m of Object.values(MESSAGES)) assert.doesNotMatch(m, /\$\{/);
});

// 子进程：验证在连库之前的拒绝路径，以及输出里从不出现密码
function run(args: string[], env: Record<string, string> = {}, input = '') {
  const r = spawnSync(process.execPath, ['scripts/admin-create.mjs', ...args], {
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, input, encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('CLI：命令行带密码 → 退出 1，输出不回显密码', () => {
  const r = run(['--email', 'a@example.com', '--password', PW], { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x' });
  assert.equal(r.code, 1); assert.match(r.out, /命令行参数/); assert.ok(!r.out.includes(PW));
});

test('CLI：弱密码（环境变量 / 标准输入）→ 退出 1，不连库，输出不含密码', () => {
  const weak = 'weak-pw';
  for (const [env, input] of [[{ ADMIN_CREATE_PASSWORD: weak }, ''], [{}, `${weak}\n`]] as const) {
    const r = run(['--email', 'a@example.com'], { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x', ...env }, input);
    assert.equal(r.code, 1); assert.match(r.out, /密码不符合/); assert.ok(!r.out.includes(weak));
  }
});

test('CLI：数据库不可达 → 退出 1，只给错误类型，不输出密码或连接串', () => {
  const r = run(['--email', 'a@example.com'], { DATABASE_URL: 'postgresql://dbuser:dbpass-SHOULD-NOT-LEAK@127.0.0.1:1/x', ADMIN_CREATE_PASSWORD: PW });
  assert.equal(r.code, 1); assert.match(r.out, /数据库操作失败/);
  for (const s of [PW, 'dbpass-SHOULD-NOT-LEAK', 'dbuser']) assert.ok(!r.out.includes(s), s);
});

test('只有 CLI，没有 HTTP 建首个管理员的接口；审计不含密码；会进 standalone 产物', () => {
  const src = readFileSync('scripts/admin-create.mjs', 'utf8');
  assert.match(src, /action: 'user\.create'/);
  assert.doesNotMatch(src.slice(src.indexOf('auditLog.create'), src.indexOf('auditLog.create') + 200), /password|passwordHash|email/i);
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*password/i);
  assert.ok(!existsSync('src/app/api/admin/bootstrap') && !existsSync('src/app/api/setup'));
  assert.match(readFileSync('next.config.ts', 'utf8'), /outputFileTracingIncludes: \{ '\/api\/health': \['\.\/scripts\/admin-create\.mjs', '\.\/scripts\/admin-create-lib\.mjs'\] \}/);
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).scripts['admin:create'], 'node scripts/admin-create.mjs');
});
