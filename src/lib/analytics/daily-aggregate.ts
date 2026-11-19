/**
 * M5-T12 日聚合纯函数：冒烟谓词、终态分区、站点/产品无身份指标、UTC 日映射与完整性分类。
 *
 * 语义逐条对齐 r5r3 模型（`testing-anon-aggregate-design-r5r3-model-20261109.py`）：
 * - `compute_metrics`（L391-473）：站点 UV 取当日计入事实的 distinct browserHash；
 *   产品 UV 只取 `product_view`、`model_view_start`、路径命中该产品的 `page_view`
 *   三类来源，终态不作 UV 来源；successes/failures/duration 只来自配对终态，按 eventId 去重。
 * - `q1`：站点日界在 SQL 与纯函数两侧同一条谓词，`occurredAt > notAfter` 的事实并入 defer。
 * - `utc_dates_covered` / `m6`（L817-847）：UTC 日映射与四条件分类。
 *
 * 不读 DB、不碰时钟；输入为某站点日已按快照选题的事实集合。
 */

export type AnalyticsFactKind =
  | 'page_view'
  | 'product_view'
  | 'model_view_start'
  | 'model_load_success'
  | 'model_load_failure'
  | 'chat_start';

export type TerminalFactKind = 'model_load_success' | 'model_load_failure';

export type AnalyticsFact = {
  eventId: string;
  kind: AnalyticsFactKind;
  browserHash: string;
  viewId: string | null;
  occurredAt: Date;
  receivedAt: Date;
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
  /** 本日计入事实与配对终态里最晚的 receivedAt；无事实为 null。 */
  sourceThrough: Date | null;
};

const INCLUDED_KINDS: ReadonlySet<AnalyticsFactKind> = new Set([
  'page_view',
  'product_view',
  'model_view_start',
  'model_load_success',
  'model_load_failure',
  'chat_start',
]);

const TERMINAL_KINDS: ReadonlySet<AnalyticsFactKind> = new Set([
  'model_load_success',
  'model_load_failure',
]);

export function isTerminalKind(kind: AnalyticsFactKind): kind is TerminalFactKind {
  return TERMINAL_KINDS.has(kind);
}

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

/** 配对终态按 eventId 去重（同一终态事件在 Q3 里只应出现一次；不按 viewId 再折叠）。 */
export function dedupeTerminalsByEventId(terminals: AnalyticsFact[]): AnalyticsFact[] {
  const seen = new Set<string>();
  const out: AnalyticsFact[] = [];
  for (const terminal of terminals) {
    if (seen.has(terminal.eventId)) continue;
    seen.add(terminal.eventId);
    out.push(terminal);
  }
  return out;
}

function countDistinct(values: Iterable<string>): number {
  return new Set(values).size;
}

export type ComputeOptions = {
  localDate: string;
  notAfter: Date;
  /** `/<locale>/products/<seg>` → 内部产品 slug；不提供时页面路径不补产品 UV 来源。 */
  resolveProductSlugFromPath?: (normalizedPath: string, locale: string) => string | null;
};

export type ComputeResult = {
  site: DailyMetrics;
  products: Map<string, DailyMetrics>;
  /**
   * 本日窗口内（Q1 计入集合）、却找不到本日 start 的终态：
   * 调用方据此做 Q2 闭包、Q5 可见倒置探测或 `late_unattributable` gap。
   */
  unattributableInDayTerminals: AnalyticsFact[];
};

/**
 * 计算站点与产品日指标。输入事实必须是「本站点日、已过冒烟与事件窗口过滤」的集合
 * （Q1 计入部分）；`terminals` 为这些 start 的候选终态（Q3，含 occurredAt 晚于 notAfter 的）。
 * 站点 UV = 当日计入事实（含终态）的 distinct browserHash；产品 UV 单独 distinct，不可累加。
 */
export function computeDailyMetrics(
  facts: AnalyticsFact[],
  terminals: AnalyticsFact[],
  options: ComputeOptions,
): ComputeResult {
  const included = facts.filter(isIncludedFact);
  const countedTerminals = dedupeTerminalsByEventId(
    partitionTerminals(terminals.filter(isIncludedFact), options.notAfter).counted,
  );

  const startByKey = new Map<string, AnalyticsFact>();
  for (const fact of included) {
    if (fact.kind !== 'model_view_start') continue;
    const key = factKey(fact);
    if (key !== null && !startByKey.has(key)) startByKey.set(key, fact);
  }

  const siteVisitors = countDistinct(included.map((fact) => fact.browserHash));

  const terminalStats = (selected: AnalyticsFact[]) => {
    let successes = 0;
    let failures = 0;
    let durationMsSum = 0n;
    let samples = 0;
    for (const terminal of selected) {
      if (terminal.kind === 'model_load_success') successes += 1;
      if (terminal.kind === 'model_load_failure') failures += 1;
      if (terminal.durationMs !== null && Number.isFinite(terminal.durationMs) && terminal.durationMs >= 0) {
        durationMsSum += BigInt(Math.trunc(terminal.durationMs));
        samples += 1;
      }
    }
    return { successes, failures, durationMsSum, samples };
  };

  const siteTerminal = terminalStats(countedTerminals);
  const sourceThrough = latestReceivedAt([...included, ...countedTerminals]);
  const site: DailyMetrics = {
    dimension: 'site',
    visitors: siteVisitors,
    pageViews: included.filter((fact) => fact.kind === 'page_view').length,
    productViews: included.filter((fact) => fact.kind === 'product_view').length,
    modelStarts: included.filter((fact) => fact.kind === 'model_view_start').length,
    modelSuccesses: siteTerminal.successes,
    modelFailures: siteTerminal.failures,
    chatStarts: included.filter((fact) => fact.kind === 'chat_start').length,
    durationMsSum: siteTerminal.durationMsSum,
    loadDurationSamples: siteTerminal.samples,
    sourceThrough,
  };

  type ProductBucket = {
    productViews: number;
    modelStarts: number;
    chatStarts: number;
    visitors: Set<string>;
    successes: number;
    failures: number;
    durationMsSum: bigint;
    samples: number;
  };
  const buckets = new Map<string, ProductBucket>();
  const bucket = (slug: string): ProductBucket => {
    let current = buckets.get(slug);
    if (current === undefined) {
      current = {
        productViews: 0,
        modelStarts: 0,
        chatStarts: 0,
        visitors: new Set<string>(),
        successes: 0,
        failures: 0,
        durationMsSum: 0n,
        samples: 0,
      };
      buckets.set(slug, current);
    }
    return current;
  };
  const slugOf = (value: string | null): string | null => (value !== null && value !== '' ? value : null);

  // 产品 UV 来源只有三类：product_view、model_view_start、路径命中该产品的 page_view。
  for (const fact of included) {
    if (fact.kind === 'product_view') {
      const slug = slugOf(fact.productSlug);
      if (slug === null) continue;
      const row = bucket(slug);
      row.productViews += 1;
      row.visitors.add(fact.browserHash);
      continue;
    }
    if (fact.kind === 'model_view_start') {
      const slug = slugOf(fact.productSlug);
      if (slug === null) continue;
      const row = bucket(slug);
      row.modelStarts += 1;
      row.visitors.add(fact.browserHash);
      continue;
    }
    if (fact.kind === 'page_view') {
      if (options.resolveProductSlugFromPath === undefined) continue;
      const normalized = normalizePath(fact.path);
      if (normalized === null) continue;
      const slug = options.resolveProductSlugFromPath(normalized, fact.locale ?? 'en');
      if (slug === null) continue;
      bucket(slug).visitors.add(fact.browserHash);
      continue;
    }
    if (fact.kind === 'chat_start') {
      const slug = slugOf(fact.productSlug);
      if (slug === null) continue;
      bucket(slug).chatStarts += 1;
    }
  }

  // 终态只经 start 归属，不作 UV 来源；缺 start 的终态用自身 productSlug 建行。
  for (const terminal of countedTerminals) {
    const key = factKey(terminal);
    const start = key === null ? undefined : startByKey.get(key);
    const slug = slugOf(start?.productSlug ?? terminal.productSlug);
    if (slug === null) continue;
    const row = bucket(slug);
    if (terminal.kind === 'model_load_success') row.successes += 1;
    if (terminal.kind === 'model_load_failure') row.failures += 1;
    if (terminal.durationMs !== null && Number.isFinite(terminal.durationMs) && terminal.durationMs >= 0) {
      row.durationMsSum += BigInt(Math.trunc(terminal.durationMs));
      row.samples += 1;
    }
  }

  const products = new Map<string, DailyMetrics>();
  for (const [slug, row] of buckets) {
    products.set(slug, {
      dimension: `product:${slug}`,
      visitors: row.visitors.size,
      pageViews: null,
      productViews: row.productViews,
      modelStarts: row.modelStarts,
      modelSuccesses: row.successes,
      modelFailures: row.failures,
      chatStarts: row.chatStarts,
      durationMsSum: row.durationMsSum,
      loadDurationSamples: row.samples,
      sourceThrough,
    });
  }

  const unattributableInDayTerminals = included.filter((fact) => {
    if (!isTerminalKind(fact.kind)) return false;
    const key = factKey(fact);
    return key === null || !startByKey.has(key);
  });

  return { site, products, unattributableInDayTerminals };
}

function latestReceivedAt(facts: AnalyticsFact[]): Date | null {
  let latest: Date | null = null;
  for (const fact of facts) {
    const at = fact.receivedAt.getTime();
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest.getTime()) latest = fact.receivedAt;
  }
  return latest;
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

/* ------------------------------------------------------------------------- *
 * UTC 日映射与 M6 完整性分类（设计 §8）
 * ------------------------------------------------------------------------- */

/**
 * 站点日 `[startUtc, endUtc)` 覆盖到的 UTC 自然日（含首尾被跨到的日）。
 * M6 用它把站点日映射成 `AnalyticsDayChange` 的键；必须用**该 revision 行内时区**
 * 算出的边界，不能用当前站点设置的时区（R1）。
 */
export function utcDatesCovered(bounds: { startUtc: string; endUtc: string }): string[] {
  const start = Date.parse(bounds.startUtc);
  const end = Date.parse(bounds.endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: string[] = [];
  let cursor = start;
  while (cursor < end) {
    const iso = new Date(cursor).toISOString().slice(0, 10);
    if (out[out.length - 1] !== iso) out.push(iso);
    cursor = Date.parse(`${iso}T00:00:00.000Z`) + 86_400_000;
  }
  return out;
}

export type DayCompletenessInput = {
  /** 该 revision 的 site 行；null 表示当日无数据。只用到行内 `timezone`。 */
  siteRow: { timezone: string } | null;
  /** 同日 day-state；null 走 `state_missing`（防御路径，不崩、不假 complete）。 */
  state: { markerVersions: Record<string, string>; deferUntil: Date | null; gapKind: string | null } | null;
  /** 该站点日 `[startUtc,endUtc)` 的边界；由 site 行的时区算出。 */
  bounds: { startUtc: string; endUtc: string } | null;
  /** `AnalyticsDayChange` 现值：utcDate → version（十进制字符串或 number）。 */
  liveVersions: ReadonlyMap<string, string | number>;
};

export type DayCompleteness = {
  status: 'no_data' | 'partial' | 'complete';
  reason:
    | 'no_site_row'
    | 'state_missing'
    | `gap:${string}`
    | 'defer_pending'
    | 'live_marker_ahead'
    | 'site_row_no_gap_no_defer_marker_equal';
  /** 触发 `live_marker_ahead` 的 UTC 日；其它情况为 null。 */
  utcDate: string | null;
  /** 十进制字符串（BigInt 规范化），缺键为 `'0'`。 */
  live: string | null;
  consumed: string | null;
};

/** 设计 §8 的分类顺序：无 site 行 → 无 state → gap → defer → marker 全等。 */
export function classifyDayCompleteness(input: DayCompletenessInput): DayCompleteness {
  if (input.siteRow === null) {
    return {
      status: 'no_data',
      reason: 'no_site_row',
      utcDate: null,
      live: null,
      consumed: null,
    };
  }
  if (input.state === null) {
    return { status: 'partial', reason: 'state_missing', utcDate: null, live: null, consumed: null };
  }
  if (input.state.gapKind !== null && input.state.gapKind !== '') {
    return {
      status: 'partial',
      reason: `gap:${input.state.gapKind}`,
      utcDate: null,
      live: null,
      consumed: null,
    };
  }
  if (input.state.deferUntil !== null) {
    return { status: 'partial', reason: 'defer_pending', utcDate: null, live: null, consumed: null };
  }
  const mapped = input.bounds === null ? [] : utcDatesCovered(input.bounds);
  for (const utcDate of mapped) {
    const live = toVersion(input.liveVersions.get(utcDate));
    const consumed = toVersion(input.state.markerVersions[utcDate]);
    if (live !== consumed) {
      return {
        status: 'partial',
        reason: 'live_marker_ahead',
        utcDate,
        live,
        consumed,
      };
    }
  }
  return {
    status: 'complete',
    reason: 'site_row_no_gap_no_defer_marker_equal',
    utcDate: null,
    live: null,
    consumed: null,
  };
}

/** 缺键按 0 比；十进制字符串规范化（BigInt 语义，超过 2^53 也不丢精度）。 */
export function toVersion(value: string | number | undefined): string {
  if (value === undefined) return '0';
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)).toString() : '0';
  try {
    const parsed = BigInt(value);
    return parsed < BigInt(0) ? '0' : parsed.toString();
  } catch {
    return '0';
  }
}
