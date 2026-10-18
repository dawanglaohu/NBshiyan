import { getTranslations } from 'next-intl/server';
import { getAboutContent } from '@/lib/server/site-settings';
import { aboutOgVersion } from '@/lib/seo/about';
import { ogSafeText } from '@/lib/seo/og/articleOgLayout';
import { renderArticleOgPng } from '@/lib/seo/og/renderArticleOg';
import { aboutOgResponse } from '@/lib/about/og-response';

// #350 /about 分享图 /<locale>/about/og?v=<sha8>（1200×630 PNG，文章分享图模板：标题 + 品牌 + 角标「About / О компании」，不用上传的照片）。
// 规则见 src/lib/about/og-response.ts（全栈复核）。期望的 v 用 SEO 的 aboutOgVersion(locale, title, badge)，不另写哈希。
// 角标 = Nav.about；页面 generateMetadata 传给 buildAboutMetadata 的 ogBadge 也是它，三处同一个值。
// 不读请求头 / Host；只把 req.url 交给 aboutOgVersionParam 取 v。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { params: Promise<{ locale: string }> };

/** 和 SEO 的 aboutOgImageUrl 一致：标题为空或没有能画的字 → 不出专属图 */
const expectedVersion = (locale: 'en' | 'ru', title: string, badge: string): string | null =>
  title.trim() && ogSafeText(title.trim()) ? aboutOgVersion(locale, title.trim(), badge) : null;

export async function GET(req: Request, { params }: P) {
  const { locale } = await params;
  return aboutOgResponse(req.url, locale, {
    getAboutContent,
    getBadge: async (l) => (await getTranslations({ locale: l, namespace: 'Nav' }))('about'),
    expectedVersion,
    render: (title, l, badge) => renderArticleOgPng(title, l, { badge }),
  });
}
