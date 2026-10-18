import { isPublishedLocale } from '@/lib/server/published-locales';
import { getPublishedAboutLocales } from '@/lib/server/site-settings';

/**
 * #350 前台判断某语言的 /about 是否显示（layout 的导航/页脚入口、/about 页、首页区块共用这一个判断）。
 * 只信后端读取函数的结果：getPublishedAboutLocales() 已按「开关 + 内容完整（about-rules.ts）+ 已上线语言」过滤。
 * 读取函数现在是桩（恒为空数组），所以入口、页面、区块都不显示——与开关关闭一致。
 */
export async function isAboutVisible(locale: string): Promise<boolean> {
  return isPublishedLocale(locale) && (await getPublishedAboutLocales()).includes(locale);
}
