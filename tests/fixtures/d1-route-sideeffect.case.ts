// D1 退役路由「真实调用计数」回归用例（子进程执行，需 --experimental-test-module-mocks）。
//
// 为什么单独成文件：Node 的 mock.module 必须在进程启动时带 flag，且必须在路由模块首次导入前注册，
// 所以不能在默认测试进程里做，而由 tests/d1-route-sideeffect.test.ts 以子进程方式拉起。
//
// 被测对象（同一套断言）：
//   - 默认：工作树当前路由，先复制进本进程独占的临时目录再加载，字节必须一致
//   - D1_ROUTE_REV=<rev>：从该 Git 提交取出旧路由源码写入同一独占目录再加载
//     （只在本机全量克隆可用；CI 是浅克隆，默认入口不依赖它）
//
// 临时目录归属：mkdtemp 唯一目录，进程退出时只删自己这一个；固定路径与父目录一律不碰。
//
// 隔离：db / 聚合 / 告警 / 审计 / 邮件全部用哨兵替身，不连真实 DB、不发 SMTP；鉴权走真实 secretMatches。
import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const ROUTE_REL = 'src/app/api/admin/cron/analytics-rollup/route.ts';
const OLD_REV = process.env.D1_ROUTE_REV?.trim() || null;
const SECRET = 'd1-sideeffect-cron-secret-not-a-real-value';

const RESULTS_DIR = path.join(ROOT, 'test-results');

// 本进程独占目录：mkdtemp 生成唯一名字，前后缀都不与历史固定路径 `.d1-route-sideeffect` 冲突，
// 因此哪怕旧目录还被别的东西留着，也不会被这里匹配或删除。
mkdirSync(RESULTS_DIR, { recursive: true });
const OWNED_DIR = mkdtempSync(path.join(RESULTS_DIR, '.d1-route-sideeffect-'));
const OWNED_ROUTE = path.join(OWNED_DIR, 'route.ts');

/** 只清理本进程创建的那一个目录；重复调用安全（after 与 exit 双保险） */
function removeOwnedDir() {
  rmSync(OWNED_DIR, { recursive: true, force: true });
}
process.on('exit', removeOwnedDir);

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
let previousSecret: string | undefined;

before(async () => {
  previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;

  let text: string;
  let source: string;
  let blob: string | undefined;
  if (OLD_REV) {
    text = execFileSync('git', ['show', `${OLD_REV}:${ROUTE_REL}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    source = `git ${OLD_REV}:${ROUTE_REL}`;
    blob = execFileSync('git', ['rev-parse', `${OLD_REV}:${ROUTE_REL}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  } else {
    text = readFileSync(path.join(ROOT, ROUTE_REL), 'utf8');
    source = `worktree ${ROUTE_REL}`;
  }

  writeFileSync(OWNED_ROUTE, text, 'utf8');
  // 字节身份：源码 → 临时副本必须一致，加载的就是被测实现本身
  const onDisk = readFileSync(OWNED_ROUTE, 'utf8');
  assert.equal(sha256(onDisk), sha256(text), '临时目录里的路由副本必须与源码逐字节一致');

  route = (await import(pathToFileURL(OWNED_ROUTE).href)) as RouteModule;

  console.log(
    // 用正斜杠输出：TAP 诊断行会再转义一次反斜杠，原样输出 Windows 路径无法稳定解析
    `[d1-sideeffect] tmpdir ${JSON.stringify({ dir: OWNED_DIR.split(path.sep).join('/'), owned: true, pid: process.pid })}`,
  );
  console.log(
    `[d1-sideeffect] 被测路由 ${JSON.stringify({
      source,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256(text),
      ...(blob ? { blob } : {}),
    })}`,
  );
});

after(() => {
  removeOwnedDir();
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
