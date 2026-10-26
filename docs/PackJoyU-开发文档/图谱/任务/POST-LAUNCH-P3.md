---
type: task
id: POST-LAUNCH-P3
status: done
module: M7
origin: issue-ledger-20261024
---

# POST-LAUNCH-P3　上线后小任务

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：待开 issue
- PR：#459
- 合并提交：`e5dc024fc467bbd10c2ed0df75cedd44ea097e74`
- 审查：全栈审查
- 登记状态：已落地

已由 PR #459 于 2026-10-25 合入 main。合并提交 e5dc024fc467bbd10c2ed0df75cedd44ea097e74。没有单独的 GitHub issue。已核对 main：src/lib/admin/enroll.ts 的 RESET_2FA_CONFIRM 已含「重置后，对方可能还要等最多 10 分钟才能重新登录。」，tests/admin-enroll-347-fe.test.ts 已断言该句。该项来自 UX，#454 已经改过，不列入剩余工作。

## 输入 / 产出

- **输入**：上线后的运维、UX、SEO 检查和 #432、#454、#457 审查留下的小项。本登记不实施。
- **产出**：按下面条目改 src、next.config.ts 和 public。合入后需要部署。
- **有效路径**：`next.config.ts`、`security-headers.ts`、`src/app/[locale]/layout.tsx`、`src/lib/home/brandMedia.ts`、`src/components/layout/BrandScene.tsx`、`src/lib/server/ratelimit/index.ts`、`src/lib/server/ratelimit/redis.ts`、`src/lib/server/admin/guard.ts`、`src/app/api/auth-admin/enroll/route.ts`、`src/app/api/auth-admin/enroll/confirm/route.ts`、`src/auth.ts`、`scripts/admin-reset-initial-password-lib.mjs`、`scripts/admin-reset-initial-password-lib.d.mts`、`scripts/smoke.ts`、`tests/smoke.test.ts`、`tests/ratelimit.test.ts`、`tests/og-static-cache.test.ts`、`tests/home-brand-media.test.ts`、`e2e/home-media.spec.ts`、`public/brand/packjoyu-industrial-city-v3-loop.gif`、`public/brand/packjoyu-industrial-city-v3-loop-preview.gif`

## 验收标准

已由 PR #459 于 2026-10-25 合入 main。合并提交 e5dc024fc467bbd10c2ed0df75cedd44ea097e74。GitHub 上没有单独 issue。实施时前端、后端、SEO、UX 按条目审查。改到 src/lib/server、src/auth.ts、scripts、security-headers.ts 的条目走全栈安全审。不新增后台登录。单 IP 登录总数不超过 26。文档和 PR 不写连接串、密码、主机名或 IP。条目如下。（1）/brand 下文件名无 hash 的 mp4，在 next.config.ts 的 headers() 设置 Cache-Control 为 public, max-age=86400, stale-while-revalidate=604800。不加 immutable。Cloudflare 浏览器缓存 TTL 目前把源站覆盖成 max-age=14400，PR 里写明这一层，并请运维调整或确认。来源是运维、UX。（2）清理没人引用的大文件。磁盘上是 public/brand/packjoyu-industrial-city-v3-loop.gif（13.2MB）和 public/brand/packjoyu-industrial-city-v3-loop-preview.gif（8.3MB），以及其他旧 GIF。删除前用 rg 确认无引用。登记时 src/lib/home/brandMedia.ts、tests/home-brand-media.test.ts、e2e/home-media.spec.ts 仍出现预览 GIF 文件名，有引用的文件先改引用再删。实施时 e2e/home-media.spec.ts 里「不请求 GIF」的断言要改成匹配任意 .gif 请求，不能删掉。现在三处断言的是路径等于 /brand/packjoyu-industrial-city-v3-loop.gif。改成任意以 .gif 结尾的请求都为空，断言本身保留。来源是运维、#444 后续、前端。（3）/og 下的 404 响应改为 Cache-Control: no-store。动态文章 og 和关于页 og 的 404 已经是 no-store，这次补静态 /og 未命中时仍被 1 天缓存头盖住的情况。验收：curl 请求一个不存在的 /og/*.jpg，返回 404，且 Cache-Control 为 no-store。/og/home-en.jpg 的响应头保持 public, max-age=86400, stale-while-revalidate=604800，不加 immutable，不加 s-maxage。来源是 SEO 上线检查。（4）security-headers.ts 的 Permissions-Policy 去掉 Chrome 不认识的 bluetooth。来源是 UX。（5）一个预加载的 CSS 在加载后几秒内未被使用，控制台出现警告。从 src/app/[locale]/layout.tsx 引入的全局样式查起，查清是哪一个文件，然后修掉。来源是 UX。（6）按账号限流返回 429 时补 Retry-After 头和 retryAfter 字段。当前 enroll 与 confirm 的 429 走 src/lib/server/admin/guard.ts 的 jsonErr，响应只有 error。询盘和样品接口故意不返回该字段，避免探测邮箱，这两处保持原样。来源是测试复验 #432。（7）Auth.js 默认登录页把密码框渲染成 type=text。由全栈评估后再修，配置入口在 src/auth.ts。来源是测试复验。（8）scripts/admin-reset-initial-password-lib.mjs 仍有 export { ARGON, firstLine }，去掉遗留的 firstLine 再导出，并同步 admin-reset-initial-password-lib.d.mts。来源是 #457 审查。（9）src/lib/server/ratelimit/redis.ts 解析批量回复时，bulk 长度只有 -1 视为 null，其他负数视为错误。createRateLimitStore 增加运行时明文连接检查。重置脚本判断生产环境时要同时认 VERCEL_ENV。rateLimitEnv 拼 key 前缀时已经回退到 VERCEL_ENV。productionRedisProblem 和 upstash 的 http 拒绝仍只比较 APP_ENV。这次补的是这两处生产判断。来源是 #454 审查。（10）部署 smoke（scripts/smoke.ts 与 tests/smoke.test.ts）里，401 清除会话 cookie 的断言改成白名单。只允许 2 个会话 cookie 名、空值、Max-Age=0 或 1970 过期、HttpOnly、Path=/，以及 SameSite=Lax 或 SameSite=Strict、Secure。除此之外一律失败。来源是全栈确认。（11）首页城市场景 video 出错之后，用户点播放重试的那条路径先 load() 再 play()。位置是 src/components/layout/BrandScene.tsx。现在视频出错后只会退回静帧，并不会自动调用 play()。要改的是出错之后用户点播放重试的路径，不改 onError 本身。播放后的暂停和恢复仍然不能调用 load()，那会丢掉当前帧。审查人是前端和 UX。UX 负责核对暂停和恢复不丢当前帧。来源是前端、SEO。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `next.config.ts:37` — /brand 下无内容哈希的 mp4。存在的文件 Cache-Control 为 public, max-age=86400, stale-while-revalidate=604800。
- `next.config.ts:39` — 不存在的 /brand/*.mp4 使用 no-store。
- `next.config.ts:97` — 通配 no-store 写在逐文件 1 天缓存之前。不加 immutable，不加 s-maxage。
- `next.config.ts:41` — 文件名进路由前只放行 ^[a-z0-9._-]+$，其余跳过。
- `next.config.ts:35` — 未命中的 /og/*.jpg 使用 Cache-Control: no-store。
- `next.config.ts:101` — no-store 写在逐文件长缓存之前。同名 Cache-Control 以后一条为准。
- `next.config.ts:79` — 磁盘上存在的 /og jpg（含 /og/home-en.jpg）保持 1 天缓存。public/og 新增 jpg 后必须重新 build。生产 build 下列表为空或读目录失败则构建失败。
- `src/lib/home/brandMedia.ts:8` — 城市场景不再带预览 GIF 字段。
- `public/brand/packjoyu-industrial-city-v3-loop.gif` — 已删除。删除前代码和测试不再引用。
- `public/brand/packjoyu-industrial-city-v3-loop-preview.gif` — 已删除。
- `e2e/home-media.spec.ts:221` — 任意以 .gif 结尾的请求必须为空。另外两处在 301 和 376。
- `tests/home-brand-media.test.ts:14` — 批准文件清单不含这两份 GIF。
- `tests/og-static-cache.test.ts:75` — 不存在的 /og jpg 断言 no-store；命中与品牌 mp4 在 98 行和 106 行。
- `security-headers.ts:28` — Permissions-Policy 不含 bluetooth。
- `src/app/[locale]/layout.tsx:19` — 全局样式只从这里引入 globals.css。这一行保持原样。
- `src/lib/server/admin/guard.ts:13` — 登录桶 429 带 retryAfter 字段和 Retry-After 头。
- `src/app/api/auth-admin/enroll/route.ts:34` — checkPassword 返回 rate_limited 时走 rateLimited。窗口是 LOGIN_WINDOW_MS/1000。
- `src/app/api/auth-admin/enroll/confirm/route.ts:36` — 同上。
- `tests/admin-enroll-token-347.test.ts:244` — 登录桶 429 断言 retryAfter 为 600。
- `tests/admin-enroll-void-ratelimit.test.ts:142` — confirm 的登录桶 429 同样断言。共享桶在 182 行。
- `src/auth.ts:63` — 默认登录页的密码框 type 为 password。
- `scripts/admin-reset-initial-password-lib.mjs:35` — 再导出只保留 ARGON。
- `scripts/admin-reset-initial-password-lib.d.mts:2` — 类型声明同步，没有 firstLine。
- `src/lib/server/ratelimit/redis.ts:111` — bulk 长度只有 -1 是 null，其他负数是错误。
- `scripts/admin-reset-initial-password-lib.mjs:358` — 重置脚本的 RESP 解析与应用解析器一致。
- `src/lib/server/ratelimit/index.ts:108` — 生产环境拒绝非本机明文 Redis。
- `scripts/admin-reset-initial-password-lib.mjs:304` — 生产判断同时认 APP_ENV 和 VERCEL_ENV。
- `scripts/admin-reset-initial-password-lib.mjs:313` — productionRedisProblem 使用这个判断。
- `scripts/admin-reset-initial-password-lib.mjs:496` — upstash 的 http 拒绝使用同一个判断。
- `tests/admin-reset-initial-password.test.ts:393` — VERCEL_ENV=production 时拒绝远程明文 redis 和 http upstash。
- `tests/ratelimit.test.ts:76` — bulk 长度 -1 为 null，其他负数为错误。生产明文连接在 91 行。
- `scripts/smoke.ts:125` — 401 清除会话 cookie 的白名单。Expires 整段比对在 158 行。
- `scripts/smoke.ts:242` — 白名单挂在未登录的 /api/admin/inquiries 401 上。/og/home-en.jpg 的 1 天缓存头在 250 行。
- `tests/smoke.test.ts:118` — 空列表、合法清除头和各项非法头。条数 11。不合规 cookie 与 no-store 在 137 行之后。
- `src/app/globals.css:52` — 合盖、开盖、展开刀模三条规则。src/styles/views.css 已删除。
- `e2e/home-media.spec.ts:400` — 城市视频第一次 404 退回静帧，播放后再次请求，暂停再恢复不再请求。
- `src/components/layout/BrandScene.tsx:193` — 出错后用户点播放才清 didLoad。效果在 164 行先 load()，wantPlay 时再 play()。
- `src/components/layout/BrandScene.tsx:260` — onError 只退回静帧。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- /brand 下的 mp4 没有内容哈希。磁盘上存在的文件源站 Cache-Control 是 1 天，外加 7 天 stale-while-revalidate。不存在的 /brand/*.mp4 先匹配 no-store，存在的文件再覆盖成 1 天，顺序和 /og 一样。Cloudflare 浏览器缓存 TTL 会把源站这一头盖成 max-age=14400。那一层不在 next.config.ts 里，由运维调整或确认。这两条媒体缓存都不加 immutable，也不加 s-maxage。
- /og 未命中规则排在逐文件命中规则前面。同名 Cache-Control 以后一条为准，顺序反了就会让 404 再吃到 1 天缓存。常量的值是 no-store。开发模式渲染 HTML 404 时会把响应头改成 no-store, must-revalidate，所以对不存在的 /og/*.jpg 做开发服 curl 看不到单独的 no-store。磁盘上的 jpg 走静态文件，已经写上的 Cache-Control 会被保留。动态文章 og 和关于页 og 的路径不在 /og/ 下。生产 build 读不到 public/og，或里面没有可缓存的 jpg，就直接失败。public/og 新增 jpg 后必须重新 build 才有 1 天缓存头。文件名必须匹配 ^[a-z0-9._-]+$，其余跳过。
- 城市场景运行时只剩静帧和 mp4。e2e「不请求 GIF」匹配任意以 .gif 结尾的请求。断言若改回某一个文件名，新的 gif 请求会漏过。docs/brand-media 里仍写着旧的 public 路径，那是文档，不是运行时引用。
- retryAfter 和 Retry-After 只在 checkPassword 返回 rate_limited 时出现。秒数是 LOGIN_WINDOW_MS/1000，当前为 600。IP 限流、冷却、并发 pending、enrollConfirm 的 429 仍只有 error。询盘和样品保持不返回该字段。checkPassword 的一个返回值覆盖 IP 加账号、只按账号、只按 IP 三种登录桶，所以这三种 429 都带该字段。要按桶区分，得改登录桶的返回值。
- Auth.js 内置登录页在凭证没有 type 时使用 text，然后展开凭证对象，对象里的 type 盖掉这个默认值。password 写成 { type: 'password' } 就是整段修复。email、totp、recoveryCode、rememberDevice 保持空对象。站点没有 pages.signIn，默认页是 /api/auth/signin。
- 重置库继续导出 ARGON，重置脚本从这里取哈希参数。firstLine 留在创建脚本里，重置库不再导出它。类型声明和运行时导出一起去掉 firstLine。
- RESP bulk 只有长度 -1 是 null。其他负数是错误，解析停在该行 CRLF 之后。应用解析器和重置脚本解析器一起改。只改一边，两边的对照测试会失败。
- 重置脚本把 APP_ENV 或 VERCEL_ENV 为 production 视为生产。productionRedisProblem 和 upstash 的 http 拒绝都走这个函数。createRateLimitStore 的明文检查用 isProdEnvFrom，同样认这两个变量。允许的明文主机只有 127.0.0.1、::1、localhost。错误文案只有「REDIS_URL 必须是 rediss://」，文案里不出现主机和口令。createRateLimitStore 里 upstash 的 https 检查仍只看 NODE_ENV。生产环境的本机明文，以及任何非生产明文，仍然允许。这项检查不要求连接串带密码。
- 401 清除会话 cookie 的白名单挂在未登录的 GET /api/admin/inquiries 上。这个接口 401 时会发清除头。Sanity webhook 的 401 不发 cookie，不再做这项检查。检查条数是 11。Expires 必须整段等于 Thu, 01 Jan 1970 00:00:00 GMT。SameSite=Lax 或 Strict、Secure 仍然允许。零个 Set-Cookie 算通过。Domain、非空值、非 / 的 Path、缺少 HttpOnly、非 0 的 Max-Age、不是那一串的 Expires、未知属性、重复名、超过 2 个 cookie 都失败。不新增后台登录。
- 视频元素出错后停在上一次错误，直到 load()。用户点播放并且 failedRef 为真时才把 didLoad 清掉，这行写在暂停的提前返回之后。暂停和恢复保持 didLoad，效果不会再次 load()，当前帧还在。onError 只把画面退回静帧，不调用 play()。
- 布局只引入 globals.css。合盖、开盖、展开刀模的三条规则从 src/styles/views.css 移进 globals.css，ProductGallery 不再单独引入那张表。生产构建下打开 /en，等首页预取 /en/products 再等 5 秒：修前 1920、1440、390 都出现 preloaded but not used，对象是 views.css 拆出的 /_next/static/css/db7724ad78675cc0.css。修后同一条件三个宽度都没有这条警告，产品预取仍然发生。/en/products 上 .card .views 仍是 flex、间距 6px、内边距 0 16px 14px，按钮最小高度 32px、内边距 4px 12px，按下态用强调色。Manrope 的预加载保持默认。globals.css 里的两行 @import 留在原文件。
<!-- notes:end -->
