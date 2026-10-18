/**
 * #350 后台「关于我们 · 图片列表」：数据形状、纯逻辑、文案和接口层（UX spec v1.0 §3「图片列表」、v1.0.7 / v1.0.8；后端 #374 PublicAsset）。
 * 组件 AboutImages.tsx 只依赖这里导出的东西。和 site-settings.ts 分开放，尽量不改 about 文字部分的文件。
 *
 * 存储模型（后端 #374）：
 * - 图片文件各语言共用：`about.images` = 有序的 PublicAsset id + 每张两种尺寸的实际宽高快照，单独 PUT /about/images（expectedVersion，409）。
 * - 替代文字 / 图片说明按语言：`about.<locale>.imageMeta[id]`，跟着该语言的 PUT /about/<locale> 一起保存。
 *   前端只发「当前图片列表里有的 id」（pruneImageMeta），已移除 / 已删除的图片的旧文字不再带回去（后端会对未知 id 400 unknown_asset）。
 * - URL 里的数字是名义长边（800 / 1600），不是实际宽度；宽高一律用 sm / lg 字段。
 */
import { ABOUT_LIMITS, countChars } from '@/lib/site-settings/about-rules';
import { errorText } from '@/components/admin/format';
import { dirtyFields, draftCompleteness, emptyDraft, type AboutDraft, type AboutSettingsApi, type AboutSettingsData, type Completeness, type SaveResult } from './site-settings';
import { draftFromView } from './site-settings-http';

export type Dims = { w: number; h: number };
/** 关于页图片列表里的一项（= 后端 about.images 的一项 + 地址） */
export type AboutImageItem = { id: string; sm: Dims; lg: Dims; src: { sm: string; lg: string } };
export type AboutImagesState = { version: number; items: AboutImageItem[] };
export type ImageMeta = Record<string, { alt: string; caption: string }>;
/** 图片库里的一张（GET /assets、POST /assets 的返回，后端 PublicAssetView） */
export type LibraryAsset = {
  id: string; width: number; height: number;
  sm: { url: string; width: number; height: number; bytes: number };
  lg: { url: string; width: number; height: number; bytes: number };
  bytes: number; createdAt: string; inUse: boolean; warnings: string[];
};

export const IMAGES_MAX = ABOUT_LIMITS.imagesMax; // 6
export const IMAGE_BYTES_MAX = 10 * 1024 * 1024; // 单张 ≤ 10 MB（后端 413 file_too_large）
/** lg 名义长边；长边 < 1600 时后端给 warnings:['image_small'] */
export const LG_EDGE = 1600;
export const ACCEPT = 'image/jpeg,image/png,image/webp';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 固定文案（UX v1.0 §3、v1.0.7、v1.0.8，逐字） */
export const IMAGES_TEXT = {
  label: '图片列表（选填，/about 与首页共用）',
  alt: (l: string) => `替代文字（${l.toUpperCase()}）`,
  altPlaceholder: '描述图片内容，≤125 字',
  altMissing: '请填写替代文字',
  caption: '图片说明（选填）',
  captionPlaceholder: '≤80 字，显示在图片下方',
  tooLong: (n: number, max: number) => `超出上限：${n} / ${max}`,
  missingSummary: (n: number) => `${n} 张图片缺少替代文字，补齐后才能保存。`,
  missingOther: (l: string, n: number) => `${l.toUpperCase()}：${n} 张图片缺少替代文字`,
  add: '＋ 添加图片',
  addRule: 'JPG / PNG / WebP，单张 ≤ 10 MB',
  addRule2: (left: number) => `上传后统一转为 WebP · 建议长边 ≥ 1600 px · 还可加 ${left} 张`,
  full: `已达上限：最多 ${ABOUT_LIMITS.imagesMax} 张`,
  uploading: (p: number) => `上传中 ${p}%`,
  cancel: '取消',
  notUploaded: '未上传',
  retry: '重试',
  retryIn: (s: number) => `${s} 秒后可重试`,
  dismiss: '关闭',
  small: '图片较小，大屏上可能不够清晰',
  duplicate: '这张图已经在列表里了',
  left: '左移', right: '右移',
  remove: '从关于页移除',
  library: (n: number) => `图片库（已上传 ${n} 张）`,
  libraryHint: '从关于页移除的图片还留在图片库里，可以重新加入；没被关于页使用的图片才能删除。',
  libraryEmpty: '还没有上传过图片。',
  libraryAdd: '加入关于页',
  libraryAdded: '已在列表中',
  libraryInUse: '关于页使用中',
  delete: '删除',
  deleteTitle: '删除这张图片？',
  deleteBody: '删除后，旧的图片链接可能仍能访问一段时间',
  dirtyList: '图片列表',
  dirtyMeta: '图片文字',
  // 右栏完整度清单（稿件 settings-desktop 的 .ss-chk 最后一项）和语言标签上的「缺…」
  checkAlt: '图片替代文字',
  checkAltMissing: (n: number) => `图片替代文字 · ${n} 张缺失`,
  checkAltNone: '图片替代文字（暂无图片）',
} as const;

/** 上传 / 删除 / 保存图片列表的错误码 → 后台文案（v1.0.7 表 + v1.0.8 修订；其余沿用 errorText） */
const UPLOAD_ERR: Record<string, string> = {
  file_too_large: '图片不能超过 10MB',
  unsupported_type: '仅支持 JPG、PNG、WebP 静态图片',
  image_too_small: '图片太小，长边至少 800 像素',
  processing_failed: '图片处理失败，请换一张重试',
  image_too_large_dimensions: '图片像素过大（超过 6000 万），请缩小后再上传',
  rate_limited: '上传太频繁，请稍后再试',
  asset_in_use: '这张图正在关于页使用，请先从关于页移除',
  // 下面三条稿里没有，前端补的（PR 正文「和稿不同」里列出）
  not_found: '这张图已经被删除了',
  unknown_asset: '列表里有图片已经被删除，请移除后再保存',
  network: '网络错误，请检查网络后重试',
};
export const imageErrorText = (code: string, prefix = '上传失败'): string => UPLOAD_ERR[code] ?? errorText(code, prefix);

/** 状态码 → 错误码（nginx 等前置层返回的 413 / 429 可能不是 JSON） */
const STATUS_CODE: Record<number, string> = { 413: 'file_too_large', 415: 'unsupported_type', 429: 'rate_limited' };

/** Retry-After：秒数或 HTTP 日期；读不出来按 60 秒（后端固定发 60） */
export function retryAfterMs(h: string | null | undefined, now = Date.now()): number {
  const v = (h ?? '').trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 3600) * 1000;
  const t = v ? Date.parse(v) : NaN;
  if (Number.isFinite(t)) return Math.max(0, Math.min(t - now, 3_600_000));
  return 60_000;
}

export type UploadOk = { ok: true; asset: LibraryAsset; deduplicated: boolean; warnings: string[] };
export type UploadFail = { ok: false; code: string; message: string; retryAfterMs?: number };
export type UploadOutcome = UploadOk | UploadFail;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const warningsOf = (v: unknown) => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : []);

/** 后端 PublicAssetView（+ inUse / warnings）→ LibraryAsset；字段不全返回 null */
export function libraryAssetFrom(v: unknown): LibraryAsset | null {
  if (!isObj(v) || !isObj(v.sm) || !isObj(v.lg)) return null;
  const sm = { url: str(v.sm.url), width: num(v.sm.width), height: num(v.sm.height), bytes: num(v.sm.bytes) };
  const lg = { url: str(v.lg.url), width: num(v.lg.width), height: num(v.lg.height), bytes: num(v.lg.bytes) };
  if (!str(v.id) || !sm.url || !lg.url || !sm.width || !sm.height || !lg.width || !lg.height) return null;
  return { id: str(v.id), width: lg.width, height: lg.height, sm, lg, bytes: num(v.bytes), createdAt: str(v.createdAt), inUse: v.inUse === true, warnings: warningsOf(v.warnings) };
}

/** 上传响应 → 结果（纯函数，便于测试）。201 新图；200 + deduplicated:true 是同一张图重复上传，复用已有记录 */
export function uploadOutcome(status: number, bodyText: string, retryAfter: string | null, now = Date.now()): UploadOutcome {
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* 非 JSON（例如 nginx 的 413 页面） */ }
  if (status === 200 || status === 201) {
    const asset = libraryAssetFrom(body);
    if (asset) {
      const b = body as Record<string, unknown>;
      return { ok: true, asset, deduplicated: b.deduplicated === true, warnings: warningsOf(b.warnings) };
    }
    return { ok: false, code: 'processing_failed', message: imageErrorText('processing_failed') };
  }
  if (status === 401) return { ok: false, code: 'unauthorized', message: imageErrorText('unauthorized') };
  const e = isObj(body) && typeof body.error === 'string' && body.error ? body.error : STATUS_CODE[status] ?? (status === 0 ? 'network' : `http_${status}`);
  const fail: UploadFail = { ok: false, code: e, message: imageErrorText(e) };
  if (status === 429 || e === 'rate_limited') fail.retryAfterMs = retryAfterMs(retryAfter, now);
  return fail;
}

/** 选文件后、上传前的检查：超过 10 MB 不上传；浏览器明确报出的其他类型（HEIC、GIF、SVG…）也不上传。类型为空时交给服务端按 magic bytes 判 */
export function precheckFile(f: { size: number; type: string }): string | null {
  if (f.size > IMAGE_BYTES_MAX) return 'file_too_large';
  if (f.type && !ALLOWED_TYPES.has(f.type.toLowerCase())) return 'unsupported_type';
  return null;
}

export const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 长边 < 1600：大屏可能不够清晰（和后端 warningsFor 同一条规则） */
export const isSmallImage = (lg: Dims): boolean => Math.max(lg.w, lg.h) < LG_EDGE;

export const itemFromAsset = (a: LibraryAsset): AboutImageItem => ({
  id: a.id, sm: { w: a.sm.width, h: a.sm.height }, lg: { w: a.lg.width, h: a.lg.height }, src: { sm: a.sm.url, lg: a.lg.url },
});

// ───────── 6 张上限、排序 ─────────
/** 还能加几张：列表 + 正在上传的都算 */
export const slotsLeft = (items: readonly unknown[], uploading = 0): number => Math.max(0, IMAGES_MAX - items.length - uploading);
/** 加到列表末尾：已在列表里或已满 6 张时原样返回 */
export function addImage(items: readonly AboutImageItem[], it: AboutImageItem): AboutImageItem[] {
  if (items.length >= IMAGES_MAX || items.some((x) => x.id === it.id)) return [...items];
  return [...items, it];
}
export function moveImage<T>(items: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= items.length || j < 0 || j >= items.length) return [...items];
  const n = [...items]; [n[i], n[j]] = [n[j], n[i]];
  return n;
}
export const removeImage = (items: readonly AboutImageItem[], id: string): AboutImageItem[] => items.filter((x) => x.id !== id);
export const sameIds = (a: readonly { id: string }[], b: readonly { id: string }[]): boolean => a.length === b.length && a.every((x, i) => x.id === b[i].id);

// ───────── imageMeta（按语言的替代文字 / 说明） ─────────
/**
 * 只保留 ids 里有的图片、并按 ids 的顺序；alt 和说明都空的条目不发。
 * 已从列表移除 / 已删除的图片的旧文字到这里就被去掉（后端对已删除 id 400 unknown_asset，而且 imageMeta 最多 6 个键）。
 */
export function pruneImageMeta(meta: ImageMeta | undefined, ids: readonly string[]): ImageMeta {
  const out: ImageMeta = {};
  for (const id of ids) {
    const m = meta?.[id];
    if (!m) continue;
    const alt = m.alt ?? ''; const caption = m.caption ?? '';
    if (alt.trim() || caption.trim()) out[id] = { alt, caption };
  }
  return out;
}
const metaKey = (meta: ImageMeta | undefined, ids: readonly string[]) => JSON.stringify(ids.map((id) => { const m = pruneImageMeta(meta, [id])[id]; return m ? [m.alt.trim(), m.caption.trim()] : ['', '']; }));
/** 这个语言的图片文字（只看当前列表里的图）有没有改过 */
export const metaChanged = (a: AboutDraft | undefined, b: AboutDraft | undefined, ids: readonly string[]): boolean => metaKey(a?.imageMeta, ids) !== metaKey(b?.imageMeta, ids);
export function setMeta(meta: ImageMeta | undefined, id: string, field: 'alt' | 'caption', value: string): ImageMeta {
  const cur = meta?.[id] ?? { alt: '', caption: '' };
  return { ...(meta ?? {}), [id]: { ...cur, [field]: value } };
}

/**
 * 校验（阻止保存）：替代文字必填 ≤125、说明 ≤80（spec §3）。
 * 「必填」只对有内容的语言生效：完全没填过的语言（圆点灰色）前台本来就不显示，不逼着先写它的 alt。
 * 有内容的语言缺 alt 时，保存图片列表会让这个语言前台变成不完整（isAboutContentComplete → 404），所以必须拦住。
 */
export type LocaleImageErrors = { missing: string[]; alt: Record<string, string>; caption: Record<string, string> };
export function localeImageErrors(d: AboutDraft | undefined, ids: readonly string[]): LocaleImageErrors {
  const e: LocaleImageErrors = { missing: [], alt: {}, caption: {} };
  const draft = d ?? emptyDraft();
  const required = draftCompleteness(draft).state !== 'empty';
  for (const id of ids) {
    const m = draft.imageMeta?.[id];
    const alt = (m?.alt ?? '').trim(); const cap = (m?.caption ?? '').trim();
    if (!alt && required) { e.missing.push(id); e.alt[id] = IMAGES_TEXT.altMissing; }
    else if (countChars(alt) > ABOUT_LIMITS.imageAltMax) e.alt[id] = IMAGES_TEXT.tooLong(countChars(alt), ABOUT_LIMITS.imageAltMax);
    if (countChars(cap) > ABOUT_LIMITS.imageCaptionMax) e.caption[id] = IMAGES_TEXT.tooLong(countChars(cap), ABOUT_LIMITS.imageCaptionMax);
  }
  return e;
}
export const hasImageErrors = (e: LocaleImageErrors): boolean => Object.keys(e.alt).length > 0 || Object.keys(e.caption).length > 0;
export function anyImageErrors(drafts: Record<string, AboutDraft>, locales: readonly string[], ids: readonly string[]): boolean {
  return ids.length > IMAGES_MAX || locales.some((l) => hasImageErrors(localeImageErrors(drafts[l], ids)));
}

// ───────── 完整度（spec §1：「完成」要求所有图片都有替代文字；前台缺 alt 的语言 404） ─────────
export const missingAltCount = (d: AboutDraft | undefined, ids: readonly string[]): number =>
  ids.filter((id) => !(d?.imageMeta?.[id]?.alt ?? '').trim()).length;
/** 右栏完整度清单的「图片替代文字」一项：没图 –（选填）；有缺 !（N 张缺失）；都填了 ✓。按完整度显示，空语言也算缺 */
export type ImageAltCheck = { key: 'imageAlt'; label: string; state: 'ok' | 'missing' | 'optional' };
export function imageAltChecklistItem(d: AboutDraft | undefined, ids: readonly string[]): ImageAltCheck {
  if (!ids.length) return { key: 'imageAlt', label: IMAGES_TEXT.checkAltNone, state: 'optional' };
  const n = missingAltCount(d, ids);
  return n ? { key: 'imageAlt', label: IMAGES_TEXT.checkAltMissing(n), state: 'missing' } : { key: 'imageAlt', label: IMAGES_TEXT.checkAlt, state: 'ok' };
}
/** 语言标签 / 前台状态的完整度再算上图片替代文字：完整 → 「缺图片替代文字」；「缺正文」→「缺正文、图片替代文字」；未填写不变 */
export function withImageAltCompleteness(c: Completeness, d: AboutDraft | undefined, ids: readonly string[]): Completeness {
  if (c.state === 'empty' || missingAltCount(d, ids) === 0) return c;
  const label = c.state === 'complete' ? `缺${IMAGES_TEXT.checkAlt}` : c.label.startsWith('缺') ? `${c.label}、${IMAGES_TEXT.checkAlt}` : c.label;
  return { state: 'partial', label };
}

/**
 * 保存条「有未保存的修改（EN：正文、图片文字；图片列表）」：在 site-settings.ts 的 dirtySummary 结果上补图片部分——
 * 某语言的图片文字改了就在该语言后面加「图片文字」，列表（各语言共用）变了就加一段「图片列表」。
 */
export function withImagesDirty(base: string, saved: Record<string, AboutDraft>, draft: Record<string, AboutDraft>, savedImages: readonly AboutImageItem[], draftImages: readonly AboutImageItem[]): string {
  const ids = draftImages.map((i) => i.id);
  const parts = base ? base.split('；') : [];
  for (const l of Object.keys(draft)) {
    if (!metaChanged(saved[l], draft[l], ids)) continue;
    const head = `${l.toUpperCase()}：`;
    const i = parts.findIndex((p) => p.startsWith(head));
    if (i >= 0) parts[i] = `${parts[i]}、${IMAGES_TEXT.dirtyMeta}`; else parts.push(`${head}${IMAGES_TEXT.dirtyMeta}`);
  }
  if (!sameIds(savedImages, draftImages)) parts.push(IMAGES_TEXT.dirtyList);
  return parts.join('；');
}
// ───────── 保存（文字 + 图片列表） ─────────
export type ImagesPutResult = { ok: true; images: AboutImagesState } | { ok: false; code: string; currentVersion?: number };
export type SaveAllResult =
  | { ok: true; data: AboutSettingsData; images: AboutImagesState }
  | (Extract<SaveResult, { ok: false }> & { images?: AboutImagesState });

/**
 * 一次「保存」：改过的语言 + 图片列表。
 * - 图片列表没变：只 PUT 改过的语言，imageMeta 剪到当前列表。
 * - 图片列表变了：顺序是 ① 改过的语言先 PUT，imageMeta 带「旧列表 ∪ 新列表」（不超过 6 张时）→ ② PUT /about/images →
 *   ③ 有多带了旧图文字的语言再 PUT 一次，剪到新列表。这样任何一步失败，库里的每个状态都是「列表里的图都有 alt」，
 *   已发布的语言不会因为缺 alt 掉成 404。并集超过 6 张时退回只带新列表（短暂窗口，见 PR 正文）。
 * - 任何一步 409 / 出错就停（不自动重发），已经保存成功的部分放在 saved / images 里，页面只更新「已保存」基线。
 */
export async function saveAboutWithImages(o: {
  locales: readonly string[]; draft: Record<string, AboutDraft>; saved: AboutSettingsData;
  savedImages: AboutImagesState; draftImages: readonly AboutImageItem[];
  api: Pick<AboutSettingsApi, 'save'>; putImages: (expectedVersion: number, ids: string[]) => Promise<ImagesPutResult>;
}): Promise<SaveAllResult> {
  const newIds = o.draftImages.map((i) => i.id);
  const oldIds = o.savedImages.items.map((i) => i.id);
  const listChanged = !sameIds(o.savedImages.items, o.draftImages);
  const dirty = o.locales.filter((l) => o.draft[l] && (dirtyFields(o.saved.locales[l] ?? emptyDraft(), o.draft[l]).length > 0 || metaChanged(o.saved.locales[l], o.draft[l], newIds)));
  const withMeta = (l: string, ids: readonly string[], base?: AboutDraft): AboutDraft => ({ ...o.draft[l], ...(base ? { version: base.version } : {}), imageMeta: pruneImageMeta(o.draft[l].imageMeta, ids) });

  if (!listChanged) {
    const r = dirty.length ? await o.api.save(Object.fromEntries(dirty.map((l) => [l, withMeta(l, newIds)])), o.saved) : { ok: true as const, data: o.saved };
    return r.ok ? { ok: true, data: r.data, images: o.savedImages } : r;
  }
  const union = [...new Set([...oldIds, ...newIds])];
  const wide = union.length <= IMAGES_MAX ? union : newIds;
  const r1 = dirty.length ? await o.api.save(Object.fromEntries(dirty.map((l) => [l, withMeta(l, wide)])), o.saved) : { ok: true as const, data: o.saved };
  if (!r1.ok) return r1;
  const ri = await o.putImages(o.savedImages.version, newIds);
  if (!ri.ok) return { ok: false, code: ri.code, currentVersion: ri.currentVersion, ...(dirty.length ? { saved: r1.data } : {}) };
  const extra = dirty.filter((l) => Object.keys(pruneImageMeta(o.draft[l].imageMeta, wide)).some((id) => !newIds.includes(id)));
  if (!extra.length) return { ok: true, data: r1.data, images: ri.images };
  const r3 = await o.api.save(Object.fromEntries(extra.map((l) => [l, withMeta(l, newIds, r1.data.locales[l])])), r1.data);
  if (!r3.ok) return { ...r3, saved: r3.saved ?? r1.data, images: ri.images };
  return { ok: true, data: r3.data, images: ri.images };
}

// ───────── 接口层 ─────────
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const ABOUT = '/api/admin/site-settings/about';
const ASSETS = '/api/admin/site-settings/assets';

/** GET /about 的 images（AdminAboutImagesView）→ AboutImagesState；不认识的条目丢掉 */
export function imagesStateFrom(v: unknown): AboutImagesState {
  if (!isObj(v)) return { version: 0, items: [] };
  const dims = (x: unknown): Dims | null => (isObj(x) && num(x.w) && num(x.h) ? { w: num(x.w), h: num(x.h) } : null);
  const items: AboutImageItem[] = [];
  for (const it of Array.isArray(v.items) ? v.items : []) {
    if (!isObj(it) || !str(it.id) || !isObj(it.src)) continue;
    const sm = dims(it.sm); const lg = dims(it.lg);
    if (!sm || !lg || !str(it.src.sm) || !str(it.src.lg)) continue;
    items.push({ id: str(it.id), sm, lg, src: { sm: str(it.src.sm), lg: str(it.src.lg) } });
  }
  return { version: typeof v.version === 'number' ? v.version : 0, items: items.slice(0, IMAGES_MAX) };
}

async function call(f: Fetch, path: string, init?: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; code: string; currentVersion?: number; status: number }> {
  let res: Response;
  try { res = await f(path, { credentials: 'same-origin', cache: 'no-store', ...init }); } catch { return { ok: false, code: 'network', status: 0 }; }
  const body = await res.json().catch(() => ({})) as { error?: unknown; currentVersion?: unknown };
  if (res.ok) return { ok: true, body };
  if (res.status === 401) return { ok: false, code: 'unauthorized', status: 401 };
  const code = typeof body.error === 'string' && body.error ? body.error : STATUS_CODE[res.status] ?? `http_${res.status}`;
  return { ok: false, code, status: res.status, ...(typeof body.currentVersion === 'number' ? { currentVersion: body.currentVersion } : {}) };
}

export function createAboutImagesApi(f: Fetch) {
  return {
    /** 一次 GET /about 同时拿到文字（和 aboutSettingsApi.load 同样的形状）和图片列表 */
    async loadWithImages(locales: readonly string[]): Promise<{ data: AboutSettingsData; images: AboutImagesState }> {
      const r = await call(f, ABOUT);
      if (!r.ok) throw new Error(r.code);
      const b = r.body as { enabled?: unknown; enabledMeta?: { version?: number }; locales?: Record<string, Parameters<typeof draftFromView>[0]>; images?: unknown };
      return {
        data: { enabled: b.enabled === true, enabledVersion: b.enabledMeta?.version ?? 0, locales: Object.fromEntries(locales.map((l) => [l, draftFromView(b.locales?.[l])])) },
        images: imagesStateFrom(b.images),
      };
    },
    /** 只读图片列表（409 刷新时和 aboutSettingsApi.load 配合用） */
    async loadImages(): Promise<AboutImagesState> {
      const r = await call(f, ABOUT);
      if (!r.ok) throw new Error(r.code);
      return imagesStateFrom((r.body as { images?: unknown }).images);
    },
    async listAssets(): Promise<LibraryAsset[]> {
      const r = await call(f, ASSETS);
      if (!r.ok) throw new Error(r.code);
      const a = (r.body as { assets?: unknown }).assets;
      return (Array.isArray(a) ? a : []).map(libraryAssetFrom).filter((x): x is LibraryAsset => !!x);
    },
    async deleteAsset(id: string): Promise<{ ok: true } | { ok: false; code: string }> {
      const r = await call(f, `${ASSETS}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return r.ok ? { ok: true } : { ok: false, code: r.code };
    },
    async putImages(expectedVersion: number, ids: string[]): Promise<ImagesPutResult> {
      const r = await call(f, `${ABOUT}/images`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion, ids }) });
      if (!r.ok) return { ok: false, code: r.code, ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}) };
      return { ok: true, images: imagesStateFrom((r.body as { images?: unknown }).images) };
    },
  };
}
export const aboutImagesApi = createAboutImagesApi((input, init) => fetch(input, init));

/** 最小的 XHR 形状（测试里换成假的）；fetch 拿不到上传进度，所以上传用 XHR */
export type XhrLike = {
  open(method: string, url: string): void; send(body: FormData): void; abort(): void;
  getResponseHeader(name: string): string | null; status: number; responseText: string; withCredentials: boolean;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null;
};

/** POST /assets（multipart，字段 file）。onProgress 0–100；signal 取消 → { code: 'aborted' } */
export function uploadAboutImage(file: Blob & { name?: string }, opts: { onProgress?: (p: number) => void; signal?: AbortSignal; xhr?: () => XhrLike } = {}): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const x = opts.xhr ? opts.xhr() : (new XMLHttpRequest() as unknown as XhrLike);
    const fd = new FormData();
    fd.append('file', file, file.name ?? 'image');
    x.open('POST', ASSETS);
    x.withCredentials = true;
    x.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(100, Math.round((e.loaded / e.total) * 100))); };
    x.onload = () => resolve(uploadOutcome(x.status, x.responseText, x.getResponseHeader('Retry-After')));
    x.onerror = () => resolve({ ok: false, code: 'network', message: imageErrorText('network') });
    x.onabort = () => resolve({ ok: false, code: 'aborted', message: '' });
    if (opts.signal) {
      if (opts.signal.aborted) { x.abort(); return; }
      opts.signal.addEventListener('abort', () => x.abort(), { once: true });
    }
    x.send(fd);
  });
}
