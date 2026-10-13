import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './security-headers';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const isProd = process.env.VERCEL_ENV === 'production';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { formats: ['image/avif', 'image/webp'] },
  async headers() {
    const headers = [
      { source: '/:path*', headers: securityHeaders },
      // 非正式环境一律禁止收录（SEO 要求）
      ...(isProd ? [] : [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }]),
      { source: '/admin/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      { source: '/s/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      { source: '/models/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }
    ];
    return headers;
  }
};
export default withNextIntl(nextConfig);
