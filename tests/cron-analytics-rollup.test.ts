import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('analytics-aggregate 每 5 分钟经 operations 在容器内调度，命令行只有 process.env.CRON_SECRET', () => {
  const text = readFileSync('deploy/cron.nbshiyan', 'utf8');
  const lines = text.split(/\r?\n/);
  const line = lines.find((row) => row.includes('/api/admin/cron/operations'));
  assert.ok(line);
  assert.match(line, /^\*\/5 \* \* \* \*/);
  assert.match(line, /process\.env\.CRON_SECRET/);
  assert.equal(line.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
  assert.match(line, /AbortSignal\.timeout\(55000\)/);
  assert.match(line, /r\.status===409/);
  assert.match(line, /normal skip, not a failure/);
  assert.match(line, /jobKey:'analytics-aggregate'/);
  assert.match(line, />> @DATA_DIR@\/cron-analytics-aggregate\.log 2>&1$/);
  assert.equal(
    lines.some((row) => row.includes('/api/admin/cron/analytics-rollup')),
    false,
    '旧五分钟 rollup 行必须已移除，不能双写',
  );
});

test('汇总失败只调用一次告警，审计抛错不会再进外层告警', () => {
  const route = readFileSync('src/app/api/admin/cron/analytics-rollup/route.ts', 'utf8');
  assert.equal((route.match(/alertAnalyticsRollupIssue\(/g) ?? []).length, 1);
  assert.match(route, /analytics rollup alert audit failed/);
  const failed = route.slice(route.indexOf("result.status === 'failed'"));
  assert.equal(failed.includes('alertAnalyticsRollupIssue'), false);
  assert.match(failed, /reportRollupFailure\(/);
});
