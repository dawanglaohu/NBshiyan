---
type: task
id: CI-DB-TESTS
status: done
module: M7
origin: issue-ledger-20261024
---

# CI-DB-TESTS　数据库测试接进 PostgreSQL 17

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#472
- 合并提交：`a3fb6696162fedc5d71b4c9b8a3678823c403351`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。不新增后台登录。未接 admin HTTP 计数和 admin-users-last-admin。

## 输入 / 产出

- **输入**：若干数据库测试在没有 DATABASE_URL 时会跳过，跳过仍算通过。
- **产出**：e2e 的 PostgreSQL 17 步骤串行跑这些测试，跳过不再算通过。
- **有效路径**：`.github/workflows/ci.yml`

## 验收标准

已由 PR #472 于 2026-10-25 合入 main。合并提交 a3fb6696162fedc5d71b4c9b8a3678823c403351。把 analytics 和 chat 的数据库测试接进 PostgreSQL 17。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `.github/workflows/ci.yml:93` — e2e job 在设备会话回归之后、Playwright 之前新增 “Analytics, chat, and other PostgreSQL regressions”：串行跑 analytics、chat、cleanup-lock、job-leases、last-admin、admin-reset，并断言 TAP 的 skipped 为 0、fail 为 0、pass 大于 0。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- `pnpm test` 在没有 `DATABASE_URL` 的 build-and-audit 里会跳过这些数据库用例。e2e job 已有 postgres:17，这一步把它们接上，跳过不再算通过。
- analytics 设置、analytics 写入、job lease、最后一名管理员、重置初始密码都用独立 schema，结束时删除。cleanup lock 只碰事务级 advisory lock。chat 的 loopback 用例写一行访客会话并在 finally 删除。
- 本地 PostgreSQL 17.11 上 pass 56、fail 0、skipped 0。跑完 public 相关表行数为 0，没有残留 schema，也没有残留 advisory lock。
- 未接 admin HTTP 计数（会改 public 的站点设置）和 `admin-users-last-admin`（与 last-admin 数据库测试重复）。设备会话两个文件维持原步骤，不新增后台登录。
<!-- notes:end -->
