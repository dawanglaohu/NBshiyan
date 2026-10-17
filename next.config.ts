import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './security-headers';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { assertProdEnv } from './prod-env-check';
import { isProdEnvFrom } from './src/lib/site';
import { seoMockEnabled } from './src/lib/seo/mock';


const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const adminHeaders = [
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Referrer-Policy', value: 'no-referrer' }
];
const isProd = isProdEnvFrom();
// 输出存储文件的接口（logo、模型）：CSP 由 src/lib/server/file-response.ts 设置
const FILE_ROUTE_SOURCES = ['/api/admin/uploads/:path*', '/api/admin/models/:id/file', '/api/designs/:id/logo', '/api/models/:id/:variant'];
const FILE_ROUTE_EXCLUDE = 'api/admin/uploads(?:/|$)|api/admin/models/[^/]+/file$|api/designs/[^/]+/logo$|api/models/[^/]+/[^/]+$';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 自建部署：服务器上 docker build，运行 .next/standalone/server.js（Vercel 忽略此项）。
  // standalone 启动不会重新执行下面的 config()，运行时的生产配置检查在 src/instrumentation.ts 里再做一次。
  output: 'standalone',
  // 建首个管理员的 CLI（docker compose exec app node scripts/admin-create.mjs）不被任何页面 import，
  // 挂在 /api/health 的追踪上一起复制进 standalone；它用到的 @prisma/client、@node-rs/argon2 应用本身已被追踪。
  outputFileTracingIncludes: { '/api/health': ['./scripts/admin-create.mjs', './scripts/admin-create-lib.mjs'] },
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
      // 全站 CSP：输出存储文件的接口除外（FILE_ROUTE_SOURCES），由接口自己返回 `default-src 'none'; sandbox`（file-response.ts），避免被全站 CSP 覆盖
      { source: `/((?!${FILE_ROUTE_EXCLUDE}).*)`, headers: securityHeaders },
      // 被排除的路径仍然要带除 CSP 以外的其他安全头
      ...FILE_ROUTE_SOURCES.map((source) => ({ source, headers: securityHeaders.filter((h) => h.key !== 'Content-Security-Policy') })),
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
// 生产配置检查：`next build` 时跳过只在运行时用的密钥（见 prod-env-check.ts 的 RUNTIME_ONLY），`next start` 时全部检查
export default function config(phase: string) {
  assertProdEnv(process.env, phase === PHASE_PRODUCTION_BUILD ? 'build' : 'runtime');
  return withNextIntl(nextConfig);
}
