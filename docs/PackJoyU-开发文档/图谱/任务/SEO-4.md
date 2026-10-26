---
type: task
id: SEO-4
status: done
module: M7
origin: issue-ledger-20261024
---

# SEO-4　生产环境只认 APP_ENV

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#428
- PR：#462
- 合并提交：`42ca1d1403a78ea8683bb6640a34eb2c71f4d22a`
- 审查：全栈审查
- 登记状态：已落地

已由 PR #462 于 2026-10-25 合入 main。合并提交 42ca1d1403a78ea8683bb6640a34eb2c71f4d22a。issue #428 已关闭。运维只核对 APP_ENV 这一个变量是否为 production。不要在文档或 PR 里记录完整环境输出。

## 输入 / 产出

- **输入**：现在仍把 VERCEL_ENV 当作生产兜底的判断。
- **产出**：生产只认 APP_ENV=production。
- **有效路径**：`src/lib/site.ts`、`src/lib/seo/mock.ts`、`src/lib/server/privacy.ts`、`src/lib/server/security.ts`、`src/lib/server/mail/config.ts`、`src/lib/server/admin/enroll-token.ts`

## 验收标准

已由 PR #462 于 2026-10-25 合入 main。去掉 VERCEL_ENV 兜底。src 里不再把 VERCEL_ENV 当成生产（专门断言「只设 VERCEL_ENV=production 仍是非生产」的测试除外）。单测：APP_ENV=production 是生产；只设 VERCEL_ENV=production 不是生产；生产下 TURNSTILE_VERIFY_URL 和 SEO_AUDIT_MOCK=1 都不生效。tsc、lint、test、build 通过。改到 src/lib/server，必须全栈审查。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/site.ts:7` — `isProdEnvFrom` 仅当 `APP_ENV === 'production'` 时为真
- `src/lib/server/security.ts:25` — `turnstileVerifyUrl` 经 `isProdEnvFrom`，生产下忽略 `TURNSTILE_VERIFY_URL`（本文件未改）
- `src/lib/seo/mock.ts:11` — `SEO_AUDIT_MOCK=1` 只在 `APP_ENV` 去空白后非空且不是 production 时打开
- `src/lib/server/mail/config.ts:124` — 发信 mock 与 SEO mock 同一条 `APP_ENV` 规则
- `src/lib/server/privacy.ts:16` — `APP_ENV=production`，或未设 `APP_ENV` 且 `NODE_ENV=production`（非 CI）时拒绝派生哈希密钥；`VERCEL_ENV` 不参与
- `src/lib/server/admin/enroll-token.ts:59` — 本机 http 只在非 `APP_ENV=production` 时作为绑定链接前缀
- `scripts/enroll-token-lib.mjs:26` — 脚本侧 `isProd` 与 TypeScript 相同
- `src/lib/server/ratelimit/index.ts:108` — 远程明文 Redis 的生产拒绝仍调用 `isProdEnvFrom`；本目录未改
- `tests/ratelimit.test.ts:94` — `APP_ENV=production` 仍拒绝远程明文 `redis://`
- `tests/ratelimit.test.ts:99` — 只设 `VERCEL_ENV=production` 不再拒绝
- `tests/app-env-production.test.ts:15` — 生产判定、Turnstile、SEO mock、邮件 mock、隐私哈希、enroll 的集中断言
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
生产门闩是 `APP_ENV` 与字符串 `production` 的精确相等。前后有空白不算生产。未设置 `APP_ENV` 时 `isProdEnvFrom` 为 false，整站按非生产处理（noindex、关闭 IndexNow）。SEO mock 和发信 mock 还要求 `APP_ENV` 去空白后非空，所以未设置时 mock 仍然关闭。只设 `VERCEL_ENV` 打不开它们。

隐私哈希比 `isProdEnvFrom` 多一条：`APP_ENV` 未设置、`NODE_ENV=production`、且不是 CI 时，仍然拒绝回退到 `AUTH_SECRET`。原先 `VERCEL_ENV=preview` 可以豁免这条，现在不能。`NODE_ENV=production` 这条还在。

`rateLimitEnv`（`src/lib/server/security.ts:70`）仍按 `APP_ENV`、`VERCEL_ENV`、`NODE_ENV` 取限流 key 的名字空间，用来隔开共用存储时的计数。它不决定是否生产，本任务没有改它。

限流库没有改。只设 `VERCEL_ENV=production` 时，远程明文 `redis://` 不再被拒绝。`APP_ENV=production` 时仍然拒绝，错误信息不含主机。生产进程若没有 `APP_ENV=production`，这条拒绝、Turnstile 覆盖锁、SEO mock 锁和 enroll 的 https 限制都不会按生产生效。合并和部署前要先有运维的 PASS。

enroll 的 TypeScript 与 `scripts/enroll-token-lib.mjs` 一起改。冻结测试对比两边。只改一边会让本机 http 在脚本和运行时给出不同结果。
<!-- notes:end -->
