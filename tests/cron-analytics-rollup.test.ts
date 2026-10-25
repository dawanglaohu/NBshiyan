import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('analytics-rollup 每 5 分钟在容器内调度，命令行只有 process.env.CRON_SECRET', () => {
  const text = readFileSync('deploy/cron.nbshiyan', 'utf8');
  const line = text.split(/\r?\n/).find((row) => row.includes('/api/admin/cron/analytics-rollup'));
  assert.ok(line);
  assert.match(line, /^\*\/5 \* \* \* \*/);
  assert.match(line, /process\.env\.CRON_SECRET/);
  assert.equal(line.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
  assert.match(line, /AbortSignal\.timeout\(240000\)/);
  assert.match(line, /r\.status===409/);
  assert.match(line, /normal skip, not a failure/);
  assert.match(line, />> @DATA_DIR@\/cron-analytics-rollup\.log 2>&1$/);
  assert.doesNotMatch(line, /\bmethod\s*:/);
});

test('汇总失败只调用一次告警，审计抛错不会再进外层告警', () => {
  const route = readFileSync('src/app/api/admin/cron/analytics-rollup/route.ts', 'utf8');
  assert.equal((route.match(/alertAnalyticsRollupIssue\(/g) ?? []).length, 1);
  assert.match(route, /analytics rollup alert audit failed/);
  const failed = route.slice(route.indexOf("result.status === 'failed'"));
  assert.equal(failed.includes('alertAnalyticsRollupIssue'), false);
  assert.match(failed, /reportRollupFailure\(/);
});
