import { isPublishedLocale, type PublishedLocale } from '@/lib/server/published-locales';
import { getAboutContent, getPublishedAboutLocales, type AboutContent } from '@/lib/server/site-settings';

/**
 * #350 前台判断某语言的 /about 是否显示（layout 的导航/页脚入口、/about 页、首页区块共用这一个判断）。
 * 只信后端读取函数的结果：getPublishedAboutLocales() 已按「开关 + 内容完整（about-rules.ts）+ 已上线语言」过滤。
 * 传入 publishedLocales 时用这份列表，不再读库。
 */
export async function isAboutVisible(locale: string, publishedLocales?: readonly string[]): Promise<boolean> {
  const published = publishedLocales ?? await getPublishedAboutLocales();
  return isPublishedLocale(locale) && published.includes(locale);
}

export type AboutPageRead = {
  isAboutVisible: (locale: string) => Promise<boolean>;
  getAboutContent: (locale: PublishedLocale) => Promise<AboutContent | null>;
};

/**
 * /about 页面和 sitemap 共用的读取。语言未上线、前台不可见或没有内容时返回 null（页面 404，sitemap 不收录）。
 * read 省略时用上面的 isAboutVisible 和 getAboutContent。
 */
export async function loadAboutPage(locale: string, read?: AboutPageRead): Promise<AboutContent | null> {
  const visible = read?.isAboutVisible ?? isAboutVisible;
  const contentOf = read?.getAboutContent ?? getAboutContent;
  if (!isPublishedLocale(locale) || !(await visible(locale))) return null;
  return contentOf(locale);
}
