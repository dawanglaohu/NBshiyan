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

已由 PR #454 于 2026-10-24 合入 main。合并提交 3c45e699c41c0e0c01efbba5f4d2e58746193944。issue #432 已关闭。审查留下的按账号 429、批量长度和明文连接检查见 POST-LAUNCH-P3。

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
_落地前回填：`路径:行号` — 作用。_
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
_落地前回填实现选择、失败教训与维护约束。_
<!-- notes:end -->
