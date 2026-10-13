import type { MetadataRoute } from 'next';
export default function robots(): MetadataRoute.Robots {
  const isProd = process.env.VERCEL_ENV === 'production';
  return { rules: isProd ? { userAgent: '*', allow: '/', disallow: ['/admin', '/s/', '/api/'] } : { userAgent: '*', disallow: '/' } };
}
