import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync('launch-runbook.md', 'utf8');

test('launch-runbook.md exists at the path code references and keeps the deploy/rollback rules', () => {
  assert.match(doc, /先\*\* 对生产库执行 `prisma db push`，\*\*再\*\* 部署代码/);
  assert.match(doc, /additive-only/);
  assert.match(doc, /回滚：只回滚代码/);
  assert.match(doc, /永远不要用旧 schema 再跑 `prisma db push`/);
  assert.match(doc, /RETENTION_RUN_DEADLINE_MS/); // 被 .env.example / cron 路由引用
  assert.match(doc, /每批 500 条/); // 被 privacy.ts 引用
});

test('launch-runbook.md contains no connection strings, secrets or local paths', () => {
  assert.doesNotMatch(doc, /postgres(ql)?:\/\/|rediss?:\/\/|\.upstash\.io|r2\.cloudflarestorage\.com/i);
  assert.doesNotMatch(doc, /\/workspace\//);
  assert.doesNotMatch(doc, /(re_|sk_|whsec_)[A-Za-z0-9]{16,}/);
});

test('launch-runbook.md documents the manual deletion step for the notification inbox', () => {
  assert.match(doc, /INQUIRY_NOTIFY_EMAIL/);
  assert.match(doc, /30 天内/);
  assert.match(doc, /Resend/);
});

const ADMIN_DOCS = ['deploy/README.md', 'launch-runbook.md', 'docs/launch-infra.md'] as const;

/** 命令行才算示例。镜像文件清单里的脚本名不是调用。 */
function adminCliLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) =>
    /node\s+scripts\/admin-create\.mjs/.test(line) || /node\s+scripts\/admin-reset-initial-password\.mjs/.test(line));
}

test('admin-create and reset examples allocate a terminal', () => {
  for (const path of ADMIN_DOCS) {
    const lines = adminCliLines(readFileSync(path, 'utf8'));
    assert.ok(lines.length > 0, path);
    for (const line of lines) {
      assert.match(line, /docker compose exec -it|\$DC exec -it|run --rm -it/);
      assert.doesNotMatch(line, /exec -T\b/);
      assert.doesNotMatch(line, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  }
});

test('the three deploy docs state the no-terminal and private-link contracts', () => {
  const readme = readFileSync('deploy/README.md', 'utf8');
  assert.match(readme, /exits 2 and changes nothing/);
  assert.match(readme, /Feeding a password on standard input is invalid/);
  assert.match(readme, /the account is still created, but the script does not issue or display the binding link/);
  assert.match(readme, /Send the binding link only in private to the account owner/);

  for (const path of ['launch-runbook.md', 'docs/launch-infra.md'] as const) {
    const text = readFileSync(path, 'utf8');
    assert.match(text, /没有终端时退出 2，什么都不改/);
    assert.match(text, /从标准输入喂密码的旧用法已失效/);
    assert.match(text, /没有终端时会建号，但不签发、不显示绑定链接/);
    assert.match(text, /绑定链接只私下发给账号本人/);
  }

  assert.match(doc, /### 4\.4 重设未绑定管理员的初始密码/);
  assert.match(doc, /\[deploy\/README\.md\]\(deploy\/README\.md\) 的 “Reset the initial password of an unbound ADMIN”/);
});
