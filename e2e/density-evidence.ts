import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page, TestInfo } from '@playwright/test';

// M5-T10 三视口密度取证：真实页面取原始 densityProbe JSON、computed style 与几何。
// 只写 e2e-evidence/（CI 的 playwright-report 产物 if: always() 整目录上传）；不用
// testInfo.attach——它落在 test-results/，成功运行不上传。本层不产出 D1–D6 / overflow 判定。

export const DENSITY_API_PATH = '/api/admin/settings/analytics';
/** 入口与选中链接都必须解析到这个完整同源目标。 */
export const DENSITY_LANDING_PATH = '/admin/settings?section=analytics';

/** 本用例的固定视口与探针参数；与既有断言使用同一组值。 */
export const DENSITY_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
] as const;

export const DENSITY_PROBE_OPTIONS = { type: 'form', density: 7, gutter: 16, gap: 16, pad: 16, main: '.st-page' } as const;

export type DensityViewport = { width: number; height: number };
export type DensityRect = { x: number; y: number; width: number; height: number; left: number; right: number; top: number; bottom: number };
export type DensityNode = {
  tag: string; id: string | null; class: string | null; rect: DensityRect; styles: Record<string, string>;
  disabled: boolean | null; ariaInvalid: string | null; ariaCurrent: string | null; activeElement: boolean;
};
export type DensityElementGroup = { selector: string; count: number; nodes: DensityNode[] };
export type DensityStyleJson = {
  route: string;
  viewport: {
    innerWidth: number; innerHeight: number; devicePixelRatio: number; scrollX: number; scrollY: number;
    visualWidth: number | null; visualHeight: number | null; visualScale: number | null;
  };
  media: { mobileUnder768: boolean; coarsePointer: boolean; hoverNone: boolean };
  fontStatus: string | null;
  widths: { htmlClient: number; htmlScroll: number; htmlDelta: number; bodyClient: number | null; bodyScroll: number | null };
  elements: Record<string, DensityElementGroup>;
  grids: Array<{ element: DensityNode; children: DensityNode[] }>;
};

export type DensityEntryFacts = {
  href: string; pathname: string; search: string; section: string | null;
  pageCount: number; formCount: number; pageContainsForm: boolean;
  inputVisible: boolean; timezoneVisible: boolean; navLinkFound: boolean;
  ariaCurrent: string | null; menuVisible: boolean; adminNavVisible: boolean;
};

export type DensityHookState = {
  installed: boolean; token: string | null; docId: string | null; count: number; status: number | null;
  url: string | null; href: string; settled: boolean;
};
export type DensityLinkFact = {
  text: string; href: string; origin: string; target: string; pathname: string; section: string | null;
  ariaCurrent: string | null;
};
/** 一次页内执行同时得到文档标识与 probe；两者必然来自同一文档实例。 */
export type DensityProbeSample = { docId: string | null; probe: unknown; error: string | null };
/** 一次页内执行同时得到文档标识与 computed style；两者必然来自同一文档实例。 */
export type DensityStyleSample = { docId: string | null; style: DensityStyleJson };
export type DensityLandingFacts = DensityEntryFacts & {
  readyState: string; fontsStatus: string | null; formContainsInput: boolean;
  hook: DensityHookState; navLinks: DensityLinkFact[]; currentLinks: DensityLinkFact[];
};
export type DensityLandingResult = { verified: boolean; reasons: string[]; facts: DensityLandingFacts | null };

export type DensityEntryResponse = { status: number | null; url: string | null; error: string | null };
export type DensityBrowserClock = { timeZone: string; offsetMinutes: number; locale: string; userAgent: string };

export type DensityProbeJson = {
  probe?: string; version?: number; url?: string; type?: string; viewport?: { width: number; height: number };
  mobile?: boolean; main?: string; rail?: { path: string; width: number } | null;
  avail?: { left: number; right: number; width: number }; contentFound?: boolean;
  fill?: number; leftGap?: number; rightGap?: number; interiorBand?: { px: number; ratio: number };
  overflowX?: number; bars?: number; growth?: unknown[]; emptyTracks?: unknown[];
  gapOffenders?: unknown[]; padOffenders?: unknown[]; sparseBlocks?: unknown[]; centeredCaps?: unknown[];
  counts?: Record<string, number>; verdict?: Record<string, string | boolean>;
};

export type DensityCaptureStatus = 'pending' | 'captured' | 'captured-with-flags' | 'entry-not-verified' | 'probe-invalid' | 'style-failed';

export type DensityCaptureRecord = {
  viewport: string; requested: DensityViewport; status: DensityCaptureStatus;
  entry: (DensityEntryFacts & { getStatus: number | null; getUrl: string | null; getError: string | null }) | null;
  landing: DensityLandingFacts | null;
  /** 入口、probe、浏览器时钟与样式各自取样时的文档实例标识；任一不等于 entry 即判入口未核实。 */
  documents: { entry: string | null; probe: string | null; clock: string | null; style: string | null } | null;
  timeZone: string | null;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  flags: string[]; error: string | null;
};

export type DensityRun = {
  root: string; runId: string; runDir: string; parent: string; uploadRoot: string; offArtifact: boolean; token: string;
  startedAt: string; finishedAt: string | null;
  identity: Record<string, unknown>; captures: DensityCaptureRecord[];
};

export type DensityRunSummary = {
  schema: string; claim: string; complete: boolean; clean: boolean;
  missing: string[]; problems: Array<{ viewport: string; status: string; error: string | null }>;
  files: Array<{ viewport: string; name: string; bytes: number; sha256: string }>;
};

/**
 * 已封 collect-computed-style.cjs 的逐字段移植（唯一差别是 TS 类型注解，运行时同源）。
 * page.evaluate 会序列化整个函数体，因此它必须自包含。
 */
export function collectComputedStyle(): DensityStyleJson {
  const rect = (node: Element): DensityRect => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const properties = [
    'display', 'visibility', 'position', 'overflowX', 'overflowY', 'width', 'minWidth', 'maxWidth',
    'height', 'minHeight', 'maxHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'rowGap', 'columnGap',
    'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'flexDirection', 'justifyContent',
    'alignItems', 'order', 'color', 'backgroundColor', 'backgroundImage', 'borderTopWidth',
    'borderTopStyle', 'borderTopColor', 'borderRightWidth', 'borderRightStyle', 'borderRightColor',
    'borderRadius', 'boxShadow', 'opacity', 'outlineWidth', 'outlineStyle', 'outlineColor',
    'outlineOffset', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'transform', 'zIndex'
  ];
  const describe = (node: Element): DensityNode => {
    const cs = getComputedStyle(node) as unknown as Record<string, string>;
    const styles: Record<string, string> = {};
    for (const p of properties) styles[p] = cs[p];
    return {
      tag: node.tagName.toLowerCase(), id: node.id || null,
      class: node.getAttribute('class'), rect: rect(node), styles,
      disabled: 'disabled' in node ? !!(node as HTMLInputElement).disabled : null,
      ariaInvalid: node.getAttribute('aria-invalid'), ariaCurrent: node.getAttribute('aria-current'),
      activeElement: document.activeElement === node
    };
  };
  const selectors: Record<string, string> = {
    document: 'html', body: 'body', adminMain: 'main.adm-main',
    analyticsPage: '.st-page', sections: '.st-page .st-sections',
    currentSection: '.st-page .st-sections a[aria-current="page"]',
    pageTitle: '.st-page h1', grid: '.st-page .st-grid',
    formColumn: '.st-page .st-main', formCard: '.st-page .st-main > .st-card',
    form: '.st-page .st-main form', formField: '.st-page .st-main .st-f',
    input: '[data-testid="analytics-settings-input"]',
    save: '[data-testid="analytics-settings-save"]',
    aside: '.st-page .st-side', asideCard: '.st-page .st-side > .st-card',
    asideDetails: '.st-page .st-side dl',
    status: '[data-testid="analytics-settings-status"]',
    fieldError: '[data-testid="analytics-settings-field-error"]',
    alert: '[data-testid="analytics-settings-alert"]',
    menu: '.adm-menu', adminNav: '#adm-nav'
  };
  const elements: Record<string, DensityElementGroup> = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const nodes = Array.from(document.querySelectorAll(selector));
    elements[name] = { selector, count: nodes.length, nodes: nodes.map(describe) };
  }
  const page = document.querySelector('.st-page');
  const grids = page ? Array.from(page.querySelectorAll('*')).filter((n) => getComputedStyle(n).display.includes('grid')).map((grid) => ({
    element: describe(grid),
    children: Array.from(grid.children).map(describe)
  })) : [];
  const html = document.documentElement;
  const body = document.body;
  return {
    route: location.pathname + location.search,
    viewport: {
      innerWidth: innerWidth, innerHeight: innerHeight, devicePixelRatio,
      scrollX: window.scrollX, scrollY: window.scrollY,
      visualWidth: window.visualViewport ? window.visualViewport.width : null,
      visualHeight: window.visualViewport ? window.visualViewport.height : null,
      visualScale: window.visualViewport ? window.visualViewport.scale : null
    },
    media: {
      mobileUnder768: matchMedia('(max-width:767px)').matches,
      coarsePointer: matchMedia('(pointer:coarse)').matches,
      hoverNone: matchMedia('(hover:none)').matches
    },
    fontStatus: document.fonts ? document.fonts.status : null,
    widths: {
      htmlClient: html.clientWidth, htmlScroll: html.scrollWidth,
      htmlDelta: Math.max(0, html.scrollWidth - html.clientWidth),
      bodyClient: body ? body.clientWidth : null, bodyScroll: body ? body.scrollWidth : null
    },
    elements, grids
  };
}

/**
 * 入口与请求归属：一次页面求值同时读当次文档的 GET 观察器、路由、选中项和表单状态。
 * 观察器由 installDensityObserver 在每个新文档的页面脚本前安装，先前文档和子帧的请求
 * 不会出现在这里；调用方仍须再跑 verifyDensityLanding 才能判定可用。
 */
export function readDensityLanding(): DensityLandingFacts {
  const shown = (node: Element | null): boolean => {
    if (!node) return false;
    const cs = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && box.width >= 1 && box.height >= 1;
  };
  const linkFact = (link: Element): DensityLinkFact => {
    const raw = link.getAttribute('href') ?? '';
    let pathname = '';
    let section: string | null = null;
    let origin = '';
    let target = '';
    try {
      const url = new URL(raw, document.baseURI);
      pathname = url.pathname;
      section = url.searchParams.get('section');
      origin = url.origin;
      target = url.href;
    } catch {
      // 非法 href 保留空值，由 verifyDensityLanding 记 destination 问题
    }
    return {
      text: (link.textContent ?? '').trim(), href: raw, origin, target, pathname, section,
      ariaCurrent: link.getAttribute('aria-current')
    };
  };
  const page = document.querySelector('.st-page');
  const form = page ? page.querySelector('form') : null;
  const input = document.querySelector('[data-testid="analytics-settings-input"]');
  const navLinks = Array.from(document.querySelectorAll('nav[aria-label="站点设置分区"] a')).map(linkFact);
  const currentLinks = navLinks.filter((link) => link.ariaCurrent === 'page');
  const selected = navLinks.find((link) => link.text === '统计时区') ?? null;
  const hook = (window as unknown as {
    __m5t10DensityGet?: {
      token: string; docId: string; count: number; status: number | null; url: string | null; href: string; settled: boolean;
    };
  }).__m5t10DensityGet;
  return {
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    section: new URL(location.href).searchParams.get('section'),
    pageCount: document.querySelectorAll('.st-page').length,
    formCount: page ? page.querySelectorAll('form').length : 0,
    pageContainsForm: !!(page && form && page.contains(form)),
    inputVisible: shown(input),
    timezoneVisible: shown(document.querySelector('[data-testid="analytics-settings-timezone"]')),
    navLinkFound: !!selected,
    ariaCurrent: selected ? selected.ariaCurrent : null,
    menuVisible: shown(document.querySelector('.adm-menu')),
    adminNavVisible: shown(document.querySelector('#adm-nav')),
    readyState: document.readyState,
    fontsStatus: document.fonts ? document.fonts.status : null,
    formContainsInput: !!(form && input && form.contains(input)),
    hook: hook
      ? {
        installed: true, token: hook.token, docId: hook.docId, count: hook.count, status: hook.status,
        url: hook.url, href: hook.href, settled: hook.settled
      }
      : { installed: false, token: null, docId: null, count: 0, status: null, url: null, href: '', settled: false },
    navLinks,
    currentLinks
  };
}

/** 每个新文档脚本前安装：只记录该文档实际发出的目标 GET，不改请求与返回的 Promise。 */
export async function installDensityObserver(page: Page, baseURL: string, token: string): Promise<{ token: string; dispose: () => Promise<void> }> {
  const origin = new URL(baseURL).origin;
  const initScript = await page.addInitScript(({ runToken, apiOrigin, pathname }) => {
    type Hook = {
      token: string; docId: string; count: number; status: number | null; url: string | null; href: string; settled: boolean;
    };
    // 本脚本在每个新文档的页面脚本前执行一次；同 URL 重载也会换新值，用它区分文档实例。
    const docId = `${runToken}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
    const state: Hook = { token: runToken, docId, count: 0, status: null, url: null, href: '', settled: false };
    const original = window.fetch;
    window.fetch = (...args) => {
      const pending = original.apply(window, args);
      const [input, init] = args;
      const request = input instanceof window.Request ? input : null;
      if ((init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'GET') return pending;
      let url: URL;
      try {
        url = new URL(request?.url ?? String(input), document.baseURI);
      } catch {
        return pending;
      }
      if (url.origin !== apiOrigin || url.pathname !== pathname) return pending;
      state.count += 1;
      state.href = location.href;
      state.status = null;
      state.settled = false;
      pending.then(
        (response) => { state.status = response.status; state.url = url.href; state.settled = true; },
        () => { state.settled = true; }
      );
      return pending;
    };
    (window as unknown as { __m5t10DensityGet?: Hook }).__m5t10DensityGet = state;
  }, { runToken: token, apiOrigin: origin, pathname: DENSITY_API_PATH });
  return { token, dispose: () => initScript.dispose() };
}

/** 一次页内执行同时得到文档标识与浏览器时钟；两者必然来自同一文档实例。 */
export type DensityClockSample = { docId: string | null; clock: DensityBrowserClock };

/** 页内：与文档标识一起返回时区/语言/UA；body 内联，避免序列化时丢引用。 */
export function readDensityClock(): DensityClockSample {
  const hook = (window as unknown as { __m5t10DensityGet?: { docId?: string } }).__m5t10DensityGet;
  return {
    docId: hook?.docId ?? null,
    clock: {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: new Date().getTimezoneOffset(),
      locale: navigator.language,
      userAgent: navigator.userAgent
    }
  };
}

/**
 * probe 取样：注入脚本后**一次页内执行**同时读该文档标识并调用 densityProbe。
 * 标识与结果必须来自同一次执行；若注入后文档已换，新文档没有 densityProbe，直接记失败
 * 而不是把别处的数字当成这份文档的。调用方仍须把返回值交给 captureDensityViewport 比对。
 */
export async function sampleDensityProbe(
  page: Page,
  probeSource: string,
  options: { type: 'form'; density: number; gutter: number; gap: number; pad: number; main: string }
): Promise<DensityProbeSample> {
  await page.addScriptTag({ content: probeSource });
  try {
    const sampled = await page.evaluate((opts) => {
      const hook = (window as unknown as { __m5t10DensityGet?: { docId?: string } }).__m5t10DensityGet;
      const densityProbe = (window as unknown as { densityProbe?: (x: typeof opts) => unknown }).densityProbe;
      if (!densityProbe) throw new Error('densityProbe 未注入');
      return { docId: hook?.docId ?? null, probe: densityProbe(opts) };
    }, options);
    return { docId: sampled.docId, probe: sampled.probe, error: null };
  } catch (error) {
    return { docId: null, probe: null, error: errorText(error) };
  }
}

/** 已封 collectComputedStyle 的函数体注入当前文档；与样本在同一文档实例里执行。 */
const STYLE_COLLECTOR_SOURCE = `window.__m5t10CollectStyle = (${collectComputedStyle.toString()});`;

/**
 * computed style 取样：注入采集器后**一次页内执行**同时读该文档标识并采集样式。
 * 注入后文档已换时新文档没有采集器，抛错由调用方记为 style-failed，不会留下别处的样式件。
 */
export async function sampleDensityStyle(page: Page): Promise<DensityStyleSample> {
  await page.addScriptTag({ content: STYLE_COLLECTOR_SOURCE });
  return page.evaluate(() => {
    const hook = (window as unknown as { __m5t10DensityGet?: { docId?: string } }).__m5t10DensityGet;
    const collect = (window as unknown as { __m5t10CollectStyle?: () => DensityStyleJson }).__m5t10CollectStyle;
    if (!collect) throw new Error('样式采集器未注入');
    return { docId: hook?.docId ?? null, style: collect() };
  });
}

/**
 * 在当前文档里等观察器看到并结算该文档自己的目标 GET，然后一次求值读入口事实。
 * 等待只轮询当前主帧的页面钩子；先前文档或子帧的 200 无法满足它。
 */
export async function waitForDensityLanding(page: Page, baseURL: string, options: { timeoutMs?: number } = {}): Promise<DensityLandingResult> {
  const timeout = options.timeoutMs ?? 15_000;
  let waitError: string | null = null;
  try {
    await page.waitForFunction(() => {
      const hook = (window as unknown as { __m5t10DensityGet?: { count: number; settled: boolean } }).__m5t10DensityGet;
      return !!hook && hook.count > 0 && hook.settled;
    }, undefined, { timeout });
  } catch (error) {
    waitError = errorText(error);
  }
  let facts: DensityLandingFacts | null = null;
  try {
    facts = await page.evaluate(readDensityLanding);
  } catch (error) {
    return { verified: false, reasons: [`landing-read-failed:${errorText(error)}`], facts: null };
  }
  const verdict = verifyDensityLanding(facts, baseURL);
  if (waitError) verdict.reasons.unshift('observer-wait-timeout');
  return { verified: verdict.reasons.length === 0, reasons: verdict.reasons, facts };
}

/** 入口硬门：该文档 GET 200、唯一区域、唯一且同源指向统计分区的选中项、区内已加载表单。 */
export function verifyDensityLanding(facts: DensityLandingFacts | null, baseURL: string): { verified: boolean; reasons: string[] } {
  if (!facts) return { verified: false, reasons: ['landing-facts-unavailable'] };
  const reasons: string[] = [];
  const apiUrl = `${new URL(baseURL).origin}${DENSITY_API_PATH}`;
  const expectedOrigin = new URL(baseURL).origin;
  const expectedTarget = new URL(DENSITY_LANDING_PATH, baseURL).href;
  const hook = facts.hook;
  if (!hook.installed) reasons.push('observer-not-installed');
  if (hook.installed && !hook.docId) reasons.push('observer-document-id-missing');
  if (hook.installed && hook.count !== 1) reasons.push(`observer-count-${hook.count}`);
  if (hook.installed && hook.status !== 200) reasons.push(`get-status-${hook.status ?? 'missing'}`);
  if (hook.installed && hook.url !== apiUrl) reasons.push('get-url-mismatch');
  if (hook.installed && hook.href !== facts.href) reasons.push('observer-document-mismatch');
  if (facts.pathname !== '/admin/settings') reasons.push(`pathname-${facts.pathname}`);
  if (facts.section !== 'analytics') reasons.push(`section-${facts.section ?? 'missing'}`);
  if (facts.readyState !== 'complete') reasons.push(`ready-state-${facts.readyState}`);
  if (facts.fontsStatus !== 'loaded') reasons.push(`fonts-${facts.fontsStatus ?? 'unknown'}`);
  if (facts.pageCount !== 1) reasons.push(`page-count-${facts.pageCount}`);
  if (facts.formCount !== 1) reasons.push(`form-count-${facts.formCount}`);
  if (!facts.pageContainsForm) reasons.push('form-not-in-page');
  if (!facts.formContainsInput) reasons.push('input-not-in-form');
  if (!facts.inputVisible) reasons.push('input-not-visible');
  if (!facts.timezoneVisible) reasons.push('timezone-not-visible');
  if (facts.currentLinks.length !== 1) {
    reasons.push(`current-links-${facts.currentLinks.length}`);
  } else {
    const current = facts.currentLinks[0];
    if (current.text !== '统计时区') reasons.push(`current-link-${current.text || 'empty'}`);
    if (current.origin !== expectedOrigin) reasons.push('current-link-origin');
    else if (current.target !== expectedTarget) reasons.push('current-link-target');
  }
  const targets = facts.navLinks.filter((link) => link.text === '统计时区');
  if (targets.length !== 1) reasons.push(`nav-target-count-${targets.length}`);
  else if (targets[0].origin !== expectedOrigin) reasons.push('nav-target-origin');
  else if (targets[0].target !== expectedTarget) reasons.push('nav-target-destination');
  return { verified: reasons.length === 0, reasons };
}

/** 浏览器时区/语言/UA 只用于标识本次运行的客户端上下文，不含凭据。 */
export function readBrowserClock(): DensityBrowserClock {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date().getTimezoneOffset(),
    locale: navigator.language,
    userAgent: navigator.userAgent
  };
}

export function densityEvidenceRoot(): string {
  const parent = path.resolve(process.env.M5T10_DENSITY_EVIDENCE_ROOT ?? path.join('e2e-evidence', 'm5-t10-density'));
  const uploadRoot = path.resolve('e2e-evidence');
  if (!(parent === uploadRoot || parent.startsWith(uploadRoot + path.sep))) {
    throw new Error(`M5T10_EVIDENCE_ROOT_OUTSIDE_UPLOAD ${parent} 不在 ${uploadRoot} 内，CI artifact 收不到`);
  }
  return parent;
}

export function viewportLabel(vp: DensityViewport): string {
  return `${vp.width}x${vp.height}`;
}

export type DensityGeometryInput = {
  viewport: DensityViewport; probe: DensityProbeJson; style: DensityStyleJson;
  entry: DensityEntryFacts | null; clock: DensityBrowserClock | null; response: DensityEntryResponse;
  documents?: { entry: string | null; probe: string | null; style: string | null } | null;
};

/**
 * 几何只放原值与算术（来源逐项标注），不写 D1–D6 / overflow 判定；quality flags 供验收方
 * 判断该视口证据是否可用，不能升级成合同通过。
 */
export function buildGeometry(input: DensityGeometryInput): Record<string, unknown> {
  const { probe, style, entry, clock, response } = input;
  const flags: string[] = [];
  const group = (name: string): DensityElementGroup => style.elements[name] ?? { selector: name, count: 0, nodes: [] };
  const shownNode = (node: DensityNode | null): boolean => !!node && node.styles.display !== 'none' &&
    node.styles.visibility !== 'hidden' && Number(node.styles.opacity) !== 0 && node.rect.width >= 1 && node.rect.height >= 1;
  const rectOf = (name: string) => {
    const g = group(name);
    const node = g.nodes[0] ?? null;
    return { selector: g.selector, count: g.count, rect: node ? node.rect : null, shown: shownNode(node) };
  };
  const fields = group('formField').nodes.filter(shownNode).slice().sort((a, b) => a.rect.top - b.rect.top);
  const fieldGaps = fields.slice(1).map((node, i) => Math.round((node.rect.top - fields[i].rect.bottom) * 100) / 100);
  const pageGroup = group('analyticsPage');
  const htmlDelta = style.widths.htmlDelta;
  const probeOverflow = typeof probe.overflowX === 'number' ? probe.overflowX : null;
  const crossCheck = probeOverflow === null ? 'unavailable' : (probeOverflow === htmlDelta ? 'match' : 'mismatch');
  const touch = (name: string) => {
    const node = group(name).nodes[0] ?? null;
    if (!node || !shownNode(node)) return { name, available: false, rect: null, referenceMinPx: 44, atLeastReference: null };
    return {
      name, available: true, rect: node.rect, referenceMinPx: 44,
      atLeastReference: node.rect.width >= 44 && node.rect.height >= 44
    };
  };

  if (style.fontStatus !== 'loaded') flags.push(`fonts-${style.fontStatus ?? 'unknown'}`);
  if (pageGroup.count !== 1) flags.push(`page-count-${pageGroup.count}`);
  if (!entry) flags.push('entry-facts-unavailable');
  else {
    if (!entry.pageContainsForm) flags.push('form-not-in-page');
    if (!entry.inputVisible) flags.push('input-not-visible');
    if (!entry.timezoneVisible) flags.push('timezone-not-visible');
    if (entry.ariaCurrent !== 'page') flags.push(`aria-current-${entry.ariaCurrent ?? 'missing'}`);
    if (entry.section !== 'analytics') flags.push(`section-${entry.section ?? 'missing'}`);
  }
  if (typeof probe.main === 'string' && !probe.main.includes('st-page')) flags.push('probe-main-not-st-page');
  if (probe.contentFound === false) flags.push('probe-content-not-found');
  if (crossCheck === 'mismatch') flags.push(`overflow-cross-check-${htmlDelta}!=${probeOverflow}`);
  if (typeof probe.viewport?.width === 'number' && probe.viewport.width !== style.viewport.innerWidth) {
    flags.push(`probe-viewport-${probe.viewport.width}!=${style.viewport.innerWidth}`);
  }
  if (style.viewport.innerWidth !== input.viewport.width || style.viewport.innerHeight !== input.viewport.height) {
    flags.push(`requested-viewport-${input.viewport.width}x${input.viewport.height}!=${style.viewport.innerWidth}x${style.viewport.innerHeight}`);
  }
  if (style.route !== '/admin/settings?section=analytics') flags.push(`route-${style.route}`);
  if (response.status !== 200) flags.push(`get-status-${response.status ?? 'missing'}`);

  return {
    schema: 'm5t10-density-geometry/1',
    claim: '仅原值、来源与算术；不含 D1–D6 / overflow 判定',
    requestedViewport: input.viewport,
    observedViewport: style.viewport,
    route: style.route,
    browserClock: clock,
    fontStatus: style.fontStatus,
    media: style.media,
    entry: {
      documentId: input.documents?.entry ?? null,
      getStatus: response.status, getUrl: response.url, getError: response.error,
      pathname: entry?.pathname ?? null, search: entry?.search ?? null, section: entry?.section ?? null,
      ariaCurrent: entry?.ariaCurrent ?? null, navLinkFound: entry?.navLinkFound ?? null,
      inputVisible: entry?.inputVisible ?? null, timezoneVisible: entry?.timezoneVisible ?? null,
      pageCount: entry?.pageCount ?? null, formCount: entry?.formCount ?? null, pageContainsForm: entry?.pageContainsForm ?? null
    },
    pageWidths: {
      htmlClient: style.widths.htmlClient, htmlScroll: style.widths.htmlScroll, htmlDelta,
      bodyClient: style.widths.bodyClient, bodyScroll: style.widths.bodyScroll,
      probeOverflowX: probeOverflow, crossCheck,
      formula: 'htmlDelta = max(0, documentElement.scrollWidth - documentElement.clientWidth)；probe.overflowX 同式另算'
    },
    uniqueCounts: Object.fromEntries(Object.entries(style.elements).map(([name, g]) => [name, g.count])),
    nodes: {
      page: rectOf('analyticsPage'), pageTitle: rectOf('pageTitle'), grid: rectOf('grid'),
      formColumn: rectOf('formColumn'), formCard: rectOf('formCard'), form: rectOf('form'),
      formField: rectOf('formField'), input: rectOf('input'), save: rectOf('save'),
      aside: rectOf('aside'), asideCard: rectOf('asideCard'), asideDetails: rectOf('asideDetails'),
      status: rectOf('status'), fieldError: rectOf('fieldError'), alert: rectOf('alert'),
      menu: rectOf('menu'), adminNav: rectOf('adminNav')
    },
    layout: {
      grids: style.grids.map((grid) => ({
        rect: grid.element.rect,
        display: grid.element.styles.display,
        gridTemplateColumns: grid.element.styles.gridTemplateColumns,
        gridTemplateRows: grid.element.styles.gridTemplateRows,
        gap: grid.element.styles.gap,
        rowGap: grid.element.styles.rowGap,
        columnGap: grid.element.styles.columnGap,
        padding: [grid.element.styles.paddingTop, grid.element.styles.paddingRight, grid.element.styles.paddingBottom, grid.element.styles.paddingLeft],
        border: [grid.element.styles.borderTopWidth, grid.element.styles.borderRightWidth, grid.element.styles.borderBottomWidth, grid.element.styles.borderLeftWidth],
        children: grid.children.map((child) => ({ tag: child.tag, class: child.class, rect: child.rect, display: child.styles.display }))
      }))
    },
    spacing: {
      formFieldCount: group('formField').count,
      formFieldGapsPx: fieldGaps,
      note: '相邻 .st-f 的净间距 = next.top - prev.bottom（实测 rect，不是 CSS 常量）'
    },
    touch: { input: touch('input'), save: touch('save') },
    mobile: {
      probeRail: probe.rail ?? null,
      menuShown: shownNode(group('menu').nodes[0] ?? null),
      adminNavShown: shownNode(group('adminNav').nodes[0] ?? null)
    },
    probeValues: {
      main: probe.main ?? null, rail: probe.rail ?? null, contentFound: probe.contentFound ?? null,
      fill: probe.fill ?? null, leftGap: probe.leftGap ?? null, rightGap: probe.rightGap ?? null,
      interiorBand: probe.interiorBand ?? null, avail: probe.avail ?? null,
      overflowX: probeOverflow, counts: probe.counts ?? null,
      emptyTracks: Array.isArray(probe.emptyTracks) ? probe.emptyTracks : null
    },
    flags
  };
}

export async function beginDensityEvidence(o: { testInfo: TestInfo; browser: Browser; baseURL: string }): Promise<DensityRun> {
  const parent = densityEvidenceRoot();
  mkdirSync(parent, { recursive: true });
  const token = randomBytes(6).toString('hex');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let root = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const runId = `${stamp}-w${o.testInfo.workerIndex}-r${o.testInfo.retry}-${randomBytes(3).toString('hex')}`;
    const candidate = path.join(parent, `run-${runId}`);
    try {
      mkdirSync(candidate, { recursive: false });
      root = candidate;
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  const uploadRoot = path.resolve('e2e-evidence');
  const offArtifact = !(root === uploadRoot || root.startsWith(uploadRoot + path.sep));
  const run: DensityRun = {
    root,
    runId: path.basename(root),
    runDir: path.basename(root),
    parent,
    uploadRoot: 'e2e-evidence',
    offArtifact,
    token,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    identity: {
      testTitle: o.testInfo.title,
      project: o.testInfo.project.name,
      retry: o.testInfo.retry,
      workerIndex: o.testInfo.workerIndex,
      repeatEachIndex: o.testInfo.repeatEachIndex,
      browserVersion: o.browser.version(),
      baseURL: o.baseURL,
      role: 'ADMIN（useSharedAdmin content-admin 真实会话）',
      runId: path.basename(root),
      runDir: path.basename(root),
      runIsolation: '每次运行独占 e2e-evidence/m5-t10-density/run-<UTC>-w<worker>-r<retry>-<random>',
      uploadRoot: 'e2e-evidence',
      offArtifact,
      observerToken: token,
      entry: {
        kind: 'direct-url', url: '/admin/settings?section=analytics', navigationChain: false,
        note: '本用例直接打开分区 URL；导航链（站点设置 → 统计时区）由具名入口用例承担，两条证据分开标识'
      },
      probeOptions: DENSITY_PROBE_OPTIONS,
      probeSource: 'docs/PackJoyU-开发文档/_run/density_probe.js（页面内 addScriptTag，原值返回）',
      styleSource: 'e2e/density-evidence.ts collectComputedStyle（已封 collect-computed-style.cjs 的逐字段移植）',
      claim: '仅采集原始证据；不产出 D1–D6 / overflow 判定，总 CI 绿不替代 11-UI 逐条判定',
      env: readEnvIdentity(),
      git: readGitIdentity()
    },
    captures: DENSITY_VIEWPORTS.map((vp) => ({
      viewport: viewportLabel(vp), requested: { width: vp.width, height: vp.height },
      status: 'pending', entry: null, landing: null, documents: null, timeZone: null, files: [], flags: [], error: null
    }))
  };
  writeRun(run);
  return run;
}

export async function captureDensityViewport(
  run: DensityRun,
  o: {
    page: Page; viewport: DensityViewport; landing: DensityLandingResult;
    probeSample: DensityProbeSample;
  }
): Promise<DensityCaptureRecord> {
  const label = viewportLabel(o.viewport);
  const record = run.captures.find((c) => c.viewport === label);
  if (!record) throw new Error(`M5T10_EVIDENCE_UNKNOWN_VIEWPORT ${label}`);

  const sampled = o.probeSample;
  const probe = (sampled.probe ?? null) as DensityProbeJson | null;
  if (sampled.error !== null || !probe || typeof probe !== 'object' || Array.isArray(probe)) {
    record.status = 'probe-invalid';
    record.error = sampled.error !== null ? `densityProbe 取样失败：${sampled.error}` : 'densityProbe 未返回对象';
    writeRun(run);
    console.warn(`[m5t10-density] ${label} probe invalid: ${record.error}`);
    return record;
  }
  writeEvidenceFile(run.root, `m5t10-probe-${label}.json`, probe, record);

  const facts = o.landing.facts;
  record.landing = facts;
  record.flags = o.landing.verified ? [] : (o.landing.reasons.length > 0 ? o.landing.reasons.slice() : ['landing-not-verified']);
  record.entry = facts
    ? { ...facts, getStatus: facts.hook.status, getUrl: facts.hook.url, getError: facts.hook.settled ? null : 'observer-not-settled' }
    : null;
  const entryDocId = facts ? facts.hook.docId : null;
  const documents = { entry: entryDocId, probe: sampled.docId, clock: null as string | null, style: null as string | null };
  record.documents = documents;
  // 取样与它的文档标识来自同一次页内执行；标识不等于入口那一份就不写样式件。
  const switched = (step: string, docId: string | null): string | null =>
    (entryDocId === null || docId === entryDocId ? null : `document-switched-${step}`);
  const failEntry = (flags: string[], detail: string): DensityCaptureRecord => {
    record.flags = flags;
    record.status = 'entry-not-verified';
    record.error = `${detail}（${flags.join('; ')}）`;
    writeRun(run);
    console.warn(`[m5t10-density] ${label} ${detail}; style capture skipped`);
    return record;
  };
  if (!o.landing.verified || !facts) {
    record.status = 'entry-not-verified';
    record.error = record.flags.join('; ') || 'landing-not-verified';
    writeRun(run);
    console.warn(`[m5t10-density] ${label} entry not verified; style capture skipped: ${record.error}`);
    return record;
  }
  const probeSwitch = switched('probe', sampled.docId);
  if (probeSwitch !== null) return failEntry([probeSwitch], 'probe 取样跨文档实例');

  let clock: DensityBrowserClock | null = null;
  try {
    const clockSample = await o.page.evaluate(readDensityClock);
    documents.clock = clockSample.docId;
    const clockSwitch = switched('clock', clockSample.docId);
    if (clockSwitch !== null) return failEntry([clockSwitch], '时钟取样跨文档实例');
    clock = clockSample.clock;
  } catch {
    clock = null;
  }
  record.timeZone = clock?.timeZone ?? null;

  let sample: DensityStyleSample;
  try {
    sample = await sampleDensityStyle(o.page);
    documents.style = sample.docId;
  } catch (error) {
    record.status = 'style-failed';
    record.error = `computed style 采集失败：${errorText(error)}`;
    writeRun(run);
    console.warn(`[m5t10-density] ${label} style failed: ${record.error}`);
    return record;
  }
  const style = sample.style;
  const styleSwitch = switched('style', sample.docId);
  if (styleSwitch !== null) return failEntry([styleSwitch], '样式取样跨文档实例');

  // 汇总几何前总核一次：probe、时钟、样式都必须出自入口那份文档实例。
  const sources: Array<[string, string | null]> = [
    ['probe', documents.probe], ['clock', documents.clock], ['style', documents.style]
  ];
  const offDocument = sources.filter(([, id]) => id !== entryDocId).map(([step]) => `document-switched-${step}`);
  if (offDocument.length > 0) return failEntry(offDocument, '取样来源不是同一文档实例');

  const response: DensityEntryResponse = { status: facts.hook.status, url: facts.hook.url, error: null };
  writeEvidenceFile(run.root, `m5t10-style-${label}.json`, style, record);
  const geometry = buildGeometry({ viewport: o.viewport, probe, style, entry: facts, clock, response, documents });
  writeEvidenceFile(run.root, `m5t10-geometry-${label}.json`, geometry, record);
  const geometryFlags = geometry.flags;
  record.flags = Array.isArray(geometryFlags) ? geometryFlags.map(String) : [];
  record.status = record.flags.length > 0 ? 'captured-with-flags' : 'captured';
  record.error = null;
  writeRun(run);
  return record;
}

/**
 * 收尾：默认从不覆盖已抛的测试错误（options.failing=true 时不抛），RUN 写入失败也只记
 * 采集错误；strict 的不完整失败只在没有原测试错误时抛出。
 */
export function finishDensityEvidence(run: DensityRun, options: { failing?: boolean } = {}): DensityRunSummary | null {
  run.finishedAt = new Date().toISOString();
  let summary: DensityRunSummary | null = null;
  let writeError: unknown = null;
  try {
    summary = writeRun(run);
  } catch (error) {
    writeError = error;
    console.warn(`[m5t10-density] RUN write failed: ${errorText(error)}`);
  }
  if (!summary) {
    if (options.failing) return null;
    throw writeError;
  }
  if (!summary.complete) {
    console.warn(`[m5t10-density] evidence incomplete: ${summary.missing.join(',') || 'no captured files'}`);
  } else if (!summary.clean) {
    console.warn(`[m5t10-density] evidence captured with flags: ${summary.problems.map((p) => p.viewport).join(',')}`);
  }
  if (process.env.M5T10_DENSITY_EVIDENCE_STRICT === '1' && !summary.complete && !options.failing) {
    throw new Error(`M5T10_DENSITY_EVIDENCE_INCOMPLETE ${JSON.stringify({ missing: summary.missing, problems: summary.problems })}`);
  }
  return summary;
}

function writeRun(run: DensityRun): DensityRunSummary {
  const complete = run.captures.every((c) => c.files.length === 3 &&
    (c.status === 'captured' || c.status === 'captured-with-flags'));
  const clean = complete && run.captures.every((c) => c.flags.length === 0);
  const summary: DensityRunSummary = {
    schema: 'm5t10-density-evidence/2',
    claim: '采集记录，不是验收结论；complete 仅表示三视口三份文件到位',
    complete,
    clean,
    missing: run.captures.filter((c) => c.status === 'pending').map((c) => c.viewport),
    problems: run.captures.filter((c) => c.status !== 'pending' && c.status !== 'captured' && c.status !== 'captured-with-flags')
      .map((c) => ({ viewport: c.viewport, status: c.status, error: c.error })),
    files: run.captures.flatMap((c) => c.files.map((f) => ({ viewport: c.viewport, ...f })))
  };
  const body = JSON.stringify({
    ...summary,
    runId: run.runId,
    runDir: run.runDir,
    uploadRoot: run.uploadRoot,
    offArtifact: run.offArtifact,
    observerToken: run.token,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    identity: run.identity,
    viewports: run.captures.map((c) => c.viewport),
    captures: run.captures
  }, null, 2) + '\n';
  writeAtomic(path.join(run.root, 'm5t10-RUN.json'), body);
  return summary;
}

function writeEvidenceFile(root: string, name: string, value: unknown, record: DensityCaptureRecord): void {
  const body = JSON.stringify(value, null, 2) + '\n';
  const buffer = Buffer.from(body, 'utf8');
  const target = path.join(root, name);
  writeAtomic(target, body, buffer);
  record.files.push({ name, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
}

/** 仅合成对照注入：默认直连 node:fs；可在一次收尾写入上制造失败而不动其它写入。 */
export const evidenceIo = {
  rename: (from: string, to: string): void => { renameSync(from, to); }
};

/** 先写同目录临时文件并核对长度，再以 rename 替换；失败时旧 RUN 保持原样。 */
function writeAtomic(target: string, body: string, buffer?: Buffer): void {
  const payload = buffer ?? Buffer.from(body, 'utf8');
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, payload);
  const size = statSync(tmp).size;
  if (size !== payload.length) {
    rmSync(tmp, { force: true });
    throw new Error(`M5T10_EVIDENCE_SIZE_MISMATCH ${path.basename(target)} ${size}!=${payload.length}`);
  }
  evidenceIo.rename(tmp, target);
}

function readEnvIdentity(): Record<string, string | null> {
  const keys = ['CI', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_WORKFLOW', 'GITHUB_REF'];
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = process.env[key] ?? null;
  return out;
}

function readGitIdentity(): Record<string, string | null> {
  return { head: gitValue(['rev-parse', 'HEAD']), tree: gitValue(['rev-parse', 'HEAD^{tree}']), parent: gitValue(['rev-parse', 'HEAD^']) };
}

function gitValue(args: string[]): string | null {
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}
