import type { MetadataRoute } from 'next';
import { SITE_URL, isProdEnv } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  if (!isProdEnv) return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/*/admin', '/s/', '/api/'] },
    sitemap: `${SITE_URL}/sitemap.xml`
  };
}
