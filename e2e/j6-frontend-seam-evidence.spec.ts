import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, test, type APIRequestContext, type BrowserContext, type Page, type Request as PlaywrightRequest, type Response, type TestInfo } from '@playwright/test';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { products as FALLBACK_PRODUCTS } from '../src/data/products';
import { mergeCatalog, withPublishedReady, type CatalogModel } from '../src/lib/catalog/catalog';
import { categorySlugs } from '../src/lib/seo/categorySlugs';

/**
 * J6 前台主流程接缝证据补采（opt-in，不是产品测试，不进默认 A3）。
 *
 * 只补同构建里**没有机器可核联结**的那一段：真实 `/en` 导航与 SSR 目录、
 * 同意前零写入、真实控件接受分析后的 page_view、真实 GLB 200、同一 viewId 的
 * start/terminal、同一 navigationId 的 page_view、事件经真实注册的
 * analytics-aggregate 作业写进 T12 `AnalyticsDaily` 的前后日行与增量，
 * 以及同意撤回与独立拒绝上下文的零写入边界。
 *
 * 不注册任何 page.route / route.fulfill / route.abort，不写 localStorage、
 * 不直接 INSERT/UPDATE/DELETE，不复制模型素材；只读 DB 的 SELECT/COUNT。
 *
 * 启用：J6_SEAM_EVIDENCE=1（未启用时本文件不注册任何用例，默认 A3 244 不变）。
 * 必填：J6_SEAM_RUN_DIR、J6_SEAM_EVIDENCE_ROOT、DATABASE_URL（或 M5T8_TEST_DATABASE_URL）、CRON_SECRET。
 * 只允许在**没有并发调度**的专属实例上跑；看到 409 直接失败，不当作本轮覆盖。
 */
const ENABLED = process.env.J6_SEAM_EVIDENCE === '1';
const ORIGIN = `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;
const DB_URL = process.env.DATABASE_URL ?? process.env.M5T8_TEST_DATABASE_URL;
const M5T8_DB_URL = process.env.M5T8_TEST_DATABASE_URL;
const APP_DB_URL = process.env.DATABASE_URL;
const BUILD_ID_PATH = process.env.J6_BUILD_ID_PATH ?? path.join('.next', 'standalone', '.next', 'BUILD_ID');
const SERVER_ENTRY = path.join('.next', 'standalone', 'server.js');
const ANALYTICS_EVENTS = '/api/analytics/events';
const ANALYTICS_CONSENT = '/api/analytics/consent';
const OPERATIONS = '/api/admin/cron/operations';
const AGGREGATE_KEY = 'analytics-aggregate';
const TOKENS = {
  cssBg: '#ffffff',
  cssAccent: '#b45700',
  cssRadius: '0px',
  cssBorder: '2px',
  bodyBg: 'rgb(255, 255, 255)',
  bodyColor: 'rgb(0, 0, 0)',
  bodyFontSize: '16px',
  bodyLineHeight: '24px',
} as const;
const SOURCE_PATHS = [
  'e2e/brand-smoke.spec.ts',
  'e2e/model-events.spec.ts',
  'e2e/analytics-consent.spec.ts',
  'e2e/analytics-job-runtime.spec.ts',
  'e2e/j6-frontend-seam-evidence.spec.ts',
  'src/lib/client/analytics.ts',
  'src/lib/server/analytics/aggregate-repo.ts',
  'src/lib/server/jobs/registry.ts',
  // 日窗与 T12 汇总公式、目录→真实模型路径的固定来源。
  'src/lib/analytics/day-boundaries.ts',
  'src/lib/analytics/daily-aggregate.ts',
  'src/data/products.ts',
  'src/lib/catalog/catalog.ts',
  'src/lib/seo/categorySlugs.ts',
  'src/lib/server/published-models.ts',
] as const;

type SafeEvent = {
  kind: string;
  eventId: string;
  navigationId: string | null;
  viewId: string | null;
  productSlug: string | null;
  path: string | null;
  durationMs: number | null;
  occurredAt: string | null;
};

type GlbFact = {
  path: string;
  search: string;
  status: number;
  contentLength: number | null;
  contentType: string | null;
  fromServiceWorker: boolean;
  frameMain: boolean;
  pagePath: string | null;
  resourceType: string;
  servedFileSize: number | null;
  servedFileSha256: string | null;
  bodyBytes: number | null;
  bodySha256: string | null;
  requestAt: number;
  responseAt: number;
};

/**
 * 目录→真实模型路径：与 /en/products 的服务端组件同一条读取（Model3D 已上架行 +
 * withPublishedReady + mergeCatalog + products.ts 回退）。model 是页面真正交给 3D 卡的 URL。
 */
type CatalogBinding = {
  source: 'api' | 'fallback';
  slug: string;
  model: string;
  pathname: string;
  search: string;
  apiModelId: string | null;
  apiVersion: string | null;
  apiUpdatedAt: string | null;
};

type EventAssociation = {
  viewId: string;
  navigationId: string | null;
  productSlug: string;
  startEventId: string;
  terminalEventId: string;
  pageViewEventId: string;
  productViewEventId: string;
  oneTerminalForView: true;
};

type PersistedEventRow = {
  kind: string;
  eventId: string;
  viewId: string | null;
  navigationId: string | null;
  productSlug: string | null;
  path: string | null;
  durationMs: number | null;
  occurredAt: Date;
  receivedAt: Date;
};

type ConsentZeroStageInput = {
  navigatedPath: string;
  eventPosts: number;
  queueLength: number;
  cookiePresent: boolean;
  collecting: boolean;
  dbBefore: number;
  dbAfter: number;
  // 阶段身份：主上下文接受/撤回共用同一 nonce；独立拒绝必须是新上下文的新 nonce 且晚于撤回结束。
  contextNonce: string;
  startedAt: string;
  finishedAt: string;
};

type DailyRow = {
  dimension: string;
  localDate: string;
  visitors: number;
  pageViews: number | null;
  productViews: number;
  modelStarts: number;
  modelSuccesses: number;
  modelFailures: number;
  durationMsSum: string;
  sourceThrough: Date | null;
  timezone: string;
  timezoneRevision: number;
};

type JobStateRow = {
  generation: number;
  lastStatus: string;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lockedUntil: Date | null;
  summary: unknown;
};

type JobRound = {
  status: number;
  candidateCount: number | null;
  generation: number;
  startedAt: Date | null;
  succeededAt: Date | null;
  lockedUntil: Date | null;
  lastStatus: string;
};

type RunFile = {
  schema: 'j6-frontend-seam/2';
  captureGate: string;
  root: string;
  startedAt: string;
  finishedAt: string | null;
  closed: boolean;
  status: 'running' | 'passed' | 'failed';
  errors: string[];
  identity: Record<string, unknown>;
  sources: Array<{ path: string; sha256: string }>;
  evidence: Record<string, unknown>;
};

let run: RunFile | null = null;
let db: PrismaClient | undefined;

function database(): PrismaClient {
  if (!DB_URL) throw new Error('J6_SEAM_DB_MISSING：需要 DATABASE_URL 或 M5T8_TEST_DATABASE_URL');
  db ??= new PrismaClient({ datasources: { db: { url: DB_URL } } });
  return db;
}

/**
 * 应用实际 Prisma 连接上的 PG 身份三元组：库名、server_version_num、cluster 标识哈希。
 * runner 会用 postgres service 的 `docker exec … psql -d <同一库>` 独立读同一三元组并逐字段比对；
 * 三件只保留这个脱敏投影，原始 system identifier 不落盘、不进制品。
 */
type PgIdentity = {
  database: string;
  serverVersionNum: number;
  clusterSha256: string;
};

async function readPgIdentity(): Promise<PgIdentity> {
  let rows: Array<{ database: string; serverVersionNum: number | bigint; systemIdentifier: string }>;
  try {
    rows = await database().$queryRaw<Array<{ database: string; serverVersionNum: number; systemIdentifier: string }>>`
      SELECT current_database() AS database,
             current_setting('server_version_num')::int AS "serverVersionNum",
             (SELECT system_identifier FROM pg_control_system())::text AS "systemIdentifier"`;
  } catch (error) {
    throw new Error(`J6_SEAM_PG_IDENTITY_QUERY ${error instanceof Error ? error.message : String(error)}`);
  }
  const row = rows[0];
  if (!row) throw new Error('J6_SEAM_PG_IDENTITY_EMPTY');
  const dbName = String(row.database);
  if (!/^b10_j6_seam_[1-9][0-9]{0,19}_[1-9][0-9]{0,5}$/.test(dbName)) {
    throw new Error(`J6_SEAM_PG_DATABASE ${dbName}`);
  }
  const systemIdentifier = String(row.systemIdentifier);
  if (!/^[0-9]{1,20}$/.test(systemIdentifier)) throw new Error('J6_SEAM_PG_SYSTEM_IDENTIFIER');
  const serverVersionNum = Number(row.serverVersionNum);
  if (!Number.isInteger(serverVersionNum) || serverVersionNum < 170000 || serverVersionNum > 179999) {
    throw new Error(`J6_SEAM_PG_VERSION ${serverVersionNum}`);
  }
  return { database: dbName, serverVersionNum, clusterSha256: sha256Hex(systemIdentifier) };
}

function git(args: string[]): string {
  const out = execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (!out) throw new Error(`J6_SEAM_GIT_EMPTY git ${args.join(' ')}`);
  return out;
}

/** `git status --porcelain` 干净时输出为空，不能用上面的非空断言。 */
function gitStatusTracked(): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
}

function assertRepoRoot(): void {
  if (!existsSync(path.join('e2e', 'model-events.spec.ts')) || !existsSync(path.join('src', 'lib', 'client', 'analytics.ts'))) {
    throw new Error('J6_SEAM_WRONG_CWD：必须在验收 checkout 根目录运行');
  }
}

function hashFile(relative: string): string {
  if (!existsSync(relative)) throw new Error(`J6_SEAM_SOURCE_MISSING ${relative}`);
  return sha256Hex(readFileSync(relative));
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

/**
 * runner 身份只从 GitHub 环境读，不手设；缺省（本机）记 local，CI 里五字段必须齐全且合法。
 * 只存安全标识，不存 URL/令牌。
 */
function readRunnerIdentity(): Record<string, string | null> {
  const safe = (name: string, pattern: RegExp): string | null => {
    const value = process.env[name] ?? null;
    if (value !== null && !pattern.test(value)) throw new Error(`J6_SEAM_RUNNER_INVALID ${name}`);
    return value;
  };
  const runId = safe('GITHUB_RUN_ID', /^[1-9]\d{0,19}$/);
  const runAttempt = safe('GITHUB_RUN_ATTEMPT', /^[1-9]\d{0,5}$/);
  const job = safe('GITHUB_JOB', /^[A-Za-z0-9 ._-]{1,80}$/);
  const workflow = safe('GITHUB_WORKFLOW', /^[A-Za-z0-9 ._()/-]{1,120}$/);
  const ref = safe('GITHUB_REF', /^refs\/[A-Za-z0-9 ._()/-]{1,160}$/);
  if (ref !== null && ref.includes('..')) throw new Error('J6_SEAM_RUNNER_INVALID GITHUB_REF');
  const fields = [runId, runAttempt, job, workflow, ref];
  const anyPresent = fields.some((item) => item !== null);
  const allPresent = fields.every((item) => item !== null);
  if (anyPresent && !allPresent) {
    throw new Error('J6_SEAM_RUNNER_INCOMPLETE runner 五字段必须同时存在或同时缺省');
  }
  return { runId, runAttempt, job, workflow, ref, source: allPresent ? 'github' : 'local' };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`J6_SEAM_ENV_MISSING ${name}`);
  return value;
}

function requireRun(): RunFile {
  if (!run) throw new Error('J6_SEAM_RUN_NOT_STARTED');
  return run;
}

function writeRun(): void {
  const state = requireRun();
  const file = path.join(state.root, 'RUN.json');
  const tmp = `${file}.tmp`;
  const text = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(tmp, text);
  if (statSync(tmp).size !== Buffer.byteLength(text)) throw new Error('J6_SEAM_RUN_SIZE_MISMATCH');
  renameSync(tmp, file);
  if (readFileSync(file, 'utf8') !== text) throw new Error('J6_SEAM_RUN_READBACK_MISMATCH');
}

function beginRun(testInfo: TestInfo, browserVersion: string): RunFile {
  assertRepoRoot();
  // 应用的 DATABASE_URL 与测试读取必须是同一个库；不给“读到另一个库”的机会。
  if (!APP_DB_URL) throw new Error('J6_SEAM_DB_APP_MISSING：应用进程的 DATABASE_URL 未设置');
  if (M5T8_DB_URL && M5T8_DB_URL !== APP_DB_URL) {
    throw new Error('J6_SEAM_DB_MISMATCH：M5T8_TEST_DATABASE_URL 与 DATABASE_URL 不是同一个库');
  }
  const runDir = path.resolve(requireEnv('J6_SEAM_RUN_DIR'));
  const evidenceRootRaw = path.resolve(requireEnv('J6_SEAM_EVIDENCE_ROOT'));
  mkdirSync(evidenceRootRaw, { recursive: true });
  const evidenceRoot = realpathSync(evidenceRootRaw);
  if (!(runDir === evidenceRoot || runDir.startsWith(`${evidenceRoot}${path.sep}`))) {
    throw new Error(`J6_SEAM_RUN_OUTSIDE_ROOT ${runDir} !< ${evidenceRoot}`);
  }
  if (existsSync(path.join(runDir, 'RUN.json'))) throw new Error(`J6_SEAM_RUN_NOT_UNIQUE ${runDir}`);
  mkdirSync(runDir, { recursive: true });

  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const tree = git(['rev-parse', '--verify', 'HEAD^{tree}']);
  const dirtyTracked = gitStatusTracked();
  if (dirtyTracked) throw new Error(`J6_SEAM_DIRTY_TRACKED ${dirtyTracked.slice(0, 300)}`);
  const githubSha = process.env.GITHUB_SHA ?? null;
  if (githubSha && githubSha.toLowerCase() !== head.toLowerCase()) {
    throw new Error(`J6_SEAM_SHA_MISMATCH GITHUB_SHA=${githubSha} HEAD=${head}`);
  }
  if (!existsSync(SERVER_ENTRY)) throw new Error(`J6_SEAM_CARRIER_MISSING ${SERVER_ENTRY}`);
  if (!existsSync(BUILD_ID_PATH)) throw new Error(`J6_SEAM_BUILD_ID_MISSING ${BUILD_ID_PATH}`);
  const buildId = readFileSync(BUILD_ID_PATH, 'utf8').trim();
  if (!buildId) throw new Error(`J6_SEAM_BUILD_ID_EMPTY ${BUILD_ID_PATH}`);

  run = {
    schema: 'j6-frontend-seam/2',
    captureGate: 'J6_SEAM_EVIDENCE=1（只在采集进程，不设 job 级）',
    root: runDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    closed: false,
    status: 'running',
    errors: [],
    identity: {
      head,
      tree,
      githubSha,
      buildId,
      buildIdPath: BUILD_ID_PATH.replaceAll('\\', '/'),
      serverEntry: SERVER_ENTRY.replaceAll('\\', '/'),
      node: process.version,
      browserVersion,
      basePath: '/',
      originHost: 'localhost',
      originPort: Number(process.env.E2E_PORT ?? 3100),
      testTitle: testInfo.title,
      project: testInfo.project.name,
      // 同一 runner 的固定回执字段；checker 写 RUNNER-RECEIPT.json 时逐字段投影并绑定 RUN/CHECK 摘要。
      runner: readRunnerIdentity(),
    },
    sources: SOURCE_PATHS.map((relative) => ({ path: relative, sha256: hashFile(relative) })),
    evidence: {},
  };
  writeRun();
  console.log(`J6_SEAM_RUN_DIR=${runDir}`);
  return run;
}

function safeEvent(raw: unknown): SafeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  const kind = typeof event.kind === 'string' ? event.kind : null;
  const eventId = typeof event.eventId === 'string' ? event.eventId : null;
  if (!kind || !eventId) return null;
  const numberOrNull = typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) ? event.durationMs : null;
  const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    kind,
    eventId,
    navigationId: stringOrNull(event.navigationId),
    viewId: stringOrNull(event.viewId),
    productSlug: stringOrNull(event.productSlug),
    path: stringOrNull(event.path),
    durationMs: numberOrNull,
    occurredAt: stringOrNull(event.occurredAt),
  };
}

function parsePostedEvents(body: string | null): SafeEvent[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { events?: unknown };
    if (!Array.isArray(parsed.events)) return [];
    return parsed.events.flatMap((event) => {
      const fact = safeEvent(event);
      return fact ? [fact] : [];
    });
  } catch {
    return [];
  }
}

function canonicalPath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

type J6NetworkScope = 'main' | 'rejected';
type J6NetworkWindow = {
  scope: J6NetworkScope;
  contextNonce: string;
  startedAt: string;
  finishedAt: string;
  guardedPages: number;
  sameOriginRequests: number;
  sameOriginResponses: number;
  sameOriginNetworkFailures: number;
  sameOriginDocumentSuccesses: number;
  serviceWorkerHits: number;
  registeredRoutes: number;
  blocked: string[];
};

const ROUTING_METHODS = ['route', 'routeFromHAR', 'routeWebSocket', 'addInitScript'] as const;

function lockJ6NetworkMethods(target: object, names: readonly string[], onBlocked: (name: string) => void): () => void {
  const owned: Array<[string, () => never]> = [];
  for (const name of names) {
    if (typeof Reflect.get(target, name) !== 'function') throw new Error('J6_SEAM_NETWORK_GUARD');
    const blocker = () => {
      onBlocked(name);
      throw new Error('J6_SEAM_NETWORK_INTERVENTION');
    };
    Object.defineProperty(target, name, { value: blocker, configurable: false, writable: false });
    owned.push([name, blocker]);
  }
  return () => {
    for (const [name, blocker] of owned) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor?.value !== blocker || descriptor.configurable !== false || descriptor.writable !== false) {
        throw new Error('J6_SEAM_NETWORK_GUARD');
      }
    }
  };
}

function j6RegisteredRoutes(target: BrowserContext | Page): number {
  // Playwright 1.64 client route registries. An unknown registry shape cannot establish the no-route proof.
  return ['_routes', '_webSocketRoutes', '_harRouters'].reduce((total, key) => {
    const registry: unknown = Reflect.get(target, key);
    if (!Array.isArray(registry)) throw new Error('J6_SEAM_NETWORK_GUARD');
    return total + registry.length;
  }, 0);
}

function observeJ6Network(context: BrowserContext, origin: string, scope: J6NetworkScope, contextNonce: string) {
  if (context.pages().length !== 0 || j6RegisteredRoutes(context) !== 0) throw new Error('J6_SEAM_NETWORK_GUARD');
  const blocked = new Set<string>();
  const onBlocked = (name: string) => blocked.add(name);
  const verifyContext = lockJ6NetworkMethods(context, [...ROUTING_METHODS, 'newCDPSession', 'setOffline'], onBlocked);
  const pages = new Map<Page, () => void>();
  const onPage = (page: Page) => {
    if (j6RegisteredRoutes(page) !== 0) throw new Error('J6_SEAM_NETWORK_GUARD');
    pages.set(page, lockJ6NetworkMethods(page, ROUTING_METHODS, onBlocked));
  };
  const sameOrigin = (url: string) => URL.canParse(url) && new URL(url).origin === origin;
  let requests = 0;
  let responses = 0;
  let failures = 0;
  let documentSuccesses = 0;
  let serviceWorkerHits = 0;
  const onRequest = (req: PlaywrightRequest) => {
    if (!sameOrigin(req.url())) return;
    requests += 1;
    if (req.serviceWorker()) serviceWorkerHits += 1;
  };
  const onResponse = (res: Response) => {
    if (!sameOrigin(res.url())) return;
    responses += 1;
    if (res.fromServiceWorker()) serviceWorkerHits += 1;
    if (res.request().isNavigationRequest() && res.ok() && !res.fromServiceWorker()) documentSuccesses += 1;
  };
  const onFailure = (req: PlaywrightRequest) => {
    if (sameOrigin(req.url())) failures += 1;
  };
  const startedAt = new Date().toISOString();
  context.on('page', onPage);
  context.on('request', onRequest);
  context.on('response', onResponse);
  context.on('requestfailed', onFailure);
  return () : J6NetworkWindow => {
    verifyContext();
    let registeredRoutes = j6RegisteredRoutes(context);
    for (const [page, verifyPage] of pages) {
      verifyPage();
      registeredRoutes += j6RegisteredRoutes(page);
    }
    if (registeredRoutes !== 0 || !pages.size || !requests || !responses || !documentSuccesses
        || responses > requests || failures > requests) throw new Error('J6_SEAM_NETWORK_GUARD');
    const finishedAt = new Date().toISOString();
    context.off('requestfailed', onFailure);
    context.off('response', onResponse);
    context.off('request', onRequest);
    context.off('page', onPage);
    return {
      scope, contextNonce, startedAt, finishedAt, guardedPages: pages.size,
      sameOriginRequests: requests, sameOriginResponses: responses, sameOriginNetworkFailures: failures,
      sameOriginDocumentSuccesses: documentSuccesses, serviceWorkerHits, registeredRoutes, blocked: [...blocked].sort(),
    };
  };
}

function projectJ6Network(windows: readonly J6NetworkWindow[], browserBlocked: ReadonlySet<string>) {
  // An observed empty routing registry and sealed entry points bound both route terminal actions to zero.
  const routes = windows.reduce((total, window) => total + window.registeredRoutes, 0);
  return {
    sameOriginFulfilled: routes,
    sameOriginAborted: routes,
    serviceWorker: windows.some((window) => window.serviceWorkerHits > 0),
    intercepted: [...new Set([...browserBlocked, ...windows.flatMap((window) => window.blocked)])].sort(),
  };
}

async function queueLength(page: Page): Promise<number> {
  const raw = await page.locator('html').getAttribute('data-analytics-queue');
  return Number(raw ?? '0');
}

async function readAnalyticsGuardState(page: Page): Promise<{ queueLength: number; cookiePresent: boolean; collecting: boolean }> {
  const cookies = await page.context().cookies();
  const cookiePresent = cookies.some((item) => item.name === 'pj_analytics');
  const collecting = (await page.locator('html').getAttribute('data-analytics-collecting')) === 'true';
  const queued = await queueLength(page);
  return { queueLength: queued, cookiePresent, collecting };
}

async function readSettings(): Promise<{ timezone: string; timezoneRevision: number }> {
  const rows = await database().$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings'
  `;
  const raw = rows[0]?.value;
  if (raw && typeof raw === 'object') {
    const value = raw as { timezone?: unknown; timezoneRevision?: unknown };
    const timezone = typeof value.timezone === 'string' ? value.timezone : 'UTC';
    const revision = typeof value.timezoneRevision === 'number' ? value.timezoneRevision : 1;
    return { timezone, timezoneRevision: revision };
  }
  return { timezone: 'UTC', timezoneRevision: 1 };
}

/**
 * 用 /en/products 服务端组件的同一条目录读取（已上架 Model3D + withPublishedReady +
 * mergeCatalog + products.ts 回退）求该 slug 真正交给 3D 卡的 model URL。
 * 不用任何自报字段或新增拦截；只在测试进程里读同一库、跑同一份纯函数。
 */
async function resolveCatalogModel(slug: string): Promise<CatalogBinding> {
  const rows = await database().model3D.findMany({
    where: { published: true, status: 'READY' },
    orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
    select: {
      id: true,
      productSlug: true,
      category: true,
      animated: true,
      posterKey: true,
      updatedAt: true,
    },
  });
  const models: CatalogModel[] = withPublishedReady(rows.map((row) => {
    const version = row.updatedAt.getTime().toString(36);
    return {
      productSlug: row.productSlug,
      category: row.category,
      animated: row.animated,
      slugs: categorySlugs(row.category),
      glbUrl: `/api/models/${row.id}/glb?v=${version}`,
      posterUrl: row.posterKey ? `/api/models/${row.id}/poster?v=${version}` : null,
    };
  }));
  const merged = mergeCatalog(models, 'en', FALLBACK_PRODUCTS);
  const list = merged.applied ? merged.products : FALLBACK_PRODUCTS;
  const product = list.find((item) => item.slug === slug);
  if (!product?.model) throw new Error(`J6_SEAM_CATALOG_SLUG_MISSING ${slug}`);
  let url: URL;
  try {
    url = new URL(product.model, 'http://catalog.invalid');
  } catch {
    throw new Error(`J6_SEAM_CATALOG_MODEL_INVALID ${slug}`);
  }
  if (url.origin !== 'http://catalog.invalid') throw new Error(`J6_SEAM_CATALOG_MODEL_ABSOLUTE ${slug}`);
  const api = /^\/api\/models\/([^/]+)\/glb$/.exec(url.pathname);
  // 来源按该产品最终 URL 的形状判定：合并目录里仍可能保留 products.ts 回退项。
  const source: 'api' | 'fallback' = api ? 'api' : 'fallback';
  if (source === 'api') {
    const apiModelId = api![1]!;
    if (!/^[a-z0-9]{20,40}$/.test(apiModelId)) {
      throw new Error(`J6_SEAM_CATALOG_API_ID_INVALID ${slug} id=${apiModelId}`);
    }
    const matchedRow = rows.find((row) => row.id === apiModelId && row.category === slug);
    if (!matchedRow) {
      throw new Error(`J6_SEAM_CATALOG_API_ROW_MISSING ${slug} id=${apiModelId}`);
    }
    const expectedVersion = matchedRow.updatedAt.getTime().toString(36);
    const actualVersion = url.searchParams.get('v');
    if (actualVersion !== expectedVersion || url.search !== `?v=${expectedVersion}`) {
      throw new Error(`J6_SEAM_CATALOG_API_VERSION_MISMATCH ${slug} v=${String(actualVersion)} expected=${expectedVersion}`);
    }
    return {
      source: 'api',
      slug,
      model: product.model,
      pathname: url.pathname,
      search: url.search,
      apiModelId,
      apiVersion: expectedVersion,
      apiUpdatedAt: matchedRow.updatedAt.toISOString(),
    };
  }
  if (!/^\/models\/[^/]+\.glb$/.test(url.pathname) || url.search !== '') {
    throw new Error(`J6_SEAM_CATALOG_FALLBACK_INVALID ${slug} model=${product.model}`);
  }
  const fallbackItem = FALLBACK_PRODUCTS.find((item) => item.slug === slug);
  if (fallbackItem?.model !== url.pathname) {
    throw new Error(`J6_SEAM_CATALOG_FALLBACK_MISMATCH ${slug} ${url.pathname} != ${String(fallbackItem?.model)}`);
  }
  return {
    source: 'fallback',
    slug,
    model: product.model,
    pathname: url.pathname,
    search: '',
    apiModelId: null,
    apiVersion: null,
    apiUpdatedAt: null,
  };
}

async function readDailyRows(siteDay: string, revision: number): Promise<Map<string, DailyRow>> {
  const rows = await database().$queryRaw<DailyRow[]>`
    SELECT
      "dimension",
      "localDate"::text AS "localDate",
      "visitors",
      "pageViews",
      "productViews",
      "modelStarts",
      "modelSuccesses",
      "modelFailures",
      "durationMsSum"::text AS "durationMsSum",
      "sourceThrough",
      "timezone",
      "timezoneRevision"
    FROM "AnalyticsDaily"
    WHERE "localDate" = ${siteDay} AND "timezoneRevision" = ${revision}
  `;
  return new Map(rows.map((row) => [row.dimension, row]));
}

function candidateCountOf(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const counts = (summary as { counts?: unknown }).counts;
  if (!counts || typeof counts !== 'object') return null;
  const value = (counts as { candidateCount?: unknown }).candidateCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function jobState(): Promise<JobStateRow | null> {
  const rows = await database().$queryRaw<JobStateRow[]>`
    SELECT "generation", "lastStatus"::text AS "lastStatus", "lastStartedAt", "lastSucceededAt",
           "lockedUntil", "summary"
    FROM "JobState" WHERE "key" = ${AGGREGATE_KEY}
  `;
  return rows[0] ?? null;
}

function requireCronSecret(): string {
  if (!process.env.CRON_SECRET) throw new Error('J6_SEAM_CRON_SECRET_MISSING：需要 CRON_SECRET');
  return process.env.CRON_SECRET;
}

async function runAggregate(request: APIRequestContext, label: string): Promise<JobRound> {
  const secret = requireCronSecret();
  const response = await request.post(`${ORIGIN}${OPERATIONS}`, {
    headers: { authorization: `Bearer ${secret}` },
    data: { jobKey: AGGREGATE_KEY },
    timeout: 120_000,
  });
  const text = await response.text();
  if (response.status() === 409) throw new Error(`J6_SEAM_AGGREGATE_LEASE_BUSY ${label}：实例仍有并发调度，不能绑定本轮`);
  if (response.status() !== 200) throw new Error(`J6_SEAM_AGGREGATE_HTTP ${label} status=${response.status()} body=${text.slice(0, 200)}`);
  let body: { status?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { status?: unknown };
  } catch {
    body = null;
  }
  if (body?.status !== 'SUCCEEDED') throw new Error(`J6_SEAM_AGGREGATE_STATUS ${label} ${String(body?.status)}`);
  const state = await jobState();
  if (!state) throw new Error(`J6_SEAM_AGGREGATE_STATE_MISSING ${label}`);
  if (state.lastStatus !== 'SUCCEEDED') throw new Error(`J6_SEAM_AGGREGATE_STATE ${label} ${state.lastStatus}`);
  if (state.lockedUntil !== null) throw new Error(`J6_SEAM_AGGREGATE_LEASE_HELD ${label}`);
  return {
    status: response.status(),
    candidateCount: candidateCountOf(state.summary),
    generation: state.generation,
    startedAt: state.lastStartedAt,
    succeededAt: state.lastSucceededAt,
    lockedUntil: state.lockedUntil,
    lastStatus: state.lastStatus,
  };
}

async function waitForQuiet(posts: unknown[], page: Page): Promise<void> {
  await expect.poll(async () => queueLength(page), { timeout: 30_000 }).toBe(0);
  let last = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (posts.length === last) stable += 1;
    else {
      stable = 0;
      last = posts.length;
    }
    if (stable >= 3) return;
    await page.waitForTimeout(500);
  }
  throw new Error('J6_SEAM_EVENTS_NOT_QUIET：事件批次在 20s 内没有稳定下来');
}

function numberOrZero(value: number | null): number {
  return value ?? 0;
}

function bigintOf(value: string | null): bigint {
  try {
    return value === null ? 0n : BigInt(value);
  } catch {
    return 0n;
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * 同意与三阶段零写入投影：同意前、独立拒绝上下文、同意后撤回各自绑定真实网络与持久计数。
 */
function projectConsentEvidence(input: {
  postStatus: number | null;
  grantedCookieShape: boolean;
  collecting: boolean;
  preConsentPosts: number;
  postAcceptEventPosts: number;
  preConsent: ConsentZeroStageInput;
  rejected: ConsentZeroStageInput & {
    isolatedContext: boolean;
    consentPostStatus: number | null;
    browserTiming: {
      pageCreationStartedAt: string;
      navigationStartedAt: string;
      denialConfirmedAt: string;
      contextClosedAt: string;
    };
  };
  withdrawn: ConsentZeroStageInput & { consentPostStatus: number | null };
}) {
  const stage = (item: ConsentZeroStageInput) => ({
    navigatedPath: item.navigatedPath,
    eventPosts: item.eventPosts,
    queueLength: item.queueLength,
    cookiePresent: item.cookiePresent,
    collecting: item.collecting,
    dbBefore: item.dbBefore,
    dbAfter: item.dbAfter,
    dbDelta: item.dbAfter - item.dbBefore,
    contextNonce: item.contextNonce,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
  });
  return {
    postStatus: input.postStatus,
    grantedCookieShape: input.grantedCookieShape,
    collecting: input.collecting,
    preConsentPosts: input.preConsentPosts,
    postAcceptEventPosts: input.postAcceptEventPosts,
    preConsent: {
      ...stage(input.preConsent),
      postAcceptEventPosts: input.postAcceptEventPosts,
    },
    rejected: {
      isolatedContext: input.rejected.isolatedContext,
      consentPostStatus: input.rejected.consentPostStatus,
      browserTiming: input.rejected.browserTiming,
      ...stage(input.rejected),
    },
    withdrawn: {
      consentPostStatus: input.withdrawn.consentPostStatus,
      ...stage(input.withdrawn),
    },
  };
}

/**
 * 写进 RUN.json 的事件白名单投影：starts / terminals 真实保留 occurredAt，
 * 供复核器以同 eventId 对照数据库持久发生时刻、顺序与 GLB 响应窗口。
 */
function projectEventsEvidence(
  posts: Array<{ events: SafeEvent[] }>,
  eventResponseStatuses: number[],
  pageViews: SafeEvent[],
  productViews: SafeEvent[],
  starts: SafeEvent[],
  terminals: SafeEvent[],
  association: EventAssociation,
) {
  return {
    posts: posts.map((post, index) => ({
      status: eventResponseStatuses[index] ?? null,
      count: post.events.length,
      kinds: [...new Set(post.events.map((event) => event.kind))],
    })),
    responseStatuses: eventResponseStatuses,
    pageViews: pageViews.map((event) => ({
      eventId: event.eventId,
      navigationId: event.navigationId,
      path: event.path,
      occurredAt: event.occurredAt,
    })),
    productViews: productViews.map((event) => ({
      eventId: event.eventId,
      navigationId: event.navigationId,
      productSlug: event.productSlug,
      path: event.path,
      occurredAt: event.occurredAt,
    })),
    starts: starts.map((event) => ({
      eventId: event.eventId,
      viewId: event.viewId,
      navigationId: event.navigationId,
      productSlug: event.productSlug,
      path: event.path,
      occurredAt: event.occurredAt,
    })),
    terminals: terminals.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      viewId: event.viewId,
      navigationId: event.navigationId,
      productSlug: event.productSlug,
      durationMs: event.durationMs,
      occurredAt: event.occurredAt,
    })),
    association: {
      viewId: association.viewId,
      navigationId: association.navigationId,
      productSlug: association.productSlug,
      startEventId: association.startEventId,
      terminalEventId: association.terminalEventId,
      pageViewEventId: association.pageViewEventId,
      productViewEventId: association.productViewEventId,
      oneTerminalForView: association.oneTerminalForView,
    },
  };
}

function projectDbEvidence(eventIds: string[], rows: PersistedEventRow[], maxReceivedAt: number, pg: PgIdentity) {
  return {
    rowCount: rows.length,
    eventIds,
    rows: rows.map((row) => ({
      kind: row.kind,
      eventId: row.eventId,
      viewId: row.viewId,
      navigationId: row.navigationId,
      productSlug: row.productSlug,
      path: row.path,
      durationMs: row.durationMs,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
    })),
    maxReceivedAt: new Date(maxReceivedAt).toISOString(),
    // 只出三元组投影；runner 用同一库的 service 侧查询独立比对，checker 再核对目标 run/attempt 专库名。
    pg: {
      database: pg.database,
      serverVersionNum: pg.serverVersionNum,
      clusterSha256: pg.clusterSha256,
    },
  };
}

/**
 * 从真实 baseline / after 日行与捕获事件投影 T12 证据：delta 直接由前后行差值算出，
 * 复核器按同一缺行置零与 BigInt 规则独立重算并对账持久事件表。
 */
function projectAggregateEvidence(input: {
  siteDay: string;
  eventDay: string;
  settings: { timezone: string; timezoneRevision: number };
  baselineJob: JobRound;
  siteBefore: DailyRow | undefined;
  productBefore: DailyRow | undefined;
  afterJob: JobRound;
  siteAfter: DailyRow;
  productAfter: DailyRow;
  pageViews: SafeEvent[];
  productViews: SafeEvent[];
  starts: SafeEvent[];
  successes: SafeEvent[];
  slug: string;
}) {
  const {
    siteDay, eventDay, settings, baselineJob, siteBefore, productBefore,
    afterJob, siteAfter, productAfter, pageViews, productViews, starts, successes, slug,
  } = input;
  const startsAll = starts.length;
  const startsForSlug = starts.filter((item) => item.productSlug === slug).length;
  const expectedPageViews = pageViews.length;
  const expectedProductViews = productViews.filter((view) => view.productSlug === slug).length;
  const successesForSlugList = successes.filter((item) => item.productSlug === slug);
  const durationSum = successes.reduce((sum, item) => sum + BigInt(Math.max(0, Math.trunc(item.durationMs ?? 0))), 0n);
  const durationSumForSlug = successesForSlugList.reduce((sum, item) => sum + BigInt(Math.max(0, Math.trunc(item.durationMs ?? 0))), 0n);
  const siteDelta = {
    visitors: siteAfter.visitors - numberOrZero(siteBefore?.visitors ?? null),
    pageViews: numberOrZero(siteAfter.pageViews) - numberOrZero(siteBefore?.pageViews ?? null),
    productViews: siteAfter.productViews - numberOrZero(siteBefore?.productViews ?? null),
    modelStarts: siteAfter.modelStarts - numberOrZero(siteBefore?.modelStarts ?? null),
    modelSuccesses: siteAfter.modelSuccesses - numberOrZero(siteBefore?.modelSuccesses ?? null),
    modelFailures: siteAfter.modelFailures - numberOrZero(siteBefore?.modelFailures ?? null),
    durationMsSum: String(bigintOf(siteAfter.durationMsSum) - bigintOf(siteBefore?.durationMsSum ?? null)),
  };
  const productDelta = {
    visitors: productAfter.visitors - numberOrZero(productBefore?.visitors ?? null),
    productViews: productAfter.productViews - numberOrZero(productBefore?.productViews ?? null),
    modelStarts: productAfter.modelStarts - numberOrZero(productBefore?.modelStarts ?? null),
    modelSuccesses: productAfter.modelSuccesses - numberOrZero(productBefore?.modelSuccesses ?? null),
    modelFailures: productAfter.modelFailures - numberOrZero(productBefore?.modelFailures ?? null),
    durationMsSum: String(bigintOf(productAfter.durationMsSum) - bigintOf(productBefore?.durationMsSum ?? null)),
  };
  return {
    siteDay,
    localDate: siteAfter.localDate,
    eventDay,
    settings,
    baseline: {
      job: { ...baselineJob, startedAt: iso(baselineJob.startedAt), succeededAt: iso(baselineJob.succeededAt) },
      site: siteBefore ? { ...siteBefore, sourceThrough: iso(siteBefore.sourceThrough) } : null,
      product: productBefore ? { ...productBefore, sourceThrough: iso(productBefore.sourceThrough) } : null,
    },
    after: {
      job: { ...afterJob, startedAt: iso(afterJob.startedAt), succeededAt: iso(afterJob.succeededAt) },
      site: { ...siteAfter, sourceThrough: iso(siteAfter.sourceThrough) },
      product: { ...productAfter, sourceThrough: iso(productAfter.sourceThrough) },
    },
    expected: {
      startsAll,
      startsForSlug,
      pageViews: expectedPageViews,
      productViews: expectedProductViews,
      successesAll: successes.length,
      successesForSlug: successesForSlugList.length,
      durationMs: String(durationSum),
      durationMsForSlug: String(durationSumForSlug),
    },
    delta: { site: siteDelta, product: productDelta },
  };
}

function recordJ6Case(checkpoint: 'spec-registered' | 'before-all-entered' | 'before-all-complete'
  | 'case-entered' | 'first-nav-started' | 'first-nav-returned'
  | 'home-http-ok' | 'home-url-ok' | 'home-style-ok' | 'catalog-ssr-ok'
  | 'consent-nav-ok' | 'model-network-ok' | 'persisted-aggregate-ok' | 'case-body-passed'): void {
  const root = process.env.J6_SEAM_EVIDENCE_ROOT;
  const directory = process.env.J6_PW_PROGRESS_DIR;
  if (!ENABLED || !root || directory !== path.join(root, 'pw-progress')) return;
  try {
    writeFileSync(path.join(directory, checkpoint), '', { flag: 'wx' });
  } catch {
    // Observation failure leaves the capture result unchanged.
  }
}

if (ENABLED) {
  // 本采集不写 trace/video/screenshot：失败 trace 会把请求头与响应体带进制品，
  // 与“安全网络摘要”口径冲突；证据只落 RUN.json（白名单字段）。
  test.use({ trace: 'off', video: 'off', screenshot: 'off' });

  test.describe('J6 前台主流程接缝证据（opt-in）', () => {
    test.beforeAll(async ({ browser }, testInfo) => {
      recordJ6Case('before-all-entered');
      run = beginRun(testInfo, browser.version());
      if (process.env.M5T8_E2E_SCHEDULER === '1') {
        throw new Error('J6_SEAM_SCHEDULER_ON：本采集必须在不带并发调度的专属实例上运行');
      }
      recordJ6Case('before-all-complete');
    });

    test.afterEach(({}, testInfo) => {
      if (!run) return;
      const record = run.evidence as { test?: Record<string, unknown> };
      record.test = { title: testInfo.title, status: testInfo.status ?? 'unknown', retry: testInfo.retry };
      writeRun();
    });

    test.afterAll(async () => {
      if (run) {
        run.closed = true;
        run.finishedAt = new Date().toISOString();
        writeRun();
        console.log(`J6_SEAM_RUN_CLOSED=${run.root}`);
      }
      await db?.$disconnect();
    });

    test('同构建 /en→products：token、SSR 无 /api/models、真实 GLB 同 viewId、T12 日行增量', async ({ context, request, browser, baseURL }) => {
      recordJ6Case('case-entered');
      test.setTimeout(240_000);
      const state = requireRun();
      const evidence: Record<string, unknown> = state.evidence;
      // 身份在读任何事件前取自应用同一 Prisma 连接；主上下文 nonce 供接受/撤回共用，拒绝另起新 nonce。
      const pgIdentity = await readPgIdentity();
      const mainContextNonce = randomUUID();
      const browserBlocked = new Set<string>();
      const verifyBrowser = lockJ6NetworkMethods(browser, ['newBrowserCDPSession'], (name) => browserBlocked.add(name));
      if (!baseURL) throw new Error('J6_SEAM_NETWORK_ORIGIN');
      const origin = new URL(baseURL).origin;
      const finishMainNetwork = observeJ6Network(context, origin, 'main', mainContextNonce);
      const page = await context.newPage();
      const pageRequests: string[] = [];
      const posts: Array<{ events: SafeEvent[] }> = [];
      const eventResponseStatuses: number[] = [];
      const consentStatuses: number[] = [];
      const glbFacts: GlbFact[] = [];
      const glbRequestTimes = new WeakMap<PlaywrightRequest, number>();
      const glbMagicOk = new WeakMap<GlbFact, boolean>();

      const onRequest = (req: PlaywrightRequest): void => {
        const pathname = canonicalPath(req.url());
        if (!pathname) return;
        glbRequestTimes.set(req, Date.now());
        pageRequests.push(`${req.method()} ${pathname}`);
        if (req.method() === 'POST' && pathname === ANALYTICS_EVENTS) {
          posts.push({ events: parsePostedEvents(req.postData()) });
        }
      };
      page.on('request', onRequest);
      const glbBodyChecks: Array<Promise<void>> = [];
      page.on('response', (response) => {
        const pathname = canonicalPath(response.url());
        if (pathname === ANALYTICS_EVENTS && response.request().method() === 'POST') {
          eventResponseStatuses.push(response.status());
        }
        if (pathname === ANALYTICS_CONSENT && response.request().method() === 'POST') {
          consentStatuses.push(response.status());
        }
        // 真实 GLB 可能是目录回退的 /models/*.glb，也可能是已上架目录的 /api/models/<id>/glb。
        const isStaticGlb = /^\/models\/[^/]+\.glb$/.test(pathname);
        const isApiGlb = /^\/api\/models\/[^/]+\/glb$/.test(pathname);
        if ((!isStaticGlb && !isApiGlb) || response.request().method() !== 'GET') return;
        const responseAt = Date.now();
        const requestAt = glbRequestTimes.get(response.request()) ?? responseAt;
        const length = response.headers()['content-length'];
        const served = isStaticGlb ? path.join('public', pathname) : null;
        const fact: GlbFact = {
          path: pathname,
          search: new URL(response.url()).search,
          status: response.status(),
          contentLength: length ? Number(length) : null,
          contentType: response.headers()['content-type'] ?? null,
          fromServiceWorker: response.fromServiceWorker(),
          // 归属锚：同一主帧、同一页面路径、同一采集轮（RUN.startedAt 之后）。
          frameMain: response.request().frame() === page.mainFrame(),
          pagePath: canonicalPath(page.url()),
          resourceType: response.request().resourceType(),
          servedFileSize: served && existsSync(served) ? statSync(served).size : null,
          servedFileSha256: served && existsSync(served) ? sha256Hex(readFileSync(served)) : null,
          bodyBytes: null,
          bodySha256: null,
          requestAt,
          responseAt,
        };
        glbFacts.push(fact);
        glbBodyChecks.push(response.body().then((body) => {
          fact.bodyBytes = body.length;
          fact.bodySha256 = sha256Hex(body);
          glbMagicOk.set(fact, body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'glTF');
        }).catch(() => undefined));
      });
      try {
        const settings = await readSettings();
        const siteDay = siteLocalDate(new Date(), settings.timezone);
        const baselineJob = await runAggregate(request, 'baseline');
        const baselineDaily = await readDailyRows(siteDay, settings.timezoneRevision);
        const preConsentStartedAt = new Date().toISOString();
        const dbBeforePreConsent = await database().analyticsEvent.count();

        recordJ6Case('first-nav-started');
        const navigation = await page.goto('/en');
        recordJ6Case('first-nav-returned');
        expect(navigation?.status(), '/en 文档状态').toBe(200);
        recordJ6Case('home-http-ok');
        await expect(page).toHaveURL(/\/en$/);
        recordJ6Case('home-url-ok');

        const tokenFacts = await page.evaluate(() => {
          const rootStyle = getComputedStyle(document.documentElement);
          const bodyStyle = getComputedStyle(document.body);
          const button = document.querySelector('.hero .btn');
          const buttonStyle = button ? getComputedStyle(button) : null;
          return {
            cssBg: rootStyle.getPropertyValue('--pj-bg').trim(),
            cssAccent: rootStyle.getPropertyValue('--pj-accent').trim(),
            cssRadius: rootStyle.getPropertyValue('--pj-radius').trim(),
            cssBorder: rootStyle.getPropertyValue('--pj-border-width').trim(),
            bodyBg: bodyStyle.backgroundColor,
            bodyColor: bodyStyle.color,
            bodyFontSize: bodyStyle.fontSize,
            bodyLineHeight: bodyStyle.lineHeight,
            heroBtnBorderWidth: buttonStyle?.borderTopWidth ?? null,
            heroBtnBorderRadius: buttonStyle?.borderTopLeftRadius ?? null,
          };
        });
        expect(tokenFacts.cssBg, '--pj-bg').toBe(TOKENS.cssBg);
        expect(tokenFacts.cssAccent, '--pj-accent').toBe(TOKENS.cssAccent);
        expect(tokenFacts.cssRadius, '--pj-radius').toBe(TOKENS.cssRadius);
        expect(tokenFacts.cssBorder, '--pj-border-width').toBe(TOKENS.cssBorder);
        expect(tokenFacts.bodyBg, 'body 背景').toBe(TOKENS.bodyBg);
        expect(tokenFacts.bodyColor, 'body 前景').toBe(TOKENS.bodyColor);
        expect(tokenFacts.bodyFontSize, 'body 字号').toBe(TOKENS.bodyFontSize);
        expect(tokenFacts.bodyLineHeight, 'body 行高').toBe(TOKENS.bodyLineHeight);
        expect(tokenFacts.heroBtnBorderWidth, '主控件边宽').toBe(TOKENS.cssBorder);
        expect(tokenFacts.heroBtnBorderRadius, '主控件圆角').toBe(TOKENS.cssRadius);
        recordJ6Case('home-style-ok');

        const ssr = await request.get('/en/products');
        expect(ssr.status(), 'SSR 目录状态').toBe(200);
        const html = await ssr.text();
        const hasTitle = html.includes('Our products in 3D');
        const articleCardCount = (html.match(/<article[^>]*class="card/g) ?? []).length;
        expect(hasTitle, 'SSR 目录标题').toBe(true);
        expect(articleCardCount, 'SSR 产品卡数量').toBeGreaterThanOrEqual(12);
        recordJ6Case('catalog-ssr-ok');

        // 未同意阶段：真实进入一次产品页，必须在同意点击前显式断言网络与持久层零写入。
        await page.locator('header.site nav.nav-desktop a[href="/en/products"]').click();
        await expect(page).toHaveURL(/\/en\/products$/);
        const preConsentPosts = posts.length;
        expect(preConsentPosts, '同意前零事件批').toBe(0);
        const preConsentGuard = await readAnalyticsGuardState(page);
        expect(preConsentGuard.queueLength, '同意前队列为 0').toBe(0);
        expect(preConsentGuard.cookiePresent, '同意前无分析 cookie').toBe(false);
        expect(preConsentGuard.collecting, '同意前未开启采集').toBe(false);
        const dbAfterPreConsent = await database().analyticsEvent.count();
        expect(dbAfterPreConsent - dbBeforePreConsent, '同意前数据库零写入').toBe(0);
        const preConsentFinishedAt = new Date().toISOString();

        const banner = page.getByRole('region', { name: 'Cookie consent' });
        await expect(banner).toBeVisible();
        await banner.getByRole('button', { name: 'Accept all' }).click();
        await expect(banner).toBeHidden();
        await expect(page.locator('.consent-toast')).toBeVisible();
        await expect.poll(async () => {
          const cookies = await page.context().cookies();
          const cookie = cookies.find((item) => item.name === 'pj_analytics');
          const collecting = await page.locator('html').getAttribute('data-analytics-collecting');
          return Boolean(cookie && cookie.value.startsWith('v1.') && cookie.value.length > 20 && collecting === 'true');
        }, { timeout: 20_000 }).toBe(true);
        await expect.poll(() => consentStatuses.length, { timeout: 20_000 }).toBeGreaterThan(0);
        const consentStatus = consentStatuses[0] ?? null;
        expect(consentStatus, '同意写响应').toBe(200);
        const postAcceptEventPosts = posts.length;
        expect(postAcceptEventPosts, '同意点击后不补发同意前浏览').toBe(0);
        expect(posts.length, '同意前不产生事件批').toBe(preConsentPosts);

        const markerA = `j6-a-${Date.now()}`;
        await page.evaluate((marker) => {
          (window as unknown as { __j6NavMarker?: string }).__j6NavMarker = marker;
        }, markerA);
        await page.getByTestId('home-link').click();
        await expect(page).toHaveURL(/\/en$/);
        expect(await page.evaluate(() => (window as unknown as { __j6NavMarker?: string }).__j6NavMarker ?? null), '第一次客户端导航').toBe(markerA);

        const markerB = `j6-b-${Date.now()}`;
        await page.evaluate((marker) => {
          (window as unknown as { __j6NavMarker?: string }).__j6NavMarker = marker;
        }, markerB);
        await page.getByTestId('products-link').click();
        await expect(page).toHaveURL(/\/en\/products$/);
        expect(await page.evaluate(() => (window as unknown as { __j6NavMarker?: string }).__j6NavMarker ?? null), '第二次客户端导航').toBe(markerB);

        // 目录走 SSR；页面不得自己再拉一次 /api/models（与 brand-smoke 同一条产品要求）。
        expect(pageRequests.filter((entry) => entry === 'GET /api/models'), '页面不额外请求 GET /api/models').toEqual([]);
        recordJ6Case('consent-nav-ok');

        // 指针下真实卡片的 slug 是独立 DOM 读，用来和事件里的 productSlug 交叉核。
        const pointerViewport = page.locator('[data-testid="product-viewport"]').first();
        await expect(pointerViewport).toBeInViewport();
        const pointerBox = await pointerViewport.boundingBox();
        const viewportSize = page.viewportSize();
        if (!pointerBox || !viewportSize) throw new Error('J6_SEAM_CARD_AT_POINTER_BOX_MISSING');
        const visibleLeft = Math.max(0, pointerBox.x);
        const visibleTop = Math.max(0, pointerBox.y);
        const visibleRight = Math.min(viewportSize.width, pointerBox.x + pointerBox.width);
        const visibleBottom = Math.min(viewportSize.height, pointerBox.y + pointerBox.height);
        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) throw new Error('J6_SEAM_CARD_AT_POINTER_OUTSIDE_VIEWPORT');
        const pointer = { x: (visibleLeft + visibleRight) / 2, y: (visibleTop + visibleBottom) / 2 };
        const cardAtPointer = await page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          const viewport = element?.closest('[data-testid="product-viewport"]');
          return viewport
            ? { slug: viewport.getAttribute('data-slug'), state: viewport.getAttribute('data-model-state') }
            : null;
        }, pointer);

        // 真实的指针移动启用 3D 懒加载；不要求激活点击，也不拦截 GLB。
        const attemptStartedAt = Date.now();
        await page.mouse.move(pointer.x, pointer.y);
        await expect.poll(() => posts.flatMap((post) => post.events).filter((event) => event.kind === 'model_view_start').length, { timeout: 120_000 })
          .toBeGreaterThan(0);
        await expect.poll(() => posts.flatMap((post) => post.events).filter((event) => event.kind === 'model_load_success' || event.kind === 'model_load_failure').length, { timeout: 120_000 })
          .toBeGreaterThan(0);
        await waitForQuiet(posts, page);
        await Promise.all(glbBodyChecks);
        await expect.poll(() => eventResponseStatuses.length, { timeout: 20_000 }).toBe(posts.length);
        expect(eventResponseStatuses.filter((status) => status !== 200), '分析事件批全部 200').toEqual([]);

        const events = posts.flatMap((post) => post.events);
        const starts = events.filter((event) => event.kind === 'model_view_start');
        const terminals = events.filter((event) => event.kind === 'model_load_success' || event.kind === 'model_load_failure');
        const failures = terminals.filter((event) => event.kind === 'model_load_failure');
        if (failures.length > 0) {
          throw new Error(`J6_SEAM_UNEXPECTED_FAILURE ${failures.map((event) => event.productSlug ?? 'null').join(',')}`);
        }
        const pageViews = events.filter((event) => event.kind === 'page_view');
        const productViews = events.filter((event) => event.kind === 'product_view');
        if (!cardAtPointer?.slug) throw new Error('J6_SEAM_CARD_AT_POINTER_MISSING');
        const pointerSlug = cardAtPointer.slug;
        const succeeded = terminals.find((terminal) => terminal.kind === 'model_load_success'
          && terminal.productSlug === pointerSlug
          && typeof terminal.viewId === 'string'
          && starts.some((start) => start.viewId === terminal.viewId));
        if (!succeeded || !succeeded.viewId) {
          throw new Error(`J6_SEAM_NO_SUCCESS_TERMINAL starts=${starts.length} terminals=${terminals.length} pointer=${pointerSlug}`);
        }
        const viewId = succeeded.viewId;
        const start = starts.find((item) => item.viewId === viewId);
        if (!start) throw new Error(`J6_SEAM_START_MISSING ${viewId}`);
        expect(start.productSlug, '指针卡片与 start 的 productSlug 同一').toBe(pointerSlug);
        expect(start.navigationId, 'start 的 navigationId').toBe(succeeded.navigationId);
        expect(start.productSlug, 'start 的 productSlug').toBe(succeeded.productSlug);
        expect(start.path, 'start 的 path').toBe('/en/products');
        expect(terminals.filter((terminal) => terminal.viewId === viewId), '同 viewId 只留一种终态').toHaveLength(1);
        expect(Number.isInteger(succeeded.durationMs), 'success durationMs 是整数').toBe(true);
        expect(succeeded.durationMs ?? -1, 'success durationMs >= 0').toBeGreaterThanOrEqual(0);

        // 视口里可能同时有两张卡各自成功：增量按实际 successes 计，不写死 1。
        const successes = terminals.filter((terminal) => terminal.kind === 'model_load_success');
        const slug = start.productSlug ?? '';

        const boundPageView = pageViews.find((view) => view.path === '/en/products' && view.navigationId === start.navigationId);
        if (!boundPageView) throw new Error(`J6_SEAM_PAGE_VIEW_UNBOUND startNav=${start.navigationId ?? 'null'} pageViews=${pageViews.map((view) => `${view.path}:${view.navigationId}`).join(',')}`);
        const boundProductView = productViews.find((view) => view.navigationId === start.navigationId && view.productSlug === start.productSlug);
        if (!boundProductView) throw new Error('J6_SEAM_PRODUCT_VIEW_UNBOUND');

        // 先求该 slug 在 SSR 目录里真正的 model URL，再要求 facts 里该 URL 的响应字节唯一。
        // 首次产品页已按真实网络加载同一模型；第二次客户端导航复用页面模型缓存（drei useGLTF），
        // 此时本轮尝试没有新响应，只能以“同一主帧、同一页面路径、同一采集轮、同一目录 URL”的
        // 预热响应归属；有本轮响应时仍要求恰好一条且落在窗口内。
        const catalogModel = await resolveCatalogModel(slug);
        expect(catalogModel.slug, '目录绑定 slug 与关联 slug 同一').toBe(slug);
        const chosenFacts = glbFacts.filter((fact) => fact.path === catalogModel.pathname);
        if (chosenFacts.length === 0) {
          throw new Error(`J6_SEAM_GLB_CHOICE ${catalogModel.pathname} count=0 facts=${JSON.stringify(glbFacts.map((fact) => `${fact.path}:${fact.status}`))}`);
        }
        const chosenVariants = new Set(chosenFacts.map((fact) => `${fact.status}:${String(fact.bodySha256)}:${String(fact.bodyBytes)}`));
        if (chosenVariants.size !== 1) {
          throw new Error(`J6_SEAM_GLB_CHOICE ${catalogModel.pathname} variants=${chosenVariants.size} facts=${JSON.stringify(chosenFacts.map((fact) => `${fact.status}:${String(fact.bodyBytes)}`))}`);
        }
        const chosenGlb = chosenFacts[chosenFacts.length - 1]!;
        const attemptFacts = chosenFacts.filter((fact) => fact.responseAt >= attemptStartedAt);
        const cacheServed = attemptFacts.length === 0;
        const captureStartMs = Date.parse(state.startedAt);
        if (cacheServed) {
          if (!chosenGlb.frameMain || chosenGlb.fromServiceWorker || chosenGlb.pagePath !== '/en/products'
              || chosenGlb.responseAt < captureStartMs) {
            throw new Error(`J6_SEAM_GLB_OWNERSHIP path=${chosenGlb.path} frame=${String(chosenGlb.frameMain)} sw=${String(chosenGlb.fromServiceWorker)} page=${String(chosenGlb.pagePath)} at=${chosenGlb.responseAt}`);
          }
        }
        if (chosenGlb.status !== 200) throw new Error(`J6_SEAM_GLB_STATUS ${chosenGlb.path} ${chosenGlb.status}`);
        if (chosenGlb.fromServiceWorker) throw new Error(`J6_SEAM_GLB_SERVICE_WORKER ${chosenGlb.path}`);
        if (chosenGlb.search !== catalogModel.search) {
          throw new Error(`J6_SEAM_GLB_QUERY ${chosenGlb.path} ${chosenGlb.search} != ${catalogModel.search}`);
        }
        if (!chosenGlb.bodySha256 || (chosenGlb.bodyBytes ?? 0) <= 1_000) {
          throw new Error(`J6_SEAM_GLB_BODY ${chosenGlb.path} bytes=${String(chosenGlb.bodyBytes)}`);
        }
        if (!glbMagicOk.get(chosenGlb)) {
          throw new Error(`J6_SEAM_GLB_MAGIC ${chosenGlb.path}`);
        }
        if (catalogModel.source === 'fallback') {
          if (chosenGlb.servedFileSize !== chosenGlb.bodyBytes || chosenGlb.servedFileSha256 !== chosenGlb.bodySha256) {
            throw new Error(`J6_SEAM_GLB_BYTES ${chosenGlb.path} ${String(chosenGlb.servedFileSha256)} != ${chosenGlb.bodySha256}`);
          }
        } else {
          const apiMatch = /^\/api\/models\/([^/]+)\/glb$/.exec(chosenGlb.path);
          const version = new URLSearchParams(chosenGlb.search).get('v');
          if (!catalogModel.apiModelId || apiMatch?.[1] !== catalogModel.apiModelId || version !== catalogModel.apiVersion) {
            throw new Error(`J6_SEAM_GLB_API_VERSION ${chosenGlb.path} id=${String(apiMatch?.[1])} v=${String(version)} != ${String(catalogModel.apiModelId)}:${String(catalogModel.apiVersion)}`);
          }
        }
        const startMs = Date.parse(start.occurredAt ?? '');
        const successMs = Date.parse(succeeded.occurredAt ?? '');
        if (!Number.isFinite(startMs) || !Number.isFinite(successMs)) throw new Error('J6_SEAM_EVENT_TIME_MISSING');
        if (successMs < startMs) throw new Error(`J6_SEAM_EVENT_TIME_ORDER start=${startMs} success=${successMs}`);
        if (chosenGlb.responseAt < (cacheServed ? captureStartMs : startMs - 2_000)
            || chosenGlb.responseAt > successMs + 2_000) {
          throw new Error(`J6_SEAM_GLB_WINDOW at=${chosenGlb.responseAt} start=${startMs} success=${successMs} cache=${String(cacheServed)}`);
        }
        // 指针卡片、事件 slug、目录路径、实际响应四者同一。
        const cardAfter = page.locator(`[data-testid="product-viewport"][data-slug="${slug}"]`);
        await expect(cardAfter).toHaveAttribute('data-model-state', 'ready');
        expect(await cardAfter.getAttribute('data-slug'), '成功后卡片 slug 不变').toBe(slug);
        expect(cardAtPointer.slug, '指针卡片 slug').toBe(slug);
        expect(cardAtPointer.state, '指针卡片初始未就绪').not.toBe('ready');
        recordJ6Case('model-network-ok');

        const eventIds = [...new Set(events.map((event) => event.eventId))];
        const rows = await database().analyticsEvent.findMany({
          where: { eventId: { in: eventIds } },
          select: {
            kind: true,
            eventId: true,
            viewId: true,
            navigationId: true,
            productSlug: true,
            path: true,
            durationMs: true,
            occurredAt: true,
            receivedAt: true,
          },
        });
        expect(rows.length, '每个事件恰好一行持久化').toBe(eventIds.length);
        const persistedById = new Map(rows.map((row) => [row.eventId, row]));
        for (const captured of events) {
          const persisted = persistedById.get(captured.eventId);
          if (!persisted) throw new Error(`J6_SEAM_DB_EVENT_MISSING ${captured.eventId}`);
          const capturedMs = Date.parse(captured.occurredAt ?? '');
          if (!Number.isFinite(capturedMs) || persisted.occurredAt.getTime() !== capturedMs) {
            throw new Error(`J6_SEAM_DB_OCCURRED_AT_MISMATCH ${captured.eventId} ${String(captured.occurredAt)} != ${persisted.occurredAt.toISOString()}`);
          }
        }
        const rowByKind = (kind: string): typeof rows[number] | undefined => rows.find((row) => row.kind === kind);
        const persistedStart = persistedById.get(start.eventId);
        const persistedSuccess = persistedById.get(succeeded.eventId);
        const persistedPageView = persistedById.get(boundPageView.eventId);
        const persistedProductView = persistedById.get(boundProductView.eventId);
        if (!persistedStart || !persistedSuccess || !persistedPageView || !persistedProductView) {
          throw new Error('J6_SEAM_DB_ROWS_INCOMPLETE');
        }
        expect(persistedStart.viewId, '持久 start viewId').toBe(viewId);
        expect(persistedSuccess.viewId, '持久 success viewId').toBe(viewId);
        expect(persistedStart.productSlug, '持久 start productSlug').toBe(start.productSlug);
        expect(persistedSuccess.occurredAt.getTime(), '持久终态不早于 start').toBeGreaterThanOrEqual(persistedStart.occurredAt.getTime());
        expect(rowByKind('model_load_failure'), '本路径不应有失败终态').toBeUndefined();
        if (chosenGlb.responseAt < (cacheServed ? captureStartMs : persistedStart.occurredAt.getTime() - 2_000)
            || chosenGlb.responseAt > persistedSuccess.occurredAt.getTime() + 2_000) {
          throw new Error(`J6_SEAM_GLB_WINDOW at=${chosenGlb.responseAt} dbStart=${persistedStart.occurredAt.getTime()} dbSuccess=${persistedSuccess.occurredAt.getTime()} cache=${String(cacheServed)}`);
        }
        const maxReceivedAt = Math.max(...rows.map((row) => row.receivedAt.getTime()));

        const afterJob = await runAggregate(request, 'after-events');
        if (!afterJob.candidateCount || afterJob.candidateCount < 1) {
          throw new Error(`J6_SEAM_AGGREGATE_NO_TARGETS candidateCount=${String(afterJob.candidateCount)}`);
        }
        if (!afterJob.startedAt) throw new Error('J6_SEAM_AGGREGATE_STARTED_AT_MISSING');
        expect(afterJob.startedAt.getTime(), '聚合轮次晚于事件入库').toBeGreaterThan(maxReceivedAt - 2_000);
        const settingsAfter = await readSettings();
        expect(settingsAfter.timezone, '聚合前后站点时区不变').toBe(settings.timezone);
        expect(settingsAfter.timezoneRevision, '聚合前后时区代次不变').toBe(settings.timezoneRevision);
        const afterDaily = await readDailyRows(siteDay, settings.timezoneRevision);
        const siteBefore = baselineDaily.get('site');
        const siteAfter = afterDaily.get('site');
        const productDimension = `product:${slug}`;
        const productBefore = baselineDaily.get(productDimension);
        const productAfter = afterDaily.get(productDimension);
        if (!siteAfter || !productAfter) throw new Error(`J6_SEAM_DAILY_ROW_MISSING site=${Boolean(siteAfter)} product=${Boolean(productAfter)}`);
        // T12 按持久 occurredAt 在站点时区分日，receivedAt 只作快照水位；跨午夜直接失败关闭。
        const occurredDays = [...new Set(rows.map((row) => siteLocalDate(row.occurredAt, settings.timezone)))];
        if (occurredDays.length !== 1) {
          throw new Error(`J6_SEAM_EVENT_DAY_SPAN ${occurredDays.join(',')}`);
        }
        const eventDay = occurredDays[0]!;
        expect(siteAfter.localDate, 'site 行 localDate 与待验证日同一').toBe(siteDay);
        expect(productAfter.localDate, 'product 行 localDate 与待验证日同一').toBe(siteDay);
        if (siteBefore) expect(siteBefore.localDate, 'baseline site localDate').toBe(siteDay);
        if (productBefore) expect(productBefore.localDate, 'baseline product localDate').toBe(siteDay);
        expect(eventDay, '持久 occurredAt 站点日与待验证日同一（午夜 fail-closed）').toBe(siteDay);

        const projectedAggregate = projectAggregateEvidence({
          siteDay,
          eventDay,
          settings,
          baselineJob,
          siteBefore,
          productBefore,
          afterJob,
          siteAfter,
          productAfter,
          pageViews,
          productViews,
          starts,
          successes,
          slug,
        });
        const { delta: { site: siteDelta, product: productDelta }, expected: expectedAggregate } = projectedAggregate;
        expect(siteAfter.timezone, 'site 日行 timezone').toBe(settings.timezone);
        expect(siteAfter.timezoneRevision, 'site 日行 revision').toBe(settings.timezoneRevision);
        expect(productAfter.timezone, 'product 日行 timezone').toBe(settings.timezone);
        expect(productAfter.timezoneRevision, 'product 日行 revision').toBe(settings.timezoneRevision);
        expect(siteDelta.pageViews, 'site pageViews 增量').toBe(expectedAggregate.pageViews);
        expect(siteDelta.productViews, 'site productViews 增量').toBe(productViews.length);
        expect(siteDelta.modelStarts, 'site modelStarts 增量').toBe(expectedAggregate.startsAll);
        expect(siteDelta.modelSuccesses, 'site modelSuccesses 增量').toBe(expectedAggregate.successesAll);
        expect(siteDelta.modelFailures, 'site modelFailures 增量').toBe(0);
        expect(siteDelta.durationMsSum, 'site durationMsSum 增量').toBe(expectedAggregate.durationMs);
        expect(productDelta.productViews, 'product productViews 增量').toBe(expectedAggregate.productViews);
        expect(productDelta.modelStarts, 'product modelStarts 增量').toBe(expectedAggregate.startsForSlug);
        expect(productDelta.modelSuccesses, 'product modelSuccesses 增量').toBe(expectedAggregate.successesForSlug);
        expect(productDelta.modelFailures, 'product modelFailures 增量').toBe(0);
        expect(productDelta.durationMsSum, 'product durationMsSum 增量').toBe(expectedAggregate.durationMsForSlug);
        if (!siteAfter.sourceThrough || !productAfter.sourceThrough) throw new Error('J6_SEAM_SOURCE_THROUGH_MISSING');
        expect(siteAfter.sourceThrough.getTime(), 'site sourceThrough 覆盖本次事件').toBeGreaterThanOrEqual(maxReceivedAt);
        expect(productAfter.sourceThrough.getTime(), 'product sourceThrough 覆盖本次事件').toBeGreaterThanOrEqual(maxReceivedAt);
        recordJ6Case('persisted-aggregate-ok');

        // 同意撤回阶段：在同一已授权会话通过页脚偏好面板撤回同意，真实导航后必须零上报、零入库。
        const postsBeforeWithdraw = posts.length;
        const consentCountBeforeWithdraw = consentStatuses.length;
        const withdrawStartedAt = new Date().toISOString();
        const dbBeforeWithdraw = await database().analyticsEvent.count();
        await page.locator('#analytics-preferences').scrollIntoViewIfNeeded();
        await page.locator('#analytics-preferences').click();
        const settingsDialog = page.getByRole('dialog', { name: 'Cookie settings' });
        await expect(settingsDialog).toBeVisible();
        await settingsDialog.getByRole('button', { name: 'Reject all' }).click();
        await expect(settingsDialog).toBeHidden();
        await expect.poll(async () => {
          const guard = await readAnalyticsGuardState(page);
          return !guard.cookiePresent && !guard.collecting && guard.queueLength === 0
            && consentStatuses.length > consentCountBeforeWithdraw;
        }, { timeout: 20_000 }).toBe(true);
        const withdrawConsentStatus = consentStatuses[consentStatuses.length - 1] ?? null;
        expect(withdrawConsentStatus, '撤回写响应').toBe(200);
        await page.getByTestId('home-link').click();
        await expect(page).toHaveURL(/\/en$/);
        await page.getByTestId('products-link').click();
        await expect(page).toHaveURL(/\/en\/products$/);
        const withdrawGuard = await readAnalyticsGuardState(page);
        const withdrawEventPosts = posts.length - postsBeforeWithdraw;
        const dbAfterWithdraw = await database().analyticsEvent.count();
        expect(withdrawEventPosts, '撤回后零事件批').toBe(0);
        expect(withdrawGuard.queueLength, '撤回后队列为 0').toBe(0);
        expect(withdrawGuard.cookiePresent, '撤回后无分析 cookie').toBe(false);
        expect(withdrawGuard.collecting, '撤回后采集关闭').toBe(false);
        expect(dbAfterWithdraw - dbBeforeWithdraw, '撤回后数据库零写入').toBe(0);
        const withdrawFinishedAt = new Date().toISOString();

        // 独立拒绝上下文：新建浏览器上下文明确点 Reject all 并导航产品页，必须零上报、零入库且页面可用。
        let rejectConsentStatus: number | null = null;
        let rejectEventPosts = 0;
        let rejectGuard = { queueLength: 0, cookiePresent: false, collecting: false };
        const rejectContextNonce = randomUUID();
        const rejectStartedAt = new Date().toISOString();
        const dbBeforeReject = await database().analyticsEvent.count();
        const rejectContext = await browser.newContext();
        const finishRejectNetwork = observeJ6Network(rejectContext, origin, 'rejected', rejectContextNonce);
        const pageCreationStartedAt = new Date().toISOString();
        let navigationStartedAt: string;
        let denialConfirmedAt: string;
        try {
          const rejectPage = await rejectContext.newPage();
          rejectPage.on('request', (req) => {
            if (req.method() === 'POST' && canonicalPath(req.url()) === ANALYTICS_EVENTS) {
              rejectEventPosts += 1;
            }
          });
          rejectPage.on('response', (res) => {
            if (res.request().method() === 'POST' && canonicalPath(res.url()) === ANALYTICS_CONSENT) {
              rejectConsentStatus = res.status();
            }
          });
          navigationStartedAt = new Date().toISOString();
          const rejectNav = await rejectPage.goto('/en');
          expect(rejectNav?.status(), '独立拒绝上下文 /en 状态').toBe(200);
          const rejectBanner = rejectPage.getByRole('region', { name: 'Cookie consent' });
          await expect(rejectBanner).toBeVisible();
          await rejectBanner.getByRole('button', { name: 'Reject all' }).click();
          await expect(rejectBanner).toBeHidden();
          await expect.poll(async () => {
            const guard = await readAnalyticsGuardState(rejectPage);
            return rejectConsentStatus !== null && !guard.cookiePresent && !guard.collecting && guard.queueLength === 0;
          }, { timeout: 20_000 }).toBe(true);
          expect(rejectConsentStatus, '独立拒绝写响应').toBe(200);
          denialConfirmedAt = new Date().toISOString();
          await rejectPage.getByTestId('products-link').click();
          await expect(rejectPage).toHaveURL(/\/en\/products$/);
          await expect(rejectPage.locator('[data-testid="product-viewport"]').first()).toBeVisible();
          rejectGuard = await readAnalyticsGuardState(rejectPage);
        } finally {
          await rejectContext.close();
        }
        const contextClosedAt = new Date().toISOString();
        const dbAfterReject = await database().analyticsEvent.count();
        expect(rejectEventPosts, '独立拒绝零事件批').toBe(0);
        expect(rejectGuard.queueLength, '独立拒绝队列为 0').toBe(0);
        expect(rejectGuard.cookiePresent, '独立拒绝无分析 cookie').toBe(false);
        expect(rejectGuard.collecting, '独立拒绝采集关闭').toBe(false);
        expect(dbAfterReject - dbBeforeReject, '独立拒绝数据库零写入').toBe(0);
        const rejectFinishedAt = new Date().toISOString();
        const rejectedNetwork = finishRejectNetwork();
        const mainNetwork = finishMainNetwork();
        verifyBrowser();
        const windows = [mainNetwork, rejectedNetwork];
        const network = projectJ6Network(windows, browserBlocked);
        evidence.networkObservation = { method: 'playwright-context-guard/1', browserBlocked: [...browserBlocked].sort(), windows };
        evidence.network = network;
        if (network.serviceWorker || network.intercepted.length !== 0) throw new Error('J6_SEAM_NETWORK_INTERVENTION');

        evidence.tokens = tokenFacts;
        evidence.catalog = {
          pageRequestCount: pageRequests.length,
          apiModelsGets: pageRequests.filter((entry) => entry === 'GET /api/models'),
          ssrStatus: ssr.status(),
          ssrHasTitle: hasTitle,
          ssrArticleCardCount: articleCardCount,
          model: {
            source: catalogModel.source,
            slug: catalogModel.slug,
            path: catalogModel.pathname,
            search: catalogModel.search,
            apiModelId: catalogModel.apiModelId,
            apiVersion: catalogModel.apiVersion,
            apiUpdatedAt: catalogModel.apiUpdatedAt,
          },
        };
        evidence.consent = projectConsentEvidence({
          postStatus: consentStatus,
          grantedCookieShape: true,
          collecting: true,
          preConsentPosts,
          postAcceptEventPosts,
          preConsent: {
            navigatedPath: '/en/products',
            eventPosts: preConsentPosts,
            queueLength: preConsentGuard.queueLength,
            cookiePresent: preConsentGuard.cookiePresent,
            collecting: preConsentGuard.collecting,
            dbBefore: dbBeforePreConsent,
            dbAfter: dbAfterPreConsent,
            contextNonce: mainContextNonce,
            startedAt: preConsentStartedAt,
            finishedAt: preConsentFinishedAt,
          },
          rejected: {
            isolatedContext: true,
            consentPostStatus: rejectConsentStatus,
            browserTiming: { pageCreationStartedAt, navigationStartedAt, denialConfirmedAt, contextClosedAt },
            navigatedPath: '/en/products',
            eventPosts: rejectEventPosts,
            queueLength: rejectGuard.queueLength,
            cookiePresent: rejectGuard.cookiePresent,
            collecting: rejectGuard.collecting,
            dbBefore: dbBeforeReject,
            dbAfter: dbAfterReject,
            contextNonce: rejectContextNonce,
            startedAt: rejectStartedAt,
            finishedAt: rejectFinishedAt,
          },
          withdrawn: {
            consentPostStatus: withdrawConsentStatus,
            navigatedPath: '/en/products',
            eventPosts: withdrawEventPosts,
            queueLength: withdrawGuard.queueLength,
            cookiePresent: withdrawGuard.cookiePresent,
            collecting: withdrawGuard.collecting,
            dbBefore: dbBeforeWithdraw,
            dbAfter: dbAfterWithdraw,
            contextNonce: mainContextNonce,
            startedAt: withdrawStartedAt,
            finishedAt: withdrawFinishedAt,
          },
        });
        evidence.navigation = { homeMarkerKept: true, productsMarkerKept: true };
        evidence.glb = {
          facts: glbFacts,
          chosen: chosenGlb,
          catalogPath: catalogModel.pathname,
          catalogSearch: catalogModel.search,
          cacheServed,
          attemptStartedAt: new Date(attemptStartedAt).toISOString(),
          attemptResponseCount: attemptFacts.length,
          window: {
            startAt: persistedStart.occurredAt.getTime(),
            successAt: persistedSuccess.occurredAt.getTime(),
          },
          card: {
            slug: cardAtPointer.slug,
            stateAtPointer: cardAtPointer.state,
            stateAfter: 'ready',
          },
        };
        evidence.events = projectEventsEvidence(
          posts,
          eventResponseStatuses,
          pageViews,
          productViews,
          starts,
          terminals,
          {
            viewId,
            navigationId: start.navigationId,
            productSlug: slug,
            startEventId: start.eventId,
            terminalEventId: succeeded.eventId,
            pageViewEventId: boundPageView.eventId,
            productViewEventId: boundProductView.eventId,
            oneTerminalForView: true,
          },
        );
        evidence.db = projectDbEvidence(eventIds, rows, maxReceivedAt, pgIdentity);
        evidence.aggregate = projectedAggregate;
        evidence.safety = {
          noRouteInterception: network.intercepted.length === 0,
          noStorageWrites: true,
          noDirectWrites: true,
          traceDisabled: true,
          collectedApis: [ANALYTICS_EVENTS, ANALYTICS_CONSENT, OPERATIONS],
        };
        state.status = 'passed';
        recordJ6Case('case-body-passed');
      } catch (error) {
        state.status = 'failed';
        state.errors.push(error instanceof Error ? error.message : String(error));
        writeRun();
        throw error;
      }
    });
  });
  recordJ6Case('spec-registered');
}
