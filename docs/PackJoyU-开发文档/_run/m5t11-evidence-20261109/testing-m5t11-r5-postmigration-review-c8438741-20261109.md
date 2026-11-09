# M5-T11 R5 迁移后真库复验（固定 `c843874110979abb19045482d6699488522dab45`）

- 验证人：测试工程师（本轮 `b9_m5t11` 唯一测试执行者；源码只读；未 push/CI/landed）
- 固定对象：`c8438741`／tree `6f35721236610ab14056a82f9f938ae0950f3345`／父 `803038df`；`803038df..c8438741` 两文件 **+283/−16**，本地 0 dirty
- 前置：接 R5 静态复审（R4-S1/R4-S2 限定关闭）与 D 盘纯用例复验（15/15）；本报告只补真库项，不重跑离线裁决
- **结论：R5 真库复验 PASS（限定）。D4 的 settings/generation 守卫异常出口、删除批次、阶段区分、真实等锁与热锁全部实测成立；主文件 41/41、相关套件全部通过（含 cron 窄修实跑）。剩余 1 项“事务未开启”：本窗未执行真库回调前启动失败，其分类仅由既有假 DB 证据覆盖，已列未证。**

## 1. 载体、绑定与环境

| 项 | 值 |
|---|---|
| 载体 | WSL `/root/m5t11-r5-review-testeng`（`git archive c8438741` 展开，排除 docs/design/public/e2e） |
| 依赖 | 只读复用 `/root/m5t11-r1-review-testeng/node_modules`（符号链接，未复制、未安装、未重建） |
| 绑定 | 载体实算 = HEAD blob：`aggregate.ts` `2b4e2f800e2c6c5795e58098a081d397210a49af`、`retention.ts` `51011a4890871fe6be3e0ef65a45e9925a544751`、测试 `2579959026dc2dee4afa801f9ce3eb90da792871`、`jobs-runtime` `1718876237fda5222c61b44e9443c9aa4d6ed656`、cron `a3f146d8…` |
| 运行环境 | WSL Ubuntu-20.04、Node v22.17.0、`node --import tsx`；PG 由运维正常启动后在线（**本验证窗未再重启**） |
| 数据库 | `b9_m5t11` / `b9_m5t11` / `127.0.0.1:5432` / **PostgreSQL 12.22** / `TimeZone=America/Los_Angeles`；凭据只 source 原 env，未打印 |

## 2. 主文件 41 项（15 纯 + 26 真库）

| 项 | 值 |
|---|---|
| 命令 | `M5T11_REQUIRE_DATABASE=true node --import tsx --test tests/analytics-retention.db.test.ts` |
| 结果 | **tests 41 / pass 41 / fail 0 / skipped 0 / todo 0，EXIT=0**（18,823 ms） |
| 基线/残留 | 跑前非系统 schema 仅 `public`；跑后 `m5t11%` = `<none>` |
| 日志 | `testing-m5t11-r5-postmigration-db-20261109T0315.log` 14,241 B `a45eb2f9a0995d7b5a13227bfa083f30098980c0e054082a163a06b804d947ef` |

## 3. 相关套件（显式映射本任务库 + PID schema 载入前守卫）

全部 0 fail / 0 skip；每套运行前守卫打印 `GUARD_OK`（确认本子进程 PID 对应 schema 不存在），运行后统一复核无 fixture schema 残留：

| 套件 | 结果 | 日志 bytes / sha256 |
|---|---|---|
| `analytics-aggregate.db.test.ts`（`aggregate_<pid>`） | **17/17** | `…aggregate.log` 4,943 B `3b21a0769929326cb102fcccbe28e0d84f8ff45e8b93abb6e1f72cd312b95323` |
| `job-leases.db.test.ts`（`joblease_<pid>`） | **15/15** | `…joblease.log` 3,686 B `d35e4482f14932e7bbdb1376093da465c1b231a8385e82a87a4a24cc2bcf26e7` |
| `jobs-runtime.http.test.ts`（`m5t8_<pid>`） | **16/16**（**cron 窄修用例实际执行**，无 SKIP） | `…jobsruntime.log` 5,074 B `a53dab7592a101d90640382b2dac0fb915811a46d4438263fc8add914a44cf0b` |
| `retention-cleanup.http.db.test.ts`（`retclean_<pid>`） | **9/9** | `…retcleanup.log` 2,316 B `802b03df968793f299e79b71f22494696d48e900d08ba8baaec8a1a73b6937ca` |
| `retention-cleanup.test.ts`（纯） | **11/11** | `…retcleanup_pure.log` 2,690 B `d09127546730556e7093aca0bc3e29fb2f530c666d74bec04d2ed46f4e224ca1` |

汇总日志：`testing-m5t11-r5-postmigration-related-20261109T0325.log` 858 B `84d1befc01d2d72fe019321e5be9ae599bfea7280194e97d2c732590ef18d7a2`（含各套件 GUARD_OK 行、计数与最终残留）。

## 4. D4 真库探针（`testing-m5t11-r5-postmigration-probes-20261109T0335.log` 2,401 B `ed65c91b8c4ae30c25fe1f6ddd36779f21ac279337d66da2369efb2ecae91e98`）

注入均为**合成一次性错误**，明确不代表自然并发；自然并发行为由 W1/W2 独立观测。

| 场景 | 实测 |
|---|---|
| **A4** settings 守卫注入 **23505** | `completed` / **FAILED** / `internal_error` / `gapDays=[]` / `recomputedDays=['2027-02-14']`（未转 gap）/ `deletedEvents=0` / raw 仍在 / 当天 watermark 未写 / 终态 **FAILED/internal_error** |
| **A5** settings 守卫注入 **XX000** | 同上（FAILED/internal_error、无 gap、删 0、raw 在、无 watermark、终态 FAILED） |
| **A5b** generation 读取注入 **XX000**（R5 新修） | 同上：**FAILED/internal_error、gap=[]、删 0、raw 在、终态 FAILED** —— generation 前置读取已与 settings 同属守卫失败，不再降 gap 继续删 |
| **A6** 删除批次守卫注入 XX000 | `completed` / **FAILED** / `internal_error` / `deletedEvents=0` / raw 在 / 终态 FAILED —— 批次停手 |
| **D3** 前置通过后业务写入失败（触发器） | `completed` / **PARTIAL** / `source_unavailable` / `gapDays=['2027-02-14']` / `deletedEvents=1` / raw 已按 30 天删 —— **阶段区分未被扩大为守卫失败** |
| **W1** 真实等锁 1.2 s 期间另一连接提交 revision=2 | `finish_failed` / `deletedEvents=0` / 耗时 1,233 ms / raw 在 / revision=2 / 无终态行 |
| **W2** 真实热锁（持锁 12 s，本轮 deadline 6 s） | **`timeout`** / 耗时 3,797 ms / raw 在 / 无终态行 —— 55P03/57014/P2028 预算分类保持 |

## 5. D4 关闭矩阵（真库侧）

| 缺陷 | 状态 | 依据 |
|---|---|---|
| R4-S1：settings 守卫异常被降 gap 继续删 | **关闭（真库）** | A4/A5：FAILED/internal_error、无 gap、删 0、raw 在、终态一致 |
| R5-S1：generation 前置读取异常同类风险 | **关闭（真库）** | A5b 同上 |
| 删除批次守卫异常 | **关闭（真库）** | A6：FAILED、删 0、raw 在 |
| 阶段区分被扩大（普通聚合失败被误标） | **未回退** | D3：PARTIAL + gap + 继续删；41 项内 R4/R5 阶段用例通过 |
| 真实等锁期间 revision 变化 | **关闭（真库）** | W1：finish_failed、删 0、无终态、耗时证明真实等待 |
| 热锁/预算分类 | **关闭（真库）** | W2：timeout、删 0、无终态 |
| B2 计数与已提交批次保留 | **未回退** | 41 项内 B2 三阶段 + D4 批次用例通过 |
| “事务未开启”分类 | **仅假 DB** | 本窗未执行真库回调前启动失败（`$transaction` 未开成）；分类仅由既有纯用例/独立假 DB 证据覆盖，**不记真库通过** |

## 6. 未证 / 边界

1. **事务未开启**（`$transaction` 在回调前失败）：本窗未执行该真库场景；分类仅由既有假 DB 证据覆盖，不冒充真实事务结论。
2. commit/WAL 仍不在截止检查内；“写入后到期”回滚仍属假 DB 观察（本窗未造 commit 延迟）。
3. 注入证据是合成错误，不能证明 23505 会自然出现；**本窗 W1 原始日志只列归一后的 `AggregateVersionConflict`，未记录原始 SQLSTATE；R3 窗记录的 40001 不属本窗实测**。
4. PG 12.22 本地结论未搬 CI 的 PG17；CI 未接线。
5. B1 生产删除授权条件、双 cron 退役、生产真实删除均未变；未 push/PR/landed。
6. 迁移后新盘只证明在线与目录可读（运维口径），本报告不复用事故前任何结果；以上全部为恢复后新跑。

## 7. 空间、库释放与结论

- 全部运行结束后：非系统 schema 仅 `public`；`m5t11/aggregate/joblease/m5t8/retclean` 前缀 schema 计数 **0**；根盘 251G 用 20G、可用 219G；PG `127.0.0.1:5432` accepting（运维正常启动后，**本验证窗未再重启**）。
- 本窗自建 schema 全部由 `after()`/探针 `finally` 删除；未 reset 整库、未改配置/权限。
- **R5 真库复验 PASS（限定）**：主文件 41/41、相关套件 68/68（17+15+16+9+11）、D4 六类真库场景成立。**D4 可作为已测路径关闭；剩余“事务未开启”仍列未证**，需在报告/后续记录中保留，不得据此宣称整任务或 CI/落地通过。
