# 文档补丁 post-launch-p3-smoke-cookie

任务：POST-LAUNCH-P3
原分支：task/POST-LAUNCH-P3
原 PR：None
依据：401 session-cookie whitelist must allow SameSite=Lax or Strict and Secure, because the existing clearer already sends them and that file is outside this task.

## 差异与复验范围

- POST-LAUNCH-P3：task

### 04-执行/遗留issue-20261024.md

````diff
--- before/04-执行/遗留issue-20261024.md
+++ after/04-执行/遗留issue-20261024.md
@@ -423,7 +423,7 @@
 review: fullstack
 input: 上线后的运维、UX、SEO 检查和 #432、#454、#457 审查留下的小项。本登记不实施。
 output: 按下面条目改 src、next.config.ts 和 public。合入后需要部署。
-acceptance: 未派发。GitHub 上还没有对应 issue，编号写待开 issue，本登记不新开 issue。实施时前端、后端、SEO、UX 按条目审查。改到 src/lib/server、src/auth.ts、scripts、security-headers.ts 的条目走全栈安全审。不新增后台登录。单 IP 登录总数不超过 26。文档和 PR 不写连接串、密码、主机名或 IP。条目如下。（1）/brand 下文件名无 hash 的 mp4，在 next.config.ts 的 headers() 设置 Cache-Control 为 public, max-age=86400, stale-while-revalidate=604800。不加 immutable。Cloudflare 浏览器缓存 TTL 目前把源站覆盖成 max-age=14400，PR 里写明这一层，并请运维调整或确认。来源是运维、UX。（2）清理没人引用的大文件。磁盘上是 public/brand/packjoyu-industrial-city-v3-loop.gif（13.2MB）和 public/brand/packjoyu-industrial-city-v3-loop-preview.gif（8.3MB），以及其他旧 GIF。删除前用 rg 确认无引用。登记时 src/lib/home/brandMedia.ts、tests/home-brand-media.test.ts、e2e/home-media.spec.ts 仍出现预览 GIF 文件名，有引用的文件先改引用再删。实施时 e2e/home-media.spec.ts 里「不请求 GIF」的断言要改成匹配任意 .gif 请求，不能删掉。现在三处断言的是路径等于 /brand/packjoyu-industrial-city-v3-loop.gif。改成任意以 .gif 结尾的请求都为空，断言本身保留。来源是运维、#444 后续、前端。（3）/og 下的 404 响应改为 Cache-Control: no-store。动态文章 og 和关于页 og 的 404 已经是 no-store，这次补静态 /og 未命中时仍被 1 天缓存头盖住的情况。验收：curl 请求一个不存在的 /og/*.jpg，返回 404，且 Cache-Control 为 no-store。/og/home-en.jpg 的响应头保持 public, max-age=86400, stale-while-revalidate=604800，不加 immutable，不加 s-maxage。来源是 SEO 上线检查。（4）security-headers.ts 的 Permissions-Policy 去掉 Chrome 不认识的 bluetooth。来源是 UX。（5）一个预加载的 CSS 在加载后几秒内未被使用，控制台出现警告。从 src/app/[locale]/layout.tsx 引入的全局样式查起，查清是哪一个文件，然后修掉。来源是 UX。（6）按账号限流返回 429 时补 Retry-After 头和 retryAfter 字段。当前 enroll 与 confirm 的 429 走 src/lib/server/admin/guard.ts 的 jsonErr，响应只有 error。询盘和样品接口故意不返回该字段，避免探测邮箱，这两处保持原样。来源是测试复验 #432。（7）Auth.js 默认登录页把密码框渲染成 type=text。由全栈评估后再修，配置入口在 src/auth.ts。来源是测试复验。（8）scripts/admin-reset-initial-password-lib.mjs 仍有 export { ARGON, firstLine }，去掉遗留的 firstLine 再导出，并同步 admin-reset-initial-password-lib.d.mts。来源是 #457 审查。（9）src/lib/server/ratelimit/redis.ts 解析批量回复时，bulk 长度只有 -1 视为 null，其他负数视为错误。createRateLimitStore 增加运行时明文连接检查。重置脚本判断生产环境时要同时认 VERCEL_ENV。rateLimitEnv 拼 key 前缀时已经回退到 VERCEL_ENV。productionRedisProblem 和 upstash 的 http 拒绝仍只比较 APP_ENV。这次补的是这两处生产判断。来源是 #454 审查。（10）部署 smoke（scripts/smoke.ts 与 tests/smoke.test.ts）里，401 清除会话 cookie 的断言改成白名单。只允许 2 个会话 cookie 名、空值、Max-Age=0 或 1970 过期、HttpOnly、Path=/。其他一律失败。来源是全栈确认。（11）首页城市场景 video 出错之后，用户点播放重试的那条路径先 load() 再 play()。位置是 src/components/layout/BrandScene.tsx。现在视频出错后只会退回静帧，并不会自动调用 play()。要改的是出错之后用户点播放重试的路径，不改 onError 本身。播放后的暂停和恢复仍然不能调用 load()，那会丢掉当前帧。审查人是前端和 UX。UX 负责核对暂停和恢复不丢当前帧。来源是前端、SEO。
+acceptance: 未派发。GitHub 上还没有对应 issue，编号写待开 issue，本登记不新开 issue。实施时前端、后端、SEO、UX 按条目审查。改到 src/lib/server、src/auth.ts、scripts、security-headers.ts 的条目走全栈安全审。不新增后台登录。单 IP 登录总数不超过 26。文档和 PR 不写连接串、密码、主机名或 IP。条目如下。（1）/brand 下文件名无 hash 的 mp4，在 next.config.ts 的 headers() 设置 Cache-Control 为 public, max-age=86400, stale-while-revalidate=604800。不加 immutable。Cloudflare 浏览器缓存 TTL 目前把源站覆盖成 max-age=14400，PR 里写明这一层，并请运维调整或确认。来源是运维、UX。（2）清理没人引用的大文件。磁盘上是 public/brand/packjoyu-industrial-city-v3-loop.gif（13.2MB）和 public/brand/packjoyu-industrial-city-v3-loop-preview.gif（8.3MB），以及其他旧 GIF。删除前用 rg 确认无引用。登记时 src/lib/home/brandMedia.ts、tests/home-brand-media.test.ts、e2e/home-media.spec.ts 仍出现预览 GIF 文件名，有引用的文件先改引用再删。实施时 e2e/home-media.spec.ts 里「不请求 GIF」的断言要改成匹配任意 .gif 请求，不能删掉。现在三处断言的是路径等于 /brand/packjoyu-industrial-city-v3-loop.gif。改成任意以 .gif 结尾的请求都为空，断言本身保留。来源是运维、#444 后续、前端。（3）/og 下的 404 响应改为 Cache-Control: no-store。动态文章 og 和关于页 og 的 404 已经是 no-store，这次补静态 /og 未命中时仍被 1 天缓存头盖住的情况。验收：curl 请求一个不存在的 /og/*.jpg，返回 404，且 Cache-Control 为 no-store。/og/home-en.jpg 的响应头保持 public, max-age=86400, stale-while-revalidate=604800，不加 immutable，不加 s-maxage。来源是 SEO 上线检查。（4）security-headers.ts 的 Permissions-Policy 去掉 Chrome 不认识的 bluetooth。来源是 UX。（5）一个预加载的 CSS 在加载后几秒内未被使用，控制台出现警告。从 src/app/[locale]/layout.tsx 引入的全局样式查起，查清是哪一个文件，然后修掉。来源是 UX。（6）按账号限流返回 429 时补 Retry-After 头和 retryAfter 字段。当前 enroll 与 confirm 的 429 走 src/lib/server/admin/guard.ts 的 jsonErr，响应只有 error。询盘和样品接口故意不返回该字段，避免探测邮箱，这两处保持原样。来源是测试复验 #432。（7）Auth.js 默认登录页把密码框渲染成 type=text。由全栈评估后再修，配置入口在 src/auth.ts。来源是测试复验。（8）scripts/admin-reset-initial-password-lib.mjs 仍有 export { ARGON, firstLine }，去掉遗留的 firstLine 再导出，并同步 admin-reset-initial-password-lib.d.mts。来源是 #457 审查。（9）src/lib/server/ratelimit/redis.ts 解析批量回复时，bulk 长度只有 -1 视为 null，其他负数视为错误。createRateLimitStore 增加运行时明文连接检查。重置脚本判断生产环境时要同时认 VERCEL_ENV。rateLimitEnv 拼 key 前缀时已经回退到 VERCEL_ENV。productionRedisProblem 和 upstash 的 http 拒绝仍只比较 APP_ENV。这次补的是这两处生产判断。来源是 #454 审查。（10）部署 smoke（scripts/smoke.ts 与 tests/smoke.test.ts）里，401 清除会话 cookie 的断言改成白名单。只允许 2 个会话 cookie 名、空值、Max-Age=0 或 1970 过期、HttpOnly、Path=/，以及 SameSite=Lax 或 SameSite=Strict、Secure。除此之外一律失败。来源是全栈确认。（11）首页城市场景 video 出错之后，用户点播放重试的那条路径先 load() 再 play()。位置是 src/components/layout/BrandScene.tsx。现在视频出错后只会退回静帧，并不会自动调用 play()。要改的是出错之后用户点播放重试的路径，不改 onError 本身。播放后的暂停和恢复仍然不能调用 load()，那会丢掉当前帧。审查人是前端和 UX。UX 负责核对暂停和恢复不丢当前帧。来源是前端、SEO。
 edges: none
 note: P3。待派，本次文档更新不实施。已核对 main：src/lib/admin/enroll.ts 的 RESET_2FA_CONFIRM 已含「重置后，对方可能还要等最多 10 分钟才能重新登录。」，tests/admin-enroll-347-fe.test.ts 已断言该句。该项来自 UX，#454 已经改过，不列入剩余工作。
 ```
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 POST-LAUNCH-P3：上线后小任务
沿用分支 task/POST-LAUNCH-P3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：4302cac8deb6f15e7cd41d131060fbc950202abc3147d79a2d5912f1e7e46be3
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
未派发。GitHub 上还没有对应 issue，编号写待开 issue，本登记不新开 issue。实施时前端、后端、SEO、UX 按条目审查。改到 src/lib/server、src/auth.ts、scripts、security-headers.ts 的条目走全栈安全审。不新增后台登录。单 IP 登录总数不超过 26。文档和 PR 不写连接串、密码、主机名或 IP。条目如下。（1）/brand 下文件名无 hash 的 mp4，在 next.config.ts 的 headers() 设置 Cache-Control 为 public, max-age=86400, stale-while-revalidate=604800。不加 immutable。Cloudflare 浏览器缓存 TTL 目前把源站覆盖成 max-age=14400，PR 里写明这一层，并请运维调整或确认。来源是运维、UX。（2）清理没人引用的大文件。磁盘上是 public/brand/packjoyu-industrial-city-v3-loop.gif（13.2MB）和 public/brand/packjoyu-industrial-city-v3-loop-preview.gif（8.3MB），以及其他旧 GIF。删除前用 rg 确认无引用。登记时 src/lib/home/brandMedia.ts、tests/home-brand-media.test.ts、e2e/home-media.spec.ts 仍出现预览 GIF 文件名，有引用的文件先改引用再删。实施时 e2e/home-media.spec.ts 里「不请求 GIF」的断言要改成匹配任意 .gif 请求，不能删掉。现在三处断言的是路径等于 /brand/packjoyu-industrial-city-v3-loop.gif。改成任意以 .gif 结尾的请求都为空，断言本身保留。来源是运维、#444 后续、前端。（3）/og 下的 404 响应改为 Cache-Control: no-store。动态文章 og 和关于页 og 的 404 已经是 no-store，这次补静态 /og 未命中时仍被 1 天缓存头盖住的情况。验收：curl 请求一个不存在的 /og/*.jpg，返回 404，且 Cache-Control 为 no-store。/og/home-en.jpg 的响应头保持 public, max-age=86400, stale-while-revalidate=604800，不加 immutable，不加 s-maxage。来源是 SEO 上线检查。（4）security-headers.ts 的 Permissions-Policy 去掉 Chrome 不认识的 bluetooth。来源是 UX。（5）一个预加载的 CSS 在加载后几秒内未被使用，控制台出现警告。从 src/app/[locale]/layout.tsx 引入的全局样式查起，查清是哪一个文件，然后修掉。来源是 UX。（6）按账号限流返回 429 时补 Retry-After 头和 retryAfter 字段。当前 enroll 与 confirm 的 429 走 src/lib/server/admin/guard.ts 的 jsonErr，响应只有 error。询盘和样品接口故意不返回该字段，避免探测邮箱，这两处保持原样。来源是测试复验 #432。（7）Auth.js 默认登录页把密码框渲染成 type=text。由全栈评估后再修，配置入口在 src/auth.ts。来源是测试复验。（8）scripts/admin-reset-initial-password-lib.mjs 仍有 export { ARGON, firstLine }，去掉遗留的 firstLine 再导出，并同步 admin-reset-initial-password-lib.d.mts。来源是 #457 审查。（9）src/lib/server/ratelimit/redis.ts 解析批量回复时，bulk 长度只有 -1 视为 null，其他负数视为错误。createRateLimitStore 增加运行时明文连接检查。重置脚本判断生产环境时要同时认 VERCEL_ENV。rateLimitEnv 拼 key 前缀时已经回退到 VERCEL_ENV。productionRedisProblem 和 upstash 的 http 拒绝仍只比较 APP_ENV。这次补的是这两处生产判断。来源是 #454 审查。（10）部署 smoke（scripts/smoke.ts 与 tests/smoke.test.ts）里，401 清除会话 cookie 的断言改成白名单。只允许 2 个会话 cookie 名、空值、Max-Age=0 或 1970 过期、HttpOnly、Path=/，以及 SameSite=Lax 或 SameSite=Strict、Secure。除此之外一律失败。来源是全栈确认。（11）首页城市场景 video 出错之后，用户点播放重试的那条路径先 load() 再 play()。位置是 src/components/layout/BrandScene.tsx。现在视频出错后只会退回静帧，并不会自动调用 play()。要改的是出错之后用户点播放重试的路径，不改 onError 本身。播放后的暂停和恢复仍然不能调用 load()，那会丢掉当前帧。审查人是前端和 UX。UX 负责核对暂停和恢复不丢当前帧。来源是前端、SEO。
有效范围：
e2e/home-media.spec.ts
next.config.ts
public/brand/packjoyu-industrial-city-v3-loop-preview.gif
public/brand/packjoyu-industrial-city-v3-loop.gif
scripts/admin-reset-initial-password-lib.d.mts
scripts/admin-reset-initial-password-lib.mjs
scripts/smoke.ts
security-headers.ts
src/app/[locale]/layout.tsx
src/app/api/auth-admin/enroll/confirm/route.ts
src/app/api/auth-admin/enroll/route.ts
src/auth.ts
src/components/layout/BrandScene.tsx
src/lib/home/brandMedia.ts
src/lib/server/admin/guard.ts
src/lib/server/ratelimit/index.ts
src/lib/server/ratelimit/redis.ts
tests/home-brand-media.test.ts
tests/og-static-cache.test.ts
tests/ratelimit.test.ts
tests/smoke.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "POST-LAUNCH-P3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
