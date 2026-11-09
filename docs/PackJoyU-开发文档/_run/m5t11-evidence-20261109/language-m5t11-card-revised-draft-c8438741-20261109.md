# M5-T11 回填修订稿（固定 `c8438741`，供单写集成窗落卡）

- 对象：`c843874110979abb19045482d6699488522dab45`（tree `6f35721236610ab14056a82f9f938ae0950f3345`，父 `803038df`）
- 依据：原拟稿 [backend-m5t11-card-draft-20261109.md](<D:/xiangmu/.codex-plans/NBshiyan-m5-t11/backend-m5t11-card-draft-20261109.md>) 13,322 B `0D237040…`；审校报告 [language-m5t11-card-review-c8438741-20261109.md](<D:/xiangmu/.codex-plans/NBshiyan-m5-t11/language-m5t11-card-review-c8438741-20261109.md>)
- 本稿已落实审校 M1–M8：cron 鉴权表述、`completeSeparately` 只回滚结算事务、计数等式限定终态、普通聚合失败才继续删、等号边界、5,000 批量待数据库核查、授权来源精确化、验收不改写；并落实 Chief 追加的 M9–M11（提交结果未知、入口范围、可重算日的聚合更新）。
- 行号均按 `c8438741` 提交对象实读；源码自 `c8438741` 起零漂移（`src/`、`tests/`、`deploy/` 至 `920db0f1` 差量为空），分支现为 `920db0f1`；CI 接线为本地提交 `bded1728`（`.github/workflows/ci.yml` **+7**，blob `99a79d05…`），非作者静态审**限定 PASS**，但 **PG17/远端 CI 仍未执行**，不预填 CI 行号/未来 SHA；本稿不改任务卡、派生或原稿。
- 批量口径已由数据库核查核清（[db-m5t11-batch-bound-20261109.md](<D:/xiangmu/.codex-plans/NBshiyan-m5-t11/db-m5t11-batch-bound-20261109.md>) 10,460 B `E25367D2…`），Chief 已采纳裁决 A：**聚合按站点日计 `maxBatchDays≤500`，分析保留按删除行数计（5,000 行/DELETE、20,000 行/轮三表合计），其他作业原有 500 工作单位约束不放宽**。源文档补丁已提交 **`920db0f1`**（08/09/18 三源文 + 10 派生）；四组复核已齐 **95/95（18＋29＋30＋18）、登记尚待集成（标记未清）**，本稿不宣称已满足 L86 或已通过复验。

---

## A. `code` 区（替换 `<!-- code:begin -->…<!-- code:end -->` 之间）

```text
`src/lib/server/analytics/retention.ts:63` — `ANALYTICS_RETENTION_KEY = 'analytics-retention'`：operations 请求、registry 与 JobState 的固定 key
`src/lib/server/analytics/retention.ts:81` — `resolveRetentionMode`：请求删除与生产授权同时成立才 delete，否则 dry-run；未授权删除请求记 rejected
`src/lib/server/analytics/retention.ts:287` — `runAnalyticsRetention`：领取共享租约 → 读站点时钟 → 候选 → preflight → 分批删除 → 删后聚合
`src/lib/server/analytics/retention.ts:311` — `claimPreservingStatus` 领取 `analytics-aggregate` 租约（owner `analytics-retention`），与 5 分钟聚合互斥
`src/lib/server/analytics/retention.ts:333` — `persist`：租约释放与状态行写入同一结算事务（`completeSeparately`）；代次/租约/时区不符时**只回滚这次结算事务**（两者都不写，`finish_failed`），不回滚此前已提交的删除批次
`src/lib/server/analytics/retention.ts:375` — 站点时钟读取；revision 与领取时不符直接 FAILED `service_unavailable`，不删除
`src/lib/server/analytics/retention.ts:397` — 只读候选计数（事件/日聚合/日水位），不选 browserHash、path、payloadHash
`src/lib/server/analytics/retention.ts:415` — 同源有界候选：按 `receivedAt,eventId` 排序 `LIMIT maxPerRun`，同批取 eventId 与 occurredAt 站点日
`src/lib/server/analytics/retention.ts:432` — 旧聚合行**存在性**读取（只判行是否存在，不读 revision/watermark 判完整）
`src/lib/server/analytics/retention.ts:154` — `classifyHistoricalDays`：到期（`siteDate ≤` 汇总截止日，等号即到期）/ 可整日重算（`dayStart ≥` 完整原始覆盖起点，等号含）/ retained（旧行留存）/ gap；普通聚合失败日由服务侧记 gap
`src/lib/server/analytics/retention.ts:185` — `coverageOfHistory`：gap→unavailable、retained→partial、否则 complete；近期 complete 不掩盖历史
`src/lib/server/analytics/retention.ts:459` — 删除前对可整日重算日做单日聚合，带 `assertTimezoneRevision: true`
`src/lib/server/analytics/retention.ts:236` — `abortsRetentionRun`：版本冲突或守卫阶段失败必须终止整轮（不记 gap）
`src/lib/server/analytics/retention.ts:240` — `errorCodeOf`：版本冲突→version_conflict、守卫阶段失败→internal_error、批超限→invalid
`src/lib/server/analytics/retention.ts:497` — `runBatch`：每批独立事务、批内续租、写前 revision 守卫、按剩余预算重设 statement/lock timeout
`src/lib/server/analytics/retention.ts:503` — 每批删除前 `assertCurrentTimezoneRevision`；冲突即停本批与后续批次
`src/lib/server/analytics/retention.ts:538` — 只删预检同一 id 清单内的事件，并复查 `receivedAt <= cutoff`
`src/lib/server/analytics/retention.ts:545` — 批次事务成功返回后才累计 `deletedEvents`；提交结果未知的批次不计数、也不能由终态摘要反推；失败批次不计、已计入不重复
`src/lib/server/analytics/retention.ts:552` / `:572` — 删除 `siteDate ≤` 汇总截止日的日聚合与日水位（等号即到期）
`src/lib/server/analytics/retention.ts:586` — 删除后调用既有 `runAggregateOnce`，只重算 `dayStart ≥` 完整原始覆盖起点（等号含）的日，带写前 revision 守卫
`src/lib/server/analytics/aggregate.ts:186` — `assertCurrentTimezoneRevision`：LOCK TABLE + 已有行 `FOR UPDATE`、缺行并发安全插入；40001/40P01/P2034→版本冲突，未知→守卫阶段失败
`src/lib/server/analytics/aggregate.ts:63` / `:150` — `AggregateGuardFailure` 阶段标记；`asPreflightStageError` 只包写前前置，业务失败不误标
`src/lib/server/analytics/aggregate.ts:303` — `aggregateOneDayInSnapshot`：事务未开成/generation/settings 前置失败按守卫阶段；业务写入在保护块外
`src/lib/server/analytics/aggregate.ts:386` — `runAggregateOnce`：整组 RepeatableRead；写前 generation/settings 守卫同分类；天循环与 commit 钩子不在守卫包装内（业务错误不误标），钩子仍在同一事务
`src/lib/server/analytics/aggregate-repo.ts:94` — `readLockedGeneration`：真行锁读 JobState generation
`src/lib/server/analytics/aggregate-repo.ts:117` — `upsertWatermarkGuarded`：按 revision 分流的 WHERE 守卫，`affected≠1` 抛冲突回滚
`src/lib/server/analytics/aggregate-repo.ts:171` — `runInRepeatableReadSnapshot`：事务预算 + `SET LOCAL statement_timeout/lock_timeout`
`src/lib/server/analytics/retention-plan.ts:6` / `:9` — 单批 5,000 **行/条 DELETE**（事件行、日聚合行、日水位行，水位每行＝一天）、单轮 20,000 **行/轮（三表合计）**，两者都是**删除行批次**；作业约定 `batch≤500` 的另一支是**聚合站点日批次**（`maxBatchDays≤500`，按站点自然日计，传给删后 `runAggregateOnce`）；其他作业沿用各自既定的 500 工作单位限制
`src/lib/server/analytics/retention-plan.ts:132` — `eventExpiryCutoff`：`receivedAt ≤ now−30d`（等号即到期）
`src/lib/server/analytics/retention-plan.ts:163` — `rollupExpiryCutoff`：站点本地日 13 个自然月（`siteDate ≤ 截止日` 即到期）
`src/lib/server/analytics/retention-plan.ts:192` — `rawCoveragePlan`：完整原始覆盖起点
`src/lib/server/composition.ts:202` — 注册 `createAnalyticsRetentionJob`；生产组合点缺省由容器 `RETENTION_CLEANUP_MODE=delete` 决定 `deleteAuthorized`，测试可显式注入
`deploy/cron.nbshiyan:16` — 每日 04:30 POST operations `analytics-retention`（鉴权沿用容器 `CRON_SECRET`；请求体只含 `jobKey`，无 `dryRun:false`）；`:15` 旧 03:30 清理行保留
`tests/jobs-runtime.http.test.ts:236` — cron 窄修：唯一性按 `jobKey:'analytics-aggregate'` 有效调度行；5 分钟/55s/旧 rollup 缺席断言保留
`tests/analytics-retention.db.test.ts:43` — 模式判定；`:1029` 默认 dry-run 删 0；`:1061` 未授权 FAILED/forbidden；`:1082` 已授权只删到期行
`tests/analytics-retention.db.test.ts:1291` / `:1322` — D2 同源候选与超上限不逸出；`:1411` 跨日按 occurredAt 归属；`:1436` 可重算先聚合再删
`tests/analytics-retention.db.test.ts:1151` — 历史日无 settle 入口、只报 retained/gap；`:1213`/`:1239`/`:1264` 旧 revision、watermark 落后、闭集前写入
`tests/analytics-retention.db.test.ts:1472` / `:1513` / `:1546` — B2 三阶段中途失败（终态已写 FAILED）：已提交批次的实际差量、返回 `deletedCount` 与 JobState 摘要一致
`tests/analytics-retention.db.test.ts:1579` — D4 双连接/等锁/缺行并发；`:1626` 批间变化；`:1661` preflight；`:1686` 删后聚合
`tests/analytics-retention.db.test.ts:165` — 守卫阶段标记（假 tx）；`:289` 服务级假 DB generation/settings/事务未开启；`:478` 阶段谓词
```

## B. `notes` 区（替换 `<!-- notes:begin -->…<!-- notes:end -->` 之间）

```markdown
- **默认 dry-run 与生产授权**：operations 请求缺省 dryRun，`resolveRetentionMode` 要求“请求删除 + 容器 `RETENTION_CLEANUP_MODE=delete` 注入的 `deleteAuthorized`”同时成立才真删；未授权删除请求记 FAILED/`forbidden`、实际删除 0，只返回候选计数。生产删除授权（B1）未变，本任务不授予。
- **租约、结算与保留期**：与 5 分钟聚合共用 `analytics-aggregate` 租约，结果写独立 `analytics-retention` 行；`completeSeparately` 的代次/租约/时区不符**只回滚这一次结算事务**（租约释放与状态行都不写，`finish_failed`），不表示本轮已提交的删除批次回滚。原始事件按 `receivedAt` 到期（`now−30 天`，等号到期），日聚合与日水位按站点本地日 `siteDate` 13 个自然月（`siteDate ≤ 截止日` 即到期）；单批 5,000 行/条 DELETE、单轮 20,000 行/轮（三表合计）是**删除行批次**；`batch≤500` 的另一支是**聚合站点日批次**（`maxBatchDays≤500`，按站点自然日计，传给删后 `runAggregateOnce`）；其他作业沿用各自既定的 500 工作单位限制。清理行批次条款见 09 L73（`920db0f1` 起写明 5,000 行/DELETE、20,000 行/轮三表合计、每批独立事务）与 `docs/data-retention.md:58`；源文档补丁已提交，**95/95 复核齐、登记尚待集成**，不据此宣称满足 L86 或已通过复验。
- **同源有界候选**：先按 `receivedAt,eventId` 取前 `maxPerRun` 个待删事件 id，受影响日由**同一批**事件的 `occurredAt` 推导；删除只切这份 id 清单并逐批复查 `receivedAt <= cutoff`，不会滑入未分类事件；超上限的第 N+1 条既不删也不分类。
- **历史覆盖（保守口径）**：没有可证明的“接收后已提交”闭集，因此**不判任何历史日“旧聚合完整”**，也不提供 settle 数值入口；旧聚合行仍在只报 `retainedAggregateDays`（仅存在性，不是完整性证明、不冒充当前口径），无旧行或聚合尝试失败记 `gap`；覆盖度 `gap→unavailable`、`retained→partial`。可整日重算日满足 `dayStart ≥` 完整原始覆盖起点（等号含），先聚合再删；**只有校验通过后的普通聚合失败**才记 gap 并继续按 30 天删 raw、不延长保留；守卫阶段失败、版本冲突、预算耗尽终止本轮，不再继续删除。未到期且本轮未重算的日（retained/gap）以及重算事务失败回滚的旧结果，旧行、原 revision 与日聚合逐值不动；本轮成功重算的日会正常更新聚合与水位；已过 13 个自然月的日聚合/水位按到期规则删除。
- **写前守卫与失败阶段**：三个写事务（删除批次、preflight 单日聚合、删后整轮聚合）写前都在事务内原子复核时区 revision；锁序 JobState→SiteSetting，已有行 `FOR UPDATE`、缺行 `INSERT … ON CONFLICT … RETURNING`；40001/40P01/P2034 归一版本冲突（`version_conflict`），55P03/57014/P2028 仍是预算/超时。generation 读取、generation 比较、settings 守卫都属**写前前置**：未知错误打 `AggregateGuardFailure` 并终止整轮，不记 gap、不再删除；其中“事务未开成即打阶段标记”只适用于**删除前单日 preflight 入口**（`aggregateOneDayInSnapshot`），删后整轮入口（`runAggregateOnce`）没有该标记，事务开启失败不得外推为守卫阶段失败。校验通过后的普通聚合失败不被扩大，仍按契约记 gap 并继续 30 天删除。
- **逐批计数**：每批事务成功返回后才累计；只有终态已持久化（SUCCEEDED/FAILED/PARTIAL）且**没有删除事务提交结果未知**时，已确认提交批次的真实删除差量＝返回 `deletedCount`＝JobState 摘要，`deletedCount` 为事件/日聚合行/日水位三类合计；预算耗尽的 `timeout`、结算未持久化的 `finish_failed`、删除事务提交结果未知（连接中断/提交结果不明）均不适用——终态写成功不能证明此前未知提交是否实际发生，摘要只覆盖已成功返回的批次。任何情况下都不宣称整轮回滚。
- **时机边界**：commit/WAL 不在 deadline 检查内；“写入后到期→回滚”只有假 DB 观察；预算耗尽不写终态，租约到期由下一次调度接管。`deploy/cron.nbshiyan` 只加每日 04:30 一行（鉴权沿用容器 `CRON_SECRET`，请求体只含 `jobKey`），旧 03:30 清理行保留；该新增行触发的 jobs-runtime cron 断言已按 `jobKey:'analytics-aggregate'` 唯一性窄修，未删断言刷绿。
- **证据分层**：作者本地纯用例 15/15（R5 记录）；非作者纯验 15/15、3/3 变异变红、独立假 DB 6 条出口；恢复后真库主文件 **41/41**（15 纯 + 26 真库）、相关 **68/68**（17+15+16+9+11），D4 六类真库场景成立；静态独审 R4-S1/R4-S2 限定关闭（R5 静态报告）。**假 DB/PG12.22 本地结果不等于 PG17/CI。**
- **未证/遗留**：CI 接线仅本地提交 `bded1728`、非作者静态审限定 PASS，**PG17/远端 CI 仍未执行**（落地前以 CI 实跑为准）；源文补丁 `920db0f1` 已提交，**95/95 复核齐（18＋29＋30＋18）、登记尚待集成（标记未清）**；“事务未开启”只有假 DB 分类证据，恢复窗未执行该真库场景；注入为合成错误，自然并发本窗只记录归一后的版本冲突（未记录原始 SQLSTATE）；commit/WAL、生产真实删除、双 cron 退役未变；5,000 行负载未实测；任务卡 `status` 仍 `todo`，未 push/PR/landed。
- **验收措辞（不改原验收）**：**任务卡验收文本未改**。验收 3 的“旧完整聚合”在本实现中只记录为“旧聚合行实物保留（retained，存在性观察）”，完整性无法确认时返回 `partial/unavailable`，不宣称旧聚合完整；当前实现不提供 settle 数值入口，也不用残片替换旧行。
```

---

## C. 证据引用（未变，落卡时随卡引用）

| 材料 | bytes / SHA256 |
| --- | --- |
| 恢复后真库复验 `testing-m5t11-r5-postmigration-review-c8438741-20261109.md` | 7,899 B `113E32733DA7935BBC7AA75F080512EF6A1802234F0ACB60FC79AE1A01528BB4` |
| 非作者纯验 `testing-m5t11-r5-pure-review-c8438741-20261109.md` | 6,684 B `44B60A9BAE346F118CB80061BAA6F25C82C2A9A64A5108B3E562604F8939B2EB` |
| R5 静态独审 `db-m5t11-r5-static-c8438741-20261109.md` | 14,618 B `17395477980AABD3057CBC76C142435F9AB2D9AF607B137E3C55B85588181777` |
| R5 作者记录 `backend-m5t11-r5-20261108.md` | 7,120 B `A1BAA3E6A8944552A60229BA66DDAEFB0C4C71A8C3154C65D44FCD4864E7EC59` |
| R4 作者记录 `backend-m5t11-r4-20261108.md` | 5,228 B `9501EA2613DF4A54EEEFFA830286AC190293731D63CFCBBAE044C431C0D7A438` |
| R4 静态独审 `db-m5t11-r4-static-803038df-20261109.md` | 16,070 B `17429395969F34A5A526FBC58386BA22AFF6F7C464C1FF6AB1F6FF0CF7839353` |
| 批量口径核查 `db-m5t11-batch-bound-20261109.md` | 10,460 B `E25367D2CCEA72E85A96BEBAF39341F7281F2B2E03BB476A731BF48A2BE20BCD` |
| 源文档单位补丁 `920db0f1`（tree `69eefad0…`） | 08/09/18 三源文各 1–2 行 + 10 派生；95 项复核已齐、待集成登记（67 项 08+09+18、23 项 09+18、5 项仅 18） |
| G1 独立核对 `revalidation-g1-20261109.md` | 8,167 B `28FD989DA7881C578394C1DD266276617AA905FDF2FF9A4B11EC129E53802CE8`（18/18：6 适用、12 不适用、0 阻断） |
| CI 接线非作者静态审 `testing-m5t11-ci-review-bded1728-20261109.md` | 10,376 B `292A7FBEE275BF0A698C07F09F104F4F21B0297076D2B2AF3B4DAB0200B999FC`（限定 PASS） |

## D. 落卡前仍待（不写成通过）

- **批量口径（Chief 采纳 A，源文已补、登记尚待集成）**：`db-m5t11-batch-bound-20261109.md` 10,460 B `E25367D2…` 已核清量纲；Chief 裁决 A——聚合按站点日计 `maxBatchDays≤500`，分析保留按删除行数计 5,000 行/DELETE、20,000 行/轮（三表合计），其他作业原 500 工作单位约束不放宽，代码不改。源文档补丁**已提交 `920db0f1`**（08/09/18，四组复核齐 18＋29＋30＋18＝95）；**95/95 复核齐、登记尚待集成（标记未清）**，本稿不写“已满足 L86”、不改验收；登记集成后按实际结果落卡。
- **CI/观测**：接线为本地提交 `bded1728`（`ci.yml` +7、blob `99a79d05…`），非作者静态审限定 PASS；**PG17/远端 CI 仍未执行**，`.github/workflows/ci.yml` 行号不预填，CI 实跑与终态另窗收证。
- 任务卡 `status` 仍 `todo`；未 push/PR/landed；生产删除授权（B1）未变。
- 「事务未开启」仅假 DB 分类；注入为合成错误；W1 未记录原始 SQLSTATE。
- 本修订稿为文档拟稿，经非作者译审（`language-m5t11-card-review-c8438741-20261109.md`）后由单写集成窗落卡；**不构成任务通过、CI 通过或生产授权**。
