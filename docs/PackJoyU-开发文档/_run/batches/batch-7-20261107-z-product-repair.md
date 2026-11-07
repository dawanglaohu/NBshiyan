---
batch: 7
tasks: M2-T3, M3-T16, M3-T17, M3-T21, M3-T23, M3-T24, M3-T4, M5-T3, M5-T7
date: 2026-11-07
verdict: open
tests: fail
pr: https://github.com/dawanglaohu/NBshiyan/pull/536
repair_schema: 1
note: 第 7 批后补记录：按 Chief 采纳的 R7 非 UTC 归属裁决（adopt=take(A)）与前端技术裁决（pick=A high 0.82）新增独立产品返工；原两项测试契约 R7-T14077261、R7-T31416198 保持 todo 不改写。非 UTC 会话日界起点事件丢失已由失败证据证实（run 42341518872，aggregate 9 pass/2 fail）；watermark 非 NULL 跨会话与汇总时间戳覆盖仍未执行，验收由同一 CI 头证明。本记录不是重新收口，只登记新增产品返工。
---

本记录按 UTC 记日。它不是第 7 批的重新收口：原记录 `batch-7-20261107` 的 verdict、两条返工围栏与 note 均不改写，本记录只登记根据归属裁决与技术裁决新增的一条独立产品返工。

## 来源与归属

- 归属：`language-batch7-r7-routing-corrected-20261107.md`，`adopt=take(A)`，`band=medium`（A 0.80 / B 0.20），Chief 已核定采纳。原两张测试卡 `R7-T14077261`（E-82 服务路径）与 `R7-T31416198`（同连接非 UTC 边界）保持 `todo`，契约不降、不改写。
- 技术方案：`frontend-batch7-non-utc-decision-20261107.md`，`jev-1.14.0 pick=A high 0.82`（A 0.91 / B 0.09），一次统一参数侧 UTC 转换，覆盖 9 个时间戳参数点；最后一次窄补实见 `frontend-batch7-non-utc-test-design-20261107.md`（真实产品事务内透传适配器，类型通过、待真实 CI）。
- 失败证据：run `42341518872` / `testing-ci-42341518872.md`。同一 `loadEventsAtSnapshot`、同一数据，UTC 会话返回 `tz-at-start` 与 `tz-at-end` 两条；`Asia/Shanghai` 同事务会话仅剩 `tz-at-end`，日界起点事件被丢弃（`analytics-aggregate.db.test.ts:461`，`not ok 11`）。`watermark` 跨会话对照 `:465-513` 因 `:461` 先失败尚未执行。

## 返工任务

```task
stable-key: m5-t3-non-utc-param-binding
title: 修复 M5-T3 非 UTC 会话下的聚合时间语义
module: M5
source-tasks: M5-T3
depends-on: M5-T3
input: 失败证据 run 42341518872 / testing-ci-42341518872.md：同一 loadEventsAtSnapshot、同一数据，UTC 会话返回 tz-at-start 与 tz-at-end 两条；同一事务内 SET LOCAL TIME ZONE 后 SHOW TimeZone 自证 Asia/Shanghai，仅剩 tz-at-end，日界起点事件被丢弃（analytics-aggregate.db.test.ts:461 not ok 11）。固定头 1149aad688f6bba955f85e77de7aadd6344852c7 的 aggregate-repo.ts:58-60 用 JS Date 直接绑定 occurredAt>=start、occurredAt<end、receivedAt<=cutoff；写入侧 :118 completedAt、:120 sourceMaxReceivedAt（可空）、:121-122 now 与 aggregate.ts:100-101 的 createdAt/updatedAt 同样直接绑定 timestamp(3) 列。仓库既有 utc() 约定见 rollup.ts:59-62、event-repo.ts、settings-repo.ts。参数实际类型与驱动绑定方式尚未取证，根因不作断言。watermark 跨会话对照 :465-513 因 :461 先失败尚未执行；aggregate.ts 汇总时间戳不被 watermark 对照覆盖，二者为未测风险。技术裁决（jev-1.14.0 pick=A high 0.82）选定参数侧统一 UTC 转换：不迁 schema、不强制被测会话 UTC、不在测试中 pin UTC。
output: 把 M5-T3 新仓库层的 9 个时间戳参数点统一改为仓库既有 utc() 写法：aggregate-repo.ts:58-60 三处读；aggregate-repo.ts:118 completedAt、:120 sourceMaxReceivedAt（可空）、:121-122 now；aggregate.ts:100-101 汇总 INSERT 的 createdAt/updatedAt。保留毫秒精度、sourceMaxReceivedAt 的 NULL 与非 NULL 语义、timezoneRevision/sourceMax 单调守卫、occurredAt/receivedAt 现有索引可用性（只在参数侧 cast，>= / < 起含末不含不变）。在 tests/analytics-aggregate.db.test.ts 新增第 12 条测试（原 11 条不动）：用测试层透传适配器包住产品自己的 AggregateDb.$transaction，在同一真实 Prisma 事务内先 SET LOCAL TIME ZONE、SHOW TimeZone 断言并记录 pg_backend_pid，再把同一个 tx 交回产品原回调；回调后再核 PID 与时区，断言 proof.calls===1，options（isolationLevel RepeatableRead、maxWait 5000、timeout 15000）原样透传、不改写。固定 now=2026-03-01T10:00:00.123Z，用相同业务输入跑两轮（每次 seed 的租约时钟与事件自增 ID 会变化，不参与本测试比较）：先 UTC 轮，再重播相同业务输入跑 Asia/Shanghai 轮；各轮提交后在显式 UTC 事务内以 to_char(...MS) 读回汇总行与 watermark，再 deepEqual 两会话的聚合结果与落库值。新用例继承原套件既有预算，不另设 180 秒或任何新超时。不模拟 SQL、不复制聚合逻辑、不加产品测试钩子，不碰全局或库级时区。不修改 R7-T31416198 已写的既有断言。
acceptance: 1) 非 UTC 会话结果与 UTC 完全一致，且 tz-at-start 事件保留（analytics-aggregate.db.test.ts:461 通过，不跳过、不放宽、不改写成记录偏移）。2) 同一非 UTC 连接上 watermark 跨会话对照 :465-513 实际执行并通过（非空跑、非仅 UTC 会话执行），该段覆盖的是非 NULL watermark 的跨会话一致性；sourceMaxReceivedAt 的 NULL 语义由新增第 12 条的空事件日单独验证，不归原段、不写成原段已覆盖两态。3) aggregate.ts:100-101 的汇总时间戳由新增第 12 条测试单独证明：适配器在同一个真实 Prisma 事务内证明时空（SET LOCAL 与 SHOW TimeZone 前后断言、pg_backend_pid 前后一致、同一 tx 交回产品回调、options 原样透传、proof.calls===1）；固定毫秒 now，UTC 与 Asia/Shanghai 两轮各自在显式 UTC 事务内 to_char(...MS) 读回后 deepEqual；辅助锚点：有事件日汇总两列 createdAt/updatedAt=10:00:00.123、有事件日 watermark sourceMaxReceivedAt=09:00:00.123、无事件日 sourceMaxReceivedAt 为 NULL 且 eventCount=0；不以固定期望值替代两会话比较，不以 watermark 对照总绿代替这一项。4) 既有 11 条用例（含 R7-T31416198 已写断言）逐字不变，仅追加第 12 条；原两项测试契约不降。5) 允许并保留 UTC 对照组与显式 UTC 读回（原测试即如此设计）；只禁止把被测非 UTC 会话强制/pin 成 UTC 来掩盖问题，禁止产品侧用连接串或 SET 强制会话 UTC。6) 新用例继承原套件既有预算（不另设 180 秒或任何新超时）；未迁 schema、无 skip；tsc、eslint、diff --check 通过，PG 用例在真实新 CI 上执行。
edges: E-56, E-57
paths: src/lib/server/analytics/aggregate-repo.ts, src/lib/server/analytics/aggregate.ts, tests/analytics-aggregate.db.test.ts
estimate: 1d
severity: S2
jev: model=jev-1.14.0 adopt=take(A) routing=A medium-0.60 technical=A high-0.82
```

## 边界与未验证

- 产品实现写窗未开：本记录只登记任务与契约，不改产品源码、测试或 CI。
- 本机无 PG：原 `:461` 已在 run `42341518872` 真实执行并失败；`:465-513` 因前一条断言失败未到达；新增第 12 条尚未正式实施/执行，其设计仅做到类型与 lint 通过。修复后的真实验收待新 CI，CI 前不写通过。
- 参数实际类型与驱动绑定方式尚未取证，本记录不把具体机制写成已证根因；watermark 写入与汇总时间戳偏移属按同一根因推定的未测风险。
- 本记录不改写原记录、不改原两张 R7 契约；后续重收口 `clean` 须另写新记录，且本批三条返工全部 `done` 后才行。
