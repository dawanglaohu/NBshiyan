import { aboutHtmlToText, cleanPlainText, sanitizeAboutHtml } from './sanitize-about';

/**
 * #350 需求 A（文字部分）：SiteSetting 里 about 相关的键和存储格式。读（site-settings.ts）和写（site-settings-admin.ts）共用。
 * - `about.enabled`：{ enabled, version, updatedAt, updatedBy }（旧格式纯 true/false 也认，version 视为 0）
 * - `about.<locale>`：每个语言一份 StoredAbout，带 version（乐观锁，保存时比对，不一致 409）
 * SiteSetting 表结构不变（key String @id, value Json）。
 */
export const SITE_SETTINGS_TAG = 'site-settings';
export const ABOUT_ENABLED_KEY = 'about.enabled';
export const aboutKey = (locale: string) => `about.${locale}`;

/** 字段上限，和 #350 定稿 v1.0「字段限制」一致；前端表单用同一组数字 */
export const ABOUT_LIMITS = {
  titleMin: 2, titleMax: 80,
  summaryMax: 160,
  bodyTextMin: 50, bodyTextMax: 6000, bodyHtmlBytes: 30 * 1024,
  statsMax: 4, statLabelMax: 40, statValueMax: 12,
  homeTitleMax: 60, homeIntroMax: 300,
  imagesMax: 6, imageAltMax: 125, imageCaptionMax: 80,
} as const;

export type AboutStat = { label: string; value: string };
export type StoredImageMeta = Record<string, { alt: string; caption: string }>;
export type StoredAbout = {
  version: number;
  title: string; summary: string; bodyHtml: string;
  stats: AboutStat[];
  home: { title: string; intro: string };
  imageMeta: StoredImageMeta;
  updatedAt: string; updatedBy: string | null;
};
export type StoredEnabled = { enabled: boolean; version: number; updatedAt: string | null; updatedBy: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/** 从库里读出的值只取认识的字段；每次读出都重新净化（不只依赖入库那一次） */
export function parseStoredAbout(v: unknown): StoredAbout | null {
  if (!isObj(v)) return null;
  const home = isObj(v.home) ? v.home : {};
  const stats = Array.isArray(v.stats) ? v.stats : [];
  const meta = isObj(v.imageMeta) ? v.imageMeta : {};
  return {
    version: int(v.version),
    title: cleanPlainText(str(v.title)).slice(0, ABOUT_LIMITS.titleMax),
    summary: cleanPlainText(str(v.summary)).slice(0, ABOUT_LIMITS.summaryMax),
    bodyHtml: sanitizeAboutHtml(str(v.bodyHtml)),
    stats: stats.filter(isObj).slice(0, ABOUT_LIMITS.statsMax)
      .map((s) => ({ label: cleanPlainText(str(s.label)).slice(0, ABOUT_LIMITS.statLabelMax), value: cleanPlainText(str(s.value)).slice(0, ABOUT_LIMITS.statValueMax) }))
      .filter((s) => s.label && s.value),
    home: { title: cleanPlainText(str(home.title)).slice(0, ABOUT_LIMITS.homeTitleMax), intro: cleanPlainText(str(home.intro), true).slice(0, ABOUT_LIMITS.homeIntroMax) },
    imageMeta: Object.fromEntries(Object.entries(meta).filter(([k, m]) => IMAGE_ID_RE.test(k) && isObj(m)).slice(0, ABOUT_LIMITS.imagesMax)
      .map(([k, m]) => [k, { alt: cleanPlainText(str((m as Record<string, unknown>).alt)).slice(0, ABOUT_LIMITS.imageAltMax), caption: cleanPlainText(str((m as Record<string, unknown>).caption)).slice(0, ABOUT_LIMITS.imageCaptionMax) }])),
    updatedAt: str(v.updatedAt),
    updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
  };
}

export const IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseStoredEnabled(v: unknown): StoredEnabled {
  if (typeof v === 'boolean') return { enabled: v, version: 0, updatedAt: null, updatedBy: null };
  if (!isObj(v)) return { enabled: false, version: 0, updatedAt: null, updatedBy: null };
  return { enabled: v.enabled === true, version: int(v.version), updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null, updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null };
}

/** 版本号：库里没有这一行 = 0 */
export const storedVersion = (v: unknown): number => (v === null || v === undefined ? 0 : isObj(v) ? int(v.version) : 0);

/** 「完整内容」= 标题 ≥2 字 + 正文纯文本 ≥50 字（定稿：没有完整内容的语言只在这个语言隐藏） */
export function isAboutComplete(a: Pick<StoredAbout, 'title' | 'bodyHtml'>): boolean {
  return a.title.trim().length >= ABOUT_LIMITS.titleMin && aboutHtmlToText(a.bodyHtml).length >= ABOUT_LIMITS.bodyTextMin;
}
