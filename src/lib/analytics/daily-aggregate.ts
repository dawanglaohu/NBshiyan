/**
 * M5-T12 日聚合纯函数：冒烟谓词、终态分区、站点/产品无身份指标。
 * 不读 DB、不碰时钟；输入为某站点日已选事实，输出只含计数与精确耗时总和。
 */

export type AnalyticsFactKind =
  | 'page_view'
  | 'product_view'
  | 'model_view_start'
  | 'model_load_success'
  | 'model_load_failure'
  | 'chat_start';

export type AnalyticsFact = {
  eventId: string;
  kind: AnalyticsFactKind;
  browserHash: string;
  viewId: string | null;
  occurredAt: Date;
  durationMs: number | null;
  locale: string | null;
  productSlug: string | null;
  path: string | null;
};

export type DailyMetrics = {
  dimension: string;
  visitors: number;
  pageViews: number | null;
  productViews: number;
  modelStarts: number;
  modelSuccesses: number;
  modelFailures: number;
  chatStarts: number;
  durationMsSum: bigint;
  loadDurationSamples: number;
};

const INCLUDED_KINDS: ReadonlySet<AnalyticsFactKind> = new Set([
  'page_view',
  'product_view',
  'model_view_start',
  'model_load_success',
  'model_load_failure',
  'chat_start',
]);

/** 去 query/fragment（09/10：同一条冒烟谓词在 SQL 与应用层一致）。 */
export function normalizePath(path: string | null): string | null {
  if (path === null) return null;
  const cut = Math.min(...[path.indexOf('?'), path.indexOf('#')].filter((i) => i >= 0).concat(Number.POSITIVE_INFINITY));
  return Number.isFinite(cut) ? path.slice(0, cut) : path.slice(0, path.length);
}

/**
 * 冒烟路径：整条路径或任一路径段以 `nbs-smoke-` 开头才排除；NULL 放行；
 * 段中间出现 `nbs-smoke-` 不算（对齐 SQL 的 `NOT LIKE 'nbs-smoke-%'` 与 `NOT LIKE '%/nbs-smoke-%'`）。
 */
export function isSmokePath(path: string | null): boolean {
  const normalized = normalizePath(path);
  if (normalized === null) return false;
  return normalized.split('/').some((segment) => segment.startsWith('nbs-smoke-'));
}

export function isIncludedFact(fact: AnalyticsFact): boolean {
  return INCLUDED_KINDS.has(fact.kind) && !isSmokePath(fact.path);
}

export function factKey(fact: Pick<AnalyticsFact, 'browserHash' | 'viewId'>): string | null {
  return fact.viewId === null ? null : `${fact.browserHash}\u0000${fact.viewId}`;
}

export type TerminalPartition = {
  counted: AnalyticsFact[];
  deferred: AnalyticsFact[];
};

/**
 * 终态按 `occurredAt <= notAfter` 分区：计入本日，晚于 notAfter 的并入最早 defer。
 * 终态本身不按自身发生日过滤（由调用方按 start 的站点日归属）。
 */
export function partitionTerminals(terminals: AnalyticsFact[], notAfter: Date): TerminalPartition {
  const counted: AnalyticsFact[] = [];
  const deferred: AnalyticsFact[] = [];
  for (const terminal of terminals) {
    if (terminal.occurredAt.getTime() <= notAfter.getTime()) counted.push(terminal);
    else deferred.push(terminal);
  }
  return { counted, deferred };
}

/** 同键最多一个终态：按 occurredAt 取最早（同刻按 eventId 稳定排序）。 */
export function pickTerminalPerStart(terminals: AnalyticsFact[]): Map<string, AnalyticsFact> {
  const picked = new Map<string, AnalyticsFact>();
  for (const terminal of terminals) {
    const key = factKey(terminal);
    if (key === null) continue;
    const current = picked.get(key);
    if (
      current === undefined ||
      terminal.occurredAt.getTime() < current.occurredAt.getTime() ||
      (terminal.occurredAt.getTime() === current.occurredAt.getTime() && terminal.eventId < current.eventId)
    ) {
      picked.set(key, terminal);
    }
  }
  return picked;
}

function countDistinct(values: Iterable<string>): number {
  return new Set(values).size;
}

export type ComputeOptions = {
  localDate: string;
  notAfter: Date;
  /** `/<locale>/products/<seg>` → 内部产品 slug；不提供时产品维度只按事实自带 `productSlug` 归属。 */
  resolveProductSlugFromPath?: (normalizedPath: string) => string | null;
};

export type ComputeResult = {
  site: DailyMetrics;
  products: Map<string, DailyMetrics>;
  /** 无真实 start 可归属的终态，供 aggregate 侧写 `late_unattributable` gap。 */
  unattributableTerminals: AnalyticsFact[];
};

/**
 * 计算站点与产品日指标。输入事实必须是“本站点日、已过冒烟与事件窗口过滤”的集合；
 * `terminals` 为与这些 start 同键的候选终态（调用方已完成 Q2/Q3 读取）。
 * 站点 UV = 当日计入事实的 distinct browserHash；产品 UV 单独 distinct，不可累加。
 */
export function computeDailyMetrics(
  facts: AnalyticsFact[],
  terminals: AnalyticsFact[],
  options: ComputeOptions,
): ComputeResult {
  const included = facts.filter(isIncludedFact);
  const countedTerminals = partitionTerminals(terminals.filter(isIncludedFact), options.notAfter).counted;
  const terminalByKey = pickTerminalPerStart(countedTerminals);

  const siteVisitors = countDistinct(included.map((fact) => fact.browserHash));
  const pageViews = included.filter((fact) => fact.kind === 'page_view').length;
  const productViews = included.filter((fact) => fact.kind === 'product_view').length;
  const modelStarts = included.filter((fact) => fact.kind === 'model_view_start').length;
  const chatStarts = included.filter((fact) => fact.kind === 'chat_start').length;

  const terminalStats = (startFacts: AnalyticsFact[]) => {
    let successes = 0;
    let failures = 0;
    let durationMsSum = 0n;
    let samples = 0;
    for (const start of startFacts) {
      const key = factKey(start);
      if (key === null) continue;
      const terminal = terminalByKey.get(key);
      if (terminal === undefined) continue;
      if (terminal.kind === 'model_load_success') successes += 1;
      if (terminal.kind === 'model_load_failure') failures += 1;
      if (terminal.durationMs !== null && Number.isFinite(terminal.durationMs) && terminal.durationMs >= 0) {
        durationMsSum += BigInt(Math.trunc(terminal.durationMs));
        samples += 1;
      }
    }
    return { successes, failures, durationMsSum, samples };
  };

  const startFacts = included.filter((fact) => fact.kind === 'model_view_start');
  const siteTerminal = terminalStats(startFacts);
  const site: DailyMetrics = {
    dimension: 'site',
    visitors: siteVisitors,
    pageViews,
    productViews,
    modelStarts,
    modelSuccesses: siteTerminal.successes,
    modelFailures: siteTerminal.failures,
    chatStarts,
    durationMsSum: siteTerminal.durationMsSum,
    loadDurationSamples: siteTerminal.samples,
  };

  const resolveSlug = (fact: AnalyticsFact): string | null => {
    if (fact.productSlug !== null && fact.productSlug !== '') return fact.productSlug;
    if (options.resolveProductSlugFromPath === undefined) return null;
    const normalized = normalizePath(fact.path);
    return normalized === null ? null : options.resolveProductSlugFromPath(normalized);
  };

  const byProduct = new Map<string, AnalyticsFact[]>();
  for (const fact of included) {
    const slug = resolveSlug(fact);
    if (slug === null) continue;
    const bucket = byProduct.get(slug);
    if (bucket === undefined) byProduct.set(slug, [fact]);
    else bucket.push(fact);
  }

  const products = new Map<string, DailyMetrics>();
  for (const [slug, productFacts] of byProduct) {
    const productStartFacts = productFacts.filter((fact) => fact.kind === 'model_view_start');
    const productTerminal = terminalStats(productStartFacts);
    products.set(slug, {
      dimension: `product:${slug}`,
      visitors: countDistinct(productFacts.map((fact) => fact.browserHash)),
      pageViews: null,
      productViews: productFacts.filter((fact) => fact.kind === 'product_view').length,
      modelStarts: productStartFacts.length,
      modelSuccesses: productTerminal.successes,
      modelFailures: productTerminal.failures,
      chatStarts: productFacts.filter((fact) => fact.kind === 'chat_start').length,
      durationMsSum: productTerminal.durationMsSum,
      loadDurationSamples: productTerminal.samples,
    });
  }

  const unattributable = countedTerminals.filter((terminal) => {
    const key = factKey(terminal);
    return key === null || !included.some((fact) => fact.kind === 'model_view_start' && factKey(fact) === key);
  });

  return { site, products, unattributableTerminals: unattributable };
}

/** 均值读侧加权：Σ durationMsSum / Σ loadDurationSamples；samples=0 → null。 */
export function meanDurationMs(sum: bigint, samples: number): number | null {
  if (samples <= 0) return null;
  return Number(sum) / samples;
}

/** 成功率分母只取 modelStarts；有分母且 successes=0 → 0%；无分母 → null。 */
export function successRate(starts: number, successes: number): number | null {
  if (starts <= 0) return null;
  return successes / starts;
}
