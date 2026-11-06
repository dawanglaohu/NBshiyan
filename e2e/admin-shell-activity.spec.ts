import { writeFileSync } from 'node:fs';
import { performance as nodePerf } from 'node:perf_hooks';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import { useSharedAdmin } from './shared-admin';

/**
 * M3-T7 统一后台外壳：真实登录 → 角色菜单 → GET account → 真实活动 → signOut。
 *
 * 登录：照 e2e/shared-admin.ts 的模式，用 scripts/create-admin.mjs 建**独立**管理员
 * （唯一 email、ADMIN_SEED_TOTP_SECRET=E2E_TOTP），每组 beforeAll 只登录一次、
 * beforeEach 把 cookie 放进每个用例自己的 page context。
 * 不复用全局 E2E_ADMIN：它会把共享管理员绑掉，让同文件后续用例与 admin.spec.ts 静默 skip。
 *
 * 为什么 signOut 单独一组会话：signOut 会撤销该设备会话，若与其它用例共用 beforeAll 的
 * 旧 cookie，后续 beforeEach 注入的旧 cookie 已失效，会 401 落到登录页。这里给 signOut
 * 单独建管理员/会话，不依赖用例执行顺序（即使将来 workers/fullyParallel 变化也不互相污染）。
 *
 * 视觉证据：`test.use({ video: 'on' })` 写在**文件顶层一次**（Playwright 不允许放在 describe 内，
 * 会强制新 worker、收集阶段直接报错）；CI 从 test-results 视频转 GIF；三尺寸下量真实壳元素。
 * `.adm-top` 桌面断点 display:none，只在窄屏（<768）断言；桌面量始终可见的 .adm-side/.adm-main。
 *
 * 证据分级：
 * - 本文件在真实 standalone 服务 + 浏览器里跑，量的是 DOM/请求，不是纯函数。
 * - 服务端 T15 的续期写回与撤销并发由 tests/admin-session-activity.http.test.ts 与
 *   e2e/admin-device-session.spec.ts 覆盖，本卡不重跑、不冒充。
 * - 15 分钟节流 / 隐藏页不发 / 失焦取消由 tests/admin-shell-activity.test.ts 的纯逻辑用例覆盖；
 *   这里只验「真实操作确实发出 POST」与「首帧不报」。
 */
const PASSWORD = 'e2e-shell-Passw0rd!';
const ACCOUNT = '/api/admin/account';

type ContentRole = 'state-text' | 'state-block' | 'data-name' | 'data-role' | 'signout-control' | 'signout-text' | 'other-text' | 'other-box';
/** 面板同坐标系（相对 panel 左上角）的可见内容盒；role/group 保留安全语义，不存文字内容。 */
type ContentRect = { role: ContentRole; group: string; top: number; left: number; right: number; bottom: number; h: number };

/** 侧栏 `.adm-account` 面板几何帧（只读采集，不含 cookie/token/账号邮箱/正文文本）。 */
type AccountFrame = {
  state: string;
  viewport: string;
  atMs: number; // 页面 performance.now() 单调时钟下的采集时刻（仅事件排序）
  clock: 'performance.now';
  docId: string;  // 当前 document 初始化时分配一次的稳定身份（observer/帧/校准共用；resize 不换）
  seq: number;    // 该 document 内的帧采样序号
  panel: {
    w: number; h: number;
    borderTop: string; borderRight: string; borderBottom: string; borderLeft: string;
    padTop: string; padRight: string; padBottom: string; padLeft: string;
    rowGap: string; columnGap: string; minHeight: string;
    display: string; flexDirection: string; visibility: string;
    cssReady: boolean;
  };
  content: ContentRect[];
  textLen: number;
};

/** 11 节 / density_probe.js 既有阈值，不自造更宽阈值。 */
const ACCOUNT_DENSITY = { padMax: 20, gapMax: 24, nearMax: 24, sparsePad: 32, sparseHeight: 80, sparseText: 120 };
const EPS = 1.5; // 仅浮点容差，不放宽任何验收阈值

/** 严格 CSS px 读数：只接受完整 `Npx` / `N.px`，非法/缺失/负值返回 null，绝不 `||0` 静默当通过。 */
function px(v: string | undefined): number | null {
  if (typeof v !== 'string' || !/^\d+(?:\.\d+)?px$/.test(v.trim())) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/** rect 数值必须有限且自洽，否则该帧不参与 D5 通过判定。 */
function finiteRect(r: ContentRect): boolean {
  return [r.top, r.left, r.right, r.bottom, r.h].every((n) => Number.isFinite(n)) && r.h > 0 && r.right > r.left && r.bottom > r.top;
}

/** 单一真值：按 state×viewport 检查有效帧覆盖；两例的 report.pass 与最终断言都只认它的结果。 */
function frameCoverage(frames: AccountFrame[], states: readonly string[], viewports: readonly string[]) {
  const cells = states.flatMap((s) => viewports.map((v) => ({ state: s, viewport: v })));
  const detail = cells.map((cell) => {
    const matched = frames.filter((f) => f.state === cell.state && f.viewport === cell.viewport && f.panel.cssReady);
    const judged = matched.map((f) => judgeAccountFrame(f));
    return { ...cell, count: matched.length, ok: matched.length > 0 && judged.every((j) => j.d4.pass && j.d5.pass) };
  });
  return { complete: detail.every((d) => d.ok), detail };
}

/**
 * 独立判定：D4 是 CSS 值（四边 padding / row+column gap），D5 是几何布局结果。
 * 关键：loading/cleared 的**状态文字**与所属状态块单独判定局部左上 / 内部留白，
 * 不让兄弟 `.adm-signout` 按钮或背景块的 minLeft/minTop 抵消偏移；按钮内部正常居中文字
 * 不按状态文字规则误判。两类判定互不充当。
 */
function judgeAccountFrame(f: AccountFrame) {
  const p = f.panel;
  const pads = [px(p.padTop), px(p.padRight), px(p.padBottom), px(p.padLeft)];
  const borders = [px(p.borderTop), px(p.borderRight), px(p.borderBottom), px(p.borderLeft)];
  const rowGap = px(p.rowGap), colGap = px(p.columnGap), minHeightPx = px(p.minHeight);
  const w = p.w, h = p.h;
  const all = f.content || [];
  const rectsValid = all.every(finiteRect);
  const c = all.filter((r) => finiteRect(r));
  const contentTop = c.length ? Math.min(...c.map((r) => r.top)) : null;
  const contentLeft = c.length ? Math.min(...c.map((r) => r.left)) : null;
  const contentRight = c.length ? Math.max(...c.map((r) => r.right)) : null;
  const contentBottom = c.length ? Math.max(...c.map((r) => r.bottom)) : null;
  const sorted = c.slice().sort((a, b) => a.top - b.top);
  let worstChildGap = 0;
  for (let i = 1; i < sorted.length; i++) worstChildGap = Math.max(worstChildGap, sorted[i].top - sorted[i - 1].bottom);
  const innerLeft = (borders[3] ?? 0) + (pads[3] ?? 0);
  const innerTop = (borders[0] ?? 0) + (pads[0] ?? 0);
  const innerRight = w - (borders[1] ?? 0) - (pads[1] ?? 0);
  const innerBottom = h - (borders[2] ?? 0) - (pads[2] ?? 0);
  const topGap = contentTop !== null ? contentTop - innerTop : null;
  const leftGap = contentLeft !== null ? contentLeft - innerLeft : null;
  const bottomWhitespace = contentBottom !== null ? innerBottom - contentBottom : null;
  const stretchedInner = c.some((r) => r.h >= ACCOUNT_DENSITY.sparseHeight && r.h > 80);

  // 状态文字独立：只看 role='state-text'（及其所属 state-block），不看 signout 兄弟控件。
  // loading / cleared 必须有真实 state-text（其余 state 如 data 才允许不适用），否则仅剩按钮也能通过。
  const stateTextRequired = f.state === 'loading' || f.state === 'cleared';
  const stateTexts = c.filter((r) => r.role === 'state-text');
  const stateBlocks = c.filter((r) => r.role === 'state-block');
  const hasStateText = stateTexts.length > 0;
  const stateTextLeftGap = hasStateText ? Math.min(...stateTexts.map((r) => r.left)) - innerLeft : null;
  const stateTextTopGap = hasStateText ? Math.min(...stateTexts.map((r) => r.top)) - innerTop : null;
  // 只把 state-text 与**同 group** 的 state-block 配对，不做所有 blocks×所有 texts 交叉比较；
  // 块自身也不得撑高居中。
  const stateBlockStretched = stateBlocks.some((b) => b.h >= ACCOUNT_DENSITY.sparseHeight);
  const stateTextInsideBlock = !hasStateText || stateTexts.every((t) => {
    const own = stateBlocks.filter((b) => b.group === t.group);
    return own.length === 0 || own.every((b) => t.left - b.left <= ACCOUNT_DENSITY.nearMax + EPS && t.top - b.top <= ACCOUNT_DENSITY.nearMax + EPS);
  });

  const numbersValid = rectsValid && [...pads, ...borders, rowGap, colGap, minHeightPx].every((n) => n !== null);
  const d4 = {
    numbersValid,
    paddingLe20: numbersValid && Math.max(...(pads as number[])) <= ACCOUNT_DENSITY.padMax,
    rowGapLe24: numbersValid && (rowGap as number) <= ACCOUNT_DENSITY.gapMax,
    colGapLe24: numbersValid && (colGap as number) <= ACCOUNT_DENSITY.gapMax,
  };
  const d5 = {
    numbersValid,
    hasContent: c.length > 0,
    // loading/cleared 缺真实状态文字（只剩退出按钮/背景块）必须失败，不能一律 n/a。
    requiredStateTextPresent: !stateTextRequired || hasStateText,
    insideLeft: leftGap !== null && leftGap >= -EPS,
    insideTop: topGap !== null && topGap >= -EPS,
    insideRight: contentRight !== null && contentRight <= innerRight + EPS,
    insideBottom: bottomWhitespace !== null && bottomWhitespace >= -EPS,
    contentTopNear: topGap !== null && topGap >= -EPS && topGap <= ACCOUNT_DENSITY.nearMax,
    contentLeftNear: leftGap !== null && leftGap >= -EPS && leftGap <= ACCOUNT_DENSITY.nearMax,
    // 状态文字独立局部左上：42px 偏移、按钮 left=18 掩盖时必失败；无状态文字（data 态）则不适用
    stateTextLeftNear: !hasStateText || (stateTextLeftGap !== null && stateTextLeftGap >= -EPS && stateTextLeftGap <= ACCOUNT_DENSITY.nearMax),
    stateTextTopNear: !hasStateText || (stateTextTopGap !== null && stateTextTopGap >= -EPS && stateTextTopGap <= ACCOUNT_DENSITY.nearMax),
    stateTextNotMasked: !hasStateText || (stateTextLeftGap !== null && stateTextLeftGap <= ACCOUNT_DENSITY.nearMax),
    stateTextInsideBlock,
    noStateBlockStretch: !stateBlockStretched,
    minHeightNoStretch: minHeightPx !== null && (minHeightPx <= EPS || (contentBottom !== null && minHeightPx <= contentBottom + EPS)),
    noStretchedInner: !stretchedInner,
    bottomWhitespaceSmall: bottomWhitespace !== null && bottomWhitespace >= -EPS && bottomWhitespace <= ACCOUNT_DENSITY.nearMax,
    childGapSmall: worstChildGap <= ACCOUNT_DENSITY.gapMax + EPS,
    notSparseBlock: numbersValid && !(
      Math.max(...(pads as number[])) >= ACCOUNT_DENSITY.sparsePad &&
      h >= ACCOUNT_DENSITY.sparseHeight && f.textLen < ACCOUNT_DENSITY.sparseText && c.length <= 4
    ),
  };
  return {
    d4: { ...d4, pass: Object.values(d4).every(Boolean) },
    d5: { ...d5, pass: Object.values(d5).every(Boolean) },
    metrics: {
      pads, borders, rowGap, colGap, minHeightPx, w, h, rectsValid,
      contentTop, contentLeft, contentRight, contentBottom, innerLeft, innerTop, innerRight, innerBottom,
      topGap, leftGap, bottomWhitespace, worstChildGap, stretchedInner, contentBoxes: c.length, textLen: f.textLen,
      stateTextLeftGap, stateTextTopGap, stateTextCount: stateTexts.length, stateBlockStretched,
    },
  };
}

/**
 * 注入浏览器：只读 observer。CSS 就绪判据取真实壳样式特征，不按验收阈值筛帧。
 * 单 pending rAF（有界）、stopped guard、保存的 MutationObserver + 全部具名监听在 stop 时移除，
 * stop 幂等、停止后不再采帧/排帧。状态文字/状态块/退出控件按 role+group 分别标注，不存正文。
 */
function installAccountObserver(): void {
  const frames: AccountFrame[] = [];
  // 当前 document 初始化时只分配一次稳定 ID：observer 每帧沿用，read/clockBridge 沿用，resize 不换。
  const docId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const host = window as unknown as { __admAccountFrames: AccountFrame[]; __admDocId: string; __admObserverStop?: () => void };
  host.__admAccountFrames = frames;
  host.__admDocId = docId;
  let stopped = false;
  let pendingRaf: number | null = null;
  let budget = 900;
  let observer: MutationObserver | null = null;
  const listeners: Array<[EventTarget, string, EventListener]> = [];
  const on = (t: EventTarget, type: string, fn: EventListener) => { t.addEventListener(type, fn); listeners.push([t, type, fn]); };
  const schedule = () => {
    if (stopped || pendingRaf !== null) return;
    if (budget <= 0) { stop(); return; } // 预算耗尽走同一幂等停止，不留 MO/监听继续扫描
    budget--;
    pendingRaf = requestAnimationFrame(() => { pendingRaf = null; if (!stopped) scan(); });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pendingRaf !== null) { cancelAnimationFrame(pendingRaf); pendingRaf = null; }
    if (observer) { observer.disconnect(); observer = null; }
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
    listeners.length = 0;
  };
  host.__admObserverStop = stop;

  const cssReady = (ps: CSSStyleDeclaration): boolean => {
    const root = window.getComputedStyle(document.documentElement);
    const bw = parseFloat(ps.borderTopWidth), pad = parseFloat(ps.paddingTop);
    return ps.display === 'flex' && Number.isFinite(bw) && bw > 0 && Number.isFinite(pad) &&
      root.getPropertyValue('--pj-accent').trim() === '#b45700' && /^\d/.test(root.getPropertyValue('--pj-border-width').trim());
  };
  const rel = (r: DOMRect, pr: DOMRect) => ({ top: r.top - pr.top, left: r.left - pr.left, right: r.right - pr.left, bottom: r.bottom - pr.top, h: r.height });
  const snap = (state: string): boolean => {
    if (stopped) return false;
    const panel = document.querySelector('.adm-account') as HTMLElement | null;
    if (!panel) return false;
    const pr = panel.getBoundingClientRect();
    const ps = getComputedStyle(panel);
    if (ps.display === 'none' || ps.visibility === 'hidden' || pr.width < 1 || pr.height < 1 || !cssReady(ps)) return false;
    const content: ContentRect[] = [];
    const stateNode = panel.querySelector('.adm-account-loading, .adm-account-cleared') as HTMLElement | null;
    const stateGroup = stateNode ? stateNode.className : '';
    const nameNode = panel.querySelector('.adm-account-name') as HTMLElement | null;
    const roleNode = panel.querySelector('.adm-account-role') as HTMLElement | null;
    const signout = panel.querySelector('.adm-signout') as HTMLElement | null;
    const walk = (node: Node, group: string, roleOfText: ContentRole, isStateBlock: boolean, isSignout: boolean): void => {
      if (node.nodeType === 3 && (node.nodeValue || '').trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) {
          content.push({ role: isSignout ? 'signout-text' : roleOfText, group, ...rel(r as DOMRect, pr) });
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as HTMLElement;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const replaceable = /^(IMG|SVG|CANVAS|VIDEO|INPUT|SELECT|TEXTAREA|BUTTON|PROGRESS|METER|IFRAME)$/.test(el.tagName);
      const surfaced = parseFloat(cs.borderTopWidth) > 0 || (cs.backgroundColor !== 'transparent' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)');
      if (isStateBlock) content.push({ role: 'state-block', group, ...rel(r as DOMRect, pr) });
      else if (isSignout && replaceable) content.push({ role: 'signout-control', group, ...rel(r as DOMRect, pr) });
      else if (replaceable || surfaced) content.push({ role: 'other-box', group, ...rel(r as DOMRect, pr) });
      const childIsState = isStateBlock || el === stateNode;
      const childIsSignout = isSignout || el === signout;
      for (const child of Array.from(el.childNodes)) {
        const childRole: ContentRole = childIsState ? 'state-text' : el === nameNode ? 'data-name' : el === roleNode ? 'data-role' : childIsSignout ? 'signout-text' : 'other-text';
        walk(child, childIsState ? group : (isSignout ? 'signout' : ''), childRole, childIsState, childIsSignout);
      }
    };
    for (const child of Array.from(panel.childNodes)) {
      const isState = child === stateNode;
      const isSignout = child === signout;
      walk(child, isState ? stateGroup : (isSignout ? 'signout' : ''), 'other-text', isState, isSignout);
    }
    frames.push({
      state, viewport: `${window.innerWidth}x${window.innerHeight}`, atMs: performance.now(), clock: 'performance.now', docId, seq: frames.length,
      panel: {
        w: Math.round(pr.width), h: Math.round(pr.height),
        borderTop: ps.borderTopWidth, borderRight: ps.borderRightWidth, borderBottom: ps.borderBottomWidth, borderLeft: ps.borderLeftWidth,
        padTop: ps.paddingTop, padRight: ps.paddingRight, padBottom: ps.paddingBottom, padLeft: ps.paddingLeft,
        rowGap: ps.rowGap, columnGap: ps.columnGap, minHeight: ps.minHeight,
        display: ps.display, flexDirection: ps.flexDirection, visibility: ps.visibility, cssReady: true,
      },
      content, textLen: (panel.textContent || '').trim().length,
    });
    return true;
  };
  const seen: Record<string, boolean> = {};
  const key = (s: string) => `${s}@${window.innerWidth}x${window.innerHeight}`;
  function scan() {
    if (stopped) return;
    const states: Array<[string, boolean]> = [
      ['loading', !!document.querySelector('.adm-account-loading')],
      ['data', !!document.querySelector('.adm-account-name')],
      ['cleared', !!document.querySelector('.adm-account-cleared')],
    ];
    let pending = false;
    for (const [s, present] of states) {
      if (present && !seen[key(s)] && snap(s)) seen[key(s)] = true;
      if (present && !seen[key(s)]) pending = true;
    }
    if (pending) schedule();
  }
  observer = new MutationObserver(scan);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  on(document, 'DOMContentLoaded', scan);
  if (document.readyState !== 'loading') schedule();
  on(window, 'resize', () => { if (!stopped) schedule(); });
  on(window, 'pagehide', stop);
}

/** 读取当前 document 的帧：docId 由 observer 初始化时分配并随帧返回，这里不重赋；同 doc 反复读返回同一批。 */
async function readAccountFrames(page: import('@playwright/test').Page): Promise<AccountFrame[]> {
  return (await page.evaluate(() => {
    const w = window as unknown as { __admAccountFrames?: unknown };
    return w.__admAccountFrames ?? [];
  })) as AccountFrame[];
}

/** 帧累积去重：按 docId + state + viewport + seq，保留第一档不丢；同 document 重复 read 不新增。 */
function collectFrames(out: AccountFrame[], batch: AccountFrame[]): void {
  const seen = new Set(out.map((f) => `${f.docId}|${f.state}|${f.viewport}|${f.seq}`));
  for (const f of batch) {
    const k = `${f.docId}|${f.state}|${f.viewport}|${f.seq}`;
    if (!seen.has(k)) { out.push(f); seen.add(k); }
  }
}

/** 只保留受控错误类别：任意 e.name / e.code 字符串不进入 JSON，未知映射为 unknown。 */
function safeError(e: unknown): { name: string; code: string } | null {
  if (!(e instanceof Error)) return e === undefined || e === null ? null : { name: 'unknown', code: 'unknown' };
  const NAMES = new Set(['Error', 'TimeoutError', 'AssertionError', 'TypeError', 'RangeError']);
  const CODES = new Set(['ENOENT', 'ECONNRESET', 'ETIMEDOUT', 'EPERM', 'EACCES']);
  const name = NAMES.has(e.name) ? e.name : 'unknown';
  const raw = 'code' in e ? (e as { code?: unknown }).code : null;
  const code = typeof raw === 'string' && CODES.has(raw) ? raw : 'unknown';
  return { name, code };
}

type ClockBridge = { valid: boolean; docId: string | null; r1: number; r2: number; pageAt: number; low: number; high: number; reason?: string };

/** 单个 document 一次时钟校准：runner r1=at() → page.evaluate 取 {docId,pageAt} → runner r2=at()。
 *  evaluate 抛错 / docId 缺失 / 时间非有限 / r2<r1 一律 valid=false（页面真正的 p=0 是合法值，不把 0 当失败）。
 *  帧 pageAt 映射为区间 [pageAt+r1-p, pageAt+r2-p]。 */
async function clockBridge(page: import('@playwright/test').Page, at: () => number): Promise<ClockBridge> {
  const r1 = at();
  let sampled: { docId?: unknown; pageAt?: unknown };
  try {
    sampled = await page.evaluate(() => ({
      docId: (window as unknown as { __admDocId?: unknown }).__admDocId,
      pageAt: performance.now(),
    }));
  } catch {
    return { valid: false, docId: null, r1, r2: at(), pageAt: 0, low: 0, high: 0, reason: 'evaluate-failed' };
  }
  const r2 = at();
  const docId = typeof sampled?.docId === 'string' && sampled.docId ? sampled.docId : null;
  const p = Number(sampled?.pageAt);
  if (!docId) return { valid: false, docId: null, r1, r2, pageAt: 0, low: 0, high: 0, reason: 'missing-docId' };
  if (!Number.isFinite(p) || !Number.isFinite(r1) || !Number.isFinite(r2) || r2 < r1) {
    return { valid: false, docId, r1, r2, pageAt: 0, low: 0, high: 0, reason: 'invalid-clock-values' };
  }
  return { valid: true, docId, r1, r2, pageAt: p, low: r1 - p, high: r2 - p };
}

/** 帧时间判据：每帧必须绑定自身 docId 的有效 bridge；区间有限有序、不早于本 doc 导航、不晚于读取观察上界，
 *  且该 doc 有真实成对浏览器 GET 401。重叠只标不确定，不编造精确先后。 */
function frameTimeVerdict(
  frames: AccountFrame[], bridge: ClockBridge | null,
  navObservedAt: number, readObservedAt: number,
  response401: Array<{ atMs: number; requestId: number }>,
) {
  const byDoc = new Map<string, ClockBridge>();
  if (bridge && bridge.valid && bridge.docId) byDoc.set(bridge.docId, bridge);
  const perFrame = frames.filter((f) => f.state === 'cleared').map((f) => {
    const b = byDoc.get(f.docId);
    if (!b) return { docId: f.docId, seq: f.seq, ok: false, reason: 'no-valid-bridge-for-doc' };
    if (!Number.isFinite(f.atMs)) return { docId: f.docId, seq: f.seq, ok: false, reason: 'nonfinite-pageAt' };
    const lo = f.atMs + b.low, hi = f.atMs + b.high;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return { docId: f.docId, seq: f.seq, ok: false, reason: 'invalid-range' };
    // 明显早于本 document 导航观察、或远晚于该帧读取观察上界，判矛盾（保留合理重叠为不确定）。
    if (hi < navObservedAt) return { docId: f.docId, seq: f.seq, ok: false, reason: 'before-navigation' };
    if (lo > readObservedAt + 1) return { docId: f.docId, seq: f.seq, ok: false, reason: 'after-read-observation' };
    return { docId: f.docId, seq: f.seq, ok: true, runnerRange: [lo, hi], note: 'overlap-uncertain' };
  });
  // 成对 401 必须存在，且时间可核（有限、在导航与读取观察之间）。
  const paired401 = response401.filter((e) => Number.isFinite(e.atMs) && e.atMs >= navObservedAt - 1 && e.atMs <= readObservedAt + 1);
  const linked = perFrame.length > 0 && perFrame.every((r) => r.ok) && paired401.length > 0 && bridge !== null && bridge.valid;
  return { linked, perFrame, paired401, navObservedAt, readObservedAt, bridgeValid: !!bridge?.valid };
}

/** 报告保存与断言共用的单一真值：coverage + 几何 + D1（两例按各自 states 调用）。 */
function densityVerdict(all: AccountFrame[], states: readonly string[], viewports: readonly string[], d1?: { present: boolean; equal: Array<{ equal: boolean }> }) {
  const coverage = frameCoverage(all, states, viewports);
  const judged = all.filter((f) => f.panel.cssReady).map((f) => ({
    viewport: f.viewport, state: f.state, atMs: f.atMs, clock: f.clock, docId: f.docId ?? null, seq: f.seq ?? null,
    panel: f.panel, content: f.content, metrics: judgeAccountFrame(f).metrics, d4: judgeAccountFrame(f).d4, d5: judgeAccountFrame(f).d5,
  }));
  const geometry = judged.every((j) => j.d4.pass && j.d5.pass);
  const d1Ok = d1 ? d1.present && d1.equal.every((e) => e.equal) : true;
  return { coverage, judged, geometry, d1Ok, pass: coverage.complete && geometry && d1Ok };
}

// Playwright 只允许 video 在文件顶层或 config：写在 describe 内会强制新 worker，
// 收集阶段直接报 "Cannot use({ video }) in a describe group"。整文件一次，两组共用。
// CI 从 test-results 视频转 GIF；本文件不用本机浏览器录。
test.use({ video: 'on' });

test('后台壳：未登录不能读 account，页面跳登录', async ({ request }) => {
  expect((await request.get(ACCOUNT)).status()).toBe(401);
  const r = await request.get('/admin/inquiries', { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(r.status());
});

test.describe('后台壳主体（独立管理员，整组一次登录）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell', name: 'E2E shell', password: PASSWORD, probe: ACCOUNT });

  test('角色菜单来自服务端、账号区读 GET account、退出控件可达', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${BASE}/admin/inquiries`);
    const accountResponse = await page.request.get(ACCOUNT);
    expect(accountResponse.status()).toBe(200);
    const account = await accountResponse.json();
    expect(['ADMIN', 'SALES', 'EDITOR']).toContain(account.role);

    const shellNav = page.getByRole('navigation', { name: '后台导航' });
    await expect(shellNav).toBeVisible();
    await expect(page.getByTestId('admin-account')).toBeVisible();
    await expect(page.getByTestId('admin-signout')).toBeVisible();
    await expect(page.getByTestId('admin-account-role')).toHaveText(account.role);

    // 角色菜单：站点设置仅 ADMIN 可见（本组是独立 ADMIN）。
    const settings = shellNav.getByRole('link', { name: '站点设置' });
    if (account.role === 'ADMIN') await expect(settings).toBeVisible();
    else await expect(settings).toHaveCount(0);

    // 键盘焦点可达：退出控件有可见焦点环。
    await page.getByTestId('admin-signout').focus();
    const outline = await page.getByTestId('admin-signout').evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(outline.style).not.toBe('none');
    expect(parseFloat(outline.width)).toBeGreaterThan(0);

    const box = await page.getByTestId('admin-signout').boundingBox();
    if (!box) throw new Error('signout 没有布局盒');
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('首帧不报 activity，真实指针/键盘/路由操作才 POST，15 分钟内不重复', async ({ page }) => {
    test.setTimeout(120_000);
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/admin/account/session/activity') posts.push(r.url());
    });
    await page.goto(`${BASE}/admin/inquiries`);
    // 首帧：只有 GET account，不应有 activity。
    await expect(page.getByTestId('admin-account')).toBeVisible();
    expect(posts).toHaveLength(0);

    // 真实键盘操作 → 上报一次。
    await page.keyboard.press('Tab');
    await expect.poll(() => posts.length).toBe(1);
    // 15 分钟内连续真实操作不再上报。
    await page.keyboard.press('Tab');
    await page.mouse.click(10, 10);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1);

    // 路由变化是真实操作，但节流未过时仍不新增。
    await page.goto(`${BASE}/admin/specs`);
    await page.waitForTimeout(300);
    expect(posts.length).toBeLessThanOrEqual(1);
  });

  test('三尺寸壳元素 computed style：2px 黑边 / 0 圆角 / 无阴影 / 强调色 #b45700 / 44px / 无横向溢出', async ({ page }) => {
    test.setTimeout(150_000);
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }, { width: 390, height: 844, label: '390x844' }]) {
      await page.setViewportSize(view);
      await page.goto(`${BASE}/admin/inquiries`);
      if (view.width < 768) {
        const menu = page.locator('.adm-menu');
        if (await menu.isVisible()) await menu.click();
      }
      await expect(page.getByTestId('admin-signout')).toBeVisible();

      // 真实壳元素：侧栏、主内容外框始终可见；顶栏桌面 display:none，只在窄屏量。
      const measured = await page.evaluate(() => {
        const pick = (selector: string) => document.querySelector(selector);
        const box = (selector: string) => {
          const el = pick(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return { w: Math.round(r.width), h: Math.round(r.height), border: s.borderTopWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow, display: s.display };
        };
        const current = pick('.adm-side a[aria-current=page]');
        const signoutEl = pick('[data-testid="admin-signout"]');
        const hover = signoutEl ? getComputedStyle(signoutEl) : null;
        const rootAccent = getComputedStyle(document.documentElement).getPropertyValue('--pj-accent').trim();
        return {
          top: box('.adm-top'),
          side: box('.adm-side'),
          main: box('.adm-main'),
          currentBg: current ? getComputedStyle(current).backgroundColor : null,
          currentColor: current ? getComputedStyle(current).color : null,
          currentAccentBorder: current ? getComputedStyle(current).borderLeftColor : null,
          signout: box('[data-testid="admin-signout"]'),
          signoutMinHeight: hover?.minHeight ?? null,
          rootAccent,
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        };
      });

      // 始终可见的壳容器：2px 边框、0 圆角、无阴影。
      for (const [name, el] of Object.entries({ side: measured.side, main: measured.main })) {
        expect(el, `${view.label} ${name} 必须有布局盒`).not.toBeNull();
        expect(el!.border, `${view.label} ${name} 边框宽度`).toBe('2px');
        expect(el!.radius, `${view.label} ${name} 圆角`).toBe('0px');
        expect(el!.shadow, `${view.label} ${name} 阴影`).toBe('none');
      }
      // 顶栏：桌面 display:none 不是可见外框，只在窄屏（<768）断言其 2px/0/none。
      if (view.width < 768) {
        expect(measured.top!.display, '390 顶栏必须可见').not.toBe('none');
        expect(measured.top!.border, '390 顶栏边框').toBe('2px');
        expect(measured.top!.radius, '390 顶栏圆角').toBe('0px');
        expect(measured.top!.shadow, '390 顶栏阴影').toBe('none');
      } else {
        expect(measured.top!.display, `${view.label} 顶栏桌面隐藏`).toBe('none');
      }
      // 当前导航项：黑白反转，不靠颜色单独传义；左边框用强调色标记当前入口。
      expect(measured.currentBg, `${view.label} 当前导航底色`).toBe('rgb(255, 255, 255)');
      expect(measured.currentColor, `${view.label} 当前导航文字色`).toBe('rgb(0, 0, 0)');
      expect(measured.currentAccentBorder, `${view.label} 当前导航强调色标记`).toBe('rgb(180, 87, 0)');
      // 强调色 #b45700：从 :root 的 --pj-accent 直接读实际值，并核壳样式确实消费该 token。
      expect(measured.rootAccent, `${view.label} 强调色 token`).toBe('#b45700');
      const usesAccent = await page.evaluate(() => {
        const css = [...document.styleSheets].flatMap((sheet) => {
          try { return [...sheet.cssRules]; } catch { return []; }
        });
        return css.some((rule) => rule.cssText?.includes('var(--pj-accent)'));
      });
      expect(usesAccent, `${view.label} 壳样式必须消费 --pj-accent`).toBe(true);
      // 触屏目标 ≥44px（桌面与窄屏都量）；退出控件同为 2px/0/无阴影。
      expect(parseFloat(measured.signoutMinHeight ?? '0'), `${view.label} 退出控件触屏目标`).toBeGreaterThanOrEqual(44);
      expect(measured.signout!.border, `${view.label} 退出控件边框`).toBe('2px');
      expect(measured.signout!.radius, `${view.label} 退出控件圆角`).toBe('0px');
      expect(measured.signout!.shadow, `${view.label} 退出控件阴影`).toBe('none');
      expect(measured.noHorizontalOverflow, `${view.label} 横向溢出`).toBe(true);
    }
  });

  /**
   * 补证：侧栏 `.adm-account` 面板（被 density_probe.js 的 rail 排除，14 次既有 main 探针量不到）
   * 的真实 data / loading 态 D4 / D5 几何，以及同元素跨断点 D1 间距。
   * 状态文字 role 独立判定，不被兄弟退出控件掩盖；单一真值 densityVerdict 同时供 report.pass 与断言使用；
   * 全部准备/导航/观测纳入 try，finally 先尽力保存脱敏报告，再执行失败断言（异常不被吞）。
   */
  test('壳内账号区 data/loading 态的 D4/D5 与跨断点 D1 间距（补证）', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const VIEWPORTS = ['1920x1080', '1440x900'] as const;
    const STATES = ['data', 'loading'] as const;
    const runnerStart = nodePerf.now();
    const at = () => nodePerf.now() - runnerStart; // runner 单调时钟（node:perf_hooks）
    const all: AccountFrame[] = [];
    const clockBridges: Array<Record<string, unknown>> = [];
    const cleanupErrors: Array<{ stage: string; code: string }> = [];
    let stage = 'init';
    let err = safeError(null);
    const reportPath = testInfo.outputPath('admin-account-density.json');
    // 临时诊断（先于任何清理/可能挂起的 dispose 落盘）：含已有脱敏原帧、实际 coverage、校准、error；
    // 标 cleanup-pending、pass=false。即使后续 dispose 挂住，磁盘已有当时真实几何与缺口。
    const saveDiag = (extra: Record<string, unknown>) => {
      const diagVerdict = densityVerdict(all, STATES, VIEWPORTS);
      writeFileSync(reportPath, JSON.stringify({
        suite: 'M3-T7 admin-account density supplement (#529)', stage, error: err, cleanupErrors,
        cleanupPending: true, pass: false,
        frames: diagVerdict.judged, coverage: diagVerdict.coverage, clockBridges,
        ...extra,
      }, null, 2));
    };
    try {
      stage = 'addInitScript';
      await page.addInitScript(installAccountObserver);
      for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }]) {
        stage = `goto:${view.label}`;
        await page.setViewportSize(view);
        await page.goto(`${BASE}/admin/inquiries`, { waitUntil: 'load' });
        await expect(page.getByTestId('admin-account-role')).toBeVisible({ timeout: 20_000 });
        // 离开此 document 前立即读出并累积该批次帧，第一档不丢；每档一次时钟校准。
        stage = `read:${view.label}`;
        collectFrames(all, await readAccountFrames(page));
        clockBridges.push({ viewport: view.label, ...(await clockBridge(page, at)) });
      }
      stage = 'done';
    } catch (e) {
      err = safeError(e);
      // 异常也尽力把当前 document 已采帧累积进诊断，不覆盖前面批次。
      try { collectFrames(all, await readAccountFrames(page)); } catch { /* 读帧失败不遮蔽原错误 */ }
    } finally {
      // 任何异步清理之前先尽力读当前 document 并稳定去重，再写含真实证据的主诊断。
      try { collectFrames(all, await readAccountFrames(page)); } catch { /* 读帧失败不遮蔽原错误 */ }
      saveDiag({});
      // 独立清理每项：任一失败记受控类别，不遮蔽原错误、不阻断其它清理，且使最终 pass=false。
      try { await page.evaluate(() => (window as unknown as { __admObserverStop?: () => void }).__admObserverStop?.()); }
      catch (e) { cleanupErrors.push({ stage: 'observer-stop', code: safeError(e)?.code ?? 'unknown' }); }
    }

    const d1920 = all.find((f) => f.viewport === '1920x1080' && f.state === 'data');
    const d1440 = all.find((f) => f.viewport === '1440x900' && f.state === 'data');
    const d1Keys = ['padTop', 'padRight', 'padBottom', 'padLeft', 'rowGap', 'columnGap'] as const;
    const d1 = {
      present: !!d1920 && !!d1440,
      equal: d1920 && d1440 ? d1Keys.map((k) => ({ key: k, a: d1920.panel[k], b: d1440.panel[k], equal: d1920.panel[k] === d1440.panel[k] })) : [],
    };
    const verdict = densityVerdict(all, STATES, VIEWPORTS, d1);
    const pass = verdict.pass && err === null && cleanupErrors.length === 0; // 与最终断言同一真值

    const report = {
      suite: 'M3-T7 admin-account density supplement (#529)',
      selector: '.adm-account', rail: 'nav#adm-nav（既有 14 次 main 探针排除侧栏，本补证直接量面板）',
      viewports: VIEWPORTS, statesMeasured: STATES,
      thresholds: ACCOUNT_DENSITY, eps: EPS,
      clock: { runner: 'node:perf_hooks performance.now()-runnerStart（单调）', calibration: '每个 document 一次 runner r1 / page p / runner r2 夹取，偏移区间 [r1-p, r2-p]；只述客户端观测顺序', clockBridges },
      sampling: '每档离开 document 前 readAccountFrames 并累积，按 docId+state+viewport+seq 去重；CSS 已生效 + 可见非零才记有效帧；单 pending rAF、stopped guard、预算耗尽复用幂等 stop、MO+具名监听完整 cleanup',
      d4Definition: 'CSS 值：四边 padding≤20 / row+column-gap≤24；严格 px 语法、非法/缺失/非有限 rect 失败',
      d5Definition: 'loading/cleared 必须有真实 state-text（否则失败）、状态文字与同 group 状态块独立局部左上（不被 signout 极值抵消）+ 四边有界 + min-height + 底部留白 + 子项间距 + 稀疏撑高块；data 允许状态文字 n/a；与 D4 独立',
      coverage: verdict.coverage, frames: verdict.judged, d1,
      stage, error: err, cleanupErrors,
      cleared401: { scope: '本用例只采 data/loading；401-cleared 构造结果见独立会话补证报告 admin-account-cleared.json。' },
      note: '390x844 phone probe 未跑，仅复用既有 44px 触控与无横向溢出证据，不伪填手机 D1–D6；card 不是本卡新增页面类型，不新造 card 页面。',
      pass,
    };
    // 用最终判定更新同一报告（不是事后补造采样时间），再 attach。
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('admin-account-density', { path: reportPath, contentType: 'application/json' });

    expect(err, `补证执行异常（stage=${stage}）`).toBeNull();
    expect(cleanupErrors.length, '清理须无失败').toBe(0);
    expect(verdict.coverage.complete, 'data/loading × 1920/1440 四格 coverage 须完整（两档各自读帧）').toBe(true);
    expect(verdict.geometry, '所有有效帧 D4/D5 须全通过').toBe(true);
    expect(verdict.d1Ok, 'D1 两档四边 padding / row+column gap 须一致').toBe(true);
    expect(pass, 'report.pass 与断言同一真值').toBe(true);
  });
});

// signOut 会撤销设备会话，单独建管理员/会话，不与上面的 beforeAll 旧 cookie 共用。
test.describe('admin-signout 真退出（独立会话）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell-signout', name: 'E2E shell signout', password: PASSWORD, probe: ACCOUNT });

  test('点 admin-signout 执行真实 Auth.js signOut，旧 cookie GET account=401', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.goto(`${BASE}/admin/inquiries`);
    await expect(page.getByTestId('admin-signout')).toBeVisible();
    expect((await page.request.get(ACCOUNT)).status()).toBe(200);

    // 真实 Auth.js signOut：点退出后旧 cookie GET account = 401。
    const before = await page.context().storageState();
    await page.getByTestId('admin-signout').click();
    await expect.poll(async () => (await page.request.get(ACCOUNT)).status()).toBe(401);
    const replay = await browser.newContext({ storageState: before });
    expect((await replay.request.get(ACCOUNT)).status()).toBe(401);
    await replay.close();
  });
});

/**
 * 401-cleared 态补证（独立会话，不污染主体组共享管理员/会话）。
 * runner 用 node:perf_hooks 的单调 performance.now()；每个 document 一次 runner/page 时钟夹取校准，
 * 帧保留原页面 performance.now() 采样时间与 docId，不在报告阶段补造采样 mark；
 * goto(domcontentloaded) 返回标 goto-complete，SSR 响应只在真实 response 回调记录（不精确推断网络时刻）。
 * 报告 finally 先写主诊断（清理前），独立清理每项并记录受控失败（最终 pass=false），再更新同一报告。
 */
test.describe('admin-account 401-cleared 态布局补证（独立会话）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell-cleared', name: 'E2E shell cleared', password: PASSWORD, probe: ACCOUNT });

  test('SSR 挂载后另一真实请求撤销会话，浏览器自身 GET account 401 触发 .adm-account-cleared（两档桌面）', async ({ page, playwright }, testInfo) => {
    test.setTimeout(150_000);
    const VIEWPORTS = ['1440x900', '1920x1080'] as const;
    const STATES = ['cleared'] as const;
    const runnerStart = nodePerf.now();
    const at = () => nodePerf.now() - runnerStart; // runner 单调时钟
    const timeline: Array<{ atMs: number; action: string; status?: number; requestId?: number; viewport?: string }> = [];
    const mark = (action: string, extra?: Partial<{ status: number; requestId: number; viewport: string }>) => { timeline.push({ atMs: at(), action, ...extra }); };
    type PWReq = import('@playwright/test').Request;
    const requestIds = new Map<PWReq, number>();
    let nextId = 0;
    const idOf = (r: PWReq): number => { let n = requestIds.get(r); if (n === undefined) { n = ++nextId; requestIds.set(r, n); } return n; };
    const browser401Ids = new Set<number>();
    const isAccount = (r: PWReq) => { try { return r.method() === 'GET' && new URL(r.url()).pathname === ACCOUNT; } catch { return false; } };
    const frames: AccountFrame[] = [];
    let navigationStatus = 0, signoutStatus = 0, replayStatus = 0;
    let shellVisible = false, clearedTextVisible = false, urlAfter = '';
    let stage = 'init';
    let err = safeError(null);
    const cleanupErrors: Array<{ stage: string; code: string }> = [];
    let bridge: ClockBridge | null = null;
    // 真实目标 document 响应观察时点（不是 goto 返回、不是服务器到达）；作有效帧区间下界。
    let navigationResponseObservedAt: number | null = null;
    let readObservedAt: number | null = null;
    let revoker: import('@playwright/test').APIRequestContext | null = null;
    let replayCtx: import('@playwright/test').APIRequestContext | null = null;
    let csrf = '';
    // 唯一 signout Promise：由真实主 frame 目标 document 响应观察回调即时启动，不等待 DOM/校准/可见。
    let signoutPromise: Promise<import('@playwright/test').APIResponse> | null = null;
    let signoutTriggered = false, signoutRejected = false, signoutSettled = false;
    let navigationResponseSeen = false;
    // finally 入口即置 true：禁止迟到 response 在清理/保存诊断期间又开启一个未纳入收尾的 signout。
    let signoutFrozen = false;

    const isTargetDocumentResponse = (r: import('@playwright/test').Response): boolean => {
      const req = r.request();
      // 仅主 frame 的目标 HTML document；排除资源、API、子 frame、后续重复事件与非 200。
      if (signoutFrozen || navigationResponseSeen || r.status() !== 200) return false;
      if (req.resourceType() !== 'document') return false;
      if (req.frame() !== page.mainFrame()) return false;
      try {
        const u = new URL(r.url());
        if (u.pathname !== '/admin/inquiries') return false;
        if (req.method() !== 'GET') return false;
      } catch { return false; }
      return true;
    };
    const startSignout = (): void => {
      if (signoutFrozen || signoutTriggered || !revoker || !csrf) return;
      signoutTriggered = true;
      mark('signout-start'); // 真实响应观察回调内即时，早于 clockBridge / 可见等待
      const posted = revoker.post('/api/auth/signout', {
        maxRedirects: 0, headers: { Origin: BASE }, form: { csrfToken: csrf, callbackUrl: `${BASE}/admin-login` },
      });
      // 结算回调即记录一次真实完成/失败 runner 时点（不被后续 clockBridge/可见等待拖延）；
      // 主流程只 await 同一 Promise 取结果，不再补写伪完成时间。
      signoutPromise = posted.then((resp) => {
        if (!signoutSettled) {
          signoutSettled = true;
          signoutStatus = resp.status();
          mark('signout-complete', { status: signoutStatus });
        }
        return resp;
      }, (cause) => {
        if (!signoutSettled) {
          signoutSettled = true;
          signoutRejected = true;
          mark('signout-failed');
        }
        throw cause; // 保留 rejection 语义，主流程 await 会接到并记受控错误
      });
      // 避免未处理 rejection（结算回调已重抛）：额外挂空 catch 消费一份，主流程 await 仍接同一 Promise。
      void signoutPromise.catch(() => undefined);
    };
    const watchRequest = (r: PWReq) => { if (isAccount(r)) mark('browser-account-request', { requestId: idOf(r) }); };
    const watchResponse = (r: import('@playwright/test').Response) => {
      const req = r.request();
      if (isAccount(req)) {
        const id = idOf(req);
        mark('browser-account-response', { status: r.status(), requestId: id });
        if (r.status() === 401) browser401Ids.add(id);
      }
      // 目标 document 响应到达的同一回调里立刻发起真实 signout（不等 DOM/校准/可见）。
      if (isTargetDocumentResponse(r)) {
        navigationResponseSeen = true;
        navigationStatus = r.status();
        navigationResponseObservedAt = at();
        mark('navigation-response-observed', { status: r.status() });
        startSignout();
      }
    };
    const watchFailed = (r: PWReq) => { if (isAccount(r)) mark('browser-account-requestfailed', { requestId: idOf(r) }); };
    // 三个监听均在导航前注册；response 回调承担「真实撤销触发点」。
    page.on('request', watchRequest);
    page.on('response', watchResponse);
    page.on('requestfailed', watchFailed);
    const reportPath = testInfo.outputPath('admin-account-cleared.json');
    // 临时诊断：任何 dispose 之前先落盘——含已有脱敏原帧、实际 coverage、timeline/请求结果、校准、error；
    // 标 cleanup-pending、pass=false。即使 dispose 挂住，磁盘已有当时真实几何与缺口。
    const saveDiag = (extra: Record<string, unknown>) => {
      const diagVerdict = densityVerdict(frames, STATES, VIEWPORTS);
      const diagResponses = new Map<number, number>();
      for (const e of timeline) if (e.action === 'browser-account-response' && typeof e.requestId === 'number' && typeof e.status === 'number') diagResponses.set(e.requestId, e.status);
      writeFileSync(reportPath, JSON.stringify({
        suite: 'M3-T7 admin-account 401-cleared density supplement (#529)', stage, error: err, cleanupErrors,
        cleanupPending: true, pass: false,
        frames: diagVerdict.judged, coverage: diagVerdict.coverage, timeline,
        responsesById: Object.fromEntries(diagResponses), clockBridge: bridge,
        realRequests: { navigationStatus, shellVisible, signoutStatus, replayAccountStatus: replayStatus, urlAfter },
        triggerState: {
          navigationResponseSeen, navigationResponseObservedAt,
          signoutTriggered, signoutRejected, signoutSettled, signoutFrozen, signoutStatus,
        },
        ...extra,
      }, null, 2));
    };
    try {
      stage = 'prepare';
      const sessionState = await page.context().storageState();
      revoker = await playwright.request.newContext({ baseURL: BASE, storageState: sessionState });
      csrf = (await (await revoker.get('/api/auth/csrf')).json()).csrfToken as string;
      replayCtx = await playwright.request.newContext({ baseURL: BASE, storageState: sessionState });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript(installAccountObserver);
      mark('prepared', { viewport: '1440x900' });

      stage = 'navigate';
      mark('goto-start');
      const nav = await page.goto(`${BASE}/admin/inquiries`, { waitUntil: 'domcontentloaded' });
      // 触发点在真实 response 回调里（startSignout），此处只标 goto 返回观察，不再发起 signout。
      if (navigationStatus === 0) navigationStatus = nav ? nav.status() : 0;
      mark('goto-complete', { status: navigationStatus });
      // 校准/可见等在 signout 已发起之后进行，不再延后撤销。
      bridge = await clockBridge(page, at);
      await expect(page.getByTestId('admin-account')).toBeVisible({ timeout: 20_000 });
      shellVisible = true;
      mark('shell-visible');

      stage = 'signout';
      // 等待唯一 signout Promise（赋值发生在 response 回调里，TS 不追踪跨函数副作用，显式读避免 narrow 成 never）。
      // signout-complete 已在发起时绑定的结算回调按真实完成时点记录一次；这里只 await 取结果，不补写时间。
      const pendingSignout = signoutPromise as Promise<import('@playwright/test').APIResponse> | null;
      if (!pendingSignout) { throw new Error('signout-not-triggered-by-target-document-response'); }
      await pendingSignout;

      stage = 'replay';
      mark('replay-start');
      replayStatus = (await replayCtx.get(ACCOUNT)).status();
      mark('replay-response', { status: replayStatus });

      stage = 'cleared-observe';
      try {
        await expect(page.getByRole('status').filter({ hasText: '会话已失效' })).toBeVisible({ timeout: 10_000 });
        clearedTextVisible = true;
        mark('cleared-text-visible', { viewport: '1440x900' });
      } catch { /* 未捕获：如实记 not-captured */ }
      await page.setViewportSize({ width: 1920, height: 1080 });
      mark('cleared-resize-1920', { viewport: '1920x1080' });
      await page.waitForTimeout(300);
      collectFrames(frames, await readAccountFrames(page)); // 帧保留原 page atMs/clock/docId/seq
      readObservedAt = at(); // 本 document 帧读取观察上界（帧区间不得远晚于此）
      urlAfter = page.url();
      stage = 'done';
    } catch (e) {
      err = safeError(e);
      try { collectFrames(frames, await readAccountFrames(page)); } catch { /* 读帧失败不遮蔽原错误 */ }
    } finally {
      // ① 入口即冻结触发：迟到 response 不得再开启一个未纳入收尾的 signout。
      signoutFrozen = true;
      // ② 尽力读当前 document 并稳定去重（读帧失败不遮蔽）。
      try { collectFrames(frames, await readAccountFrames(page)); } catch { /* 读帧失败不遮蔽原错误 */ }
      if (readObservedAt === null) readObservedAt = at();
      // ③ 在**任何可能挂起的 await 之前**先落首份诊断：含已有原帧/coverage/timeline/校准/
      //    导航观察/触发/冻结/结算/拒绝/当前请求状态，pass=false、cleanupPending=true。
      saveDiag({});
      // ④ 再安全结算/消费在途 Promise（结算回调已记真实完成时点；此处仅补齐状态、不补写时间）。
      const pendingInFinally = signoutPromise as Promise<import('@playwright/test').APIResponse> | null;
      if (pendingInFinally && !signoutSettled) {
        try { await pendingInFinally; }
        catch { signoutRejected = true; }
      }
      // ⑤ 独立清理每项：任一失败记受控类别，不遮蔽原错误、不阻断其它清理。
      const cleanups: Array<[string, () => Promise<unknown> | void]> = [
        ['observer-stop', () => page.evaluate(() => (window as unknown as { __admObserverStop?: () => void }).__admObserverStop?.())],
        ['listeners-off', () => { page.off('request', watchRequest); page.off('response', watchResponse); page.off('requestfailed', watchFailed); }],
        ['revoker-dispose', () => revoker?.dispose()],
        ['replay-dispose', () => replayCtx?.dispose()],
      ];
      for (const [name, fn] of cleanups) {
        try { await fn(); } catch (e) { cleanupErrors.push({ stage: name, code: safeError(e)?.code ?? 'unknown' }); }
      }
    }

    const verdict = densityVerdict(frames, STATES, VIEWPORTS);
    const pairedRequests = [...new Set(timeline.filter((e) => e.action.startsWith('browser-account')).map((e) => e.requestId).filter((n): n is number => typeof n === 'number'))];
    const responsesById = new Map<number, number>();
    for (const e of timeline) if (e.action === 'browser-account-response' && typeof e.requestId === 'number' && typeof e.status === 'number') responsesById.set(e.requestId, e.status);
    const clientAccount401 = pairedRequests.filter((id) => responsesById.get(id) === 401).length > 0;
    const pairingOk = pairedRequests.every((id) => timeline.some((e) => e.action === 'browser-account-request' && e.requestId === id));
    const signoutOk = signoutStatus === 200 || signoutStatus === 302;
    const replayOk = replayStatus === 401;
    // cleared 帧与真实 401 的关联：每帧绑定自身 docId 的有效 bridge，区间有限有序、
    // 不早于本 doc 导航、不晚于读取观察上界，且该 doc 有真实成对浏览器 GET 401；重叠只标不确定。
    const response401 = timeline.filter((e) => e.action === 'browser-account-response' && e.status === 401).map((e) => ({ atMs: e.atMs, requestId: e.requestId as number }));
    // 下界用真实目标 document 响应观察时点（不是 goto 返回）；未观察到则记 -1 让矛盾区间判失败。
    const timeV = frameTimeVerdict(frames, bridge, navigationResponseObservedAt ?? -1, readObservedAt ?? Number.POSITIVE_INFINITY, response401);
    const frameLinked = timeV.linked;
    const navigationResponseOk = navigationResponseSeen && navigationResponseObservedAt !== null && navigationStatus === 200;
    const signoutTriggeredOk = signoutTriggered && !signoutRejected && signoutPromise !== null;
    const captured = verdict.pass && clientAccount401 && pairingOk && signoutOk && replayOk && clearedTextVisible && frameLinked &&
      navigationResponseOk && signoutTriggeredOk && err === null && cleanupErrors.length === 0;
    const pass = captured;

    const report = {
      suite: 'M3-T7 admin-account 401-cleared density supplement (#529)',
      selector: '.adm-account / .adm-account-cleared',
      viewports: VIEWPORTS, statesMeasured: STATES,
      clock: { runner: 'node:perf_hooks performance.now()-runnerStart（单调）', calibration: bridge, pageFrame: '帧自带页面 performance.now() 采样时间，映射区间 [pageAt+r1-p, pageAt+r2-p]；只述客户端观测顺序、保留不确定性，不推服务端到达，不要求 GET 早于 signout 发出' },
      method: '导航前注册 response 观察回调：匹配主 frame 目标 document（/admin/inquiries、resourceType=document、status200、排除 API/资源/子frame/重复）的响应到达同一回调里即时启动唯一真实 Auth.js signout Promise；不等 DOM/clockBridge/可见等待。预建 revoker+CSRF+replay；Map<Request,seq> 配对浏览器自身 GET account request/response/requestfailed；goto(domcontentloaded) 仅标 goto-complete，响应观察时点另记 navigation-response-observed 作有效帧下界；复制旧 state 的真实请求确认 401；同页 resize 采两档 cleared 几何。无 CDP 延迟挂起假设、无 route.fulfill、无响应改写、无 DB 写入、无 src/DOM/CSS/React 改动、无存储注入、无固定 sleep/多次登录退出。',
      realRequests: { navigationStatus, navigationResponseSeen, navigationResponseObservedAt, signoutTriggered, signoutRejected, shellVisible, signoutStatus, replayAccountStatus: replayStatus, urlAfter },
      timeline, pairedRequests, responsesById: Object.fromEntries(responsesById), browser401Ids: [...browser401Ids],
      response401, frameTimeVerdict: timeV, frameLinked, navigationResponseOk, signoutTriggeredOk,
      navigationResponseSeen, navigationResponseObservedAt, signoutTriggered, signoutRejected,
      clientAccount401, pairingOk, signoutOk, replayOk, clearedTextVisible,
      coverage: verdict.coverage, frames: verdict.judged,
      thresholds: ACCOUNT_DENSITY, eps: EPS,
      stage, error: err, cleanupErrors,
      result: captured ? 'captured' : 'not-captured',
      note: captured
        ? '浏览器自身 GET account 实测成对 401 + 真实 signout/旧 cookie 401 + 两档桌面 cleared 几何 D4/D5 全通过 + 帧时间区间与 401 关联（不精确排序）。'
        : '本次未闭合：not-captured / 客户端 GET 非 401 或配对失败 / 缺任一视口 cleared 几何 / 缺 state-text / 几何不通过 / 帧时间未校准 / 准备或清理异常 都记为未取得，不伪填 pass、不下「实现不可能 / 须改产品」结论。390 phone probe 未跑，仅复用 44px 触控与无横向溢出，不伪填手机 D1–D6；card 不适用、不新造页面。',
      pass,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('admin-account-cleared', { path: reportPath, contentType: 'application/json' });

    expect(err, `补证执行异常（stage=${stage}）`).toBeNull();
    expect(cleanupErrors.length, '清理须无失败').toBe(0);
    expect(signoutOk, `真实 Auth.js signout 须成功（实际 ${signoutStatus}）`).toBe(true);
    expect(replayOk, `复制旧 state 的真实 GET account 须 401（实际 ${replayStatus}）`).toBe(true);
    expect(navigationResponseOk, '目标 document 真实 200 响应须被观察并触发唯一 signout').toBe(true);
    expect(signoutTriggeredOk, 'signout 须由响应回调即时发起且 Promise 未被拒').toBe(true);
    expect(pairingOk, '浏览器 GET account request/response 须按本地序号配对').toBe(true);
    expect(clientAccount401, '浏览器自身 GET account 须实测成对 401').toBe(true);
    expect(clearedTextVisible, '.adm-account-cleared 须真实可见').toBe(true);
    expect(verdict.coverage.complete, 'cleared × 1440/1920 两档 coverage 须完整').toBe(true);
    expect(verdict.geometry, 'cleared 两档几何 D4/D5 须全通过').toBe(true);
    expect(frameLinked, 'cleared 帧须绑同 doc 有效校准、区间有效并与成对 401 关联').toBe(true);
    expect(pass, 'report.pass 与断言同一真值').toBe(true);
  });
});
