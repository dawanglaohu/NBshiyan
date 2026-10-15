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
