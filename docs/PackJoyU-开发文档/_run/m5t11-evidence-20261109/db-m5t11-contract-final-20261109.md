# B9-M5T11-CONTRACT-FINAL-MAP：M5-T11 自身契约与既有证据对应

- 任务：`B9-M5T11-CONTRACT-FINAL-MAP`（Chief，2026-11-09），沿原主审续接
- 文档固定头：`920db0f12f3eb45534d347281ad3d82e0e69bd10`（tree `69eefad0…`，父 `bded1728`）
- 源码固定：`c843874110979abb19045482d6699488522dab45`（tree `6f357212…`，父 `803038df`，分支 `task/M5-T11`）；`git diff c8438741 920db0f1 -- src tests deploy` 为空
- 已落地前置：按 main `042c7d24c0a6b879355fc6b4c7454543a91475fe` 的 Git 对象读取（M5-T1/T3/T5/T8/T9 等）
- 只读：未重跑数据库/测试/整份源码独审，未运行 status/verify/build/landed，未写任务树、派生或任务卡；仅写本目录 `db-m5t11-contract-final-*`
- 范围声明：本报告只核 **M5-T11 自身契约**（三项验收 + E-48/E-82）与既有 R5/恢复后 41＋68 证据的对应；95 项共享章节复验是独立记录，**不替代**本条，也不被本条替代

## 1. 结论（先给）

**当前 `_run/M5-T11.evidence-template.json` 不能直接登记**：它是 `bded1728` 期的旧模板（`contractHash=6a8c38d7…`、`evidence=[]`、`verdict=pending`），不是现行权威值；`task-reviews.json` 的 M5-T11 旧记录同为陈旧值。现行 M5-T11 契约哈希为 `67056941490af50ad3bf52c429ea488c4ebf00af1e007ba0611ba1bc7e85a8af`（`docs-data.js` handoff.contracts 与 `_run/patches/m5t11-batch-units-20261109.evidence.json` 两处一致）。旧模板只在 `status --task` 时重生成，`sync` 未重写每任务模板，故不能拿旧模板或旧 review 当绑定依据。

**按本报告矩阵填充后，可以登记为“限定通过”**（证据 JSON 已备：`db-m5t11-contract-final-evidence-20261109.json`，`verdict=pass`、12 条真实证据）。该登记只表示**契约语义复核通过**，不表示任务通过、不授权 `--landed`、不授权 push/PR/发布；任务卡 `status` 仍 `todo`。

本次重绑（`B9-M5T11-CONTRACT-HASH-REBIND`）只把哈希改为 `67056941…` 并追加 1 条共享批量依据；原 11 条证据逐字不变，计数/失败语义不再改。旧件已按字节保留：`db-m5t11-contract-final-20261109-prehash-rebind.md`（9,809 B `066BAE03…`）与 `db-m5t11-contract-final-evidence-20261109-prehash-rebind.json`（8,116 B `E4DA153D…`）。

**不能登记为“完整通过/发布通过”**：六项性质不同，见 §4 三类——**明确必过门禁**只有远端 CI（PG17，合并/落地层面；required checks），**尚未观测、不得声称已证**为真实 04:30 部署调度、5,000 行负载、真库“事务未开启”、commit/WAL 与自然 SQLSTATE（原验收未点名这些，不自动加门槛），**明确未授权不执行**为生产删除（B1 未授予，不是待补测试）。

> 说明：verify 工具只接受 `verdict=pass`，所以“限定”只能写在证据正文里；集成者登记后请按证据正文理解，不得只看 verdict 字面。

## 2. 契约矩阵

| 契约项 | 代码（c8438741） | 已有证据 | 未闭合项（性质见 §4） | 判定 |
|---|---|---|---|---|
| **验收1** operations 固定 key→已实现服务→registry/每日 cron 实际注册；默认 dry-run、真实清理关闭；无授权删除请求拒绝、删 0、只回候选计数 | `composition.ts:198` 授权只取容器 `RETENTION_CLEANUP_MODE=delete`（缺省 false）；`:200-203` 注册 `createAnalyticsRetentionJob`；`retention.ts:63` key、`:81-90` `resolveRetentionMode`、`:404-407` 未授权删除→FAILED/forbidden；`deploy/cron.nbshiyan:16` 每日 04:30 + 55s | 真库 `tests/analytics-retention.db.test.ts:593`（registry+operations 透传 dryRun）、`:1029`（默认 dry-run 删 0、JobState SUCCEEDED）、`:1061`（未授权 FAILED/forbidden 删 0）、`:1710`（HTTP 真接线）；41/41 内 | 04:30 真调度未在部署容器执行（jobs-runtime 16/16 为 HTTP 级） | **限定满足** |
| **验收2** 仅隔离 Postgres 验证 receivedAt 30 天/聚合 13 自然月目标集合、计数与去标识；显示覆盖、不重建过期明细、不扩备份/既有删除权限（E-48） | `retention-plan.ts:126-139`（30 天等号到期）、`:149-179`（13 自然月按 expiresAt 正推反解）；候选仓储 `:273-340` 只选 eventId/siteDate/kind/locale/productSlug；`retention.ts:396-427` 同源候选 | 真库 41/41（15 纯+26 真库，PG12.22、隔离 schema、跑后残留 0），日志 14,241 B `a45eb2f9…`；`:43` 模式、`:1082` 已授权只删到期行 | PG12.22≠PG17；远端 CI 未跑 | **限定满足** |
| **验收3** 删后只重算 `dayStart≥完整原始覆盖起点`、48h 迟到仍完整时重算；部分清理日保留旧聚合并返回 partial/unavailable 与原口径；旧代次拒绝、不接触生产/恢复/备份（E-82） | `retention.ts:445-453` 覆盖起点分类、`:456-486` 删前逐日聚合、`:586-605` 删后 `runAggregateOnce(maxBatchDays=500, assertTimezoneRevision)`；`aggregate-plan.ts` `recomputableFrom` + `lateArrivalSiteDates` | 真库 41/41 + aggregate 17/17；D4 用例 `:1602/:1626/:1661/:1686`；`:1436` 先聚合后删；D4 真库 A4/A5/A5b/A6/D3/W1/W2 | 真库“事务未开启”未执行（仅假 DB）；commit/WAL 未证；**阶段标记入口限制**：`enteredTransaction` 只覆盖删除前单日 preflight（`aggregate.ts` 单日入口），不是所有入口，`runAggregateOnce` 无该标记 | **限定满足** |
| **E-48** 边界 30 天/13 自然月；默认 dry-run；无授权拒绝；隔离测试验证目标集合/计数/去标识；不扩备份或既有删除权限 | 同验收2；`retention-plan.ts:14-18` 仅精确 delete 才删；`retention.ts:537-582` 删除只触三张分析表，无备份/恢复路径 | 41/41；隔离 schema 跑后残留 0；未 reset 整库、未改配置/权限 | 生产授权未授予（设计如此）；5,000 行负载未测 | **满足（隔离范围）** |
| **E-82** 只重算不早于完整覆盖起点的自然日；超范围保留原聚合、返回 partial/unavailable 与原口径；不以残片替换；48h 迟到不扩保留 | `retention.ts:445-453`、`:586-605`；`retention.ts:479-483` 普通失败仍 gap+30 天删；`aggregate-plan.ts` 覆盖分类 | 41/41 内 `:1151/:1213/:1264/:1341/:1376`（retained 仅存在性、gap、D3）；aggregate 17/17 | 自然 23505/40001 未证（注入为合成错误）；**旧行不动的范围**：未到期且未成功重算的保留日、失败回滚的旧结果；成功重算按替换语义更新，13 个月到期按删除语义删除 | **满足** |

### 2.1 逐批计数与提交未知（B2）

每批删除事务成功返回后才累计计数（`retention.ts:535-547`、`:549-582`；失败批次不计、已计入不重复）。仅当终态已持久化，**且不存在删除事务提交结果未知**时，才适用“真实删除差量＝返回计数＝JobState 摘要”。`timeout` 不写终态；`finish_failed` 表示终态未成功持久化；提交结果未知则**可能随后持久化 FAILED**（`retention.ts:606-612` 对非超时错误仍尝试写 FAILED），但摘要只覆盖已成功返回的批次，终态写成也不能证明未知批次是否实际提交，因此该等式仍不适用。

## 3. 与既有报告/证据的绑定

| 证据 | 用途 | bytes / SHA256 |
|---|---|---|
| `db-m5t11-r5-static-c8438741-20261109.md` | R4-S1/R4-S2 限定关闭、守卫阶段分类、入口行号 | 14,618 B `17395477980AABD3057CBC76C142435F9AB2D9AF607B137E3C55B85588181777` |
| `testing-m5t11-r5-postmigration-review-c8438741-20261109.md` | 恢复后真库 41/41、相关 68/68、D4 六类、未证清单 | 7,899 B `113E32733DA7935BBC7AA75F080512EF6A1802234F0ACB60FC79AE1A01528BB4` |
| `db-m5t11-r5-static-jev-rejudge-*.json` | R5 阶段标记方案 Jev A high 0.95 | 见原报告 |
| `revalidation-g1-20261109.evidence.json` | 18 项共享章节复验（**独立记录，不替代本条**） | 11,747 B `F43E9152…` |

### 3.1 契约上下文差量（重绑依据）

- `bded1728→920db0f1`：M5 契约上下文只改 08/09/18 四处批量条款（+4/−4）；`task-contracts.json` 的 M5-T11 条目逐字节相同；M5-T11 的 `sections` 含 8/9/18，故契约哈希由 `6a8c38d7…` 变为 `67056941…`。
- `920db0f1→060746d4`：只改 `图谱/任务/M5-T11.md` 的 code/notes（+51/−2），前 45 行（验收/依赖/status）逐行相同；`task-contracts.json` 仍逐字节相同。
- 两处权威现值一致：`docs-data.js` handoff.contracts 与 `_run/patches/m5t11-batch-units-20261109.evidence.json` 均为 `67056941…`；旧每任务模板与 task-reviews 仍为 `6a8c38d7…`（陈旧，不作绑定依据）。
- 四处条款对 M5 自身的对应见证据 JSON 第 12 条（聚合按站点日、保留按删除行 5,000/20,000、55s 时间预算、其他作业 500 单位未放宽）。

## 4. 六项的性质拆分（不是同一张待补测试单）

### 4.1 明确必过门禁（合并/落地层面）

1. **远端 CI（PG17）**：本地真库为 PostgreSQL 12.22；`ci.yml` 的 PG17 接线只在本地提交 `bded1728`，远端 CI 未执行。合并/落地前必须绿（项目 required checks；运维本窗核为 build-and-audit、e2e）；**不是任务卡新增条款**，也不由本契约复核替代。

### 4.2 尚未观测、不得声称已证（不自动阻断开发交付）

2. **真实 04:30 部署调度**：验收1原文只要求“registry/每日 cron 实际注册”，代码与 `cron.nbshiyan:16` 已核；运行未观测。若要求“重启后实际运行”，须另引条款（M5-T8 有该要求，M5-T11 没有）。
3. **5,000 行生产负载**：任务验收无负载条款；不得写成已测，也不据此加门槛。
4. **真库“事务未开启”**：D4 边界分类，验收未点名；仅有假 DB 证据。
5. **commit/WAL 与自然 23505/40001**：合成注入是既定测试方法；自然发生未观测，不得写成自然并发已证。

### 4.3 明确未授权不执行（不是待补测试）

6. **生产删除**：B1 未授予，容器默认 dry-run；不得为凑验收去生产删除，也不把“未做生产删除”列为缺证。

## 5. 登记说明与风险

- 证据 JSON：`db-m5t11-contract-final-evidence-20261109.json`，`scope=task-contract`、`contractHash=67056941…`（与 `docs-data.js` handoff.contracts、补丁 evidence 模板两处权威现值一致）、`verdict=pass`、12 条证据；可直接用于 `verify --task M5-T11 --evidence <该文件>`。
- **未执行 verify**：登记由唯一集成者/审查方执行；执行前须确认当前无 M5-T11 相关 BLOCK（`review.py` 的 BLOCK 会拒绝 verify），并注意 verify 会以本文件覆盖 task-reviews 中现有的 CI 补丁证据——本文件第 1 条已把 CI 接线事实并入，覆盖不丢事实。
- 登记后仍不得 `--landed`：任务卡 `status` 仍 `todo`、未 push/PR/landed；PG17/CI 未跑，发布门未开；真实调度未观测，属 §4.2，不构成新增门槛。
- **95 项与 M5-T11 的关系**：M5-T11 **不在** 95 项中（95 项均为 `previousStatus=done` 的已落地任务）；95 项记录不证明本任务，本报告也不证明那 95 项；两份记录互不替代。

## 6. 交付文件

| 文件 | bytes | SHA256 |
|---|---|---|
| `db-m5t11-contract-final-evidence-20261109.json` | 9,663 | `5A269D2A1FF8D2358FEFDA2DC2B763AA4540CF3EE8C4D1C12AFD6CDD713B6509` |
| `db-m5t11-contract-final-20261109.md` | 以群回执为准（本表编辑后重算） | 以群回执为准 |
| `db-m5t11-contract-final-20261109-prehash-rebind.md`（历史副本） | 9,809 | `066BAE0316DA0640ED7A9AE7866D5F460CFF44BD853A0C278A0E088699443F73` |
| `db-m5t11-contract-final-evidence-20261109-prehash-rebind.json`（历史副本） | 8,116 | `E4DA153DFB69AB12EFC22C061FC9771F51E7FCF079126A7B4C1E81AA325B40E1` |
