import type { AboutContent, AboutImage, AboutStat } from '@/lib/server/site-settings';

/**
 * #350 需求 A：/about、首页区块、导航入口、后台站点设置共用的数据形状和纯逻辑（客户端、服务端都可以 import）。
 * 规则来源：UX spec v1.0（/workspace/ux-specs/about/spec.md §1 显示规则、§3 字段限制）。
 *
 * 内容原则：产能、面积、人数、认证、交期、起订量等公司事实一律不写在代码或翻译里，只能来自后台字段；
 * 字段为空时对应区块整块不渲染（不出现默认数字）。
 */

/*
 * 读模型：直接用后端约定的读取函数签名里的类型（src/lib/server/site-settings.ts，类型导入，运行时不引入服务端代码）。
 * 安全（全栈）：bodyHtml 只能是服务端经 `sanitizeAboutHtml` 净化、并在读取时再净化一次的内容，才可以进 dangerouslySetInnerHTML；
 * 前端不自建净化器。外链的 rel="noopener noreferrer" 由后端净化时统一加上。
 */
export type { AboutContent, AboutImage, AboutStat };

/** 字段限制（spec §3）。字数一律按去掉 HTML 后的字符数 */
export const ABOUT_LIMITS = {
  titleMin: 2,
  titleMax: 80,
  summaryMax: 160,
  bodyMin: 50,
  bodyMax: 6000,
  bodyHtmlBytesMax: 30 * 1024,
  statsMax: 4,
  statValueMax: 12,
  statLabelMax: 40,
  imagesMax: 6,
  imageAltMax: 125,
  imageCaptionMax: 80,
  imageBytesMax: 10 * 1024 * 1024,
  homeHeadingMax: 60,
  homeIntroMax: 300,
  /** 首页区块只取前 4 张图 */
  homeImages: 4,
} as const;

/** 只用于计数和摘要：去标签、解常见实体、合并空白。不是净化器，不能用来决定是否安全 */
export function plainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|h2|h3|li)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按 Unicode 码点计字数（俄语、中文、emoji 都算 1） */
export const charCount = (s: string | null | undefined): number => (s ? [...s].length : 0);

const filled = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

/** 数据条：数值和说明两项都填才算一条；超过 4 条只取前 4 条 */
export function visibleStats(stats: readonly AboutStat[] | null | undefined): AboutStat[] {
  return (stats ?? []).filter((s) => filled(s?.value) && filled(s?.label)).slice(0, ABOUT_LIMITS.statsMax);
}

/** 图片：必须有 id、宽高和替代文字；最多 6 张 */
export function visibleImages(images: readonly AboutImage[] | null | undefined): AboutImage[] {
  return (images ?? []).filter((i) => filled(i?.id) && filled(i?.alt) && filled(i?.src?.sm) && filled(i?.src?.lg) && i.w > 0 && i.h > 0).slice(0, ABOUT_LIMITS.imagesMax);
}

/*
 * 「完整 / 可发布」的判定（标题 2–80、正文 50–6000、图片都有 alt，spec §1）归后端 + SEO：
 * src/lib/site-settings/about-rules.ts（后端，约 01:00 PT）。前端不重复实现——前台只信读取函数的结果
 * （getPublishedAboutLocales / getAboutContent 返回 null 就是不显示）。
 */

/** 首页区块：about 本身要显示（按钮链到 /about，避免死链），并且填了首页标题和简介 */
export function homeBlockVisible(c: AboutContent | null | undefined, aboutVisible: boolean): boolean {
  return !!c && aboutVisible && filled(c.home?.title) && filled(c.home?.intro);
}

/**
 * 编辑器链接框的即时校验（spec §3「链接规则」，对齐后端 #367 sanitize-about.ts 的 safeAboutHref）：
 * - https:：必须是 https://host…，不能带账号密码（user:pw@）
 * - mailto:：必须有 @；查询参数只允许 subject（cc / bcc / body / 其他一律拒绝），subject 解码后不能有换行等控制字符
 * - 站内路径：以单个 / 开头；不能以 // 或 /\ 开头，路径里不能有反斜杠；百分号解码后（最多 3 层）再查一遍；
 *   路径里有点段（. / .. 及其 %2e 编码）一律拒绝——规范化后可能变成 //evil.com（如 /a/..//evil.com）
 * - 空白、Tab、换行、控制字符、零宽字符一律拒绝（后端是先去掉再判断；编辑器直接不让填，更严）
 * - http:、javascript:、data:、相对路径等其他一律拒绝
 * 这只是前端提示，不替代服务端的 sanitizeAboutHtml（后端入库、出库各净化一次）。
 * 用例清单：tests/about-link-cases.json（后端可以拿同一份跑 sanitizeAboutHtml）。
 */
// eslint-disable-next-line no-control-regex
const BAD_URL_CHARS = /[\s\u0000-\u001f\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/;

function percentDecode(s: string): string | null {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(cur); } catch { return null; }
    if (next === cur) return cur;
    cur = next;
  }
  return /%[0-9a-f]{2}/i.test(cur) ? null : cur; // 编码超过 3 层：拒绝
}

function isAllowedSitePath(v: string): boolean {
  const path = v.split(/[?#]/, 1)[0];
  const dec = percentDecode(v);
  const decPath = percentDecode(path);
  if (dec === null || decPath === null) return false;
  for (const x of [v, dec]) {
    if (!x.startsWith('/') || x[1] === '/' || x[1] === '\\' || x.includes('\\') || BAD_URL_CHARS.test(x)) return false;
  }
  if (decPath.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  try { return new URL(v, 'https://site.invalid').origin === 'https://site.invalid'; } catch { return false; }
}

function isAllowedMailto(v: string): boolean {
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'mailto:' || u.pathname.length < 3 || !u.pathname.includes('@') || u.hash) return false;
  const addr = percentDecode(u.pathname);
  if (addr === null || BAD_URL_CHARS.test(addr) || /[?&]/.test(addr)) return false;
  if (!u.search) return true;
  const keys = [...u.searchParams.keys()];
  if (keys.length !== 1 || keys[0].toLowerCase() !== 'subject') return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(u.searchParams.get(keys[0]) ?? '');
}

export function isAllowedAboutHref(raw: string): boolean {
  const v = raw.trim();
  if (!v || BAD_URL_CHARS.test(v)) return false;
  if (v.startsWith('/')) return isAllowedSitePath(v);
  const lower = v.toLowerCase();
  if (lower.startsWith('https:')) {
    if (!/^https:\/\/[^/\\]/i.test(v)) return false;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
    } catch { return false; }
  }
  if (lower.startsWith('mailto:')) return isAllowedMailto(v);
  return false;
}
