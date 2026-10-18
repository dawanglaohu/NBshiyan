// #331：询盘详情「操作历史」时间线。对接 GET /api/admin/inquiries/:id/history?limit=10&before=<cursor>（docs/API.md）。
// 这里只放纯逻辑（类型、参数、响应整理、状态机、文案），页面在 components/admin/InquiryHistory.tsx。

export type HistoryType = 'created' | 'status' | 'assignment' | 'reply' | 'inbound';
/**
 * 「谁做的」（#362 起后端返回）：customer 客户（actor = { name: 净化后的客户名, role: null }）、user 现有账号（{ name, role }）、
 * deleted_user 账号已删除（actor = null）、system 自动操作（actor = null）。
 */
export type ActorKind = 'customer' | 'user' | 'deleted_user' | 'system';
export const ACTOR_KINDS: readonly ActorKind[] = ['customer', 'user', 'deleted_user', 'system'];
export type HistoryActor = { name: string; role: string | null };
/**
 * 接口返回的一条记录：summary、actor.name 由后端拼好（中文、已净化、实体已解码成普通字符），前端只当 React 文本原样显示，
 * 不再解码、不走 innerHTML。actorKind 可选：#362 部署前的旧响应没有这个字段，按旧规则显示。
 */
export type HistoryItem = { type: HistoryType; at: string; actorKind?: ActorKind; actor: HistoryActor | null; summary: string; cursor: string };
export type HistoryPage = { items: HistoryItem[]; total: number };

/** 每页 10 条（接口默认 10、最多 50） */
export const HISTORY_PAGE_SIZE = 10;
export const HISTORY_MAX_LIMIT = 50;
/** 429 后「重试 / 加载更早记录」禁用多久（后端 Retry-After 固定 60 秒） */
export const HISTORY_RATE_MS = 60_000;

export const HISTORY_TEXT = {
  empty: '暂无记录',
  failed: '加载失败',
  retry: '重试',
  rateLimited: '操作太频繁，请稍等一分钟再试。',
  unauthorized: '登录已过期，请重新登录。',
  loadingMore: '加载中…',
  loadingLabel: '正在加载操作历史',
} as const;
export const loadMoreText = (left: number) => `加载更早记录（剩 ${left} 条）`;

/** 类型图标（aria-hidden，只是视觉提示；含义由 summary 说明） */
export const HISTORY_ICON: Record<HistoryType, string> = { created: '📝', status: '🔄', assignment: '👤', reply: '📤', inbound: '📥' };
export const ROLE_TEXT: Record<string, string> = { ADMIN: '管理员', SALES: '业务员', EDITOR: '编辑' };

export const ACTOR_TEXT = { customer: '客户', system: '系统', deletedUser: '已删除的账号' } as const;

const roleText = (role: string | null): string =>
  !role ? '' : Object.prototype.hasOwnProperty.call(ROLE_TEXT, role) ? ROLE_TEXT[role] : role;
const nameRole = (a: HistoryActor) => { const r = roleText(a.role); return r ? `${a.name} · ${r}` : a.name; };

/**
 * 操作人显示，只按 actorKind 决定（前端不自己拼名字）：
 * customer →「客户 · 客户名」；user →「姓名 · 角色」（role 为 null 只显示姓名）；deleted_user →「已删除的账号」（灰色）；system →「系统」。
 * 没有 actorKind（#362 之前的旧响应）或取值不认识 → 旧规则：来信「客户」，actor 为 null「系统」，否则「姓名 · 角色」。
 */
export function actorView(item: Pick<HistoryItem, 'type' | 'actor' | 'actorKind'>): { text: string; gone?: true } {
  switch (item.actorKind) {
    case 'customer': return { text: item.actor?.name ? `${ACTOR_TEXT.customer} · ${item.actor.name}` : ACTOR_TEXT.customer };
    case 'deleted_user': return { text: ACTOR_TEXT.deletedUser, gone: true };
    case 'system': return { text: ACTOR_TEXT.system };
    case 'user': if (item.actor) return { text: nameRole(item.actor) }; break;
  }
  if (item.type === 'inbound') return { text: ACTOR_TEXT.customer };
  if (!item.actor) return { text: ACTOR_TEXT.system };
  return { text: nameRole(item.actor) };
}
export const actorText = (item: Pick<HistoryItem, 'type' | 'actor' | 'actorKind'>): string => actorView(item).text;

/** 查询串：limit 夹在 1..50；before 为空时不带 */
export function historyQuery(o: { limit?: number; before?: string } = {}): string {
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(o.limit ?? HISTORY_PAGE_SIZE)));
  const p = new URLSearchParams({ limit: String(limit) });
  if (o.before) p.set('before', o.before);
  return p.toString();
}

const TYPES = new Set<string>(['created', 'status', 'assignment', 'reply', 'inbound']);
/** 整理响应：丢掉结构不对的条目（类型未知、缺字段），total 至少等于本页条数 */
export function historyPageFrom(raw: unknown): HistoryPage {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { items?: unknown; total?: unknown };
  const items = (Array.isArray(r.items) ? r.items : []).filter((x): x is HistoryItem => {
    const i = x as Partial<HistoryItem> | null;
    return !!i && typeof i.type === 'string' && TYPES.has(i.type) && typeof i.at === 'string' && typeof i.summary === 'string' && typeof i.cursor === 'string' && i.cursor.length > 0
      && (i.actor === null || i.actor === undefined || (typeof i.actor === 'object' && typeof i.actor.name === 'string'));
  }).map((i) => {
    // 只留认识的字段；actorKind 不认识就当没有（走旧规则），role 不是字符串一律 null
    const kind = typeof i.actorKind === 'string' && (ACTOR_KINDS as readonly string[]).includes(i.actorKind) ? i.actorKind : undefined;
    const actor = i.actor && typeof i.actor === 'object' ? { name: i.actor.name, role: typeof i.actor.role === 'string' && i.actor.role ? i.actor.role : null } : null;
    return { type: i.type, at: i.at, ...(kind ? { actorKind: kind } : {}), actor, summary: i.summary, cursor: i.cursor };
  });
  const total = typeof r.total === 'number' && Number.isFinite(r.total) ? Math.max(r.total, items.length) : items.length;
  return { items, total };
}

// —— 状态机 ——
export type HistoryState = {
  /** loading：第一页加载中（显示 3 行骨架）；ready：有数据或为空；error：第一页失败 */
  phase: 'loading' | 'ready' | 'error';
  items: HistoryItem[];
  total: number;
  /** 某一页返回不足一页 → 没有更早的了（防止 total 在翻页期间变化导致按钮一直在） */
  end: boolean;
  error?: string;
  more: 'idle' | 'loading' | 'error';
  moreError?: string;
  /** 429 之后到这个时间点之前禁用重试 / 加载更早 */
  rateUntil?: number;
};
export type HistoryAction =
  | { t: 'load' }
  | { t: 'loaded'; page: HistoryPage; limit?: number }
  | { t: 'failed'; code: string; now: number }
  | { t: 'moreLoad' }
  | { t: 'moreLoaded'; page: HistoryPage; limit?: number }
  | { t: 'moreFailed'; code: string; now: number }
  | { t: 'rateOver' };

export const initialHistory: HistoryState = { phase: 'loading', items: [], total: 0, end: false, more: 'idle' };
const isEnd = (page: HistoryPage, limit = HISTORY_PAGE_SIZE) => page.items.length < limit;

export function historyReducer(s: HistoryState, a: HistoryAction): HistoryState {
  switch (a.t) {
    // 刷新第一页（首次进入 / 回复、改状态、改分配之后）：已有数据时保留旧列表直到新数据回来，不闪骨架
    case 'load': return { ...s, phase: s.phase === 'ready' ? 'ready' : 'loading', error: undefined, more: 'idle', moreError: undefined };
    case 'loaded': return { ...s, phase: 'ready', items: a.page.items, total: a.page.total, end: isEnd(a.page, a.limit), error: undefined, more: 'idle', moreError: undefined };
    case 'failed': return { ...s, phase: 'error', items: [], total: 0, end: false, error: a.code, more: 'idle', moreError: undefined, rateUntil: a.code === 'rate_limited' ? a.now + HISTORY_RATE_MS : s.rateUntil };
    case 'moreLoad': return { ...s, more: 'loading', moreError: undefined };
    case 'moreLoaded': {
      const seen = new Set(s.items.map((i) => i.cursor));
      const items = [...s.items, ...a.page.items.filter((i) => !seen.has(i.cursor))];
      return { ...s, items, total: Math.max(a.page.total, items.length), end: isEnd(a.page, a.limit), more: 'idle', moreError: undefined };
    }
    case 'moreFailed': return { ...s, more: 'error', moreError: a.code, rateUntil: a.code === 'rate_limited' ? a.now + HISTORY_RATE_MS : s.rateUntil };
    case 'rateOver': return { ...s, rateUntil: undefined };
  }
}

/** 还剩多少条更早的记录 */
export const remaining = (s: Pick<HistoryState, 'total' | 'items' | 'end'>) => (s.end ? 0 : Math.max(0, s.total - s.items.length));
/** 下一页的 before：当前最后一条的 cursor */
export const nextCursor = (s: Pick<HistoryState, 'items'>) => s.items.at(-1)?.cursor;
export const rateLimited = (s: Pick<HistoryState, 'rateUntil'>, now: number) => !!s.rateUntil && now < s.rateUntil;
/** 失败文案：429 → 「操作太频繁…」（重试禁用），401 → 登录过期，其他 → 「加载失败」 */
export function historyErrorText(code: string | undefined): string {
  if (code === 'rate_limited') return `${HISTORY_TEXT.failed}：${HISTORY_TEXT.rateLimited}`;
  if (code === 'unauthorized') return `${HISTORY_TEXT.failed}：${HISTORY_TEXT.unauthorized}`;
  return HISTORY_TEXT.failed;
}
