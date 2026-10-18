import { PUBLISHED_LOCALES, type PublishedLocale } from '@/lib/server/published-locales';

/**
 * #350 about 页「完整内容 / 已发布语言」的唯一规则（纯函数）。
 * - 没有 server-only / prisma / sanitize-html 依赖：服务端读取（getAboutContent / getPublishedAboutLocales）、
 *   后台保存校验、SEO 的 meta / sitemap、前端后台的语言圆点都 import 这一个文件，不再各写一份。
 * - 字数一律按 Unicode code point 计（`[...s].length`）：emoji、生僻字等代理对算 1 个字，和 JS 的 `.length`（UTF-16 单元）不同。
 * - 上限数值按 #350 定稿 v1.0「字段限制」，集中在 ABOUT_LIMITS（site-settings-model.ts 原样 re-export）。
 */
export const ABOUT_LIMITS = {
  titleMin: 2, titleMax: 80,
  summaryMax: 160,
  bodyTextMin: 50, bodyTextMax: 6000, bodyHtmlBytes: 30 * 1024,
  statsMax: 4, statLabelMax: 40, statValueMax: 12,
  homeTitleMax: 60, homeIntroMax: 300,
  imagesMax: 6, imageAltMax: 125, imageCaptionMax: 80,
} as const;

/** 按 Unicode code point 计字数 */
export const countChars = (s: string): number => [...s].length;

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: '\u00a0' };

/**
 * 已净化 bodyHtml（只含 p/h2/h3/strong/em/a/ul/ol/li/br）→ 纯文本，用于计字数。
 * 块级结束和 <br> 记为换行，其余标签去掉，基本实体解码，首尾空白不计。
 * 不是净化函数：输出只用来数字数，不能拿去渲染。
 */
export function aboutBodyText(bodyHtml: string): string {
  return bodyHtml
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h2|h3|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e: string) => ENT[e])
    .replace(/\n{3,}/g, '\n\n').trim();
}

export type AboutRuleContent = { title: string; bodyHtml: string; images?: readonly { alt?: string | null }[] };

/**
 * 规则 1–3（全部满足才算完整）：
 * 1. 标题（去首尾空白）2–80 字
 * 2. 正文纯文本 50–6000 字
 * 3. 每张图都有非空 alt（本 PR 图片为 []，自动满足）
 */
export function isAboutContentComplete(content: AboutRuleContent | null | undefined): boolean {
  if (!content) return false;
  const t = countChars(content.title.trim());
  if (t < ABOUT_LIMITS.titleMin || t > ABOUT_LIMITS.titleMax) return false;
  const b = countChars(aboutBodyText(content.bodyHtml));
  if (b < ABOUT_LIMITS.bodyTextMin || b > ABOUT_LIMITS.bodyTextMax) return false;
  return (content.images ?? []).every((i) => typeof i.alt === 'string' && i.alt.trim().length > 0);
}

/**
 * 规则 4：某语言算「已发布」= 开关打开 AND 语言在 PUBLISHED_LOCALES 里 AND 该语言内容完整（规则 1–3）。
 * 返回顺序和 PUBLISHED_LOCALES 一致。
 */
export function resolvePublishedAboutLocales(input: {
  enabled: boolean;
  contents: Partial<Record<string, AboutRuleContent | null | undefined>>;
}): PublishedLocale[] {
  if (input.enabled !== true) return [];
  return PUBLISHED_LOCALES.filter((l) => isAboutContentComplete(input.contents[l]));
}
