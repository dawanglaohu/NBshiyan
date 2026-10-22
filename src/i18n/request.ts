import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_PUBLISHED_LOCALE, isPublishedLocale } from './published-locales';
import { withEnFallback } from './messages-fallback';
// 只解析已发布语言；未发布语言在 middleware 已 404，这里再回落到 en 兜底。
// 缺失的文案键回落到 en（深合并，en 为底）。onError / getMessageFallback 保持 next-intl 默认（报错日志 + 显示键名）。
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isPublishedLocale(requested) ? requested : DEFAULT_PUBLISHED_LOCALE;
  const own = (await import(`../../messages/${locale}.json`)).default;
  const messages = locale === DEFAULT_PUBLISHED_LOCALE ? own : withEnFallback((await import('../../messages/en.json')).default, own);
  return { locale, messages };
});
