---
type: task
id: BE-RATELIMIT-P3
status: done
module: M3
origin: issue-ledger-20261024
---

# BE-RATELIMIT-P3　限流 P3 与 TCP Redis 存储

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：无
- GitHub：#432
- PR：#454
- 合并提交：`3c45e699c41c0e0c01efbba5f4d2e58746193944`
- 审查：全栈审查
- 登记状态：已落地

已由 PR #454 于 2026-10-24 合入 main。合并提交 3c45e699c41c0e0c01efbba5f4d2e58746193944。issue #432 已关闭。剩余 P3 见 POST-LAUNCH-P3。

## 输入 / 产出

- **输入**：现有 MemoryStore、UpstashStore，以及重置脚本的清限流结果。
- **产出**：文档或实现覆盖账号级 key 的清理边界；reset 脚本在正常部署里清限流成功；TCP Redis 的 RateLimitStore。
- **有效路径**：`src/lib/server/ratelimit/index.ts`、`src/lib/server/admin/account-rate-limits.ts`、`scripts/admin-reset-initial-password-lib.mjs`、`deploy/docker-compose.yml`

## 验收标准

(a) 真实 IP 和 login-ip 桶在重置后不清，全栈已接受。文档或可选实现二选一，PR 正文说明选择，并有测试或文档覆盖。(b) 写清 reset 脚本 rate_limit=failed 的根因。正常部署下输出 rate_limit=cleared。失败路径不泄露 key、邮箱或令牌，有测试。(c) 增加 TCP Redis 的 RateLimitStore，不新增依赖。接口测试与现有两种存储相同：hit 原子、refund、清当前和上一个窗口、出错 throw。同一 PR 不删除 srh 和 srh-tls。accountRateKeys 与 accountOnlyRateKeys 的一致性测试仍通过。失败模式按路由保持不变。不改 package.json 和 lockfile。tsc、lint、test 和 admin guard 检查通过。改到 src/lib/server，走全栈审查。文档和 PR 不写连接串、密码或主机名。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/server/ratelimit/redis.ts:251` — TCP Redis 的 RedisStore。
- `src/lib/server/ratelimit/redis.ts:257` — hit 在同一次写入里 INCR，再 PEXPIRE NX。
- `src/lib/server/ratelimit/redis.ts:110` — bulk 长度小于 0 都当成 null。只把 -1 当 null 见 POST-LAUNCH-P3。
- `src/lib/server/ratelimit/index.ts:95` — createRateLimitStore 按 RATE_LIMIT_STORE 选择 memory、upstash、redis。运行时明文连接检查见 POST-LAUNCH-P3。
- `src/lib/server/admin/account-rate-limits.ts:11` — 只清账号能算出的 key。真实 IP 和 login-ip 不在这里。
- `scripts/admin-reset-initial-password-lib.mjs:307` — productionRedisProblem 只在 APP_ENV 为 production 时拒绝明文 redis。同时认 VERCEL_ENV 见 POST-LAUNCH-P3。
- `scripts/admin-reset-initial-password-lib.mjs:480` — clearAccountRateLimits。正常部署输出 rate_limit=cleared。
- `deploy/docker-compose.yml:101` — redis 服务仍在。
- `deploy/docker-compose.yml:121` — 同一文件保留 srh 和 srh-tls。去掉它们是以后的部署 PR。
- `tests/ratelimit.test.ts:112` — RedisStore 的 hit、refund、清窗口与出错 throw。
- `tests/admin-reset-initial-password.test.ts:345` — redis 清理打印 rate_limit=cleared，输出不含密码。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- PR #454，合并提交 `3c45e699c41c0e0c01efbba5f4d2e58746193944`。`git show --stat` 是 26 个文件，含 `src/lib/server/ratelimit/redis.ts`、`index.ts`、`refund-lua.ts`、`account-rate-limits.ts`、重置脚本、`deploy/docker-compose.yml`、`prod-env-check.ts` 和对应测试。不新增依赖。
- 真实 IP 和 login-ip 桶在重置后不清。账号能算出的 key 清当前窗口和上一个窗口。失败路径不输出 key、邮箱或令牌。
- srh 和 srh-tls 留在 compose 里。TCP Redis 是多出来的一种存储，不是这次替换 REST。
- 剩余 P3 见 POST-LAUNCH-P3：按账号 429 的 Retry-After、bulk 长度、createRateLimitStore 的明文连接检查，以及重置脚本判断生产环境时同时认 VERCEL_ENV。issue #432 已关闭。
<!-- notes:end -->
