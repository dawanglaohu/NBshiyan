import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { useSharedAdmin } from './shared-admin';
import {
  AnalyticsSettingsDTOSchema,
  AnalyticsSettingsUpdateDTOSchema,
  type AnalyticsSettingsDTO,
  type AnalyticsSettingsUpdateDTO,
} from '../src/lib/contracts/analytics';
import type { JSHandle, Page, Request, Route, TestInfo } from '@playwright/test';

/**
 * M5-T10 状态采集 R3（capture-only，不是产品测试，不进默认门禁）。
 *
 * R3 只做最小采集源变化（R2 的加载同态、末图 PATCH、异常态布局、4 例/15 图门保持）：
 *   - 15 张图逐张测 `[data-testid="admin-account"]`；可见时在同一次 `page.screenshot` 真传 Playwright
 *     `mask` + `maskColor: #FF00FF`，并记全页整数像素 rects / accountBox / computed / 侧栏态；
 *   - 390 折叠侧栏保持原态（不打开取证），按同次 computed visibility 与几何无交集记 `not-visible`；
 *   - `identity.baseUrl` 改为相对 `/`；失败错误码只存合同枚举，告警文案只存规范形态；
 *   - 失败态另核真实 DOM 无输入/保存节点、requestfailed 与 abort 请求对象同一、重试恢复先等实际反馈；
 *   - `run.safety.accountMask.shots` 逐图绑定同一 PNG 的 sha256，供 T10 R4 发布收件门核验。
 *
 * 启用：T10_STATE_CAPTURE=1（未启用时本文件不注册任何用例，默认 A3/CI 行为不变）。
 * 空状态要求**全新专用测试库**且本文件先于任何 T10 PATCH 运行；否则按实际契约失败，不退化成“跳过”。
 */
const CAPTURE_ENABLED = process.env.T10_STATE_CAPTURE === '1';
const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;
const ORIGIN = new URL(BASE).origin;
const API = '/api/admin/settings/analytics';
const API_URL = `${ORIGIN}${API}`;
const API_PATTERN = '**/api/admin/settings/analytics';
const LANDING = '/admin/settings?section=analytics';
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const LOADING_SENTENCE = '加载中…';
const LOAD_FAILED_SENTENCE = "The result couldn't be confirmed.";
const CLIENT_DEADLINE_MS = 15_000;
const HOLD_DEADLINE_MARGIN_MS = 1_000;
const ACCOUNT_SELECTOR = '[data-testid="admin-account"]';
const MASK_COLOR = '#FF00FF';
/** 失败态只接受合同枚举内的网络层错误码；不把任意 Chromium 原文写进 RUN。 */
const NET_ERROR_CODES = new Set([
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_FAILED',
  'net::ERR_ABORTED',
  'net::ERR_TIMED_OUT',
  'net::ERR_EMPTY_RESPONSE',
]);
/** 失败块文案 = 客户端合同句 + 真实「重试」按钮；只接受这两个规范形态。 */
const ALERT_TEXTS = new Set([LOAD_FAILED_SENTENCE, `${LOAD_FAILED_SENTENCE} 重试`]);
const BUILD_ID_PATH = process.env.T10_BUILD_ID_PATH ?? path.join('.next', 'standalone', '.next', 'BUILD_ID');
const SERVER_ENTRY = path.join('.next', 'standalone', 'server.js');
const SOURCE_PATHS = [
  'src/components/admin/stats/AnalyticsSettingsContainer.tsx',
  'src/components/admin/stats/AnalyticsSettingsContainer.module.css',
  'src/components/admin/settings/settings.css',
  'src/components/admin/settings/SettingsSections.tsx',
  'src/app/admin/settings/page.tsx',
  'src/app/api/admin/settings/analytics/route.ts',
  'src/lib/server/analytics/settings.ts',
  'src/lib/client/ops.ts',
  'src/lib/client/api.ts',
  'src/lib/client/api-errors.ts',
  'src/lib/contracts/analytics.ts',
  'e2e/analytics-settings.spec.ts',
  'e2e/density-evidence.ts',
  'e2e/t10-state-capture.spec.ts',
] as const;

type Viewport = { width: number; height: number };
type StateName = 'empty' | 'loading' | 'load-failed' | 'retry-recovered' | 'saved';

type CapturedBody =
  | { ok: true; status: number; url: string; json: unknown }
  | { ok: false; reason: 'fetch' | 'body'; url: string };
type PatchBody = { ok: true; json: unknown } | { ok: false; reason: 'fetch' | 'body' };

type GetCaptureState = {
  count: number;
  urls: string[];
  documentRoute: string;
  pending: Array<Promise<CapturedBody>>;
  stop(): void;
};

type PatchState = {
  count: number;
  requestBodies: string[];
  first: Promise<PatchBody> | null;
  stop(): number;
};

type Rect = { x: number; y: number; width: number; height: number; left: number; right: number; top: number; bottom: number };
type ComputedFact = {
  display: string;
  visibility: string;
  opacity: string;
  fontSize: string;
  lineHeight: string;
  minHeight: string;
  minWidth: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  borderTopWidth: string;
  borderRadius: string;
  color: string;
  backgroundColor: string;
};
type ControlFact = { selector: string; visible: boolean; rect: Rect; computed: ComputedFact; atLeast44: boolean };
type BlockFact = {
  selector: string;
  rect: Rect;
  visible: boolean;
  gapFromTitle: number | null;
  leftDeltaFromTitle: number | null;
  computed: ComputedFact;
};
type SparseFact = { rule: string; count: number; offenders: Array<Record<string, unknown>> };
type LayoutFact = {
  viewport: string;
  htmlClientWidth: number;
  htmlScrollWidth: number;
  overflowX: number;
  page: Rect | null;
  title: Rect | null;
  block: BlockFact | null;
  sparse: SparseFact | null;
  controls: { input: ControlFact | null; save: ControlFact | null; retry: ControlFact | null };
};

type ViewportFact = {
  requested: Viewport;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  visualWidth: number | null;
  visualHeight: number | null;
  visualScale: number | null;
  scrollX: number;
  scrollY: number;
};

type UiFacts = {
  timezone: string | null;
  revision: string | null;
  versionRevision: string | null;
  recomputable: string | null;
  status: string | null;
  alert: string | null;
  rebuild: boolean;
  inputValue: string | null;
};

type LoadingFacts = {
  sentence: string;
  sentenceVisible: boolean;
  inputPresent: boolean;
  savePresent: boolean;
  alertPresent: boolean;
  patchRequests: number;
};

type FailureFacts = {
  mode: string;
  errorText: string | null;
  alertVisible: boolean;
  alertText: string;
  retryVisible: boolean;
  responsesBeforeRetry: number;
  matchedRequests: number;
  abortedRequests: number;
  /** 失败态真实 DOM：无保存/输入节点，与 layout 的 withForm=false 固定 null 分开取证。 */
  dom: { input: number; save: number; alert: number };
  /** requestfailed 事件与 route.abort 收到的请求对象同一。 */
  abortedSameObject: boolean;
};

type RecoveryFacts = {
  oldAlertGone: boolean;
  feedback: string | null;
  feedbackWaited: boolean;
  apiResponses: number;
  getCount: number;
};

type Rect2 = { x: number; y: number; width: number; height: number };

/**
 * 单张截图的账号遮盖事实（与发布门 accountMask 合同同形）。
 * rects 是全页 PNG 像素坐标的整数内框；not-visible 必须带同次 visibility/几何/侧栏态。
 */
type MaskShot = {
  file: string;
  sha256: string;
  state: StateName;
  viewport: string;
  status: 'masked' | 'not-visible';
  count: 0 | 1;
  selector: string;
  maskColor: string;
  rects: Array<[number, number, number, number]>;
  /** DOM rect（视口 CSS px，2 位小数），只审计用；不是 mask 像素框。 */
  accountRect: Rect2;
  /** 全页整数像素内框；与 rects[0] 同值（rects 被 PNG 边界裁剪时这里记录未裁剪值）。 */
  accountBox: Rect2;
  computed: { display: string; visibility: string; opacity: string };
  sidebar: {
    mode: 'static' | 'drawer';
    visible: boolean;
    visibility: string;
    transform: string;
    inert: boolean;
    dataNav: string | null;
  };
  mobile: boolean;
  scroll: { x: number; y: number };
  intersectsOutput: boolean;
  /** 只有 drawer 模式才记录；桌面常驻侧栏不写 nav，避免把抽屉状态当成可见性。 */
  nav?: 'open' | 'closed';
};

type ScreenshotFact = {
  state: StateName;
  viewport: string;
  file: string;
  bytes: number;
  sha256: string;
  fullPage: true;
  png: { width: number; height: number };
  mask: MaskShot;
};

type PatchFacts = {
  id: string;
  request: unknown;
  pageRequest: unknown;
  status: number;
  body: AnalyticsSettingsUpdateDTO;
  count: number;
  captured: number;
  countAtResponse: number;
  capturedAtResponse: number;
  countAtEnd: number;
  capturedAtEnd: number;
  screenshotsAfterPatch: number;
};

type TestRecord = { title: string; status: string; retry: number };

type StateRecord = {
  state: StateName;
  viewport: string;
  observed: ViewportFact;
  layout: LayoutFact;
  get: { count: number; urls: string[]; documentRoute: string; bodies: CapturedBody[] } | null;
  body: AnalyticsSettingsDTO | AnalyticsSettingsUpdateDTO | null;
  ui: UiFacts;
  postReleaseUi: UiFacts | null;
  loadingFacts: LoadingFacts | null;
  failure: FailureFacts | null;
  recovery: RecoveryFacts | null;
  patch: PatchFacts | null;
  route: {
    mode: string;
    heldCount: number;
    heldMs: number | null;
    clientDeadlineMs: number;
    uiCapturedBeforeRelease: boolean;
    screenshotBeforeRelease: boolean;
  } | null;
  screenshot: ScreenshotFact;
  notes: string[];
};

type StateRun = {
  schema: 'm5t10-state-capture/2';
  claim: string;
  runId: string;
  runDir: string;
  root: string;
  uploadRoot: 'e2e-evidence';
  offArtifact: boolean;
  startedAt: string;
  finishedAt: string | null;
  closed: boolean;
  identity: Record<string, unknown>;
  tests: TestRecord[];
  states: StateRecord[];
  files: ScreenshotFact[];
  safety: Record<string, unknown>;
};

let run!: StateRun;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function label(vp: Viewport): string {
  return `${vp.width}x${vp.height}`;
}

/** 与 AnalyticsSettingsContainer.utcText 同口径；用于把 GET/PATCH 的 recomputableFrom 绑到页面文案。 */
function recomputableText(iso: string | null): string {
  if (!iso) return '无可用重算待办（null 不表示重建已完成）';
  const d = new Date(iso);
  return `partial：仅 ${Number.isNaN(d.getTime()) ? iso : d.toISOString()} 起可重算；更早历史保留原时区标签`;
}

function resolveEvidenceParent(): string {
  const parent = path.resolve(process.env.T10_STATE_EVIDENCE_ROOT ?? path.join('e2e-evidence', 't10-acceptance-r2'));
  const uploadRoot = path.resolve('e2e-evidence');
  if (!(parent === uploadRoot || parent.startsWith(uploadRoot + path.sep))) {
    throw new Error(`T10_STATE_EVIDENCE_OUTSIDE_UPLOAD ${parent} 不在 ${uploadRoot} 内，CI artifact 收不到`);
  }
  return parent;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const body = JSON.stringify(value, null, 2) + '\n';
  const buffer = Buffer.from(body, 'utf8');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, buffer);
  const size = statSync(tmp).size;
  if (size !== buffer.length) {
    rmSync(tmp, { force: true });
    throw new Error(`T10_STATE_EVIDENCE_SIZE_MISMATCH ${path.basename(file)} ${size}!=${buffer.length}`);
  }
  renameSync(tmp, file);
}

function gitValue(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function readSourceHashes(): Array<Record<string, unknown>> {
  return SOURCE_PATHS.map((relative) => {
    if (!existsSync(relative)) throw new Error(`T10_STATE_CAPTURE_SOURCE_MISSING ${relative}`);
    const raw = readFileSync(relative);
    return { path: relative, bytes: raw.length, sha256: sha256(raw) };
  });
}

function normalizeBuildPath(): string {
  return path.isAbsolute(BUILD_ID_PATH)
    ? path.basename(BUILD_ID_PATH)
    : BUILD_ID_PATH.split(path.sep).join('/');
}

function buildIdentity(browserVersion: string): Record<string, unknown> {
  const env: Record<string, string | null> = {};
  for (const key of ['CI', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_WORKFLOW', 'GITHUB_REF']) {
    env[key] = process.env[key] ?? null;
  }
  const git = {
    head: gitValue(['rev-parse', 'HEAD']),
    tree: gitValue(['rev-parse', 'HEAD^{tree}']),
    parent: gitValue(['rev-parse', 'HEAD^']),
    dirtyTracked: gitValue(['status', '--porcelain', '--untracked-files=no']),
  };
  if (!git.head || !git.tree) {
    throw new Error('T10_STATE_CAPTURE_GIT_MISSING：无法读取 HEAD/tree，证据不能绑定源码 SHA');
  }
  if (git.dirtyTracked !== null) {
    throw new Error(`T10_STATE_CAPTURE_DIRTY_TRACKED 工作树有已跟踪改动，证据不能绑定源码 SHA：${git.dirtyTracked.slice(0, 400)}`);
  }
  if (env.GITHUB_SHA && env.GITHUB_SHA !== git.head) {
    throw new Error(`T10_STATE_CAPTURE_SHA_MISMATCH GITHUB_SHA=${env.GITHUB_SHA} HEAD=${git.head}`);
  }
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`T10_STATE_CAPTURE_CARRIER_MISSING ${SERVER_ENTRY}：采集只认真实 standalone 构建`);
  }
  if (!existsSync(BUILD_ID_PATH)) {
    throw new Error(`T10_STATE_CAPTURE_BUILD_ID_MISSING ${BUILD_ID_PATH}：本采集只认真实构建产物，先 pnpm build`);
  }
  const buildIdRaw = readFileSync(BUILD_ID_PATH);
  const buildId = buildIdRaw.toString('utf8').trim();
  if (!buildId) throw new Error(`T10_STATE_CAPTURE_BUILD_ID_EMPTY ${BUILD_ID_PATH}`);
  const buildPath = normalizeBuildPath();
  return {
    // 公开身份只留相对标识；完整本机 URL 不写 RUN，也不进任何公开字段。
    baseUrl: '/',
    browserVersion,
    node: process.version,
    env,
    git,
    build: {
      path: buildPath,
      source: process.env.T10_BUILD_ID_PATH ? 'T10_BUILD_ID_PATH' : 'default',
      value: buildId,
      bytes: buildIdRaw.length,
      sha256: sha256(buildIdRaw),
    },
    carrier: {
      serverEntry: SERVER_ENTRY.split(path.sep).join('/'),
      serverEntryExists: true,
      buildIdPath: buildPath,
      node: process.version,
    },
    sources: readSourceHashes(),
    sourceBytesNote: '工作树原始字节（CI checkout 为 LF）；与 Git blob 分开记录，不互相冒充',
    captureGate: 'T10_STATE_CAPTURE=1（只在采集进程，不设 job 级）',
  };
}

function beginRun(testInfo: TestInfo, browserVersion: string): StateRun {
  const parent = resolveEvidenceParent();
  mkdirSync(parent, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runId = `${stamp}-w${testInfo.workerIndex}-r${testInfo.retry}-${randomBytes(3).toString('hex')}`;
  const root = path.join(parent, `run-${runId}`);
  mkdirSync(root, { recursive: false });
  const uploadRoot = path.resolve('e2e-evidence');
  const created: StateRun = {
    schema: 'm5t10-state-capture/2',
    claim: '真实构建 + 真实 ADMIN 会话 + 真实 HTTP 的状态采集；加载为暂扣后放行原请求/原响应，失败为可观测的真实传输失败注入；不是验收结论',
    runId,
    runDir: path.basename(root),
    root,
    uploadRoot: 'e2e-evidence',
    offArtifact: !(root === uploadRoot || root.startsWith(uploadRoot + path.sep)),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    closed: false,
    identity: buildIdentity(browserVersion),
    tests: [],
    states: [],
    files: [],
    safety: {
      session: 'e2e/run-auth.ts content-admin（合成账号）',
      // 15 张图逐张取证后才成立：可见即真实 mask，不可见即同次 not-visible；见 writeRun 的自检。
      screenshotsMayShowSyntheticAdminName: false,
      credentialsInRun: false,
      fullUrlsStored: false,
      accountMask: {
        selector: ACCOUNT_SELECTOR,
        maskColor: MASK_COLOR,
        applied: false,
        shots: {} as Record<string, MaskShot>,
      },
      note: 'RUN 只存 schema 选出的字段、归一化路由/状态和构建身份；截图在采集时对 admin-account 传真实 Playwright mask（#FF00FF），390 折叠侧栏按 not-visible 记录，不存完整 URL/凭据',
    },
  };
  const buildIdCopy = 'BUILD_ID.txt';
  const buildIdRealPath = process.env.T10_BUILD_ID_PATH ?? BUILD_ID_PATH;
  writeFileSync(path.join(root, buildIdCopy), readFileSync(buildIdRealPath));
  created.identity.buildCopy = {
    file: buildIdCopy,
    bytes: statSync(path.join(root, buildIdCopy)).size,
    sha256: sha256(readFileSync(path.join(root, buildIdCopy))),
  };
  run = created;
  writeRun();
  console.log(`T10_STATE_RUN_DIR=${root}`);
  return created;
}

function writeRun(): void {
  const uploadRoot = path.resolve('e2e-evidence');
  const { root, ...rest } = run;
  const rootRelative = path.relative(uploadRoot, root).split(path.sep).join('/');
  // accountMask 只从 files 派生，避免逐图事实与汇总各写一份而漂移；每张图的 mask.sha256 必须绑定同一份 PNG 字节。
  const shots: Record<string, MaskShot> = {};
  for (const file of run.files) {
    if (!file.mask || file.mask.file !== file.file || file.mask.sha256 !== file.sha256) {
      throw new Error(`T10_STATE_CAPTURE_MASK_BINDING ${file.file}：mask 事实未绑定同一 PNG`);
    }
    shots[file.file] = file.mask;
  }
  const masked = run.files.filter((file) => file.mask.status === 'masked').length;
  (run.safety as Record<string, unknown>).accountMask = {
    selector: ACCOUNT_SELECTOR,
    maskColor: MASK_COLOR,
    applied: masked > 0,
    masked,
    notVisible: run.files.length - masked,
    shots,
  };
  // summary 维持 R2 的五键；R13 对 summary 做整字典比较，额外键会让默认与 receipt-only 都在准入前变红。
  writeJsonAtomic(path.join(root, 'm5t10-STATE-RUN.json'), {
    ...rest,
    root: rootRelative,
    summary: {
      states: run.states.length,
      screenshots: run.files.length,
      boundBodies: run.states.filter((state) => state.body !== null).length,
      testsTotal: run.tests.length,
      testsPassed: run.tests.filter((entry) => entry.status === 'passed').length,
    },
  });
}

function pushState(record: StateRecord): void {
  const existing = run.states.findIndex((state) => state.state === record.state && state.viewport === record.viewport);
  if (existing >= 0) run.states[existing] = record;
  else run.states.push(record);
  writeRun();
}

function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString('ascii', 4, 8) !== '\r\n\x1a\n') return null;
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

type MaskPlan = Omit<MaskShot, 'file' | 'sha256' | 'state' | 'viewport' | 'rects'>;

/**
 * 同一次截图前测账号块：滚动归零 → DOM rect / computed / 侧栏态 / 是否与全页输出相交。
 * 可见即返回整数内框作为 mask rects；不可见或画外只记 not-visible，不造正矩形。
 */
async function measureAccount(page: Page, vp: Viewport): Promise<MaskPlan> {
  return page.evaluate(({ selector, maskColor, width }): MaskPlan => {
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (nodes.length !== 1) {
      throw new Error(`T10_STATE_CAPTURE_ACCOUNT_COUNT ${nodes.length}：账号块必须恰好一个`);
    }
    const el = nodes[0];
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const side = el.closest('.adm-side') as HTMLElement | null;
    const sideCs = side ? getComputedStyle(side) : null;
    const adm = document.querySelector<HTMLElement>('.adm');
    const dataNav = adm?.getAttribute('data-nav') ?? null;
    const mobile = !!sideCs && sideCs.position === 'fixed';
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const docWidth = Math.max(document.documentElement.scrollWidth, width);
    const docHeight = Math.max(document.documentElement.scrollHeight, innerHeight);
    const left = rect.x + scrollX;
    const top = rect.y + scrollY;
    const visible = cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) > 0;
    const intersectsOutput = left < docWidth && left + rect.width > 0 && top < docHeight && top + rect.height > 0;
    // 整数内框只丢弃部分覆盖的边界像素；不提前内缩，1px 边缘容差由发布门统一处理。
    const accountBox = {
      x: Math.ceil(left),
      y: Math.ceil(top),
      width: Math.floor(left + rect.width) - Math.ceil(left),
      height: Math.floor(top + rect.height) - Math.ceil(top),
    };
    const paintable = visible && intersectsOutput && accountBox.width > 0 && accountBox.height > 0;
    return {
      status: paintable ? 'masked' : 'not-visible',
      count: 1,
      selector,
      maskColor,
      accountRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      accountBox,
      computed: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity },
      sidebar: {
        mode: mobile ? 'drawer' : 'static',
        visible: !!sideCs && sideCs.display !== 'none' && sideCs.visibility === 'visible',
        visibility: sideCs ? sideCs.visibility : 'missing',
        transform: sideCs ? sideCs.transform : 'missing',
        inert: !!side && side.hasAttribute('inert'),
        dataNav,
      },
      mobile,
      scroll: { x: scrollX, y: scrollY },
      intersectsOutput,
      ...(mobile ? { nav: (dataNav === 'open' ? 'open' : 'closed') as 'open' | 'closed' } : {}),
    };
  }, { selector: ACCOUNT_SELECTOR, maskColor: MASK_COLOR, width: vp.width });
}

async function captureScreenshot(state: StateName, vp: Viewport, page: Page): Promise<ScreenshotFact> {
  const viewport = label(vp);
  const file = `state-${state}-${viewport}.png`;
  // 进入移动断点会触发抽屉过渡。截图会快进这些过渡，首次测量须等它们自然结束。
  await expect.poll(() => page.evaluate(() => {
    const sidebar = document.querySelector('.adm-side');
    if (!sidebar || getComputedStyle(sidebar).position !== 'fixed') return true;
    return sidebar.getAnimations().every((animation) =>
      !animation.pending && (animation.playState === 'finished' || animation.playState === 'idle'),
    );
  }), { message: `T10_STATE_CAPTURE_MASK_DRIFT ${file}：移动侧栏过渡未稳定` }).toBe(true);
  const plan = await measureAccount(page, vp);
  if (plan.scroll.x !== 0 || plan.scroll.y !== 0) {
    throw new Error(`T10_STATE_CAPTURE_SCROLL ${file} ${plan.scroll.x},${plan.scroll.y}：全页 mask 坐标要求滚动归零`);
  }
  const buffer = await page.screenshot({
    path: path.join(run.root, file),
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    // 与测量同一次调用：可见时才真正把账号 locator 交给 Playwright 在像素上遮盖。
    ...(plan.status === 'masked' ? { mask: [page.locator(ACCOUNT_SELECTOR)], maskColor: MASK_COLOR } : {}),
  });
  // 截图前后账号可见性/布局漂移即拒收：否则 mask 矩形可能对不上最终 PNG。
  const after = await measureAccount(page, vp);
  const stable = (value: unknown): string => JSON.stringify(value);
  if (
    after.status !== plan.status ||
    stable(after.computed) !== stable(plan.computed) ||
    stable(after.sidebar) !== stable(plan.sidebar) ||
    stable(after.accountRect) !== stable(plan.accountRect) ||
    stable(after.accountBox) !== stable(plan.accountBox) ||
    stable(after.scroll) !== stable(plan.scroll)
  ) {
    throw new Error(`T10_STATE_CAPTURE_MASK_DRIFT ${file}：截图前后账号几何/可见性发生变化`);
  }
  const png = pngSize(buffer);
  if (!png || png.width !== vp.width) {
    throw new Error(`T10_STATE_CAPTURE_PNG_INVALID ${file} ${JSON.stringify(png)} 期望宽度 ${vp.width}`);
  }
  if (png.height < 120 || png.height > 30_000) {
    throw new Error(`T10_STATE_CAPTURE_PNG_HEIGHT ${file} ${png.height}`);
  }
  // 用实际 PNG 宽高重算最终交集；不拿截图前的 scrollWidth/scrollHeight 推断。
  const x0 = Math.max(0, plan.accountBox.x);
  const y0 = Math.max(0, plan.accountBox.y);
  const x1 = Math.min(png.width, plan.accountBox.x + plan.accountBox.width);
  const y1 = Math.min(png.height, plan.accountBox.y + plan.accountBox.height);
  const intersectsOutput = x1 - x0 > 0 && y1 - y0 > 0;
  const rects: Array<[number, number, number, number]> = [];
  if (plan.status === 'masked') {
    if (!intersectsOutput) {
      throw new Error(`T10_STATE_CAPTURE_MASK_OUTSIDE ${file}：测得可见但实际输出内无交集`);
    }
    rects.push([x0, y0, x1 - x0, y1 - y0]);
  } else {
    const computed = plan.computed.visibility === 'hidden' || plan.computed.visibility === 'collapse' || plan.computed.display === 'none';
    if (intersectsOutput && !computed) {
      throw new Error(`T10_STATE_CAPTURE_MASK_UNPROVEN ${file}：既不可遮盖也未证明不可见`);
    }
  }
  const mask: MaskShot = {
    file,
    sha256: sha256(buffer),
    state,
    viewport,
    status: plan.status,
    count: plan.count,
    selector: plan.selector,
    maskColor: plan.maskColor,
    rects,
    accountRect: plan.accountRect,
    accountBox: plan.accountBox,
    computed: plan.computed,
    sidebar: plan.sidebar,
    mobile: plan.mobile,
    scroll: plan.scroll,
    intersectsOutput,
    ...(plan.nav ? { nav: plan.nav } : {}),
  };
  const fact: ScreenshotFact = { state, viewport, file, bytes: buffer.length, sha256: mask.sha256, fullPage: true, png, mask };
  const existing = run.files.findIndex((entry) => entry.file === file);
  if (existing >= 0) run.files[existing] = fact;
  else run.files.push(fact);
  return fact;
}

async function viewportFact(page: Page, requested: Viewport): Promise<ViewportFact> {
  const observed = await page.evaluate(() => {
    const vv = window.visualViewport;
    return {
      innerWidth,
      innerHeight,
      devicePixelRatio,
      visualWidth: vv ? vv.width : null,
      visualHeight: vv ? vv.height : null,
      visualScale: vv ? vv.scale : null,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  });
  return { requested, ...observed };
}

async function readUi(page: Page): Promise<UiFacts> {
  return page.evaluate((): UiFacts => {
    const byTestId = (id: string): Element | null => document.querySelector(`[data-testid="${id}"]`);
    const text = (id: string): string | null => byTestId(id)?.textContent ?? null;
    const revision = byTestId('analytics-settings-revision');
    const input = document.querySelector('[data-testid="analytics-settings-input"]') as HTMLInputElement | null;
    return {
      timezone: text('analytics-settings-timezone'),
      revision: text('analytics-settings-revision'),
      versionRevision: revision?.parentElement?.textContent ?? null,
      recomputable: text('analytics-settings-recomputable'),
      status: text('analytics-settings-status'),
      alert: text('analytics-settings-alert'),
      rebuild: byTestId('analytics-settings-rebuild') !== null,
      inputValue: input ? input.value : null,
    };
  });
}

/**
 * 异常态布局事实：只量当前可见控件；无表单的状态不量不存在的输入。
 * D5 用工具原规则（pad>=32 && height>=80 && text<120 && children<=4），只排除 .st-page 容器
 * 与 .st-side 侧栏；不把正常态 D1–D6/44px 套到异常态。
 */
async function readLayout(page: Page, state: StateName, vp: Viewport): Promise<LayoutFact> {
  return page.evaluate(({ stateName, viewportLabel, withForm }): LayoutFact => {
    const rect = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const styleOf = (el: Element): ComputedFact => {
      const cs = getComputedStyle(el);
      return {
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        minHeight: cs.minHeight,
        minWidth: cs.minWidth,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        borderTopWidth: cs.borderTopWidth,
        borderRadius: cs.borderTopLeftRadius,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
      };
    };
    const shown = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width >= 1 && r.height >= 1;
    };
    const control = (selector: string): ControlFact | null => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = rect(el);
      return { selector, visible: shown(el), rect: r, computed: styleOf(el), atLeast44: r.width >= 44 && r.height >= 44 };
    };
    const pageEl = document.querySelector('.st-page');
    const titleEl = pageEl ? pageEl.querySelector('h1') : null;
    const blockSelector = stateName === 'loading' ? 'p.st-hint' : stateName === 'load-failed' ? 'p.st-ferr[role="alert"]' : null;
    const blockEl = pageEl && blockSelector ? pageEl.querySelector(blockSelector) : null;
    let block: BlockFact | null = null;
    if (pageEl && blockEl && blockSelector) {
      const br = rect(blockEl);
      const tr = titleEl ? rect(titleEl) : null;
      block = {
        selector: blockSelector,
        rect: br,
        visible: shown(blockEl),
        gapFromTitle: tr ? Math.round((br.top - tr.bottom) * 100) / 100 : null,
        leftDeltaFromTitle: tr ? Math.round((br.left - tr.left) * 100) / 100 : null,
        computed: styleOf(blockEl),
      };
    }
    let sparse: SparseFact | null = null;
    if (pageEl && (stateName === 'loading' || stateName === 'load-failed' || stateName === 'empty')) {
      const offenders: Array<Record<string, unknown>> = [];
      for (const el of Array.from(pageEl.querySelectorAll('*'))) {
        if (!shown(el)) continue;
        if (el.closest('.st-side')) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const pad = Math.max(
          parseFloat(cs.paddingTop),
          parseFloat(cs.paddingRight),
          parseFloat(cs.paddingBottom),
          parseFloat(cs.paddingLeft),
        );
        const text = (el.textContent ?? '').trim();
        if (pad >= 32 && r.height >= 80 && text.length < 120 && el.children.length <= 4) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            class: el.getAttribute('class'),
            pad,
            height: Math.round(r.height),
            textLength: text.length,
            children: el.children.length,
          });
        }
      }
      sparse = {
        rule: 'D5: max(padding)>=32 && height>=80 && textLength<120 && children<=4；排除 .st-page 容器与 .st-side 侧栏',
        count: offenders.length,
        offenders: offenders.slice(0, 10),
      };
    }
    const html = document.documentElement;
    return {
      viewport: viewportLabel,
      htmlClientWidth: html.clientWidth,
      htmlScrollWidth: html.scrollWidth,
      overflowX: Math.max(0, html.scrollWidth - html.clientWidth),
      page: pageEl ? rect(pageEl) : null,
      title: titleEl ? rect(titleEl) : null,
      block,
      sparse,
      controls: {
        input: withForm ? control('[data-testid="analytics-settings-input"]') : null,
        save: withForm ? control('[data-testid="analytics-settings-save"]') : null,
        retry: stateName === 'load-failed' ? control('p.st-ferr[role="alert"] button') : null,
      },
    };
  }, { stateName: state, viewportLabel: label(vp), withForm: state !== 'loading' && state !== 'load-failed' });
}

/** §17 适用项：各态无横溢；加载/失败态 D5 稀疏块与放置；390 重试控件 ≥44px；有表单态只记录不套正常态 44px。 */
function expectLayout(layout: LayoutFact, state: StateName, vp: Viewport): void {
  const where = `${state}/${label(vp)}`;
  expect(layout.overflowX, `${where} 横向溢出`).toBe(0);
  if (state === 'loading' || state === 'load-failed') {
    const block = layout.block;
    if (!block) throw new Error(`${where} 缺少状态块`);
    expect(block.visible, `${where} 状态块可见`).toBe(true);
    expect(block.gapFromTitle, `${where} 状态块应在标题下方同流`).not.toBeNull();
    expect(block.gapFromTitle!, `${where} 状态块与标题净距`).toBeGreaterThanOrEqual(0);
    expect(block.gapFromTitle!, `${where} 状态块与标题净距`).toBeLessThanOrEqual(24);
    expect(block.leftDeltaFromTitle, `${where} 状态块左对齐`).not.toBeNull();
    expect(block.leftDeltaFromTitle!, `${where} 状态块左对齐`).toBeGreaterThanOrEqual(0);
    expect(block.leftDeltaFromTitle!, `${where} 状态块左对齐`).toBeLessThanOrEqual(2);
    expect(layout.sparse, `${where} D5 事实`).not.toBeNull();
    expect(layout.sparse!.count, `${where} D5 稀疏块`).toBe(0);
    expect(layout.controls.input, `${where} 无表单时不应有输入框`).toBeNull();
    expect(layout.controls.save, `${where} 无表单时不应有保存按钮`).toBeNull();
  }
  if (state === 'load-failed' && vp.width === 390) {
    const retry = layout.controls.retry;
    if (!retry) throw new Error(`${where} 缺少重试控件`);
    expect(retry.visible, `${where} 重试控件可见`).toBe(true);
    expect(retry.atLeast44, `${where} 重试控件 ≥44px`).toBe(true);
  }
  if (state === 'empty') {
    expect(layout.sparse, `${where} D5 事实`).not.toBeNull();
    expect(layout.sparse!.count, `${where} D5 稀疏块`).toBe(0);
    expect(layout.controls.input, `${where} 输入框`).not.toBeNull();
    expect(layout.controls.save, `${where} 保存按钮`).not.toBeNull();
  }
  if (state === 'retry-recovered' || state === 'saved') {
    expect(layout.controls.input, `${where} 输入框`).not.toBeNull();
    expect(layout.controls.save, `${where} 保存按钮`).not.toBeNull();
  }
}

/** 页内钩子：只复制页面自己收到的 GET 响应体；不改请求、不改返回的 Promise。 */
async function installGetCapture(page: Page): Promise<() => Promise<void>> {
  const script = await page.addInitScript(({ apiUrl, apiPath }: { apiUrl: string; apiPath: string }) => {
    const original = window.fetch;
    const state: GetCaptureState = {
      count: 0,
      urls: [],
      documentRoute: '',
      pending: [],
      stop() {
        if (window.fetch === wrapper) window.fetch = original;
      },
    };
    const wrapper: typeof window.fetch = (...args) => {
      const pending = original.apply(window, args);
      const [input, init] = args;
      const request = input instanceof window.Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return pending;
      let url: URL;
      try {
        url = new URL(request?.url ?? String(input), document.baseURI);
      } catch {
        return pending;
      }
      if (url.href !== apiUrl) return pending;
      state.count += 1;
      state.urls.push(apiPath);
      state.documentRoute = `${location.pathname}${location.search}`;
      state.pending.push(pending.then(
        async (response): Promise<CapturedBody> => {
          try {
            return { ok: true, status: response.status, url: apiPath, json: await response.clone().json() };
          } catch {
            return { ok: false, reason: 'body', url: apiPath };
          }
        },
        (): CapturedBody => ({ ok: false, reason: 'fetch', url: apiPath }),
      ));
      return pending;
    };
    window.fetch = wrapper;
    (window as unknown as { __t10GetCapture?: GetCaptureState }).__t10GetCapture = state;
  }, { apiUrl: API_URL, apiPath: API });
  return () => script.dispose();
}

async function stopGetCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __t10GetCapture?: GetCaptureState }).__t10GetCapture;
    state?.stop();
  });
}

async function waitForGetCount(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count: number) => {
    const state = (window as unknown as { __t10GetCapture?: { count: number } }).__t10GetCapture;
    return (state?.count ?? 0) === count;
  }, expected, { timeout: 20_000 });
}

async function readGetCapture(page: Page): Promise<{
  count: number;
  urls: string[];
  documentRoute: string;
  bodies: CapturedBody[];
}> {
  return page.evaluate(async () => {
    const state = (window as unknown as { __t10GetCapture?: GetCaptureState }).__t10GetCapture;
    if (!state) throw new Error('T10 GET 捕获未安装');
    const bodies = await Promise.all(state.pending);
    return { count: state.count, urls: state.urls.slice(), documentRoute: state.documentRoute, bodies };
  });
}

function expectOkBody(body: CapturedBody, step: string): Extract<CapturedBody, { ok: true }> {
  if (!body.ok) throw new Error(`${step} 缺少页面自己收到的 GET 正文（${body.reason}）`);
  expect(body.status, `${step} GET 状态码`).toBe(200);
  return body;
}

/** 同一次 GET 的正文必须与右栏四字段、输入框、null/partial 文案逐项一致；只记录归一化路由。 */
async function assertGetBound(page: Page, body: AnalyticsSettingsDTO, documentRoute: string): Promise<void> {
  expect(Object.keys(body).sort(), 'GET 四字段').toEqual([
    'recomputableFrom',
    'timezone',
    'timezoneRevision',
    'version',
  ]);
  expect(documentRoute.startsWith('/admin/settings?'), 'GET 发起文档').toBe(true);
  expect(new URL(documentRoute, 'http://placeholder.invalid').searchParams.get('section'), 'GET 发起分区').toBe('analytics');
  await expect(page.getByTestId('analytics-settings-timezone')).toHaveText(body.timezone);
  await expect(page.getByTestId('analytics-settings-revision')).toHaveText(String(body.timezoneRevision));
  await expect(page.getByTestId('analytics-settings-revision').locator('xpath=..')).toHaveText(
    `version ${body.version} · revision ${body.timezoneRevision}`,
  );
  await expect(page.getByTestId('analytics-settings-recomputable')).toHaveText(recomputableText(body.recomputableFrom));
}

/** 保存态每张截图前都核：状态文案、右栏四字段和重算提示仍对应当前这笔 PATCH 响应。 */
async function assertSavedBinding(page: Page, next: AnalyticsSettingsUpdateDTO): Promise<void> {
  await expect(page.getByTestId('analytics-settings-status')).toHaveText(
    `✓ 已保存：version ${next.version} · revision ${next.timezoneRevision} · 已登记重算`,
  );
  await expect(page.getByTestId('analytics-settings-timezone')).toHaveText(next.timezone);
  await expect(page.getByTestId('analytics-settings-revision')).toHaveText(String(next.timezoneRevision));
  await expect(page.getByTestId('analytics-settings-recomputable')).toHaveText(recomputableText(next.recomputableFrom));
  await expect(page.getByTestId('analytics-settings-rebuild')).toBeVisible();
}

if (CAPTURE_ENABLED) {
  test.describe('M5-T10 状态采集 R2（capture-only）', () => {
    test.beforeAll(async ({ browser }, testInfo: TestInfo) => {
      run = beginRun(testInfo, browser.version());
    });

    useSharedAdmin({
      emailPrefix: 'e2e-t10-state-capture-r2',
      name: 'E2E T10 state capture R2',
      probe: API,
      slot: 'content-admin',
    });

    test.afterEach(({}, testInfo: TestInfo) => {
      if (!run) return;
      run.tests.push({ title: testInfo.title, status: testInfo.status ?? 'unknown', retry: testInfo.retry });
      // 收尾写入失败必须让本次运行失败，不能只 warn。
      writeRun();
    });

    test.afterAll(() => {
      if (!run) return;
      run.closed = true;
      run.finishedAt = new Date().toISOString();
      // 最终写入失败必须抛出；没有 CLOSED 行/closed=true 的 RUN 复核器会拒绝。
      writeRun();
      console.log(`T10_STATE_RUN_CLOSED=${run.root}`);
    });

    test('空/无重算：契约初始态与同次 GET 四字段绑定（三视口）', async ({ page }) => {
      test.setTimeout(180_000);
      const stop = await installGetCapture(page);
      try {
        for (const vp of VIEWPORTS) {
          const viewport = label(vp);
          await page.setViewportSize(vp);
          const navigation = await page.goto(LANDING);
          expect(navigation?.status(), `${viewport} 分区页状态`).toBe(200);
          await waitForGetCount(page, 1);
          const get = await readGetCapture(page);
          expect(get.count, `${viewport} 空状态应只有一笔页面 GET`).toBe(1);
          const captured = expectOkBody(get.bodies[0], `${viewport} 空状态`);
          const body = AnalyticsSettingsDTOSchema.parse(captured.json);
          expect(body, `${viewport} 空状态必须是全新测试库的契约初始值；先跑本文件再做任何 T10 PATCH`).toEqual({
            version: 0,
            timezone: 'UTC',
            timezoneRevision: 1,
            recomputableFrom: null,
          });
          await assertGetBound(page, body, get.documentRoute);
          await expect(page.getByTestId('analytics-settings-input')).toHaveValue('UTC');
          await expect(page.getByTestId('analytics-settings-status')).toHaveCount(0);
          await expect(page.getByTestId('analytics-settings-alert')).toHaveCount(0);
          await expect(page.getByTestId('analytics-settings-rebuild')).toHaveCount(0);

          const observed = await viewportFact(page, vp);
          expect(observed.innerWidth, `${viewport} 观测宽度`).toBe(vp.width);
          expect(observed.innerHeight, `${viewport} 观测高度`).toBe(vp.height);
          const layout = await readLayout(page, 'empty', vp);
          expectLayout(layout, 'empty', vp);
          const ui = await readUi(page);
          const screenshot = await captureScreenshot('empty', vp, page);
          pushState({
            state: 'empty',
            viewport,
            observed,
            layout,
            get,
            body,
            ui,
            postReleaseUi: null,
            loadingFacts: null,
            failure: null,
            recovery: null,
            patch: null,
            route: null,
            screenshot,
            notes: ['契约初始态；GET 无查询参数；null 文案不表示重建完成'],
          });
        }
      } finally {
        await stopGetCapture(page).catch(() => undefined);
        await stop().catch(() => undefined);
      }
    });

    test('加载中：放行前同一 UI 状态与截图，再放行原请求（三视口）', async ({ page }) => {
      test.setTimeout(180_000);
      const stop = await installGetCapture(page);
      try {
        for (const vp of VIEWPORTS) {
          const viewport = label(vp);
          await page.setViewportSize(vp);
          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let heldCount = 0;
          let heldMs = 0;
          const handler = async (route: Route): Promise<void> => {
            const request = route.request();
            if (
              request.method() !== 'GET' ||
              request.url() !== API_URL ||
              request.frame() !== page.mainFrame() ||
              request.isNavigationRequest() ||
              request.serviceWorker()
            ) {
              await route.continue();
              return;
            }
            heldCount += 1;
            const startedAt = Date.now();
            await gate;
            heldMs = Date.now() - startedAt;
            await route.continue();
          };
          await page.route(API_PATTERN, handler);
          let patchRequests = 0;
          const countPatch = (request: Request): void => {
            if (request.method() === 'PATCH' && request.url() === API_URL) patchRequests += 1;
          };
          page.on('request', countPatch);
          try {
            const navigation = await page.goto(LANDING);
            expect(navigation?.status(), `${viewport} 分区页状态`).toBe(200);
            await waitForGetCount(page, 1);
            await expect.poll(() => heldCount, { timeout: 10_000 }).toBe(1);
            await expect(page.getByText(LOADING_SENTENCE, { exact: true })).toBeVisible();
            await expect(page.getByTestId('analytics-settings-input')).toHaveCount(0);
            const ui = await readUi(page);
            expect(ui.timezone, `${viewport} 放行前无右栏`).toBeNull();
            expect(ui.inputValue, `${viewport} 放行前无输入框`).toBeNull();
            expect(ui.status, `${viewport} 放行前无反馈`).toBeNull();
            expect(ui.alert, `${viewport} 放行前无告警`).toBeNull();
            const layout = await readLayout(page, 'loading', vp);
            expectLayout(layout, 'loading', vp);
            const loadingFacts: LoadingFacts = {
              sentence: LOADING_SENTENCE,
              sentenceVisible: await page.getByText(LOADING_SENTENCE, { exact: true }).isVisible(),
              inputPresent: (await page.getByTestId('analytics-settings-input').count()) > 0,
              savePresent: (await page.getByTestId('analytics-settings-save').count()) > 0,
              alertPresent: (await page.locator('.st-page').getByRole('alert').count()) > 0,
              patchRequests,
            };
            expect(loadingFacts.sentenceVisible).toBe(true);
            expect(loadingFacts.inputPresent).toBe(false);
            expect(loadingFacts.savePresent).toBe(false);
            expect(loadingFacts.alertPresent).toBe(false);
            expect(loadingFacts.patchRequests).toBe(0);
            const observed = await viewportFact(page, vp);
            expect(observed.innerWidth).toBe(vp.width);
            expect(observed.innerHeight).toBe(vp.height);
            const screenshot = await captureScreenshot('loading', vp, page);
            // UI、几何、视口与截图都在同一暂扣状态完成；此刻才放行原请求。
            release();
            await expect(page.getByTestId('analytics-settings-input')).toBeVisible();
            const get = await readGetCapture(page);
            expect(get.count, `${viewport} 加载态应只有一笔页面 GET`).toBe(1);
            const captured = expectOkBody(get.bodies[0], `${viewport} 加载态`);
            const body = AnalyticsSettingsDTOSchema.parse(captured.json);
            await assertGetBound(page, body, get.documentRoute);
            const postReleaseUi = await readUi(page);
            expect(postReleaseUi.timezone).toBe(body.timezone);
            expect(postReleaseUi.revision).toBe(String(body.timezoneRevision));
            expect(postReleaseUi.versionRevision?.trim()).toBe(`version ${body.version} · revision ${body.timezoneRevision}`);
            expect(postReleaseUi.recomputable).toBe(recomputableText(body.recomputableFrom));
            expect(postReleaseUi.inputValue).toBe(body.timezone);
            expect(heldMs, `${viewport} 暂扣时延应可观测`).toBeGreaterThan(0);
            expect(heldMs, `${viewport} 放行必须仍在产品 ${CLIENT_DEADLINE_MS}ms 时限内`).toBeLessThan(
              CLIENT_DEADLINE_MS - HOLD_DEADLINE_MARGIN_MS,
            );
            pushState({
              state: 'loading',
              viewport,
              observed,
              layout,
              get,
              body,
              ui,
              postReleaseUi,
              loadingFacts,
              failure: null,
              recovery: null,
              patch: null,
              route: {
                mode: 'hold-then-continue（原请求、原响应；放行前采 UI/几何/截图）',
                heldCount,
                heldMs,
                clientDeadlineMs: CLIENT_DEADLINE_MS,
                uiCapturedBeforeRelease: true,
                screenshotBeforeRelease: true,
              },
              screenshot,
              notes: [`放行前截图；heldMs=${heldMs}；放行后 GET 200 与四字段同次绑定`],
            });
          } finally {
            release();
            page.off('request', countPatch);
            await page.unroute(API_PATTERN, handler).catch(() => undefined);
          }
        }
      } finally {
        await stopGetCapture(page).catch(() => undefined);
        await stop().catch(() => undefined);
      }
    });

    test('加载失败与重试：真实传输失败（net::ERR_*）后恢复真实请求（三视口）', async ({ page }) => {
      test.setTimeout(180_000);
      const stop = await installGetCapture(page);
      try {
        for (const vp of VIEWPORTS) {
          const viewport = label(vp);
          await page.setViewportSize(vp);
          let apiResponses = 0;
          const onResponse = (response: { url(): string }): void => {
            if (response.url() === API_URL) apiResponses += 1;
          };
          page.on('response', onResponse);
          let matchedRequests = 0;
          let abortedRequests = 0;
          let abortRequest: Request | null = null;
          const failedEvent = page.waitForEvent('requestfailed', {
            predicate: (request: Request) => request.url() === API_URL && request.method() === 'GET',
            timeout: 20_000,
          });
          const handler = async (route: Route): Promise<void> => {
            const request = route.request();
            // 先排除 worker/导航，再访问 frame()：service worker 请求没有可比较的主帧。
            if (
              request.method() !== 'GET' ||
              request.url() !== API_URL ||
              request.serviceWorker() ||
              request.isNavigationRequest() ||
              request.frame() !== page.mainFrame()
            ) {
              await route.continue();
              return;
            }
            matchedRequests += 1;
            abortedRequests += 1;
            abortRequest = request;
            await route.abort('internetdisconnected');
          };
          await page.route(API_PATTERN, handler);
          try {
            const navigation = await page.goto(LANDING);
            expect(navigation?.status(), `${viewport} 分区页状态`).toBe(200);
            const failedRequest = await failedEvent;
            expect(abortRequest, `${viewport} 应记录被中止的那一笔请求`).not.toBeNull();
            // requestfailed 与 route.abort 必须是同一个 Request 对象，而不是只按 URL 猜到的另一笔。
            expect(failedRequest, `${viewport} requestfailed 与 abort 的请求对象应同一`).toBe(abortRequest);
            const rawError = failedRequest.failure()?.errorText ?? '';
            if (!NET_ERROR_CODES.has(rawError)) {
              throw new Error(`T10_STATE_CAPTURE_NET_ERROR_UNKNOWN ${viewport} ${rawError}`);
            }
            const errorText = rawError;
            const alert = page.locator('.st-page').getByRole('alert');
            await expect(alert).toBeVisible();
            const alertText = (await alert.innerText()).replace(/\s+/g, ' ').trim();
            if (!ALERT_TEXTS.has(alertText)) {
              throw new Error(`T10_STATE_CAPTURE_ALERT_TEXT ${viewport} ${alertText}`);
            }
            await expect(page.getByTestId('analytics-settings-input')).toHaveCount(0);
            const retryButton = page.getByRole('button', { name: '重试' });
            const retryVisible = await retryButton.isVisible();
            // layout 在 withForm=false 时把 input/save 固定成 null；这里单独核真实 DOM 节点数。
            const dom = {
              input: await page.getByTestId('analytics-settings-input').count(),
              save: await page.getByTestId('analytics-settings-save').count(),
              alert: await page.locator('.st-page').getByRole('alert').count(),
            };
            expect(dom.input, `${viewport} 失败态真实 DOM 无输入框`).toBe(0);
            expect(dom.save, `${viewport} 失败态真实 DOM 无保存按钮`).toBe(0);
            expect(dom.alert, `${viewport} 失败态真实 DOM 只有一个告警块`).toBe(1);
            const ui = await readUi(page);
            const layout = await readLayout(page, 'load-failed', vp);
            expectLayout(layout, 'load-failed', vp);
            const failureShot = await captureScreenshot('load-failed', vp, page);
            expect(apiResponses, `${viewport} 失败请求不得有 HTTP 响应`).toBe(0);
            expect(matchedRequests, `${viewport} 失败路由只应命中一笔精确请求`).toBe(1);
            expect(abortedRequests, `${viewport} 只应中止一笔请求`).toBe(1);
            pushState({
              state: 'load-failed',
              viewport,
              observed: await viewportFact(page, vp),
              layout,
              get: null,
              body: null,
              ui,
              postReleaseUi: null,
              loadingFacts: null,
              failure: {
                mode: 'route.abort(internetdisconnected)，真实传输失败',
                errorText,
                alertVisible: true,
                alertText,
                retryVisible,
                responsesBeforeRetry: apiResponses,
                matchedRequests,
                abortedRequests,
                dom,
                abortedSameObject: failedRequest === abortRequest,
              },
              recovery: null,
              patch: null,
              route: null,
              screenshot: failureShot,
              notes: ['故障注入：只中止目标 GET，不伪造状态码/响应体；不声明生产故障'],
            });

            await page.unroute(API_PATTERN, handler);
            await retryButton.click();
            await expect(page.getByTestId('analytics-settings-input')).toBeVisible();
            await waitForGetCount(page, 2);
            const get = await readGetCapture(page);
            expect(get.count, `${viewport} 失败后应恰有一次用户重试`).toBe(2);
            const first = get.bodies[0];
            if (first.ok) throw new Error(`${viewport} 第一次 GET 不应成功`);
            expect(first.reason, `${viewport} 第一次 GET 必须是 fetch 失败`).toBe('fetch');
            const captured = expectOkBody(get.bodies[1], `${viewport} 重试`);
            const body = AnalyticsSettingsDTOSchema.parse(captured.json);
            await assertGetBound(page, body, get.documentRoute);
            // 恢复反馈按实际 text locator 等待，再采 UI；不把“输入框出现”当成恢复成功。
            await expect(page.getByTestId('analytics-settings-status')).toHaveText(
              /^已读取最新配置（version \d+）；你的输入保留。$/,
            );
            const postUi = await readUi(page);
            expect(apiResponses, `${viewport} 重试必须命中真实服务端一次`).toBe(1);
            const oldAlertGone = (await page.locator('.st-page').getByRole('alert').count()) === 0;
            expect(oldAlertGone, `${viewport} 恢复后旧首屏错误应消失`).toBe(true);
            const recoveryLayout = await readLayout(page, 'retry-recovered', vp);
            expectLayout(recoveryLayout, 'retry-recovered', vp);
            const recoveredShot = await captureScreenshot('retry-recovered', vp, page);
            pushState({
              state: 'retry-recovered',
              viewport,
              observed: await viewportFact(page, vp),
              layout: recoveryLayout,
              get,
              body,
              ui: postUi,
              postReleaseUi: null,
              loadingFacts: null,
              failure: null,
              recovery: {
                oldAlertGone,
                feedback: postUi.status,
                feedbackWaited: true,
                apiResponses,
                getCount: get.count,
              },
              patch: null,
              route: null,
              screenshot: recoveredShot,
              notes: ['用户点击页面「重试」后走真实请求；输入框是否回填按组件实际行为记录，不假设'],
            });
          } finally {
            await page.unroute(API_PATTERN, handler).catch(() => undefined);
            page.off('response', onResponse);
          }
        }
      } finally {
        await stopGetCapture(page).catch(() => undefined);
        await stop().catch(() => undefined);
      }
    });

    test('保存结果：同笔 PATCH 200 与 UI 绑定，计数持续到最后一张截图', async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      const stopGet = await installGetCapture(page);
      let patchHandle: JSHandle<PatchState> | null = null;
      let patchStopped = false;
      const saveRequests: Request[] = [];
      const onRequest = (request: Request): void => {
        if (
          request.method() !== 'PATCH' ||
          request.url() !== API_URL ||
          request.frame() !== page.mainFrame() ||
          request.isNavigationRequest() ||
          request.serviceWorker()
        ) {
          return;
        }
        saveRequests.push(request);
      };
      page.on('request', onRequest);
      try {
        const navigation = await page.goto(LANDING);
        expect(navigation?.status(), '1440x900 分区页状态').toBe(200);
        await waitForGetCount(page, 1);
        const get = await readGetCapture(page);
        expect(get.count, '保存前应只有一笔页面 GET').toBe(1);
        const initialCaptured = expectOkBody(get.bodies[0], '保存前');
        const initial = AnalyticsSettingsDTOSchema.parse(initialCaptured.json);
        await assertGetBound(page, initial, get.documentRoute);
        await expect(page.getByTestId('analytics-settings-input')).toHaveValue(initial.timezone);

        const target = initial.timezone === 'Asia/Tokyo' ? 'Europe/Berlin' : 'Asia/Tokyo';
        await page.getByTestId('analytics-settings-input').fill(target);

        patchHandle = await page.evaluateHandle(({ apiUrl }: { apiUrl: string }) => {
          const original = window.fetch;
          const state: PatchState = {
            count: 0,
            requestBodies: [],
            first: null,
            stop(): number {
              if (window.fetch === wrapper) window.fetch = original;
              return this.count;
            },
          };
          const wrapper: typeof window.fetch = (...args) => {
            const pending = original.apply(window, args);
            const [input, init] = args;
            const request = input instanceof window.Request ? input : null;
            const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
            if (method !== 'PATCH') return pending;
            let url: URL;
            try {
              url = new URL(request?.url ?? String(input), document.baseURI);
            } catch {
              return pending;
            }
            if (url.href !== apiUrl) return pending;
            state.count += 1;
            if (typeof init?.body === 'string') state.requestBodies.push(init.body);
            if (state.count === 1) {
              state.first = pending.then(
                async (response): Promise<PatchBody> => {
                  try {
                    return { ok: true, json: await response.clone().json() };
                  } catch {
                    return { ok: false, reason: 'body' };
                  }
                },
                (): PatchBody => ({ ok: false, reason: 'fetch' }),
              );
            }
            return pending;
          };
          window.fetch = wrapper;
          return state;
        }, { apiUrl: API_URL });

        // 等待已观察的首个主帧 PATCH 的 response.request()，不是任意 PATCH。
        const [response] = await Promise.all([
          page.waitForResponse((candidate) => candidate.request() === saveRequests[0]).catch(() => {
            throw new Error(`保存未收到首个 PATCH 的响应（匹配请求数 ${saveRequests.length}）`);
          }),
          page.getByTestId('analytics-settings-save').click(),
        ]);
        expect(response.status(), '保存 PATCH 状态码').toBe(200);
        expect(response.request(), 'Playwright 响应与首个请求事件是同一笔').toBe(saveRequests[0]);
        expect(response.request().postDataJSON(), 'PATCH 请求体').toEqual({ timezone: target, expectedVersion: initial.version });
        const patchBody = await patchHandle.evaluate(async (state) => await state.first);
        if (patchBody === null) throw new Error('PATCH 正文捕获缺失');
        if (!patchBody.ok) throw new Error(`PATCH 正文捕获失败（${patchBody.reason}）`);
        const next = AnalyticsSettingsUpdateDTOSchema.parse(patchBody.json);
        expect(next.timezone, 'PATCH 响应时区').toBe(target);
        expect(next.version, 'version 契约 +1').toBe(initial.version + 1);
        expect(next.timezoneRevision, 'revision 契约 +1').toBe(initial.timezoneRevision + 1);
        expect(next.rebuildScheduled, '改区应登记重算').toBe(true);
        expect(next.recomputableFrom, '改区后应有可重算起点').not.toBeNull();

        const patchId = randomUUID();
        const countAtResponse = saveRequests.length;
        const capturedAtResponse = await patchHandle.evaluate((state) => state.count);
        const pageRequestBodies = await patchHandle.evaluate((state) => state.requestBodies.slice());
        expect(countAtResponse, '响应到达时应只有一笔 PATCH').toBe(1);
        expect(capturedAtResponse, '页内旁路应捕获一笔 PATCH').toBe(1);
        expect(pageRequestBodies.length, '页内请求体应恰好一笔').toBe(1);
        const pageRequest = JSON.parse(pageRequestBodies[0]) as unknown;
        expect(pageRequest, '页内收集的请求体与 Playwright 请求体同笔').toEqual({ timezone: target, expectedVersion: initial.version });

        const collected: Array<{
          viewport: string;
          observed: ViewportFact;
          layout: LayoutFact;
          ui: UiFacts;
          screenshot: ScreenshotFact;
        }> = [];
        for (const vp of VIEWPORTS) {
          const viewport = label(vp);
          await page.setViewportSize(vp);
          // 每张图前都核：保存反馈与右栏仍对应当前这笔 PATCH 响应。
          await assertSavedBinding(page, next);
          const observed = await viewportFact(page, vp);
          expect(observed.innerWidth, `${viewport} 观测宽度`).toBe(vp.width);
          expect(observed.innerHeight, `${viewport} 观测高度`).toBe(vp.height);
          const layout = await readLayout(page, 'saved', vp);
          expectLayout(layout, 'saved', vp);
          const ui = await readUi(page);
          expect(ui.inputValue).toBe(target);
          const screenshot = await captureScreenshot('saved', vp, page);
          collected.push({ viewport, observed, layout, ui, screenshot });
        }
        expect(collected.length, '保存态应采集三视口').toBe(3);

        // 监听与页内旁路保留到最后一张截图之后，再判恰一笔。
        const capturedAtEnd = await patchHandle.evaluate((state) => state.stop());
        patchStopped = true;
        const countAtEnd = saveRequests.length;
        expect(capturedAtEnd, '页内 PATCH 正文旁路到最后仍应恰好一次').toBe(1);
        expect(countAtEnd, '保存到最后一张截图仍应恰好一笔同源主帧 PATCH').toBe(1);
        expect(saveRequests[0], '唯一 PATCH 仍是响应对应的那一笔').toBe(response.request());

        const patchFacts: PatchFacts = {
          id: patchId,
          request: response.request().postDataJSON(),
          pageRequest,
          status: response.status(),
          body: next,
          count: countAtEnd,
          captured: capturedAtEnd,
          countAtResponse,
          capturedAtResponse,
          countAtEnd,
          capturedAtEnd,
          screenshotsAfterPatch: collected.length,
        };
        for (const item of collected) {
          pushState({
            state: 'saved',
            viewport: item.viewport,
            observed: item.observed,
            layout: item.layout,
            get,
            body: next,
            ui: item.ui,
            postReleaseUi: null,
            loadingFacts: null,
            failure: null,
            recovery: null,
            patch: patchFacts,
            route: null,
            screenshot: item.screenshot,
            notes: ['三视口复用同一笔 PATCH 响应；仅改视口不重载；计数持续到最后一张截图'],
          });
        }
      } finally {
        page.off('request', onRequest);
        if (patchHandle) {
          if (!patchStopped) {
            await patchHandle.evaluate((state) => { state.stop(); }).catch(() => undefined);
          }
          await patchHandle.dispose().catch(() => undefined);
        }
        await stopGetCapture(page).catch(() => undefined);
        await stopGet().catch(() => undefined);
      }
    });
  });
}
