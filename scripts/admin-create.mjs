#!/usr/bin/env node
// 创建第一个后台管理员（自建部署 / standalone 镜像里运行）。只有命令行，没有任何 HTTP 接口。
//   docker compose exec app node scripts/admin-create.mjs --email admin@example.com --name "Admin"
//   （或 docker compose run --rm app node scripts/admin-create.mjs …）
// 密码：终端里交互输入（不回显，输两次）；没有终端时读标准输入第一行（docker compose exec -T app node scripts/admin-create.mjs … < 文件）。
// ADMIN_CREATE_PASSWORD 只给 CI 用（读完立即删除）；APP_ENV=production 时拒绝——`docker run -e` 的值会出现在 docker inspect 里。
// 密码绝不进命令行参数、日志、异常信息或审计记录。规则与后台新建账号相同（12–200 位，不能等于邮箱）。
// 邮箱已存在 → 失败，不覆盖；已有管理员 → 失败，除非加 --allow-additional-admin。
// 建好的账号 totpEnabled=false：首次登录前照常走 2FA 绑定流程（与后台新建账号相同）。
// #347 方案 A：同时签发一次性绑定令牌，成功后在 stdout 打印一次绑定链接（只给运行脚本的人；24 小时内有效），不进审计。
// 依赖只有 @prisma/client 和 @node-rs/argon2（应用本身就用，standalone 产物里都有）。
import { enrollLink, newEnrollToken } from './enroll-token-lib.mjs';
import { ARGON, MESSAGES, USAGE, adminGateError, firstLine, isProductionEnv, parseArgs, passwordPolicyError, passwordSource, takeEnvPassword } from './admin-create-lib.mjs';

// 第一件事：把环境变量里的密码取出并从 process.env 删除
const envPassword = takeEnvPassword(process.env);

function fail(code, exitCode = 1) {
  console.error(MESSAGES[code] ?? MESSAGES.db_error);
  process.exit(exitCode);
}

/** 终端里不回显地读一行（raw mode），Ctrl-C 取消 */
function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); fail('aborted', 130); }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stderr.write('\n');
          return resolve(buf);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinLine() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) { data += chunk; if (data.includes('\n') || data.length > 4096) break; }
  return firstLine(data);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.error) fail(args.error);
  if (args.help) { console.log(USAGE); return; }
  // #323：生产环境下 ADMIN_CREATE_PASSWORD 非空直接拒绝，先于 TTY 判断，也先于连库检查
  const src = passwordSource({ isTTY: !!process.stdin.isTTY, envPassword, production: isProductionEnv(process.env) });
  if (src === 'env_refused') fail('env_refused');
  if (!process.env.DATABASE_URL) fail('no_database');
  let password;
  if (src === 'tty') {
    password = await readHidden('新管理员密码（不回显）：');
    const again = await readHidden('再输一次：');
    if (password !== again) fail('password_mismatch');
  } else password = src === 'env' ? envPassword : await readStdinLine();
  if (!password) fail('no_password');
  const policy = passwordPolicyError(password, args.email);
  if (policy) fail(policy);

  const [{ PrismaClient }, { hash }] = await Promise.all([import('@prisma/client'), import('@node-rs/argon2')]);
  const passwordHash = await hash(password, ARGON);
  password = undefined;
  const prisma = new PrismaClient({ log: [] });
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 同一时间只允许一个建号脚本在跑，避免并发下“已有管理员”检查被绕过
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin-create-cli'))`;
      const [existingAdmins, taken] = await Promise.all([
        tx.user.count({ where: { role: 'ADMIN' } }),
        tx.user.findUnique({ where: { email: args.email }, select: { id: true } }),
      ]);
      const gate = adminGateError({ existingAdmins, emailTaken: !!taken, allowAdditionalAdmin: args.allowAdditionalAdmin });
      if (gate) return { gate };
      const now = new Date();
      const t = newEnrollToken(now.getTime());
      const u = await tx.user.create({ data: { email: args.email, name: args.name, role: 'ADMIN', passwordHash, enrollIssuedAt: now, ...t.data }, select: { id: true } });
      // 审计：只记录角色和来源，不含密码、哈希、邮箱或绑定令牌
      await tx.auditLog.create({ data: { actorId: null, action: 'user.create', target: u.id, meta: { role: 'ADMIN', via: 'cli:admin-create', additional: existingAdmins > 0 } } });
      await tx.auditLog.create({ data: { actorId: null, action: 'auth.enroll_token_issued', target: u.id, meta: { source: 'cli', truncated: t.expiresTruncated } } });
      return { id: u.id, token: t.token, expiresAt: t.expiresAt };
    });
    if (result.gate) fail(result.gate);
    console.log(`已创建管理员 ${args.email}（id ${result.id}）。首次登录需先用下面的一次性链接绑定 2FA。`);
    // 绑定链接只打印这一次（stdout，给运行脚本的人），有效期见下；只私信发给本人，不要贴进群聊、工单或日志
    console.log(`绑定链接（只显示一次，有效至 ${result.expiresAt.toISOString()}）：${enrollLink(result.token, process.env)}`);
  } catch (e) {
    // 不输出底层异常信息（可能带连接串等），只给错误类型 / Prisma 错误码
    const code = typeof e?.code === 'string' && /^P\d{4}$/.test(e.code) ? e.code : e?.name ?? 'Error';
    console.error(`${MESSAGES.db_error}（${code}）`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`${MESSAGES.db_error}（${e?.name ?? 'Error'}）`);
  process.exit(1);
});
