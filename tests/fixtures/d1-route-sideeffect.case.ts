// D1 退役路由「真实调用计数」回归用例（子进程执行，需 --experimental-test-module-mocks）。
//
// 为什么单独成文件：Node 的 mock.module 必须在进程启动时带 flag，且必须在路由模块首次导入前注册，
// 所以不能在默认测试进程里做，而由 tests/d1-route-sideeffect.test.ts 以子进程方式拉起。
//
// 被测对象（二选一，同一套断言）：
//   - 默认：工作树当前路由（新实现，期望 410 + 业务调用数 0）
//   - D1_ROUTE_REV=<rev>：从该 Git 提交取出旧路由源码，写入 test-results/ 下的临时目录再加载
//     （不切换工作树、不改主检出、不改写旧路由业务逻辑；只用于红证据）
//
// 隔离：db / 聚合 / 告警 / 审计 / 邮件全部用哨兵替身，不连真实 DB、不发 SMTP；鉴权走真实 secretMatches。
import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const ROUTE_REL = 'src/app/api/admin/cron/analytics-rollup/route.ts';
const OLD_REV = process.env.D1_ROUTE_REV?.trim() || null;
const SECRET = 'd1-sideeffect-cron-secret-not-a-real-value';
const TMP_DIR = path.join(ROOT, 'test-results', '.d1-route-sideeffect');

const RETIRED_BODY = {
  error: 'route_retired',
  replacement: 'POST /api/admin/cron/operations',
  jobKey: 'analytics-aggregate',
};
const ZERO = { run: 0, alert: 0, audit: 0, mail: 0, prisma: 0 };

/** 业务调用计数：任何一项不为 0 都说明退役路由仍有副作用 */
const counters = { run: 0, alert: 0, audit: 0, mail: 0, prisma: 0 };

type Outcome = 'succeeded' | 'busy' | 'failed' | 'throws';
let outcome: Outcome = 'succeeded';

function resetCounters() {
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const srcUrl = (rel: string) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

// 哨兵：被计数或直接抛错，绝不落到真实实现
const prismaSentinel = new Proxy(
  {},
  {
    get() {
      counters.prisma += 1;
      throw new Error('D1 哨兵：退役路由触碰了 prisma，隔离未生效');
    },
  },
);

mock.module(srcUrl('lib/server/db.ts'), { namedExports: { prisma: prismaSentinel } });
mock.module(srcUrl('lib/server/analytics/rollup.ts'), {
  namedExports: {
    runAnalyticsRollup: async () => {
      counters.run += 1;
      if (outcome === 'throws') throw new Error('D1 哨兵：聚合失败');
      if (outcome === 'busy') return { status: 'busy' };
      if (outcome === 'failed') return { status: 'failed', errorCode: 'internal_error', days: 0 };
      return { status: 'succeeded', days: 1, eventCount: 3 };
    },
  },
});
mock.module(srcUrl('lib/server/cron-alert.ts'), {
  namedExports: {
    alertAnalyticsRollupIssue: async () => {
      counters.alert += 1;
    },
  },
});
mock.module(srcUrl('lib/server/admin/audit.ts'), {
  namedExports: {
    audit: async () => {
      counters.audit += 1;
    },
  },
});
mock.module(srcUrl('lib/server/mail.ts'), {
  namedExports: {
    errorSummary: (error: unknown) => ({ message: String(error) }),
    sendAdminAlert: async () => {
      counters.mail += 1;
    },
  },
});

type RouteModule = { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> };
let route: RouteModule;
let identity: { route: string; bytes: number; sha256: string; blob?: string };
let previousSecret: string | undefined;

before(async () => {
  previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;

  if (OLD_REV) {
    const text = execFileSync('git', ['show', `${OLD_REV}:${ROUTE_REL}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    const file = path.join(TMP_DIR, 'route.ts');
    writeFileSync(file, text, 'utf8');
    route = (await import(pathToFileURL(file).href)) as RouteModule;
    identity = {
      route: `git ${OLD_REV}:${ROUTE_REL} → test-results/.d1-route-sideeffect/route.ts`,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256(text),
      blob: execFileSync('git', ['rev-parse', `${OLD_REV}:${ROUTE_REL}`], { cwd: ROOT, encoding: 'utf8' }).trim(),
    };
  } else {
    const file = path.join(ROOT, ROUTE_REL);
    const text = readFileSync(file, 'utf8');
    route = (await import(pathToFileURL(file).href)) as RouteModule;
    identity = { route: `worktree ${ROUTE_REL}`, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) };
  }
  console.log(`[d1-sideeffect] 被测路由 ${JSON.stringify(identity)}`);
});

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

function request(method: 'GET' | 'POST', token?: string) {
  return new Request('http://127.0.0.1/api/admin/cron/analytics-rollup', {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function invoke(method: 'GET' | 'POST', token?: string) {
  const response = await route[method](request(method, token));
  const body = (await response.json()) as unknown;
  return { status: response.status, cacheControl: response.headers.get('cache-control'), body };
}

test('鉴权：缺凭据与错凭据都 401，且不触发任何业务调用（真实 secretMatches）', async () => {
  resetCounters();
  const missing = await invoke('GET');
  const wrong = await invoke('POST', 'wrong-token');
  assert.deepEqual(
    { missingStatus: missing.status, wrongStatus: wrong.status, wrongBody: wrong.body, counters: { ...counters } },
    { missingStatus: 401, wrongStatus: 401, wrongBody: { error: 'unauthorized' }, counters: ZERO },
    `401 分支不得进入业务链；实测 counters=${JSON.stringify(counters)}`,
  );
});

test('合法 Bearer GET（聚合成功分支）：必须 410、no-store、退役码，且业务调用数全为 0', async () => {
  outcome = 'succeeded';
  resetCounters();
  const observed = await invoke('GET', SECRET);
  assert.deepEqual(
    { ...observed, counters: { ...counters } },
    { status: 410, cacheControl: 'no-store', body: RETIRED_BODY, counters: ZERO },
    `退役路由不得执行聚合：实测 counters=${JSON.stringify(counters)}`,
  );
});

test('合法 Bearer POST（聚合返回 failed 分支）：必须 410 且不发告警、不写审计', async () => {
  outcome = 'failed';
  resetCounters();
  const observed = await invoke('POST', SECRET);
  assert.deepEqual(
    { ...observed, counters: { ...counters } },
    { status: 410, cacheControl: 'no-store', body: RETIRED_BODY, counters: ZERO },
    `退役路由不得告警/审计：实测 counters=${JSON.stringify(counters)}`,
  );
});

test('合法 Bearer GET（聚合返回 busy 分支）：必须 410，不得回 409', async () => {
  outcome = 'busy';
  resetCounters();
  const observed = await invoke('GET', SECRET);
  assert.deepEqual(
    { ...observed, counters: { ...counters } },
    { status: 410, cacheControl: 'no-store', body: RETIRED_BODY, counters: ZERO },
    `退役路由不得进入租约分支：实测 counters=${JSON.stringify(counters)}`,
  );
});

test('合法 Bearer GET（聚合抛错分支）：必须 410，不落失败告警链', async () => {
  outcome = 'throws';
  resetCounters();
  const observed = await invoke('GET', SECRET);
  assert.deepEqual(
    { ...observed, counters: { ...counters } },
    { status: 410, cacheControl: 'no-store', body: RETIRED_BODY, counters: ZERO },
    `退役路由不得走失败告警链：实测 counters=${JSON.stringify(counters)}`,
  );
});
