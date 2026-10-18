import { SITE_URL } from '@/lib/site';
import { buildOrganizationJsonLd } from '@/lib/seo/about';
import { getOrganizationSettings, type OrganizationSettings } from '@/lib/server/site-settings';
import JsonLd from './JsonLd';

/**
 * 全站 Organization + WebSite 结构化数据（server only：async 服务端组件，读 src/lib/server，不许被 'use client' 文件 import）。
 * - Organization 来自后台「组织信息」：getOrganizationSettings()（与 about 共用 unstable_cache，标签 site-settings，revalidate 60）
 *   → buildOrganizationJsonLd()。只输出后台填了的字段；alternateName / description 为空时用 ORGANIZATION_DEFAULTS，其他一律不补。
 * - 读取出错或超时 → 按空设置构建（最小默认值），绝不向 layout 抛错。
 * - WebSite 部分保持不变。输出和转义只走 JsonLd.tsx。
 */
export const ORG_SETTINGS_TIMEOUT_MS = 2000;

type Reader = () => Promise<OrganizationSettings>;

export async function readOrganizationSettingsSafe(read: Reader = getOrganizationSettings, timeoutMs = ORG_SETTINGS_TIMEOUT_MS): Promise<OrganizationSettings | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    return await Promise.race([Promise.resolve().then(read), timeout]);
  } catch {
    return null; // getOrganizationSettings 自己已经吞错并打日志；这里只兜底，不再打日志
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildSiteJsonLd(settings: OrganizationSettings | null, locale: string, origin: string = SITE_URL) {
  const organization = buildOrganizationJsonLd(settings, origin);
  delete organization['@context']; // @context 放在外层 @graph 上
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organization,
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        url: origin,
        name: 'PackJoyU',
        inLanguage: locale,
        publisher: { '@id': `${origin}/#organization` }
      }
    ]
  };
}

export default async function OrganizationJsonLd({ locale, read }: { locale: string; read?: Reader }) {
  let data;
  try {
    data = buildSiteJsonLd(await readOrganizationSettingsSafe(read), locale);
  } catch {
    data = buildSiteJsonLd(null, locale);
  }
  return <JsonLd data={data} />;
}
