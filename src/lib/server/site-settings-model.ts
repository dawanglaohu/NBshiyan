import { cleanPlainText, hasDotSegment, sanitizeAboutHtml } from './sanitize-about';
import { ABOUT_LIMITS, isAboutContentComplete } from '@/lib/site-settings/about-rules';

/**
 * #350 需求 A（文字部分）：SiteSetting 里 about 相关的键和存储格式。读（site-settings.ts）和写（site-settings-admin.ts）共用。
 * - `about.enabled`：{ enabled, version, updatedAt, updatedBy }（旧格式纯 true/false 也认，version 视为 0）
 * - `about.<locale>`：每个语言一份 StoredAbout，带 version（乐观锁，保存时比对，不一致 409）
 * SiteSetting 表结构不变（key String @id, value Json）。
 */
export const SITE_SETTINGS_TAG = 'site-settings';
export const ABOUT_ENABLED_KEY = 'about.enabled';
export const aboutKey = (locale: string) => `about.${locale}`;

/** 字段上限（#350 定稿 v1.0）：定义在纯模块 about-rules.ts，这里 re-export，旧路径照用 */
export { ABOUT_LIMITS };

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
/** 按 code point 截断（不切开代理对），和 about-rules.ts 的计数一致 */
const cut = (s: string, n: number) => [...s].slice(0, n).join('');
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/** 从库里读出的值只取认识的字段；每次读出都重新净化（不只依赖入库那一次） */
export function parseStoredAbout(v: unknown): StoredAbout | null {
  if (!isObj(v)) return null;
  const home = isObj(v.home) ? v.home : {};
  const stats = Array.isArray(v.stats) ? v.stats : [];
  const meta = isObj(v.imageMeta) ? v.imageMeta : {};
  return {
    version: int(v.version),
    title: cut(cleanPlainText(str(v.title)), ABOUT_LIMITS.titleMax),
    summary: cut(cleanPlainText(str(v.summary)), ABOUT_LIMITS.summaryMax),
    bodyHtml: sanitizeAboutHtml(str(v.bodyHtml)),
    stats: stats.filter(isObj).slice(0, ABOUT_LIMITS.statsMax)
      .map((s) => ({ label: cut(cleanPlainText(str(s.label)), ABOUT_LIMITS.statLabelMax), value: cut(cleanPlainText(str(s.value)), ABOUT_LIMITS.statValueMax) }))
      .filter((s) => s.label && s.value),
    home: { title: cut(cleanPlainText(str(home.title)), ABOUT_LIMITS.homeTitleMax), intro: cut(cleanPlainText(str(home.intro), true), ABOUT_LIMITS.homeIntroMax) },
    imageMeta: Object.fromEntries(Object.entries(meta).filter(([k, m]) => IMAGE_ID_RE.test(k) && isObj(m)).slice(0, ABOUT_LIMITS.imagesMax)
      .map(([k, m]) => [k, { alt: cut(cleanPlainText(str((m as Record<string, unknown>).alt)), ABOUT_LIMITS.imageAltMax), caption: cut(cleanPlainText(str((m as Record<string, unknown>).caption)), ABOUT_LIMITS.imageCaptionMax) }])),
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

/** 「完整内容」：规则只在 about-rules.ts（isAboutContentComplete）；存储格式里还没有图片（imageMeta 不是图片列表），images 按 [] */
export function isAboutComplete(a: Pick<StoredAbout, 'title' | 'bodyHtml'>): boolean {
  return isAboutContentComplete({ title: a.title, bodyHtml: a.bodyHtml, images: [] });
}

// ---------- 组织信息（Organization JSON-LD 用） ----------
/**
 * `site.organization`：{ version, ...下面这些可选字段, sameAs: string[], updatedAt, updatedBy }。
 * 只存后台实际填写的值；没填的字段不存、前台也不返回。默认值（alternateName / description 的初始文案）
 * 不在后端：由 SEO 的 buildOrganizationJsonLd（src/lib/seo/organization-defaults.ts）在输出时补。
 * 没有产能、面积、人数、认证、交期这类字段。
 */
export const ORGANIZATION_KEY = 'site.organization';
/** name 是 JSON-LD 必填项：后台没填时用现在的站点名（不是 SEO 默认值） */
export const ORGANIZATION_FALLBACK_NAME = 'PackJoyU';

export const ORG_LIMITS = {
  nameMax: 100, alternateNameMax: 100, legalNameMax: 150, descriptionMax: 300,
  emailMax: 254, telephoneMax: 40, addressMax: 200, urlMax: 500, sameAsMax: 10,
} as const;

export const ORG_TEXT_FIELDS = ['name', 'alternateName', 'legalName', 'description', 'email', 'telephone', 'address', 'foundingDate', 'logo'] as const;
export type OrgTextField = (typeof ORG_TEXT_FIELDS)[number];
export type OrganizationFields = Partial<Record<OrgTextField, string>> & { sameAs: string[] };
export type StoredOrganization = OrganizationFields & { version: number; updatedAt: string | null; updatedBy: string | null };

export const ORG_EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const ORG_TELEPHONE_RE = /^\+?[0-9][0-9 ()\-.]{2,39}$/;

/** foundingDate：YYYY 或 YYYY-MM-DD（真实日期），年份 1800 至今 */
export function isValidFoundingDate(s: string, now = new Date()): boolean {
  const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  if (y < 1800 || y > now.getUTCFullYear()) return false;
  if (m[2] === undefined) return true;
  const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === y && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) && d.getTime() <= now.getTime();
}

/** logo / sameAs：只允许 https 绝对地址（不带账号密码）；logo 另外允许以单个 / 开头的站内路径 */
export function safeOrgUrl(raw: string, allowSitePath = false): string | null {
  const s = raw.trim();
  if (!s || [...s].length > ORG_LIMITS.urlMax || /[\s\\\u0000-\u001f\u007f]/.test(s)) return null;
  if (allowSitePath && s.startsWith('/')) return s.startsWith('//') || /%2f|%5c/i.test(s.slice(0, 4)) || hasDotSegment(s) ? null : s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
    return u.toString();
  } catch { return null; }
}

/** 读出时重新清理并校验；不合格的字段直接丢掉（不返回），不抛错 */
export function parseStoredOrganization(v: unknown): StoredOrganization | null {
  if (!isObj(v)) return null;
  const out: StoredOrganization = { version: int(v.version), sameAs: [], updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null, updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null };
  const max: Record<OrgTextField, number> = {
    name: ORG_LIMITS.nameMax, alternateName: ORG_LIMITS.alternateNameMax, legalName: ORG_LIMITS.legalNameMax, description: ORG_LIMITS.descriptionMax,
    email: ORG_LIMITS.emailMax, telephone: ORG_LIMITS.telephoneMax, address: ORG_LIMITS.addressMax, foundingDate: 10, logo: ORG_LIMITS.urlMax,
  };
  for (const f of ORG_TEXT_FIELDS) {
    if (f === 'logo') { const u = safeOrgUrl(str(v.logo), true); if (u) out.logo = u; continue; }
    const t = cleanPlainText(str(v[f]));
    if (!t || [...t].length > max[f]) continue;
    if (f === 'email' && !ORG_EMAIL_RE.test(t)) continue;
    if (f === 'telephone' && !ORG_TELEPHONE_RE.test(t)) continue;
    if (f === 'foundingDate' && !isValidFoundingDate(t)) continue;
    out[f] = t;
  }
  const sameAs = Array.isArray(v.sameAs) ? v.sameAs : [];
  out.sameAs = [...new Set(sameAs.map((x) => safeOrgUrl(str(x))).filter((x): x is string => !!x))].slice(0, ORG_LIMITS.sameAsMax);
  return out;
}
