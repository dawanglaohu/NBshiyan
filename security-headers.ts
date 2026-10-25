// 全站安全响应头。新增第三方脚本时在对应白名单里加域名。
// #339：Cloudflare Web Analytics（边缘注入、无 Cookie）放行 beacon；浏览器不直连 R2 / Vercel，去掉对应 connect-src。
// HSTS：线上只出一份，由 nginx v5 proxy_hide_header 盖掉 app 这份后统一发；app 保留同值（1 年、不含子域、不加 preload），任何部署顺序都没有空档。升级需先盘点子域 HTTPS 并经 Ryan 同意。
const csp = [
  "default-src 'self'",
  // Next.js 内联脚本暂用 unsafe-inline，后续改为 nonce；wasm 供 Draco 解码
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://embed.tawk.to https://*.tawk.to https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://*.tawk.to https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://*.tawk.to https://fonts.gstatic.com",
  "connect-src 'self' blob: data: https://*.tawk.to wss://*.tawk.to https://cloudflareinsights.com",
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
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }
];
