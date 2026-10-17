import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './security-headers';
import { assertProdEnv } from './prod-env-check';
import { isProdEnvFrom } from './src/lib/site';
import { seoMockEnabled } from './src/lib/seo/mock';

assertProdEnv();

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const adminHeaders = [
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Referrer-Policy', value: 'no-referrer' }
];
const isProd = isProdEnvFrom();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // #291：未设置时也要内联成常量（空字符串），否则构建产物里留着运行时的 process.env，mock 分支去不掉、mock 数据会被打包
  env: { NEXT_PUBLIC_ADMIN_API: process.env.NEXT_PUBLIC_ADMIN_API ?? '', NEXT_PUBLIC_ADMIN_MAIL: process.env.NEXT_PUBLIC_ADMIN_MAIL ?? '' },
  images: { formats: ['image/avif', 'image/webp'] },
  // IndexNow 密钥文件 /{key}.txt（Refs #74）。中间件的 matcher 不处理带点的路径，所以不会进多语言路由；
  // 功能关闭或文件名不对时，路由返回 404。
  async rewrites() {
    return [{ source: '/:file([a-zA-Z0-9-]{8,128}\\.txt)', destination: '/api/indexnow-key/:file' }];
  },
  async headers() {
    const headers = [
      // 全站 CSP：/api/admin/uploads/* 除外，由该接口自己返回 `default-src 'none'; sandbox`，避免被全站 CSP 覆盖
      { source: '/((?!api/admin/uploads(?:/|$)).*)', headers: securityHeaders },
      // 被排除的路径仍然要带除 CSP 以外的其他安全头
      { source: '/api/admin/uploads/:path*', headers: securityHeaders.filter((h) => h.key !== 'Content-Security-Policy') },
      // 非正式环境一律禁止收录（SEO 要求）
      ...(isProd ? [] : [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }]),
      // 后台页面和后台接口：不缓存、不收录、不带 Referer
      ...['/admin', '/admin/:path*', '/:locale/admin', '/:locale/admin/:path*', '/api/admin/:path*'].map((source) => ({ source, headers: adminHeaders })),
      { source: '/s/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      { source: '/models/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }
    ];
    return headers;
  }
};
// #291：SEO 审计 mock 开关在构建时内联成常量。正式部署或 APP_ENV/VERCEL_ENV 都未设时一律为空字符串，
// sanity.ts / sitemap.ts 里的 import('./sanityMock') 分支就是死代码，生产包里没有 mock 文章和 mock chunk。
nextConfig.env = { ...nextConfig.env, SEO_AUDIT_MOCK_BUILD: seoMockEnabled() ? '1' : '' };
export default withNextIntl(nextConfig);
