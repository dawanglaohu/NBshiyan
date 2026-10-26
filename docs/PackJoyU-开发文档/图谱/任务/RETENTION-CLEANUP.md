---
type: task
id: RETENTION-CLEANUP
status: done
module: M5
origin: issue-ledger-20261024
---

# RETENTION-CLEANUP　保留期清理

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M5]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#479
- 合并提交：`45ada7a22131646f3be96d56f5c5baa22ce4d7f5`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。询盘仍是 730 天和 [deleted] 匿名化。任务说明里的 90 天没有落地。没有新增聊天清理。

## 输入 / 产出

- **输入**：原始统计行和汇总表需要按保留期删除。
- **产出**：每天定时清理过期行。默认只演练，环境变量精确等于 delete 才删除。
- **有效路径**：`.github/workflows/ci.yml`、`deploy/cron.nbshiyan`、`src/app/api/admin/cron/retention-cleanup/route.ts`、`src/app/api/inquiries/route.ts`、`src/lib/analytics/rollup-plan.ts`、`src/lib/server/admin/inquiries.ts`、`src/lib/server/analytics/retention-cleanup.ts`、`src/lib/server/analytics/retention-plan.ts`、`src/lib/server/analytics/rollup.ts`、`src/lib/server/cron-alert.ts`、`src/lib/server/jobs/lease-repo.ts`、`src/lib/server/privacy.ts`、`src/lib/server/retention.ts`、`tests/retention-cleanup.http.db.test.ts`、`tests/retention-cleanup.test.ts`

## 验收标准

已由 PR #479 于 2026-10-25 合入 main。合并提交 45ada7a22131646f3be96d56f5c5baa22ce4d7f5。保留期清理。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/server/retention.ts:5` — 再导出 `RAW_EVENT_RETENTION_MS`，不另写 30 天
- `src/lib/server/retention.ts:8` — 汇总保留 13 个日历月
- `src/lib/server/retention.ts:36` — 聊天和询盘天数，沿用询盘默认 730 天
- `src/lib/server/analytics/retention-plan.ts:29` — 原始事件删除下限对齐可重算起点的站点本地日
- `src/lib/server/analytics/retention-plan.ts:72` — 按代次、连续上界和重算下限把站点日分成可删或跳过
- `src/lib/server/analytics/retention-cleanup.ts:133` — 删除条件同时要求 `occurredAt` 和 `receivedAt` 早于截止点
- `src/lib/server/analytics/retention-cleanup.ts:95` — 释放 `analytics-aggregate` 租约，结果写到 `analytics-retention`
- `src/lib/server/analytics/retention-cleanup.ts:259` — 领取租约时保留汇总行已有的状态
- `src/lib/server/jobs/lease-repo.ts:197` — `claimPreservingStatus` 只更新租约字段
- `src/lib/server/jobs/lease-repo.ts:293` — `completeSeparately` 在同一事务里释放租约并写另一行
- `src/lib/analytics/rollup-plan.ts:111` — 时区代次不符就重算，包括改时区后的空日
- `src/lib/server/analytics/rollup.ts:183` — 新鲜度只查当前代次
- `src/lib/server/cron-alert.ts:70` — 保留清理失败告警，复用现有发送函数
- `src/app/api/admin/cron/retention-cleanup/route.ts:27` — 失败和未捕获异常各发一次告警，409 不发
- `deploy/cron.nbshiyan:10` — 每天 03:30 调保留清理
- `src/app/api/inquiries/route.ts:122` — 新询盘 `retainUntil` 改用同一天数函数
- `src/lib/server/admin/inquiries.ts:5` — 后台顺延改用同一天数函数
- `src/lib/server/privacy.ts:122` — 既有询盘匿名化写成 `[deleted]`，不删行
- `src/lib/server/privacy.ts:152` — `findInquiryForReply` 仍要求 `anonymizedAt` 为空
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- 默认 dry-run。只有环境变量精确等于 `delete` 才删分析行。
- 原始事件和两张汇总表分批删除。每批 5000 行，每次运行合计 20000 行，事件先删。
- 删除还要求 `occurredAt` 早于截止点。晚到但仍落在可重算窗口里的事件留下。
- 时区切换后的空日会重算到新代次，计数写成 0。连续上界可以越过这一天。
- 清理和汇总共用 `analytics-aggregate` 租约。清理结果写在 `analytics-retention`，不覆盖汇总的失败状态。
- 清理失败走现有 cron 告警。
- 询盘保持 730 天和 `[deleted]` 匿名化。任务说明里的 90 天没有落地，交给 PM。
- 没有新增聊天清理，也没有物理删除询盘。从没汇总过的过期事件先只计数。
- 不改 schema，不改隐私页正文，不改 `docs/PackJoyU-开发文档`。
- 测试在 `tests/retention-cleanup.test.ts` 和 `tests/retention-cleanup.http.db.test.ts`。数据库测试已接进 CI 的 PostgreSQL 回归步骤。
<!-- notes:end -->
