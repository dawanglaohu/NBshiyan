---
type: task
id: ANALYTICS-ROLLUP
status: done
module: M5
origin: issue-ledger-20261024
---

# ANALYTICS-ROLLUP　统计按天汇总

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M5]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#477
- 合并提交：`90b2658d2600859ed0a71d4b09e422e1b42a783d`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。本轮按单独 cron 入口接入，没有收进 jobs/registry.ts。

## 输入 / 产出

- **输入**：原始统计行需要按站点本地日汇总。
- **产出**：按天写入汇总表，并由定时调用写入进度。
- **有效路径**：`.github/workflows/ci.yml`、`deploy/cron.nbshiyan`、`prisma/schema.prisma`、`src/app/api/admin/cron/analytics-rollup/route.ts`、`src/lib/analytics/rollup-plan.ts`、`src/lib/server/analytics/rollup.ts`、`src/lib/server/cron-alert.ts`、`tests/analytics-rollup.http.db.test.ts`、`tests/analytics-rollup.test.ts`、`tests/cron-analytics-rollup.test.ts`

## 验收标准

已由 PR #477 于 2026-10-25 合入 main。合并提交 90b2658d2600859ed0a71d4b09e422e1b42a783d。统计按天汇总。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `prisma/schema.prisma:494` — AnalyticsRollupDay：siteDate 主键，另有 timezoneRevision、completedAt、eventCount、sourceMaxReceivedAt
- `prisma/schema.prisma:508` — AnalyticsDailyRollup：四维唯一，productSlug 空值存空字符串
- `src/lib/analytics/rollup-plan.ts:4` — ROLLUP_MAX_DAYS = 7
- `src/lib/analytics/rollup-plan.ts:64` — isSmokeAnalyticsPath：去掉查询串和片段后，路径段以 nbs-smoke- 开头才排除
- `src/lib/analytics/rollup-plan.ts:72` — eligibleSiteDates：只用已经结束且在 recomputableFrom 内的站点本地日
- `src/lib/analytics/rollup-plan.ts:93` — selectRollupDates：最早未完成日优先；迟到或旧时区代次会重算
- `src/lib/analytics/rollup-plan.ts:120` — aggregateSiteDay：按 kind、locale、productSlug 计数，uniqueBrowsers 只是个数
- `src/lib/analytics/rollup-plan.ts:177` — latestContiguousDate：从最早一天起连续日期的最后一天
- `src/lib/server/analytics/rollup.ts:22` — 作业名 analytics-aggregate，owner analytics-rollup
- `src/lib/server/analytics/rollup.ts:60` — utc()：timestamptz AT TIME ZONE 'UTC'
- `src/lib/server/analytics/rollup.ts:67` — notSmokeSql：与 isSmokeAnalyticsPath 同一规则
- `src/lib/server/analytics/rollup.ts:227` — writeDay：一个事务里续租、锁设置、删当天汇总行、重写、upsert 进度
- `src/lib/server/analytics/rollup.ts:295` — runAnalyticsRollup：先占租约，一天一个事务，最后完成租约
- `src/lib/server/analytics/rollup.ts:348` — isSiteDateRolledUp
- `src/lib/server/analytics/rollup.ts:359` — rolledUpDatesBefore
- `src/lib/server/analytics/rollup.ts:375` — latestContiguousRolledUpDate：只看当前时区代次
- `src/app/api/admin/cron/analytics-rollup/route.ts:16` — Bearer CRON_SECRET；忙则 409；失败告警并审计
- `src/lib/server/cron-alert.ts:48` — alertAnalyticsRollupIssue：只含任务名、错误码和已完成天数
- `.github/workflows/ci.yml:102` — 数据库测试接入既有 PostgreSQL 17 串行步骤，skipped 与 fail 门禁不变
- `tests/analytics-rollup.test.ts:33` — 跨日边界、秋令时、冒烟排除、迟到重算、天数上限、表不含个人标识
- `tests/analytics-rollup.http.db.test.ts:39` — 真实 PostgreSQL：跨日、冒烟、重跑、迟到、7 天上限、时区切换、租约互斥
- `deploy/cron.nbshiyan` — 每 5 分钟在容器内请求 /api/admin/cron/analytics-rollup；409 跳过；失败不重试
- `src/app/api/admin/cron/analytics-rollup/route.ts` — 失败只告警一次；审计抛错只记日志
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
后续仍留着，本轮不改汇总逻辑，也不改 schema：
- 不带 path 的 model_* / chat_start 若被冒烟脚本发出，现有规则会计入汇总。请运维确认冒烟事件都带 nbs-smoke- 路径段。
- uniqueBrowsers 按 kind、locale、productSlug 分组，各组不能相加当作当日独立访客。统计页做的时候要单独算。
- loadEvents 把一整天的原始行读进内存。量变大后再改成 SQL 分组聚合。
- latestContiguousRolledUpDate 只是删除上限。RETENTION-CLEANUP 仍须逐日用 isSiteDateRolledUp 和当前时区代次过滤。
- 设计里的统一入口是 jobs/registry.ts 和 /api/admin/cron/operations。本轮按单独路由接到 cron。收进 registry 另立任务。
<!-- notes:end -->
