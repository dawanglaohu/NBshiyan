# 上线前检查清单

> 账号配置（Vercel、Cloudflare R2/Turnstile/DNS、Upstash、Postgres、Resend、Tawk.to、Sanity、站长平台）需要 Ryan 登录，在私聊里完成，详见 #74 和 [launch-infra.md](./launch-infra.md)。勾选完再切正式域名。

## 1. 安全响应头（`security-headers.ts`，由 `next.config.ts` 下发）

| 响应头 | 当前值（摘要） | 结论 |
|---|---|---|
| Content-Security-Policy | `default-src 'self'`；脚本只放行自身、Tawk.to、Cloudflare Turnstile；`object-src 'none'`；`base-uri 'self'`；`form-action 'self'`；`frame-ancestors 'none'`；`upgrade-insecure-requests` | 通过。**`'wasm-unsafe-eval'` 必须保留**（public/ 里的 Draco/Basis 解码器要用）。`'unsafe-inline'` 是遗留项，后续改成 nonce。`img-src`/`media-src` 放行所有 `https:`，可接受，以后可收紧到 R2 域名 |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains; preload` | 通过（2 年、含子域、可提交 preload） |
| X-Content-Type-Options | `nosniff` | 通过 |
| X-Frame-Options | `DENY`（另有 CSP `frame-ancestors 'none'`） | 通过 |
| Referrer-Policy | `strict-origin-when-cross-origin` | 通过 |
| Permissions-Policy | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=(), interest-cohort=()` | 本 PR 补了 usb/serial/hid/bluetooth/browsing-topics/interest-cohort |
| Cross-Origin-Opener-Policy | `same-origin` | 通过 |
| 上传文件 / Logo 接口 | `default-src 'none'; sandbox` + `nosniff` | 通过（用户上传的内容不能执行脚本） |
| X-Robots-Tag | 非生产环境全站 `noindex, nofollow`；`/s/*` 始终 noindex | 通过 |

上线后用 `curl -sI https://<正式域名>/en` 抽查以上响应头。

## 2. 依赖漏洞扫描（2026-10-13，`pnpm audit`）

| 范围 | critical | high | moderate | low |
|---|---|---|---|---|
| 生产依赖（`--prod`，242 个包） | 0 | 0 | 0 | 0 |
| 全部依赖 | 0 | 1 | 0 | 0 |

- 唯一一个 high 是 `braces`（GHSA-vfj7-8cjw-p6xm）。它只经由 `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch` 进来，是开发依赖，不会打进生产包。目前没有修复版本，暂时接受，以后跟进 eslint-config-next 的升级。
- 上线前再跑一次 `pnpm audit --prod`，必须是 0 个 high/critical。

## 3. 生产环境必须项（通用）

- [ ] `RATE_LIMIT_STORE=upstash`，`UPSTASH_REDIS_REST_URL`（https）和 `UPSTASH_REDIS_REST_TOKEN` 已配置。缺任何一项，`prod-env-check.ts` 会让生产构建直接失败。
- [ ] 所有 `NEXT_PUBLIC_*_MOCK` 都未开启，开了构建会失败。
- [ ] `NEXT_PUBLIC_ADMIN_API=http`，否则构建失败。
- [ ] `MIDDLEWARE_PROBE_SECRET` 是至少 32 字节的随机值（例如 `openssl rand -base64 48`）。
- [ ] `SHORTLINK_PROBE_ORIGIN`（或 `NEXT_PUBLIC_SITE_URL`）是正式 https 域名。探测请求不使用请求里的 Host 头。
- [ ] Turnstile：正式站点密钥和 secret 已配置。生产环境不读 `TURNSTILE_VERIFY_URL`。
- [ ] Postgres：`DATABASE_URL` 已配置，并已执行 `prisma migrate deploy`。
- [ ] Vercel Cron：`vercel.json` 里的 `/api/admin/cron/cleanup-uploads` 每天 03:00 UTC 跑一次，确认首次执行成功。
- [ ] Auth.js 的密钥已配置，至少有一个管理员已绑定两步验证。

## 4. 后端

- [ ] `STORAGE_DRIVER=r2`，R2 相关变量（账号、桶、访问密钥、公开地址）都已配置。
- [ ] `RATE_LIMIT_STORE=upstash`（同第 3 节）。
- [ ] `RESEND_API_KEY` 和发件地址已配置，发件域名已在 Resend 完成 DNS 验证。
- [ ] `MIDDLEWARE_PROBE_SECRET` 是至少 32 字节的随机值。
- [ ] 生产环境**不能**设置 `ADMIN_SEED_TOTP_SECRET`。设置了的话，种子脚本会报错退出。
- [ ] 数据保留天数等隐私政策定稿后再定，相关变量写在 `docs/data-retention.md`，隐私 PR 合并后补上。

## 5. 前端

- [ ] `NEXT_PUBLIC_ADMIN_API=http`。
- [ ] 生产环境不能设置 `NEXT_PUBLIC_LOGO_UPLOAD_MOCK`。
- [ ] Tawk.to 的 property ID 和 widget ID 已配置。只有用户同意 `chat` 后才加载，e2e 的 `consent.spec.ts` 覆盖了这一点。
- [ ] public/ 里的 Draco/Basis 解码器随部署一起发布，所以 CSP 必须保留 `'wasm-unsafe-eval'`。
- [ ] 上线后用真机确认：桌面首屏不超过 2 秒，手机首屏不超过 3 秒，3D 在 3 秒内可以交互。

## 6. SEO

- [ ] 生产环境的 `NEXT_PUBLIC_SITE_URL` 填正式的 https 域名，canonical、hreflang 和 sitemap 的网址都从它来。
- [ ] 上线后确认生产页面没有 noindex（meta 和 `X-Robots-Tag` 都要查），`robots.txt` 没有禁止抓取全站。
- [ ] 填好 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`、`NEXT_PUBLIC_YANDEX_VERIFICATION`、`NEXT_PUBLIC_BING_VERIFICATION`，然后去 Google Search Console、Yandex Webmaster 和 Bing Webmaster 提交 sitemap。这一步要 Ryan 在私聊里登录，见 #74。
- [ ] IndexNow：生产环境设 `INDEXNOW_KEY`（8–128 位，只用 `a-zA-Z0-9-`），并且已经用 Upstash 做去重。上线后打开 `https://<域名>/<key>.txt`，应该返回 200 和密钥纯文本，其他 `.txt` 地址返回 404。等品类页或文章页上线后，再把 `src/lib/seo/indexnow.ts` 里 `INDEXNOW_LIVE_TYPES` 对应的类型改成 `live: true`。

## 7. 设计

- [ ] 上线前在有真实 GPU 的设备上复查 3D：颜色、阴影、#172 里那一排空白卡片、金色会不会发灰（设计这边只有软件渲染，没法确认）。
- [ ] 品牌按钮颜色：#148 已定，金色按钮用原色 `#D4AF6A` 配深色文字，hover 时变亮；#147 珊瑚色待 Ryan 定。上线前确认代码里没有残留旧色值。
- [ ] 深色模式和俄语各发一封测试邮件，用真实邮箱客户端（Gmail 网页版、iOS 邮件）确认显示正常。
