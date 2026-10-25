#!/usr/bin/env node
// 给还没绑定 2FA 的 ADMIN 重设初始密码（服务器上运行，只有命令行，没有任何 HTTP 接口）。规则见 admin-reset-initial-password-lib.mjs 文件头。
//   docker compose … exec -it app node scripts/admin-reset-initial-password.mjs --email <邮箱> [--clear-pending-enroll]
//   （或 --id <账号 id>。stdin 和 stdout 都必须是终端；否则退出码 2，什么都不改。不从标准输入读密码。）
// 密码：只在终端里交互输入（不回显，输两次）。不接受命令行参数、环境变量和标准输入（ADMIN_RESET_PASSWORD 等会被删除、从不读取）。
// 密码绝不进日志、异常信息或审计记录。规则与后台改密码相同（12–200 位，不能等于邮箱），哈希与登录校验同一套 argon2id 参数。
// TOTP 已启用一律拒绝；有未完成的绑定或绑定窗口已关闭时需加 --clear-pending-enroll。
// #347：成功后在终端显示一次 2FA 绑定链接；stdin 或 stdout 不是终端时拒绝运行（退出码 2），所以必须用 exec -it。
// 退出码：0 成功；1 运行错误；2 参数错误 / stdin 或 stdout 不是终端；3 账号状态不允许。
// 依赖只有 @prisma/client 和 @node-rs/argon2（应用本身就用，standalone 产物里都有）。
import { ARGON, MESSAGES, runReset, stripPasswordEnv } from './admin-reset-initial-password-lib.mjs';

// 第一件事：删掉可能被误设的密码环境变量（只删不读）
const ignored = stripPasswordEnv(process.env);
if (ignored.length) process.stderr.write(`已忽略并删除环境变量 ${ignored.join(', ')}：本脚本只从终端读密码。\n`);

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
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write(`\n${MESSAGES.aborted}\n`); process.exit(130); }
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

async function readPassword() {
  // runReset 在调用前已经拒绝非终端 stdin。这里再挡一次，避免任何从管道读密码的路径。
  if (process.stdin.isTTY !== true) return { error: 'stdin_not_tty' };
  const pw = await readHidden('新的初始密码（不回显）：');
  const again = await readHidden('再输一次：');
  return pw === again ? pw : { error: 'password_mismatch' };
}

const code = await runReset({
  argv: process.argv.slice(2),
  env: process.env,
  readPassword,
  db: async () => {
    const { PrismaClient } = await import('@prisma/client');
    return new PrismaClient({ log: [], errorFormat: 'minimal' });
  },
  hash: async (pw) => (await import('@node-rs/argon2')).hash(pw, ARGON),
  // 不传 fetchImpl：upstash 走 https.request，按环境变量 NODE_EXTRA_CA_CERTS 附加内部 CA（进程启动后才写这个变量对 fetch 无效）
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdoutIsTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY,
}).catch((e) => { process.stderr.write(`${MESSAGES.db_error}（${e?.name ?? 'Error'}）\n`); return 1; });
process.exitCode = code;
