import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GET, POST } from '../src/app/api/admin/cron/analytics-rollup/route';

const OPERATIONS_PATH = '/api/admin/cron/operations';
const AGGREGATE_JOB_KEY = "jobKey:'analytics-aggregate'";

/**
 * 只挑 analytics-aggregate 的 operations 行：retention 行的注释里也有
 * `analytics-aggregate` 字样，不能按子串或“第一条 operations”选。
 */
function aggregateOperationLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((row) => row.includes(OPERATIONS_PATH) && row.includes(AGGREGATE_JOB_KEY));
}

function uniqueAggregateOperationLine(text: string): string {
  const matches = aggregateOperationLines(text);
  assert.equal(matches.length, 1, `operations 调度中必须恰好一条 analytics-aggregate，实际 ${matches.length} 条`);
  return matches[0] as string;
}

test('analytics-aggregate 每 5 分钟经 operations 在容器内调度，命令行只有 process.env.CRON_SECRET', () => {
  const text = readFileSync('deploy/cron.nbshiyan', 'utf8');
  const lines = text.split(/\r?\n/);
  const line = uniqueAggregateOperationLine(text);
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

test('cron 选择器：缺失或重复 analytics-aggregate 都必须拒绝', () => {
  const retention = `30 4 * * * root node -e "fetch('http://127.0.0.1:3000${OPERATIONS_PATH}',{body:JSON.stringify({jobKey:'analytics-retention'})})" >> log 2>&1 /* analytics-aggregate lease held */`;
  const aggregate = `*/5 * * * * root node -e "fetch('http://127.0.0.1:3000${OPERATIONS_PATH}',{body:JSON.stringify({jobKey:'analytics-aggregate'})})" >> log 2>&1`;
  assert.throws(() => uniqueAggregateOperationLine(`${retention}\n`), /恰好一条/);
  assert.throws(() => uniqueAggregateOperationLine(`${retention}\n${aggregate}\n${aggregate}\n`), /恰好一条/);
});

test('cron 选择器：retention/其它 operations 行在前或在后都不影响 aggregate 选择', () => {
  const retention = `30 4 * * * root node -e "fetch('http://127.0.0.1:3000${OPERATIONS_PATH}',{body:JSON.stringify({jobKey:'analytics-retention'})})" >> log 2>&1 /* analytics-aggregate lease held */`;
  const aggregate = `*/5 * * * * root node -e "fetch('http://127.0.0.1:3000${OPERATIONS_PATH}',{body:JSON.stringify({jobKey:'analytics-aggregate'})})" >> log 2>&1`;
  const other = `15 5 * * * root node -e "fetch('http://127.0.0.1:3000${OPERATIONS_PATH}',{body:JSON.stringify({jobKey:'chat-notifications'})})" >> log 2>&1`;
  assert.equal(uniqueAggregateOperationLine(`${retention}\n${aggregate}\n`), aggregate);
  assert.equal(uniqueAggregateOperationLine(`${aggregate}\n${retention}\n`), aggregate);
  assert.equal(uniqueAggregateOperationLine(`${other}\n${retention}\n${aggregate}\n${other}\n`), aggregate);
});

test('退役旧 rollup 路由：鉴权后统一 410、指向 operations，且零写副作用', async () => {
  const route = readFileSync('src/app/api/admin/cron/analytics-rollup/route.ts', 'utf8');
  // 零副作用：不得再引用数据库、聚合、邮件或审计
  for (const forbidden of ['prisma', 'runAnalyticsRollup', 'alertAnalyticsRollupIssue', 'sendAdminAlert', 'audit(']) {
    assert.equal(route.includes(forbidden), false, `退役路由不应引用 ${forbidden}`);
  }
  // 鉴权保留
  assert.match(route, /secretMatches\(token, process\.env\.CRON_SECRET\)/);

  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'unit-test-cron-secret-not-a-real-value';
  try {
    const request = (method: 'GET' | 'POST') => new Request('http://127.0.0.1/api/admin/cron/analytics-rollup', {
      method,
      headers: { authorization: 'Bearer unit-test-cron-secret-not-a-real-value' },
    });
    for (const method of ['GET', 'POST'] as const) {
      const response = await (method === 'GET' ? GET(request('GET')) : POST(request('POST')));
      assert.equal(response.status, 410, `${method} 必须返回 410 Gone`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as { error?: string; replacement?: string };
      assert.equal(body.error, 'route_retired');
      assert.equal(body.replacement, 'POST /api/admin/cron/operations');
      assert.equal(JSON.stringify(body).includes('unit-test-cron-secret'), false);
    }
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
