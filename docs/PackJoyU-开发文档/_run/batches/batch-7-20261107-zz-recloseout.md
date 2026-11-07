---
batch: 7
tasks: M2-T3, M3-T16, M3-T17, M3-T21, M3-T23, M3-T24, M3-T4, M5-T3, M5-T7
date: 2026-11-07T15:51Z
verdict: clean
tests: pass
pr: https://github.com/dawanglaohu/NBshiyan/pull/537
repair_schema: 1
note: 第 7 批重新收口。原记录判 open 的两项证据缺口由测试返工 R7-T14077261（E-82 超范围日 partial 服务路径）与 R7-T31416198（同一连接内非 UTC 会话）补证；非 UTC 用例在 run 42341518872 真实失败并暴露产品时间参数缺陷，另立产品返工 R7-T21418022 以九处参数统一 utc() 修复。三卡均 done，登记三笔（e3ebb686→e595ccca→4920b81e，12 文件 +155/−12，全在 docs/）经非作者增量独审 PASS、0 剩余必要修改；#536 已普通合并为 3407e022（双亲 ccadccef+4920b81e，tree 24020444 与登记头逐字相同）。权威证据为 run 42384617554 success（其测试合并树 24020444 与 #536 合并后 main 树逐字相同；聚合文件 12/0/0，第 10/11/12 条；A3 194/0/9+2+1、D2 3.3s、清理双 true）。判 clean / tests pass。旧两份 open 记录逐字保留不改写。两项下游未完成边界：B7-BE-02 管理端旧「重置 2FA」入口归 M3-T9（todo）、M5-T3 未接生产调度归 M5-T8（todo，须替换旧 cron、不得双写）；40001 回滚按记录级保留；成功日志只有文件级门禁计数、无单测 TAP 与耗时，不造；真机未验、物理触控板为既有用户取消项不扩。本记录自身文档提交的检查与非作者审查另记，合入 main 并同步后第 8 批才解锁。
---

本记录里的日期按 UTC。基线 main `3407e022f8a93a604c0367a5a0858a3ab4b12c88`（#536 merge），双亲 `ccadccef76e1bf2d5a2001a9f8cd14b5ea19d6ad`（main）+ `4920b81ead49abb944051327807aea89489f1f5f`（三卡登记头，`mergedAt 2026-11-07T15:41:32Z`），tree `24020444f29cc1e11c03b09a1c248ffd07318ce7` 与登记头 tree 逐字相同——合并没有引入任何内容变化，被验证的树就是合并后的树。9 个原任务与三条返工 `R7-T14077261`／`R7-T31416198`／`R7-T21418022` 的任务卡 `status` 与 progress 均为 `done`。原收口记录 `batch-7-20261107`（open / tests: pass）与后补记录 `batch-7-20261107-z-product-repair`（open / tests: fail）逐字保留；本记录是第 7 批第 3 条记录、重新收口，不改写旧记录，也不重复 `verify`／`--landed`。

本记录的 `date` 写真实 UTC 时刻 `2026-11-07T15:51Z`（写这条记录的实际时间，不是未来日期）。机理：`read_batch_records` 按文件名升序写入 `batchRecords`，`batchRecord` 只按 `date` 字符串取最大、同日并列时退回该插入序；`batch-7-20261107.md` 无后缀，日期后首字符是 `.`（0x2E），`-z-product-repair`／`-zz-recloseout` 是 `-`（0x2D），`.` 大于 `-`，故无后缀旧记录在同日插入序里排最后、并列时被选中——纯日期会让那条 open 记录继续胜出。本条用真实 UTC 时刻消除的只是**本次**并列，不是通用方案，也未改判定代码或旧记录。显示副作用：`batchLabel` 与收口提示词直接渲染 `rec.date`，界面会显示「已收口 `2026-11-07T15:51Z` · 干净」、提示词「上次收口 `2026-11-07T15:51Z` · clean」，比纯日期多带时刻；生成器模板 `build_docs.py:2735` 仍写 `date: <YYYY-MM-DD>`，`read_batch_records` 不校验 `date` 格式，本条属解析器可接受的局部约定例外，未改生成器、未扩大既有验收口径。

## 交付了什么

第 7 批 9 项原任务（M2-T3 模型键盘触屏与复位控件、M3-T16 原子切换本人登录方式与密码、M3-T17 本人设备列表与目标撤销 API、M3-T21 询盘/详情/往来邮件视觉、M3-T23 模型上传与预览视觉、M3-T24 规格列表与品类编辑器视觉、M3-T4 签发管理员目标恢复 permit、M5-T3 一致快照重算并原子替换日聚合、M5-T7 同意 UI/页面事件与隐私说明）此前已全部落地。原记录判 open 的原因是两条契约验收证据缺口：E-82 超范围日的 partial 服务路径用例只传「当天」、分支 0 次；非 UTC 数据库会话无用例且 CI 默认 UTC。

本轮闭合由三条返工完成：`R7-T14077261` 补真实执行超范围日分支并逐字段核原值保留；`R7-T31416198` 在同一连接/事务内补非 UTC 会话对照——该用例在 run `42341518872` 真实失败，暴露产品侧按 JS `Date` 直接绑定 `timestamp(3)`、`Asia/Shanghai` 会话丢失日界起点事件；`R7-T21418022` 把九处时间戳参数统一改为仓库既有 `utc()` 写法并新增第 12 条真实事务测试。三条 done 后的登记三笔（`e3ebb686` → `e595ccca` → `4920b81e`）共 12 文件 +155/−12、全部在 `docs/`，产品与测试代码零改动，均未 amend；非作者增量独审 PASS、0 剩余必要修改；随后 #536 按锁 SHA 普通合并（未 admin、未开 auto-merge、未 rebase，命令未带 `--delete-branch`），合并 tree 与登记头相同。两点分开记：**命令行为**＝该次合并命令未请求删除分支；**当前远端状态**＝`refs/heads/batch/7-20261106` 现已不存在，仓库当前 `delete_branch_on_merge=true`，与合并后自动删除机制相符；本记录无删除审计，不指认删除者，也不据当前状态倒推运维动作，运维回执不改写。

## 逐任务复核

产品代码以 main `3407e022`（tree `24020444`）为准；9 个契约的 41 个 outputPaths 在该树上逐文件存在（41/41）。任务卡 `status: done`、progress done、`task-reviews` `verdict: pass`（`scope=task-contract`）。

|任务|验收与接缝结论|
|---|---|
|M2-T3|前端已证：`ProductGallery.tsx:185-205` 滚轮只经 `wheelAdmission` 准入、`model-pointer.ts:43-52` 真值表、`model-accessibility.ts:65-105` 复位/44px/双指；E-101/E-102/E-104/E-98 具名通过。真机触屏未验（Playwright 触控上下文）。|
|M3-T16|静态无阻断 + PG 已证：`account-security.ts:53-95` 单事务 consume LOGIN_MODE + sv CAS、`login.ts:263-281` totp-only；`admin-account-mode-password.http.test.ts` 在 run `42384617554` 的 18 文件门禁中 **pass=5 / fail=0 / skip=0**。|
|M3-T17|静态无阻断 + 动态成立：`device-management.ts:42-114` 游标稳定、DTO 无 sid、DEVICE_REVOKE 一次核销；`admin-device-management.http.test.ts` **pass=15 / fail=skip=0**。|
|M3-T21|前端已证：入口 `AdminShell.tsx:18`、页面/API 角色一致、匿名化 PATCH/notes 409、9 例具名（含 SALES 404/403、PII 消失、三尺寸）；样式只追加 `.inq-*`/`.ml`，守卫通过；mail 三模式各 1 passed。|
|M3-T23|前端已证：入口与面包屑重定向 `/admin/models/new`、ADMIN/EDITOR 8 例、`models.css` 0 处 `.adm-`；`ModelPreview.tsx` 的 OrbitControls 按契约 `M3-T23.md:31/:49` 属既有主题能力保留项，不判缺陷。|
|M3-T24|前端已证：SSR 每 key 恰一链、一次 PUT 八键/GET 持久、4 例具名、`specs.css` 只写 `.spec*`。|
|M3-T4|静态无阻断 + PG 已证：`recovery-authorizations.ts:60-112` 签发（grant 核销→角色重读→拒绝自我→目标须绑 TOTP）、`recovery-start.ts:64-112` 核销（User→Device→Grant、sv CAS）；PG `admin-recovery-authorizations` **4/0/0**、`admin-recovery-start` **6/0/0**。**含下游未完成边界 B7-BE-02**（见「边界与未覆盖」）。|
|M5-T3|静态无阻断 + PG 已证：整组单事务 + 事务首一次 `FOR UPDATE` generation、watermark 单调守卫、`receivedAt<=cutoff` 快照、ingest 语义键去重；`analytics-aggregate.db.test.ts` 在 run `42384617554` **12/0/0**（第 10/11/12 条即三条返工）。**契约内未接生产调度**（M5-T8 未接线，见边界）。|
|M5-T7|前端已证：`analytics.ts:46-64` 撤回清队列 + abort、`:214-241` 同意写串行、`analytics-consent` 4 例 + `privacy-analytics` 1 例具名。`/api/rum` 无服务端同意校验按 `10-接口约定.md:166` 不归本卡。|

## 三项返工闭合

|任务|类型|契约 hash|源码/测试位置|CI 映射|结论|
|---|---|---|---|---|---|
|`R7-T14077261`|测试（E-82 partial 服务路径）|`4ceab81810193068e42c4608b0eb4a44b939a27392cafc25553ef211620bc47e`|`tests/analytics-aggregate.db.test.ts:357-417`；两处带 `updatedAt` 的预置 INSERT 在 `:369`/`:375`（夹具修正 `f0cdc2ff`，用例原创 `8c9fdd00`）|第 **10** 条；run `42380725190`、`42384617554` 均 12/0/0|done|
|`R7-T31416198`|测试（同一连接非 UTC 会话）|`4592fdd01f99ae7f8e31ede4af7bee43a11eb8ee7f32f600b396489b2c69c3d0`|`:419-514`（一致性断言 `:448-461`、非 NULL watermark 跨会话对照 `:465-513`；`:515` 起属第 12 条区块，其 `:525-552` 适配器不归本条）|第 **11** 条；失败证据 run `42341518872` `not ok 11`（`:461`，丢 `tz-at-start`），修复后 12/0/0|done|
|`R7-T21418022`|产品修复（参数侧 `utc()`）|`d408013f8ab615bd1291f860a52cb915e8a092132e347581b57b312541adda6b`|`aggregate-repo.ts:63-65/123/125/126-127`、`aggregate.ts:105-106`；适配器 `test:525-552`、第 12 条 `test:554-657`|第 **12** 条；run `42380725190` 起 12/0/0|done|

- 归属两阶段保留：先由测试卡 `R7-T31416198` 发现缺陷（失败上报、未改断言、未 pin UTC），再由产品卡 `R7-T21418022` 独立修复；原两张测试契约不降级、不改写。
- 三卡 `task-reviews` 由 `maintain_docs.py verify --task --evidence` 刷出（未手改），三份 landing evidence `verdict: pass` 且 `contractHash` 与 `handoff.contracts` 三值一致；三卡契约 hash 相对 `3407e022` 本轮未变（`4ceab818…`／`4592fdd0…`／`d408013f…`）。需区分历史：`R7-T31416198` 的 hash 在 `e8410563`（H05 误提取修正）由 `6a3f9e34…` 变为 `4592fdd0…`，因此只能说相对 `3407e022` 未变，不能写成相对最初登记记录未变。
- 非作者登记增量独审：`language-batch7-r7-landed-review-20261107.md`（6,064 B `09250C45…`）／`.json`（4,119 B `A330362A…`），**PASS、0 剩余必要修改**；审查只读，未写仓库、未推送、未合并。第 11 条范围误归（`419-552`）由 `4920b81e` 修至 `419-514`，三份派生处残留 0。

## 验收 CI 与版本归属

三次 run 分属三棵不同的头树，不能合并成一个总括：

| run | head | 头树 | 用途 |
|---|---|---|---|
| `42334640576` | `720ff6bf` | `4de2bea2` | 9 项原任务首次收口 |
| `42380725190` | `e8410563` | `0a7e34a0` | 产品验收（三条返工首跑通过） |
| `42384617554` | `4920b81e` | `24020444` | 登记头验收（权威） |

**整树相同**的只有 `9fc4a8c6`（run `42384617554` 的测试合并提交）、`4920b81e`（其 head）与 `3407e022`（#536 合并后 main），三者 tree 均为 `24020444`；`e8410563` 与 `720ff6bf` 各有自己的历史树，不能被这条等同关系覆盖。

- **权威**：run `42384617554`（attempt 1、`pull_request`、head `4920b81e`）**success**，15:04:56→15:32:32Z（约 27m36s）；测试合并 `9fc4a8c6ecb265df6847e34a77ea77e4cfd3ff46` 树 `24020444` 与最终头树逐字相同；四 job、四项 check 全 success。
- **聚合文件**：`tests/analytics-aggregate.db.test.ts` **pass=12 / fail=0 / skip=0 / todo=0 / cancelled=0**（PG 门禁步骤 314s）。文件内恰 12 条 `test(`，第 10/11/12 条即三条返工；第 6 条是旧 E-82 用例，只留全表、不替代 #10。
- **同步骤其余 PG**：18 个门禁文件全 `fail=0 / skip=0 / todo=0 / cancelled=0`，pass 合计 **147**；device-session 组 7s、**25/0/0**；action-grant 锁等待证据 4 条。全局 `# fail 0`／`# skipped 0`／`# todo 0`／`# cancelled 0` 由步骤成功强制，`##[error]` 实际 0。
- **A3/D2**：MAIN **194/0/9**、ERRORS **2**、FLOW **1**，三段 outcome success／`released=true`；D2 `e2e/admin-legacy-inquiries-visual.spec.ts:471:7` passed **3.3s**（负控 732ms、form 3.1s）。
- **预算与清理**：e2e 1,652s / 2,100s（余量 **448s**）；mail 257s、build-and-audit 266s、posix 25s；`privateCleanup=true`、`preparedArtifactCleanup=true`，两处「越界触碰」均 false。
- **产品验收**：run `42380725190`（head `e8410563`）success——同一聚合文件 **12/0/0**（295s，三条返工首次同跑通过）、A3 194/0/9+2+1、D2 3.0s、e2e 余量 545s；取证件 `db-ci-42380725190-20261107.md` 8,201 B `E4AA2F88…`／`.json` 9,125 B `54471380…`。
- **9 项原任务**：run `42334640576`（head `720ff6bf`）success——三套件 PG **15/0/0**（`account-mode-password` 5、`recovery-authorizations` 4、`recovery-start` 6）、A3 194/0/9+2+1、D2 2.4s、e2e 余量 776s；取证件 `testing-ci-42334640576.md` 5,077 B `B8028EF6…`。
- 登记头取证件：`db-ci-42384617554-20261107.md` 8,506 B `147E29E3…`／`.json` 10,098 B `026E8339…`。
- **证据边界**：成功路径只输出文件级门禁计数；`R7-T14077261`、`R7-T31416198`、`R7-T21418022`、`# Subtest:` 在保存的 e2e 日志中命中 **0**，无逐条 TAP 与单条耗时，本记录不造。三条返工的证明方式是「文件 12/0/0 + 文件内恰 12 条 + 第 10/11/12 条为固定源码顺序」，不是 TAP 点名。

## 历史失败（保留，不抹）

run `42341518872`（head `1149aad6`）failure：`analytics-aggregate` **9 pass / 2 fail**——第 10 条夹具漏 `updatedAt`、第 11 条非 UTC 丢日界起点（`analytics-aggregate.db.test.ts:461`，`not ok 11`）；因第 9 步失败，第 10–18 步 skipped（无 A3/D2/action-grant 证据）。该 run 是这两条的真实失败证据：夹具由 `f0cdc2ff`、产品侧由 `5c324c2e` 修复后在新头重跑通过。旧失败 run 与证据（`testing-ci-42341518872.md` 6,235 B `8A4BA5BF…`）保留，不改写成通过。

## 边界与未覆盖

1. **B7-BE-02 下游未完成边界**：管理端「重置 2FA」仍发旧 body `{reason}`，服务端 strict schema 要求 `reason+actionGrant` → 必然 400。契约归属决定性：`M3-T4.md:72`「UI 迁移按契约归 M3-T9」、`M3-T9.md:22` 产出含「移除原直接重置调用」，M3-T9 为 `todo` 且不在本批。**本批不提前实现整项 M3-T9、不放宽任何服务端校验**；Jev `jev-1.14.0` A 0.52／B 0.48（band=low）仅作旁证。clean 不代表该入口已可用。
2. **M5-T3 未接生产调度**：`runAggregateOnce`／`aggregateOneDayInSnapshot` 在 `src/` 无调用方；部署层仍每 5 分钟跑旧 `/api/admin/cron/analytics-rollup`，两套共用 `JobState` 与 `AnalyticsDailyRollup`／`AnalyticsRollupDay` 两张表。**M5-T8 必须替换旧 cron，不得新增第二个写者造成双重写入**；本批 clean 不代表已接线。
3. **40001 回滚专测**缺失按记录级保留：E-81 四条具名用例已覆盖行为语义，40001 仅是行锁 PG 错误码、无显式代码分支；不新增返工、不写成已覆盖。
4. **证据边界**：成功日志无单测 TAP 与单条耗时（见上）；不为凑证据重跑旧 CI 或补造明细。
5. **真机与验收口径**：真机触屏与物理断网均为 Playwright 上下文模拟，不声称真机；物理触控板为既有用户取消项，保持取消、不恢复、不扩豁免；未做像素/美观验收（按任务口径不做）。
6. 本记录不改产品源码、测试、CI、生成器、三卡契约与 done 状态、旧批次记录；不重复 `verify`/`--landed`。合并与主目录同步由运维按锁 SHA 执行并落回执（`ops-batch7-536-merge-sync-20261107.md` 2,754 B `E803B28C…`）。

## 遗留

none（本批无未闭合返工围栏；上述第 1、2 条是后继任务边界，不属本批已实现能力）

## 返工任务

none

## 自行裁决

第 7 批两处争议均已在旧记录与 planning 留有裁定，本记录不重跑：B7-BE-02 采纳 A（归 M3-T9，Jev pick=A、A 0.52／B 0.48、band=low，仅旁证）；非 UTC 缺陷归属 `adopt=take(A)`（A 0.80／B 0.20，`language-batch7-r7-routing-corrected-20261107.md`）与技术方案 `pick=A high 0.82`（A 0.91／B 0.09，`frontend-batch7-non-utc-decision-20261107.md`）。另有一次 PASS/BLOCK 式 A/B 的 0.98 判读因选项语义不符已作废，更正后复判为 `pick=A high 0.86`（A 0.93／B 0.07），A/B 原件逐字未变。

## 给下一批的提醒

**本记录判 clean / tests: pass，但它是第 7 批第 3 条记录，不使第 8 批立即解锁。** 生效前置：本记录文档提交需过检查与非作者独审 → 合入 main → 主目录与第 7 批工作树同步到含本记录的新提交，三卡 done 与证据仍在主目录，之后第 8 批才放行。本地生成器在 clean 记录存在后会让紧邻下一批的 `implLocked` 变化，那只是本地文档状态，不构成派单授权；未经合入与同步不得派第 8 批。旧两份 open 记录逐字节保留（含返工围栏与 fail 结论），生成器按 tasks 集合取最新记录，不抹返工派生来源；`M3-T9`、`M5-T8` 仍为 `todo` 后继任务，本记录不把它们写成已实现。
