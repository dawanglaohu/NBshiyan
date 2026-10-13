// 全站安全响应头。新增第三方脚本时在对应白名单里加域名。
const csp = [
  "default-src 'self'",
  // Next.js 内联脚本暂用 unsafe-inline，后续改为 nonce；wasm 供 Draco 解码
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://embed.tawk.to https://*.tawk.to https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://*.tawk.to https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://*.tawk.to https://fonts.gstatic.com",
  "connect-src 'self' blob: data: https://*.tawk.to wss://*.tawk.to https://*.r2.dev https://*.vercel-insights.com",
  "media-src 'self' blob: https:",
  "frame-src https://*.tawk.to https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests"
].join('; ');

export const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }
];
