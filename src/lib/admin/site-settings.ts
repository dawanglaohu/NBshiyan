/**
 * #350 后台「站点设置 · 公司介绍」的数据形状、纯逻辑和接口层（UX spec v1.0 §3；稿件 settings-*）。
 * 页面只依赖这里导出的东西；文案集中在 SETTINGS_TEXT，方便 UX 对稿。
 */
import { isAllowedAboutHref, plainText, type AboutStat } from '@/lib/about/model';
import { ABOUT_LIMITS, aboutBodyText, countChars, isAboutContentComplete } from '@/lib/site-settings/about-rules';
import { errorText } from '@/components/admin/format';

/** 每个语言一份草稿（about.<locale> JSON 的可编辑部分）。图片列表等 PublicAsset PR，本 PR 不做 */
export type AboutDraft = {
  title: string;
  summary: string;
  bodyHtml: string;
  stats: AboutStat[];
  homeHeading: string;
  homeIntro: string;
  version: number | null;
  /** 图片说明（后端 imageMeta）：本 PR 不编辑，但 PUT 是整份替换，读回来的值要原样带回去，不能被清空 */
  imageMeta?: Record<string, { alt: string; caption: string }>;
  updatedAt: string | null;
  updatedByName: string | null;
};
/** enabledVersion：开关的版本号（about.enabled 的 version），切换时作为 expectedVersion 发回，不一致 409 */
export type AboutSettingsData = { enabled: boolean; enabledVersion: number | null; locales: Record<string, AboutDraft> };
export type DraftField = 'title' | 'summary' | 'bodyHtml' | 'stats' | 'homeHeading' | 'homeIntro';

export const emptyDraft = (): AboutDraft => ({ title: '', summary: '', bodyHtml: '', stats: [], homeHeading: '', homeIntro: '', version: null, updatedAt: null, updatedByName: null });

export const FIELD_LABEL: Record<DraftField, string> = { title: '标题', summary: '摘要', bodyHtml: '正文', stats: '数据条', homeHeading: '区块标题', homeIntro: '首页简介' };

/** 固定文案（与稿件逐字一致；{x} 是占位） */
export const SETTINGS_TEXT = {
  crumb: '站点设置 / 关于我们', // spec §9：面包屑跟分区名「关于我们」/「组织信息」
  h1: '公司介绍（/about 页）',
  lastEdited: '最近修改：',
  preview: '查看前台已发布页 ↗', // UX 定稿：只打开已发布的前台页（没有草稿预览）
  unpublished: '尚未发布，前台不可见',
  visibility: '前台显示',
  visibilityOn: (ls: string[]) => `已开启 · 只显示内容完整的语言（当前：${ls.length ? ls.map((l) => l.toUpperCase()).join('、') : '无'}）。关闭后 /about 全部返回 404，导航、页脚入口和 sitemap 一起移除。`,
  visibilityOff: '已关闭 · /about 返回 404，导航、页脚入口和 sitemap 都不显示。已填写的内容会保留。',
  titleHint: '显示为页面 H1，也作为默认 meta 标题。',
  summaryLabel: '摘要（选填，用于搜索结果描述）',
  bodyHint: '粘贴时自动去掉颜色、字号、图片和表格；只保留标题（H2/H3）、加粗、斜体、链接、列表。保存时服务端用 sanitizeAboutHtml 净化。',
  statsLabel: '数据条（选填）',
  statValue: '数值 ≤12 字',
  statLabel: '说明 ≤40 字',
  statAdd: '＋ 添加一条',
  statHint: '请只填可核实的数据。0 条时前台不显示数据条。',
  statPairError: '数值和说明都要填写',
  homeTitle: (l: string) => `首页「公司实力」区块 · ${l.toUpperCase()}`,
  homeHint: '显示在首页首屏下方。数据条和图片列表与 /about 共用（首页只取前 4 张图）；按钮固定链接到 /about。标题或简介为空时，该语言首页不显示此区块。',
  homeHeading: '区块标题',
  homeIntro: '首页简介（纯文本）',
  checklist: (l: string) => `${l.toUpperCase()} 完整度`,
  checkTitle: '标题',
  checkBody: '正文（≥ 50 字）',
  checkStats: (n: number) => `数据条（选填）· ${n} 条`,
  checkHome: '首页区块标题 + 简介',
  bodyShort: (min: number) => `正文不到 ${min} 字，这个语言的 /about 前台不会显示（可以先保存草稿）。`,
  localeStatus: '各语言前台状态',
  shown: '显示',
  hidden: (why: string) => `隐藏 · ${why}`,
  newLocalesNote: '新语言（ja / hi / es / de / fr / ar）上线后自动出现在标签里，未填写前不显示。',
  dirty: '有未保存的修改',
  discard: '放弃修改',
  save: '保存',
  saving: '保存中…',
  saved: (ls: string[]) => `✓ 已保存 ${ls.map((l) => l.toUpperCase()).join('、')}。前台约 1 分钟内生效。`,
  // 409 version_conflict（PM 定稿）：保存和开关共用同一条提示 + 「刷新」按钮；点刷新先确认「未保存的修改将丢弃」
  conflict: '内容已被他人修改，请刷新后重新编辑',
  conflictRefresh: '刷新',
  conflictConfirmTitle: '未保存的修改将丢弃',
  conflictConfirmOk: '丢弃并刷新',
  // UX #373 P3-2：冲突期间保存栏的说明（稿件 settings-conflict）和禁用「保存」的 title
  conflictBar: '内容冲突，刷新后才能保存',
  conflictSaveTitle: '内容冲突，请先刷新',
  leave: '有未保存的修改，确定离开？',
  linkLabel: '链接地址',
  linkOk: '确定',
  linkCancel: '取消',
  linkError: '仅支持 https://、mailto: 或站内路径 /…',
  offTitle: '关闭前台显示？',
  offLead: '关闭后立即生效：',
  off404: '返回 404',
  offNav: '导航和页脚的「About」入口隐藏',
  offSitemap: '从 sitemap 移除',
  offKeep: '已填写的内容会保留，随时可以重新开启。',
  offConfirm: '关闭显示',
  onTitle: '开启前台显示？',
  onShown: '将会显示：',
  onHidden: '没填完、不会显示：',
  onConfirm: '开启显示',
  cancel: '取消',
  unsavedNotPublished: '未保存的修改不会一起发布。',
} as const;

/**
 * 标签上的圆点（spec §3）：绿=完整（前台显示），黄=有内容但不完整，灰=未填写。
 * 「完整」直接调用后端的 isAboutContentComplete（about-rules.ts，纯函数），不另写规则；按「已保存」的内容判断。
 */
export type Completeness = { state: 'complete' | 'partial' | 'empty'; label: string };
/**
 * 缺什么（UX #373 验收 P2-2：标签上写清楚「缺标题」「缺正文」，不只写「内容不完整」）。
 * 规则和 isAboutContentComplete 一致：标题 2–80 字、正文纯文本 50–6000 字。
 */
export function missingParts(d: Pick<AboutDraft, 'title' | 'bodyHtml'>): ('title' | 'body')[] {
  const out: ('title' | 'body')[] = [];
  const t = countChars(d.title.trim());
  if (t < ABOUT_LIMITS.titleMin || t > ABOUT_LIMITS.titleMax) out.push('title');
  const b = countChars(aboutBodyText(d.bodyHtml));
  if (b < ABOUT_LIMITS.bodyTextMin || b > ABOUT_LIMITS.bodyTextMax) out.push('body');
  return out;
}
const MISSING_LABEL = { title: '标题', body: '正文' } as const;
export function draftCompleteness(d: AboutDraft): Completeness {
  const empty = !d.title.trim() && !plainText(d.bodyHtml) && !d.summary.trim() && d.stats.length === 0 && !d.homeHeading.trim() && !d.homeIntro.trim();
  if (empty) return { state: 'empty', label: '未填写' };
  if (isAboutContentComplete({ title: d.title, bodyHtml: d.bodyHtml, images: [] })) return { state: 'complete', label: '完整' };
  const miss = missingParts(d);
  return { state: 'partial', label: miss.length ? `缺${miss.map((m) => MISSING_LABEL[m]).join('、')}` : '内容不完整' };
}

/**
 * 右栏「<语言> 完整度」清单（稿件 settings-desktop 的 .ss-chk）：按当前草稿实时算。
 * state：ok ✓ / missing !（必填没满足）/ optional –（选填）。图片替代文字一项见 about-images.ts 的 imageAltChecklistItem。
 */
export type ChecklistItem = { key: 'title' | 'body' | 'stats' | 'home'; label: string; state: 'ok' | 'missing' | 'optional' };
export function draftChecklist(d: AboutDraft): ChecklistItem[] {
  const miss = missingParts(d);
  const homeOk = !!d.homeHeading.trim() && !!d.homeIntro.trim();
  return [
    { key: 'title', label: SETTINGS_TEXT.checkTitle, state: miss.includes('title') ? 'missing' : 'ok' },
    { key: 'body', label: SETTINGS_TEXT.checkBody, state: miss.includes('body') ? 'missing' : 'ok' },
    { key: 'stats', label: SETTINGS_TEXT.checkStats(d.stats.length), state: 'optional' },
    { key: 'home', label: SETTINGS_TEXT.checkHome, state: homeOk ? 'ok' : 'optional' },
  ];
}
/** 正文有字但不到 50 字：不阻止保存，但字段下方说明该语言前台不会显示 */
export function bodyTooShortNote(d: AboutDraft): string | null {
  const n = countChars(aboutBodyText(d.bodyHtml));
  return n > 0 && n < ABOUT_LIMITS.bodyTextMin ? SETTINGS_TEXT.bodyShort(ABOUT_LIMITS.bodyTextMin) : null;
}

/**
 * 字段的计数和上限：上限、计数方法都来自后端 about-rules.ts（ABOUT_LIMITS、countChars 按 code point、正文用 aboutBodyText 转纯文本）。
 * min 只用于提示（标题 ≥2、正文 ≥50 是「完整」规则，决定前台是否显示），保存草稿时后端只卡上限（外加「标题非空时 ≥2 字」）。
 */
export function fieldCount(field: Exclude<DraftField, 'stats'>, d: AboutDraft): { n: number; max: number; min?: number } {
  switch (field) {
    case 'title': return { n: countChars(d.title.trim()), max: ABOUT_LIMITS.titleMax, min: ABOUT_LIMITS.titleMin };
    case 'summary': return { n: countChars(d.summary.trim()), max: ABOUT_LIMITS.summaryMax };
    case 'bodyHtml': return { n: countChars(aboutBodyText(d.bodyHtml)), max: ABOUT_LIMITS.bodyTextMax, min: ABOUT_LIMITS.bodyTextMin };
    case 'homeHeading': return { n: countChars(d.homeHeading.trim()), max: ABOUT_LIMITS.homeTitleMax };
    case 'homeIntro': return { n: countChars(d.homeIntro.trim()), max: ABOUT_LIMITS.homeIntroMax };
  }
}

/**
 * 阻止保存的校验错误（= 后端 PUT 会 400 的情况）：超上限、正文 HTML 超 30 KB、数据条只填了一半或超长、
 * 标题非空但不到 2 字（后端 normalizeAboutInput 的 too_short）。
 * 标题为空、正文不到 50 字不阻止保存（允许先存草稿），只让该语言前台不显示（完整度圆点会提示）。
 */
export function draftErrors(d: AboutDraft): Partial<Record<DraftField, string>> {
  const e: Partial<Record<DraftField, string>> = {};
  for (const f of ['title', 'summary', 'bodyHtml', 'homeHeading', 'homeIntro'] as const) {
    const { n, max } = fieldCount(f, d);
    if (n > max) e[f] = `超出上限：${n} / ${max}`;
  }
  const t = countChars(d.title.trim());
  if (!e.title && t > 0 && t < ABOUT_LIMITS.titleMin) e.title = `标题至少 ${ABOUT_LIMITS.titleMin} 个字`;
  if (!e.bodyHtml && new TextEncoder().encode(d.bodyHtml).length > ABOUT_LIMITS.bodyHtmlBytes) e.bodyHtml = '正文格式太复杂（HTML 超过 30 KB），请删减后再保存';
  if (d.stats.length > ABOUT_LIMITS.statsMax) e.stats = `最多 ${ABOUT_LIMITS.statsMax} 条`;
  else if (d.stats.some((s) => !s.value.trim() !== !s.label.trim())) e.stats = SETTINGS_TEXT.statPairError;
  else if (d.stats.some((s) => countChars(s.value) > ABOUT_LIMITS.statValueMax || countChars(s.label) > ABOUT_LIMITS.statLabelMax)) e.stats = `数值 ≤${ABOUT_LIMITS.statValueMax} 字，说明 ≤${ABOUT_LIMITS.statLabelMax} 字`;
  return e;
}

/** 哪些字段改过（保存条「有未保存的修改（EN：正文、数据条）」） */
export function dirtyFields(a: AboutDraft, b: AboutDraft): DraftField[] {
  const out: DraftField[] = [];
  for (const f of ['title', 'summary', 'bodyHtml', 'stats', 'homeHeading', 'homeIntro'] as const) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) out.push(f);
  }
  return out;
}
export function dirtySummary(saved: Record<string, AboutDraft>, draft: Record<string, AboutDraft>): string {
  return Object.keys(draft)
    .map((l) => [l, dirtyFields(saved[l] ?? emptyDraft(), draft[l])] as const)
    .filter(([, fs]) => fs.length)
    .map(([l, fs]) => `${l.toUpperCase()}：${fs.map((f) => FIELD_LABEL[f]).join('、')}`)
    .join('；');
}

export { isAllowedAboutHref };

/** 保存 / 开关的错误文案（409 不走这里，见 conflictStep）；其他沿用后台 errorText() */
// #350 图片列表带来的新错误码（保存 / 开关的顶部错误条，经 issuesAlertText 也走这里）；其他沿用 errorText()
const SETTINGS_ERR: Record<string, string> = {
  unknown_asset: '列表里有图片已经被删除，请移除后再保存',
  network: '网络错误，请检查网络后重试',
  invalid_locale: '这个语言还不支持，请刷新页面后重试',
};
export const settingsErrorText = (code: string): string =>
  (Object.prototype.hasOwnProperty.call(SETTINGS_ERR, code) ? SETTINGS_ERR[code] : null) ?? errorText(code, '保存失败');

/** 后端 issue 转成一行文字（顶部错误条用） */
export const issueLine = (i: { path?: unknown; message?: unknown }): string => {
  const path = typeof i.path === 'string' ? i.path : ''; const msg = typeof i.message === 'string' ? i.message : '';
  return path ? `${path}：${msg}` : msg || '（未说明）';
};
/**
 * 顶部错误条文案（about 和组织信息共用）：对不上字段的 issue、或 400 / 422 没带 issues，都必须显示在这里，不能悄悄丢掉。
 * rest 是对不上字段的 issue 文字；为空时只显示错误码对应的文案。
 */
export const issuesAlertText = (code: string, rest: readonly string[] = []): string =>
  rest.length ? `${settingsErrorText(code)}（${rest.join('；')}）` : settingsErrorText(code);

// ───────────────────────── 接口层 ─────────────────────────
/**
 * 失败时 code 是后端的 error 字段原样（例如 'invalid'、'too_large'、'version_conflict'）。
 * 409 只有一个 code：'version_conflict'（body { error: 'version_conflict', currentVersion }）。currentVersion 只用于展示 / 日志，
 * 绝不拿它自动重新提交——用户必须先刷新、拿到最新内容后重新编辑。
 * saved：多语言保存时，冲突前已经成功保存的语言（每个语言单独 PUT），页面把它们标为已保存。
 */
export type SaveResult =
  | { ok: true; data: AboutSettingsData }
  | { ok: false; code: string; currentVersion?: number; saved?: AboutSettingsData; issues?: string[] };
export const VERSION_CONFLICT = 'version_conflict' as const;
export const isVersionConflict = (r: SaveResult): boolean => !r.ok && r.code === VERSION_CONFLICT;

/**
 * 409 冲突状态（PM 定稿）：
 * - none → 保存 / 开关返回 version_conflict → conflict：显示「内容已被他人修改，请刷新后重新编辑」+「刷新」；
 *   编辑器里的文字原样保留（可以复制、可以继续改），但「保存」和开关都禁用，不会带旧版本号再提交。
 * - conflict → 点「刷新」→ confirm：确认框「未保存的修改将丢弃」
 *   - 取消 → 回到 conflict（仍然不能保存，文字还在）
 *   - 确认 → loading：重新读取最新内容和版本号，丢弃本地修改（不合并、不重新提交旧输入）
 * - loading → 读取成功 → none；读取失败 → conflict（可以再点刷新）
 */
export type ConflictPhase = 'none' | 'conflict' | 'confirm' | 'loading';
export type ConflictEvent = 'conflict' | 'refresh' | 'cancel' | 'confirm' | 'reloaded' | 'reload_failed';
export function conflictStep(s: ConflictPhase, e: ConflictEvent): { next: ConflictPhase; reload: boolean } {
  if (e === 'conflict') return { next: 'conflict', reload: false };
  if (s === 'conflict' && e === 'refresh') return { next: 'confirm', reload: false };
  if (s === 'confirm' && e === 'cancel') return { next: 'conflict', reload: false };
  if (s === 'confirm' && e === 'confirm') return { next: 'loading', reload: true };
  if (s === 'loading' && e === 'reloaded') return { next: 'none', reload: false };
  if (s === 'loading' && e === 'reload_failed') return { next: 'conflict', reload: false };
  return { next: s, reload: false };
}
/** 冲突没解决前（conflict / confirm / loading）不能保存、不能切开关 */
export const writesBlocked = (s: ConflictPhase): boolean => s !== 'none';
export const canSave = (o: { busy: boolean; dirty: boolean; anyErrors: boolean; conflict: ConflictPhase }): boolean =>
  !o.busy && o.dirty && !o.anyErrors && !writesBlocked(o.conflict);
export type AboutSettingsApi = {
  load(locales: readonly string[]): Promise<AboutSettingsData>;
  /**
   * 保存所有改过的语言：每个语言单独 PUT /api/admin/site-settings/about/<locale>，带读取时的 version（expectedVersion）。
   * 按顺序保存，遇到 409 立即停止，已成功的语言放在 saved 里。base = 当前已保存的数据（拼出完整结果用）。
   */
  save(changes: Record<string, AboutDraft>, base: AboutSettingsData): Promise<SaveResult>;
  /** 开关单独保存、单独记审计（site.about.visibility）；带读取时的 enabledVersion，不一致 409 */
  setEnabled(enabled: boolean, expectedVersion: number | null): Promise<SaveResult>;
};

/** 真实接口：src/lib/admin/site-settings-http.ts（#367 的 /api/admin/site-settings/about*） */
export { aboutSettingsApi } from './site-settings-http';
