/**
 * #350 后台「站点设置 · 公司介绍」的数据形状、纯逻辑和接口层（UX spec v1.0 §3；稿件 settings-*）。
 * 页面只依赖这里导出的东西；文案集中在 SETTINGS_TEXT，方便 UX 对稿。
 */
import { ABOUT_LIMITS, charCount, isAllowedAboutHref, plainText, type AboutStat } from '@/lib/about/model';
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
  updatedAt: string | null;
  updatedByName: string | null;
};
export type AboutSettingsData = { enabled: boolean; locales: Record<string, AboutDraft> };
export type DraftField = 'title' | 'summary' | 'bodyHtml' | 'stats' | 'homeHeading' | 'homeIntro';

export const emptyDraft = (): AboutDraft => ({ title: '', summary: '', bodyHtml: '', stats: [], homeHeading: '', homeIntro: '', version: null, updatedAt: null, updatedByName: null });

export const FIELD_LABEL: Record<DraftField, string> = { title: '标题', summary: '摘要', bodyHtml: '正文', stats: '数据条', homeHeading: '区块标题', homeIntro: '首页简介' };

/** 固定文案（与稿件逐字一致；{x} 是占位） */
export const SETTINGS_TEXT = {
  crumb: '站点设置 / 公司介绍',
  h1: '公司介绍（/about 页）',
  lastEdited: '最近修改：',
  preview: (l: string) => `在新窗口预览 ${l.toUpperCase()} ↗`,
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
  localeStatus: '各语言前台状态',
  shown: '显示',
  hidden: (why: string) => `隐藏 · ${why}`,
  newLocalesNote: '新语言（ja / hi / es / de / fr / ar）上线后自动出现在标签里，未填写前不显示。',
  dirty: '有未保存的修改',
  discard: '放弃修改',
  save: '保存',
  saving: '保存中…',
  saved: (ls: string[]) => `✓ 已保存 ${ls.map((l) => l.toUpperCase()).join('、')}。前台约 1 分钟内生效。`,
  conflict: (who: string, when: string) => `保存失败（409）：内容已被其他管理员修改（${who} · ${when}）。你的修改仍保留在页面上，没有覆盖对方的版本。请复制你的修改，刷新后再合并保存。`,
  conflictUnknown: '保存失败（409）：内容已被其他管理员修改。你的修改仍保留在页面上，没有覆盖对方的版本。请复制你的修改，刷新后再合并保存。',
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
  notReady: '站点设置接口还没上线（等后端 #350），现在的修改无法保存。',
} as const;

/**
 * 标签上的圆点（spec §3）：绿=完整（前台显示），黄=有内容但不完整，灰=未填写。
 * 「完整」怎么判由后端 about-rules.ts 决定（TODO(backend #350)：接口返回每个语言的 complete / missing，前端只显示）。
 * 前端只区分「未填写」和「有内容」；后端没给结果前，有内容的一律显示黄色「待校验」，不自己推断。
 */
export type Completeness = { state: 'complete' | 'partial' | 'empty'; label: string };
export function draftCompleteness(d: AboutDraft, server?: { complete: boolean; missingLabel?: string } | null): Completeness {
  const empty = !d.title.trim() && !plainText(d.bodyHtml) && !d.summary.trim() && d.stats.length === 0 && !d.homeHeading.trim() && !d.homeIntro.trim();
  if (empty) return { state: 'empty', label: '未填写' };
  if (server?.complete) return { state: 'complete', label: '完整' };
  return { state: 'partial', label: server?.missingLabel || '待校验' };
}

/** 字段的计数（去 HTML 后的字符数）和上限 */
export function fieldCount(field: Exclude<DraftField, 'stats'>, d: AboutDraft): { n: number; max: number; min?: number } {
  switch (field) {
    case 'title': return { n: charCount(d.title.trim()), max: ABOUT_LIMITS.titleMax, min: ABOUT_LIMITS.titleMin };
    case 'summary': return { n: charCount(d.summary.trim()), max: ABOUT_LIMITS.summaryMax };
    case 'bodyHtml': return { n: charCount(plainText(d.bodyHtml)), max: ABOUT_LIMITS.bodyMax, min: ABOUT_LIMITS.bodyMin };
    case 'homeHeading': return { n: charCount(d.homeHeading.trim()), max: ABOUT_LIMITS.homeHeadingMax };
    case 'homeIntro': return { n: charCount(d.homeIntro.trim()), max: ABOUT_LIMITS.homeIntroMax };
  }
}

/**
 * 阻止保存的校验错误：超上限、正文 HTML 超 30 KB、数据条只填了一半或超长。
 * 标题/正文过短不阻止保存（允许先存草稿），只让该语言前台不显示（完整度圆点会提示）。
 */
export function draftErrors(d: AboutDraft): Partial<Record<DraftField, string>> {
  const e: Partial<Record<DraftField, string>> = {};
  for (const f of ['title', 'summary', 'bodyHtml', 'homeHeading', 'homeIntro'] as const) {
    const { n, max } = fieldCount(f, d);
    if (n > max) e[f] = `超出上限：${n} / ${max}`;
  }
  if (!e.bodyHtml && new TextEncoder().encode(d.bodyHtml).length > ABOUT_LIMITS.bodyHtmlBytesMax) e.bodyHtml = '正文格式太复杂（HTML 超过 30 KB），请删减后再保存';
  if (d.stats.length > ABOUT_LIMITS.statsMax) e.stats = `最多 ${ABOUT_LIMITS.statsMax} 条`;
  else if (d.stats.some((s) => !s.value.trim() !== !s.label.trim())) e.stats = SETTINGS_TEXT.statPairError;
  else if (d.stats.some((s) => charCount(s.value) > ABOUT_LIMITS.statValueMax || charCount(s.label) > ABOUT_LIMITS.statLabelMax)) e.stats = '数值 ≤12 字，说明 ≤40 字';
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

/** 保存 / 开关的错误文案：409 用稿件文案；其他沿用后台 errorText() */
export const settingsErrorText = (code: string): string => (code === 'not_ready' ? SETTINGS_TEXT.notReady : errorText(code, '保存失败'));

// ───────────────────────── 接口层 ─────────────────────────
export type SaveResult = { ok: true; data: AboutSettingsData } | { ok: false; code: string; conflict?: { by: string | null; at: string | null } };
export type AboutSettingsApi = {
  load(locales: readonly string[]): Promise<AboutSettingsData>;
  /** 一次请求保存所有改过的语言；每个语言带当前 version，不一致后端返回 409 */
  save(changes: Record<string, AboutDraft>): Promise<SaveResult>;
  /** 开关单独保存、单独记审计（site.about.visibility） */
  setEnabled(enabled: boolean): Promise<SaveResult>;
};

/**
 * STUB — TODO(backend #350)：后台站点设置接口还没上线（路径和请求体请后端在 PR 里贴签名后再接）。
 * 现在：读取返回「全部为空、开关关闭」；保存和开关都返回 not_ready，页面显示「接口还没上线」，不会假装保存成功。
 */
export const ABOUT_SETTINGS_API_STUB = true as const;
export const aboutSettingsApi: AboutSettingsApi = {
  async load(locales) { return { enabled: false, locales: Object.fromEntries(locales.map((l) => [l, emptyDraft()])) }; },
  async save() { return { ok: false, code: 'not_ready' }; },
  async setEnabled() { return { ok: false, code: 'not_ready' }; },
};
