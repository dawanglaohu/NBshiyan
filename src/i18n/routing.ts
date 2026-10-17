import { defineRouting } from 'next-intl/routing';
// alternateLinks: false —— 不在响应头里发 next-intl 的 `Link: rel="alternate"; hreflang=…`。
// hreflang / canonical 只由 HTML 里的 metadata（src/i18n/alternates.ts）输出：
// 响应头版本的 x-default 指向根路径 `/`，和 HTML 的 `/en` 不一致，域名还取自请求 Host。
export const routing = defineRouting({ locales: ['en', 'ru'], defaultLocale: 'en', localePrefix: 'always', alternateLinks: false });
