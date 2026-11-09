# B9-BATCH-UNITS-REVAL-G1：18 项共享章节只读复验

- 任务：`B9-BATCH-UNITS-REVAL-G1`（Chief，2026-11-09），第 1 组 18 项
- 文档固定头：`920db0f12f3eb45534d347281ad3d82e0e69bd10`（tree `69eefad05225e576bd4b3b3d2cc7e06b670590a9`，父 `bded1728`）
- 已落地代码：按已核 main `042c7d24c0a6b879355fc6b4c7454543a91475fe` 的 Git 对象读取（`git show 042c7d24:<path>`）
- 补丁：`m5t11-batch-units-20261109`（源版本 `a4d1bf67…`），只改 08/09/18 四处源文与派生
- 只读纪律：未运行 status/verify/build/landed，未改任何标记、源码、分支或任务卡；未启动数据库/服务/测试；仅写本目录 `revalidation-g1-*`
- 结论性质：只核共享章节影响，不重审整个项目、不重跑历史测试、不构成代码验收或发布许可

## 1. 四处源文落实裁决 A 的独立核对

| 裁决 A 要点 | 源文落实 | 判定 |
|---|---|---|
| 聚合批次按**站点自然日**计，`maxBatchDays≤500` | 08 jobs 段“聚合的批次以站点自然日计（maxBatchDays≤500）”；09 L86 同；18 行“聚合batch≤500按站点自然日计” | 落实 |
| 分析保留按**删除行**计：5,000 行/DELETE 批次、20,000 行/轮、三表合计、每批独立事务 | 08 jobs 段、09 L73、09 L86、18 行四处一致 | 落实 |
| 其他作业保留各自 500 工作单位限制，不放宽 | 08“其他作业沿用各自既定的500工作单位限制”；18“其他作业的既定批量限制不放宽” | 落实 |
| 55s 是**时间预算**，不等于行数上限 | 09 L86“每次max55s（时间预算，不等于行数上限）”；08/18 仍写总截止 55s | 落实 |
| 不暗示生产删除授权 | 09 L73“90d聊天清理…另有明确生产保留授权、未获授权保持dry-run”原句保留；18 授权策略行未改 | 无越界 |
| 不暗示 5,000 行负载已测 | 四处均写“生产配置”，无“已测/已验证/通过”措辞 | 无越界 |
| 不把“所有作业”改解释成 500 天 | 08/18 明确“其他作业沿用各自既定限制” | 无越界 |

diff 事实：`git diff bded1728 920db0f1 -- 02-设计/08 02-设计/09 04-执行/18` 共 4 行增删（08 一行、09 两行、18 一行），无其他源文改动。

## 2. 18 项矩阵

| # | 任务 | contractHash（前 12） | 结论 | 依据（main 042c7d24 / 文档 920db0f1） |
|---|---|---|---|---|
| 1 | ANALYTICS-ROLLUP | `2f064b49a4eb` | 不适用 | 旧汇总入口在 main 已退役为 410 `route_retired`（`analytics-rollup/route.ts:21-28`），无 DB 写入；活动聚合归 M5-T8 |
| 2 | M1-T2 | `14b9d6b8c533` | 不适用 | 交付共享 schema/DTO；四处变更句无字段/枚举/DTO 义务 |
| 3 | M1-T3 | `a17618d7df55` | 不适用 | 交付品牌媒体/logo；批量单位不涉素材、来源、署名、发布 |
| 4 | M4-T1 | `a924d04734b2` | 不适用 | 聊天首消息+出箱；main `composition.ts:192-193` 未注册聊天作业，未新增义务 |
| 5 | M4-T8 | `09d22100a837` | 不适用 | 聊天 cookie 7d/30d；租约 90s 是作业租约，不是 cookie 期限 |
| 6 | M4-T15 | `080f9d6003fd` | 不适用 | Tawk 移除/隐私文案；用户可见期限与“真实清理未启用”未改 |
| 7 | M5-T1 | `917330813673` | 适用且仍满足 | `jobs/types.ts:7 JOB_LEASE_MS=90_000`；租约/代次原语无批量上限 |
| 8 | M5-T2 | `2c26ac31a45c` | 不适用 | 同意 API/签名 cookie，与批量单位无交集 |
| 9 | M5-T3 | `949213d957f8` | 适用且仍满足 | `aggregate.ts:216` 单位=站点自然日、`:230-231` 超限拒绝；`aggregate-plan.ts:72-91` siteDates 为本地日 |
| 10 | M5-T5 | `07e0a653173c` | 适用且仍满足 | `retention-plan.ts:5-9` 5,000 行/语句、20,000 行/轮（事件+汇总合计）；`:97-111` 切批；`:232` 候选上限 |
| 11 | M5-T6 | `2b8b53d95613` | 不适用 | 事件准入/持久化；不改变接收窗口、去重、白名单 |
| 12 | M5-T7 | `20e4d7eaf8a0` | 不适用 | 客户端 UI/隐私文案；用户可见 30d/13 个月未改，5,000/20,000 不出现在文案 |
| 13 | M5-T8 | `9d1af3f9226a` | 适用且仍满足 | `registry.ts:13/16/259/350`；`cron.nbshiyan:11` */5；其他作业未注册、未放宽 |
| 14 | M5-T9 | `76574a4989e0` | 适用且仍满足 | `day-boundaries.ts:170/181/202` 定义站点日；`aggregate-plan.ts:72-91` 使用 |
| 15 | R7-T14077261 | `85ada3292d38` | 不适用 | 只加 E-82 超范围日测试，不改产品代码 |
| 16 | R7-T21418022 | `e18a9b8300fc` | 不适用 | 时间戳参数 utc() 绑定+第 12 条测试，不涉批量 |
| 17 | R7-T31416198 | `61e02f592371` | 不适用 | 只补非 UTC 会话时间边界测试 |
| 18 | RETENTION-CLEANUP | `53d9aca476ee` | 适用且仍满足 | `retention-cleanup.ts:248-249` 默认值、`:220-231` drain、`:331-338` 三表共用 budget、`:151/174/201` 每批 `$transaction`；dry-run 未变 |

统计：**适用且仍满足 6 项**（M5-T1、M5-T3、M5-T5、M5-T8、M5-T9、RETENTION-CLEANUP）；**不适用 12 项**（其余）；**阻断 0 项**。

## 3. 重点核对结论

**聚合“天”**：`maxBatchDays` 的消费单位在 main 上可证为站点自然日——`aggregate.ts:216` 注释“单位是站点自然日（不是事件数）”，`:230-231` 以 `plan.siteDates.length` 比较并抛 `AggregateBatchExceeded`，不写库；`aggregate-plan.ts:72-91` 的 `siteDates` 来自 `siteLocalDate`/`lateArrivalSiteDates`，不是事件行。`JOB_MAX_BATCH=500` 只在 M5-T8 的 `registry.ts:259` 作为 `maxBatchDays` 传入。

**分析保留“行”**：`retention-plan.ts:5-9` 的常量与注释即行单位；旧链 `retention-cleanup.ts` 的 `drain` 每批 `min(batchSize, 剩余)`，`:331-338` 三表共用同一个 `budget.removed`，即“三表合计”；三个 delete 各自 `$transaction`，即“每批独立事务”。未发现把行数改成天数或反之的实现。

**其他作业限制未被放宽**：main 的 registry 只注册 `analytics-aggregate`（`composition.ts:192-193`），聊天/邮件/运维作业尚未注册；本补丁未改其任务卡或限制。通用清理仍是 `retention.ts:42` `BATCH_SIZE=500` 行/批，未被改成 5,000。

**范围注（非阻断）**：03:30 的旧 `retention-cleanup` 路由自带 270s 预算（`retention.ts:51`、`route.ts:11 maxDuration=300`），与 registry 的 55s 不是同一条链；本补丁的 55s 句属固定作业段，未覆盖旧路由，也未把它改写成 55s。旧路由与新 registry 作业的批量单位相同（5,000/20,000），只有截止预算不同，属既有状态。

## 4. 阻断与残余

- **阻断：无**。四处源文与 main 代码事实一致，未发现“文档要求比实现更严/更松”的实质冲突。
- 残余（交下一责任人知悉，不阻断登记）：
  1. 旧 `retention-cleanup` 路由（270s）与 registry 分析保留（55s）并存，两套预算同单位不同链；文档已分别描述，但读者可能把 55s 误套到旧路由。
  2. `其他作业沿用各自既定的500工作单位限制` 在 main 上只能核到聚合作业；聊天/邮件/运维作业未注册，未来注册时需各自证明 500 工作单位。
  3. 本组未运行数据库/测试/CI；5,000 行负载、PG17 与真实删除均未实测，不能由本报告推出。

## 5. 交付与登记说明

- 证据 JSON：`revalidation-g1-20261109.evidence.json`，`scope=task-contract`，18 项各带当前 `contractHash`、`verdict=pass` 与非空证据串；contractHash 与 `_run/revalidation.json` 及补丁 evidence 模板三方一致（18/18）。
- 登记由唯一集成者执行：`verify --task <ID> --evidence <本 JSON>`；`verify` 只接受 `verdict=pass`，故“不适用”项也在证据正文首句写明，登记后请按正文而非 verdict 字面理解。
- 本组未执行 `verify`，未改 `revalidation.json`/`task-reviews.json`；未 push、未 landed、未清标记。

## 6. 证据文件

| 文件 | bytes | SHA256 |
|---|---|---|
| `revalidation-g1-20261109.evidence.json` | 11,747 | `F43E91528DE6A57428BAE7C80B5C549194A3FD1C110C507915EAF21611FA5A44` |
| `revalidation-g1-20261109.md` | 以群回执为准（本表编辑后重算） | 以群回执为准 |
