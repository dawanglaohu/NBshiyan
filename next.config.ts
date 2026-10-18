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

// #323：mock 源文件（src/lib/**/mock.ts、sanityMock.ts、models-mock.ts 等）
const MOCK_SOURCE_GLOBS = ['./src/lib/**/mock.ts', './src/lib/**/*Mock.ts', './src/lib/**/*-mock.ts'];

// 带点路径兜底 404 时跳过的前缀（这些前缀有自己的路由或 404 处理）
const NO_DOT_REWRITE = '(?:en|ru|api|admin|_next|s)(?:/|$)';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 自建部署：服务器上 docker build，运行 .next/standalone/server.js（Vercel 忽略此项）。
  // standalone 启动不会重新执行下面的 config()，运行时的生产配置检查在 src/instrumentation.ts 里再做一次。
  output: 'standalone',
  // 建首个管理员的 CLI（docker compose exec app node scripts/admin-create.mjs）不被任何页面 import，
  // 挂在 /api/health 的追踪上一起复制进 standalone；它用到的 @prisma/client、@node-rs/argon2 应用本身已被追踪。
  outputFileTracingIncludes: { '/api/health': ['./scripts/admin-create.mjs', './scripts/admin-create-lib.mjs'] },
  // #323：mock 源文件不进 standalone 产物。生产构建里 mock 分支已被构建期常量消掉（见文件末尾和 src/lib/admin/*api.ts），
  // 但文件追踪（nft）按源码文本看到 import('./mock') 仍会把 .ts 原文件复制进 .next/standalone/src。任何构建的运行时都不读这些原文件
  // （非生产构建里 mock 被打包进 chunk），所以对所有路由一律排除。不用 .dockerignore（mock 被业务代码 import，排除源码会让构建失败）。
  outputFileTracingExcludes: { '/**': MOCK_SOURCE_GLOBS },
  // #291：未设置时也要内联成常量（空字符串），否则构建产物里留着运行时的 process.env，mock 分支去不掉、mock 数据会被打包
  // #323：APP_ENV_AT_BUILD = 构建时的 APP_ENV（未设置为空字符串），启动时和运行时的 APP_ENV 比对（src/lib/server/startup/env-check.ts）
  env: { NEXT_PUBLIC_ADMIN_API: process.env.NEXT_PUBLIC_ADMIN_API ?? '', NEXT_PUBLIC_ADMIN_MAIL: process.env.NEXT_PUBLIC_ADMIN_MAIL ?? '', APP_ENV_AT_BUILD: process.env.APP_ENV ?? '' },
  images: { formats: ['image/avif', 'image/webp'] },
  // IndexNow 密钥文件 /{key}.txt（Refs #74）。中间件的 matcher 不处理带点的路径，所以不会进多语言路由；
  // 功能关闭或文件名不对时，路由返回 404。
  // 其它带点、又不是真实文件的路径（/nope.png、/manifest.webmanifest、/%2F%2Fevil.com）同样不进 middleware，
  // 会被当成 [locale] 段渲染；locale 无效时 next-intl 去读 headers()，静态页运行时转动态，返回 500。
  // 这些 rewrite 在 public 文件和静态路由之后、动态路由之前生效（afterFiles），所以真实文件不受影响；
  // 统一改到 /en/ 下不存在的路径，由 [locale]/[...rest] 给出本地化的 404。en/ru、api、admin、_next、s 开头的不动。
  async rewrites() {
    return [
      { source: '/:file([a-zA-Z0-9-]{8,128}\\.txt)', destination: '/api/indexnow-key/:file' },
      { source: `/:path((?!${NO_DOT_REWRITE}).*\\..*)`, destination: '/en/__not-found' }
    ];
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
// #323：发信 mock 适配器同理：生产构建（APP_ENV/VERCEL_ENV=production）内联为空字符串，mail/http.ts 里的 import('./mock') 是死代码；
// 非生产构建为 '1'，运行时仍由 mockAdapterAllowed()（MAIL_SEND_ADAPTER=mock 且显式非生产 APP_ENV）决定。
nextConfig.env = { ...nextConfig.env, SEO_AUDIT_MOCK_BUILD: seoMockEnabled() ? '1' : '', MAIL_MOCK_ADAPTER_BUILD: isProd ? '' : '1' };
// 文章分享图 /[locale]/articles/[slug]/og 的字体：route 里用 process.cwd() 读，追踪不到，手动带进 standalone
nextConfig.outputFileTracingIncludes = { ...nextConfig.outputFileTracingIncludes, '/[locale]/articles/[slug]/og': ['./src/assets/og-fonts/*.ttf'] };
// 生产配置检查：`next build` 时跳过只在运行时用的密钥（见 prod-env-check.ts 的 RUNTIME_ONLY），`next start` 时全部检查
export default function config(phase: string) {
  assertProdEnv(process.env, phase === PHASE_PRODUCTION_BUILD ? 'build' : 'runtime');
  return withNextIntl(nextConfig);
}
