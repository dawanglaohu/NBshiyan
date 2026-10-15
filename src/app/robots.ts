import type { MetadataRoute } from 'next';
import { SITE_URL, isProdEnvFrom } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  if (!isProdEnvFrom()) return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/*/admin', '/s/', '/*/s/', '/api/'] },
    sitemap: `${SITE_URL}/sitemap.xml`
  };
}
