import { SITE_URL } from '@/lib/site';

// 全站 Organization + WebSite 结构化数据；联系方式和社交账号等正式信息定了再补
export default function OrganizationJsonLd({ locale }: { locale: string }) {
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'PackJoyU',
        alternateName: '保乐优',
        url: SITE_URL,
        description: 'Custom packaging manufacturer: corrugated boxes, gift boxes, color boxes, molded pulp, paper cups and printing.'
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: 'PackJoyU',
        inLanguage: locale,
        publisher: { '@id': `${SITE_URL}/#organization` }
      }
    ]
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
