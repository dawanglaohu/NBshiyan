# 文档补丁 d1d2-rollup-writeback-20261108

任务：M5-T8
原分支：batch/8-20261108
原 PR：None
依据：D1/D2 回填：旧 rollup 入口退役、watermark 守卫按 revision 分流；M5-T8 supportPaths 增 4 条 D1 路径，不改状态与验收

## 差异与复验范围

- ANALYTICS-ROLLUP：task
- M2-T8：上游契约变化或本次审查目标
- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M4-T1：上游契约变化或本次审查目标
- M4-T10：上游契约变化或本次审查目标
- M4-T11：上游契约变化或本次审查目标
- M4-T12：上游契约变化或本次审查目标
- M4-T13：上游契约变化或本次审查目标
- M4-T14：上游契约变化或本次审查目标
- M4-T2：上游契约变化或本次审查目标
- M4-T3：上游契约变化或本次审查目标
- M4-T4：上游契约变化或本次审查目标
- M4-T5：上游契约变化或本次审查目标
- M4-T6：上游契约变化或本次审查目标
- M4-T7：上游契约变化或本次审查目标
- M4-T9：上游契约变化或本次审查目标
- M5-T10：上游契约变化或本次审查目标
- M5-T11：上游契约变化或本次审查目标
- M5-T4：上游契约变化或本次审查目标
- M5-T8：definition、effectivePaths
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### 04-执行/遗留issue-20261024.md

````diff
--- before/04-执行/遗留issue-20261024.md
+++ after/04-执行/遗留issue-20261024.md
@@ -598,7 +598,7 @@
 output: 按天写入汇总表，并由定时调用写入进度。
 acceptance: 已由 PR #477 于 2026-10-25 合入 main。合并提交 90b2658d2600859ed0a71d4b09e422e1b42a783d。统计按天汇总。本登记不重做。
 edges: none
-note: 没有单独的 GitHub issue。本轮按单独 cron 入口接入，没有收进 jobs/registry.ts。
+note: 没有单独的 GitHub issue。本轮（#477 阶段）按单独 cron 入口接入，没有收进 jobs/registry.ts；该接入已由 M5-T8 完成（固定 registry + `POST /api/admin/cron/operations`）。2026-11-08 更新：**收口分支**已把旧 `/api/admin/cron/analytics-rollup` 改为鉴权后统一 410 `route_retired`、零 DB/聚合/邮件/审计（D1 `3410fe95`）；**main `78966e99` 尚未包含该修复，main 仍保留旧写入实现；未核验生产部署版本**。
 ```
 
 ```issue
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2705,7 +2705,11 @@
         "src/lib/server/analytics/aggregate.ts",
         "src/lib/server/analytics/aggregate-repo.ts",
         "tests/cron-analytics-rollup.test.ts",
-        ".github/workflows/ci.yml"
+        ".github/workflows/ci.yml",
+        "src/app/api/admin/cron/analytics-rollup/route.ts",
+        "tests/analytics-rollup.test.ts",
+        "tests/d1-route-sideeffect.test.ts",
+        "tests/fixtures/d1-route-sideeffect.case.ts"
       ],
       "outputPaths": [
         "src/lib/server/jobs/registry.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续复验已落地任务 M5-T8：注册聚合作业并接通真实5分钟cron
本任务有已落地历史，现在仅因契约变化待复验。代码依据是已合入 main 的当前代码与任务回填；历史 PR 只作为已合入实现和原验收的证据。
不要创建空 PR，不重新初始化旧任务分支，不向已经 MERGED 的原 PR 追加提交或要求再次合并。
## 项目
- 项目：PackJoyU 网站改版与运营能力升级　｜　技术栈：TypeScript / Next.js 15 / React 19 / Auth.js / Prisma PostgreSQL / next-intl / React Three Fiber；现有CSS与原生控件，不接线上AI判断层
- 开发文档：docs/PackJoyU-开发文档（知识库入口 docs/PackJoyU-开发文档/_MOC.md）

## 本任务
- 模块：M5　同意与统计账本：负责分析同意、匿名浏览器与事件标识、采集准入和去重、站点统计时区设置、日与产品聚合、原始与聚合保留及可重算边界，产出真实访问和 3D 统计。
- 输入：job-leases、analytics-aggregate与M3共享HTTP防护
- 产出：job-foundation、analytics-aggregate-runtime；固定registry、POST /api/admin/cron/operations及真实cron e2e/analytics-job-runtime.spec.ts复用T7同意/访问步骤，仅新增cron、水位和UV/PV关联断言。
- 预估：2 人天　｜　前置：M5-T1　建立JobState租约与代次仓储原语；M5-T3　以一致快照重算并原子替换日聚合；M3-T1　将真实Auth.js会话绑定当前设备与权限；M5-T7　接通同意UI、页面事件与隐私说明；M3-T14　接通新API配置、错误映射与脱敏计数（已落地）
任务契约版本：cbaf13f86bcfb5423c36ecf407210068b85f9c62785068f1fb22a9210136ebab
先读 docs/PackJoyU-开发文档/图谱/任务/M5-T8.md 的代码位置、实施沉淀和已有落地记录，以及本次补丁的差异与复验清单（_run/revalidation.json 里本任务的 patches[].changedFields 列出了变化字段；只有共享章节变化时只核该章节对本任务的影响）。
若已有本次复验或修复的工作树、分支和开放 PR，沿用它们的实际标识；不假定它们仍是旧任务的分支或历史 PR。
仅核对变化条款及其直接影响，保留已有代码、回填和 done 历史，不按完整实施流程重做。
验收：
1) composition只注册已实现analytics-aggregate，deploy/cron.nbshiyan每5分钟POST /api/admin/cron/operations
固定key/Bearer常量时间校验，未知key/无凭据拒绝，不允许任意脚本。2) 真调度在重启后实际运行并提交JobState/watermark，batch≤500、55s截止、旧代次不能覆盖
停cron/失败保持上次成功watermark并显示安全状态NEVER/FAILED/旧值，不凭路由存在或手动调用宣称刚更新（E-81、E-84）。3) 浏览器同意后同日同浏览器完成两次页面访问并刷新/重试同eventId，实际job后UV仍1、真实新访问PV增加且重复事件不增加（E-44）
看板GET不触发任务，通知/邮件由M4注册，不导入未来服务或登记空实现。4) 隔离服务使用可控时钟经事件HTTP入口分别提交now-48h-1ms、now-48h、now+5min、now+5min+1ms：超界两项返回event_time_out_of_range且无记录，边界两项可准入
准入未来事件在实际聚合作业时钟到其occurredAt前不计入，到时后才计入。48h内迟到事件仅重算仍具完整原始覆盖的所属日，已关闭/超窗口历史不受任意客户端时间污染
完整覆盖外保留原聚合并标partial/unavailable，不以残片写小或造未来日（E-60）。
边界：
- E-44　C-05 分析采集、去重与保留期
  触发：同一授权浏览器刷新或重试同一事件　期望：当日授权访客按浏览器标识去重，同一事件 ID 不重复计数；真实的新页面访问可增加 PV，UV 不随刷新增加。
- E-60　今日统计的站点时区与历史重算
  触发：浏览器上传未来或明显过期的事件时间　期望：直接引用09节既定 now-48h≤occurredAt≤now+5min：超界拒绝，准入的未来事件到其真实时间后才参与聚合；闭区间历史按原始完整覆盖和既定迟到窗口处理，禁止任意客户端时间污染未来日或已关闭区间。
- E-81　分析聚合与水位发布
  触发：两个调度实例重叠，或旧任务超时后晚于新任务提交　期望：使用数据库互斥或带代次的租约及提交校验，旧任务不能覆盖新结果；一次事务替换整组目标日数据并提交 watermark，进程中断保留上次完整结果。
- E-84　分析聚合与水位发布
  触发：聚合入口存在但 cron 未注册、cron 停止或最近运行失败　期望：不宣称已接入或刚更新，展示真实最近成功 watermark 与旧值状态；实施任务必须包含真实五分钟调度注册及重启后运行证据，不能只验证手动调用接口。
有效范围：
.github/workflows/ci.yml
deploy/cron.nbshiyan
deploy/deploy.sh
e2e/analytics-job-runtime.spec.ts
prisma/schema.prisma
src/app/api/admin/account/
src/app/api/admin/chat/
src/app/api/admin/cron/analytics-rollup/route.ts
src/app/api/admin/cron/mail-queue/route.ts
src/app/api/admin/cron/operations/route.ts
src/app/api/admin/settings/analytics/route.ts
src/app/api/admin/stats/route.ts
src/app/api/admin/users/
src/app/api/analytics/
src/app/api/auth-admin/
src/app/api/auth/
src/app/api/chat/
src/app/api/internal/ops-report/route.ts
src/auth.ts
src/lib/server/analytics/aggregate-repo.ts
src/lib/server/analytics/aggregate.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
tests/analytics-rollup.test.ts
tests/cron-analytics-rollup.test.ts
tests/d1-route-sideeffect.test.ts
tests/fixtures/d1-route-sideeffect.case.ts
tests/jobs-runtime.http.test.ts

## 接线要求（做完必须从入口可达）
- backendRoutes：src/auth.ts、src/app/api/auth/、src/app/api/auth-admin/、src/app/api/admin/account/、src/app/api/admin/users/、src/app/api/chat/、src/app/api/admin/chat/、src/app/api/analytics/、src/app/api/admin/settings/analytics/route.ts、src/app/api/admin/stats/route.ts、src/app/api/admin/cron/operations/route.ts、src/app/api/admin/cron/mail-queue/route.ts、src/app/api/internal/ops-report/route.ts；路由已注册并返回真实数据
- container：src/lib/server/composition.ts、src/lib/server/db.ts、src/auth.ts；service 已注册并被路由或 job 调用
- jobs：src/lib/server/jobs/registry.ts、deploy/cron.nbshiyan；已登记且被消费
- migrations：prisma/schema.prisma、deploy/deploy.sh；已登记且被消费

## 前置留下的代码位置（直接用，不重造）

### M5-T1 建立JobState租约与代次仓储原语
`prisma/schema.prisma:415` — JobRunStatus 五个状态。
`prisma/schema.prisma:423` — JobState 的 key、租约、代次、成功时间和 summary。
`deploy/deploy.sh:94` — 现有 db push 消费整份 schema.prisma，不带 accept-data-loss。
`src/lib/server/jobs/types.ts:7` — 租约 90 秒；到期等号视为已释放。
`src/lib/server/jobs/types.ts:20` — summary 只接受白名单计数、时间和版本。
`src/lib/server/jobs/lease-repo.ts:149` — 领取、续租、完成和安全读取；仓储不创建事务。
`src/lib/server/jobs/lease-repo.ts:168` — 同一 key 的条件领取；租约未到期时不产生新代次。
`src/lib/server/jobs/lease-repo.ts:193` — 续租必须复用上层事务，取得行锁后核 owner、代次与期限。
`src/lib/server/jobs/lease-repo.ts:225` — 完成必须复用业务事务；拒绝时抛异常，使业务结果共同回滚。
`src/lib/server/jobs/lease-repo.ts:256` — 取得作业、设置与初始化锁后采时钟；到期工人不能完成。
`src/lib/server/jobs/lease-repo.ts:265` — 只有 SUCCEEDED 推进 lastSucceededAt。
`src/lib/server/jobs/lease-repo.ts:104` — 当前设置串行化读取；缺行幂等初始化，旧 RR 快照的唯一冲突使整笔事务回滚。
`src/lib/server/jobs/lease-repo.ts:79` — 安全读取丢掉不合白名单的 summary 和错误码。
`tests/job-leases.db.test.ts:143` — 隔离 PostgreSQL 上并发领取同一 key 只有一个成功。
`tests/job-leases.db.test.ts:167` — 满 90 秒新代次可领取，旧完成写不能覆盖新结果。
`tests/job-leases.db.test.ts:270` — 失败、部分完成和重复提交保留原成功时间。
`tests/job-leases.db.test.ts:355` — 空输入、脚本字段和脏错误码不写库。
`tests/job-leases.db.test.ts:402` — 旧时区代次和不可读设置拒绝提交。
`tests/job-leases.db.test.ts:473` — 外层回滚、旧代次拒绝均撤回同一事务里的业务结果。
`tests/job-leases.db.test.ts:522` — 设置锁和作业锁等待跨过 90 秒后，完成与续租都拒绝。
`tests/job-leases.db.test.ts:638` — 无上层事务的调用拒绝；仓储不能自行提交。
`tests/job-leases.db.test.ts:653` — RR 缺行旧快照遇到新 revision 后序列化失败，业务结果与作业状态共同回滚。
`src/lib/server/jobs/lease-repo.ts:180` — 领取 SQL 返回后重采时钟，只交付仍有效的租约，已到期返回 busy。
`tests/job-leases.db.test.ts:215` — PostgreSQL 真行锁等待后剩余 1ms、正好到期、过期 1ms及下一代次重领。

### M5-T3 以一致快照重算并原子替换日聚合
`src/lib/server/analytics/aggregate.ts:167` — runAggregateOnce：plan.siteDates 全放进一条 RepeatableRead 事务，事务开头只做一次行锁+generation 校验，每天共用同一 tx，任一天抛 AggregateVersionConflict 整组回滚（验收 1、E-80/E-81）
`src/lib/server/analytics/aggregate.ts:72` — writeOneDayInTx：同 tx 内 DELETE 旧 AnalyticsDailyRollup → 整组 INSERT → upsertWatermarkGuarded；:85 查已存 timezoneRevision 拦 stale_timezone_revision，:119 affected!==1 抛 watermark_regression（验收 2、E-81/E-83）
`src/lib/server/analytics/aggregate-repo.ts:145` — runInRepeatableReadSnapshot：显式 Prisma.TransactionIsolationLevel.RepeatableRead，事务内全部读取共享同一快照（验收 1）
`src/lib/server/analytics/aggregate-repo.ts:35` — loadEventsAtSnapshot：receivedAt <= cutoff 只取快照覆盖的原始事实，新到事件留给下一轮（验收 1、E-80）
`src/lib/server/analytics/aggregate-repo.ts:81` — readLockedGeneration：SELECT generation FROM JobState FOR UPDATE 真读真锁，旧代次拒绝（验收 2、E-81）
`src/lib/server/analytics/aggregate-repo.ts:117` — upsertWatermarkGuarded：ON CONFLICT DO UPDATE 带 WHERE（`:147-159`）按 timezoneRevision 分流——同 revision 非 NULL 遇 NULL/更小拒绝、旧 NULL 可写，较新 revision 允许 NULL/更小并重定基准，更低 revision 拒绝（验收 2、E-81/E-83）
`src/lib/analytics/aggregate-plan.ts:20` — LATE_ARRIVAL_MS=48h；:72 planSnapshot 只列 dayStart 不早于完整原始覆盖起点的日，超范围留 partial/unavailable 且不填 0；:102 mayPublish 旧 generation / 旧 timezoneRevision 一律拒绝（验收 2/3、E-56~E-58/E-82/E-83）
`tests/analytics-aggregate.db.test.ts:136` — 真实 PostgreSQL 具名用例，D2 `b2ea2cfe` 后整文件 **17 条**：E-80 cutoff、E-81 整组替换幂等、旧 revision 拒绝、generation 真行锁、watermark 单调、E-82 超范围、48h 迟到窗口、RepeatableRead 独立连接可见性、整组第 2 天失败回滚，另 D2 守卫矩阵与重定基准 5 条 `:702`/`:740`/`:754`/`:776`/`:824`、R7 服务级 `:357`（#520 时 9 条、CI run 41999427892 pass=9 fail=0 skip=0；D2 本地 17/17、0 skip）
`tests/analytics-aggregate-plan.test.ts` — 纯函数用例：cutoff、迟到窗口、coverage、mayPublish 的 7/7 通过
`.github/workflows/ci.yml` — 把 db 测试纳入 PG 回归 wanted/命令行/gate.files 三处，M5T3_REQUIRE_DATABASE=true 只在 PG 步骤打开，单测 job 无库整组 skip 不打红

### M3-T1 将真实Auth.js会话绑定当前设备与权限
- `prisma/schema.prisma:75` — User.passwordlessEnabled 默认 false
- `prisma/schema.prisma:92` — AdminDeviceSession：192 位 id、会话版本、设备闲置和绝对期限、撤销时间
- `src/lib/server/admin/device-session.ts:21` — 普通设备从 lastActivityAt 滑动 2 小时；记住设备取 7 天闲置和首次签发后 30 天的较早期限（E-01、E-02、E-69）
- `src/lib/server/admin/device-session.ts:53` — 先核账号与设备，再判路由角色；无效设备为 401，有效设备越权为 403；到期等号拒绝（E-70）
- `src/lib/server/admin/device-session.ts:158` — 每次授权查询当前 User 与设备，数据库失败拒绝，不保存跨请求授权结果
- `src/lib/server/admin/device-repo.ts:42` — 撤销范围为小于已提交 User.sessionVersion 的旧设备，新版本登录设备保留（E-03）
- `src/auth.ts:32` — Auth.js 与 API 共享当前环境唯一 cookie 命名空间，不回退读取另一个账号的遗留 cookie
- `src/auth.ts:43` — JWT exp 限于设备截止前一整秒，不使用全局 maxAge 延长设备期限
- `src/auth.ts:64` — 真实 Credentials 登录解析 rememberDevice 并创建当前 user/sv 的 sid
- `src/auth.ts:84` — 普通 signOut 先撤销当前 sid；撤销失败时路由返回 503（E-03）
- `src/auth.ts:97` — JWT 回调重查库，不接受客户端 session.update 的 sid、sv 或 role（E-70）
- `src/auth.ts:149` — 仅以 Auth.js 当前 cookie 名及同名 salt 解密请求会话
- `src/auth.ts:188` — 会话 Set-Cookie 不超过 JWT exp 或设备期限（E-69）
- `src/app/api/auth/[...nextauth]/route.ts:4` — Auth.js GET/POST 使用真实协议处理与期限适配
- `src/lib/server/admin/device-session.ts:122` — 清会话同时发送 Max-Age=0 与过去 Expires，经过 Next cookie 合并仍保持删除
- `src/lib/server/admin/guard.ts:31` — 可写 cookie jar 同样设置 expires: new Date(0)，不只依赖数值 0 的 maxAge
- `src/lib/server/admin/guard.ts:39` — API 验证请求 cookie，SSR 调用 Auth.js；两条入口共用设备和当前账号规则
- `src/lib/server/admin/guard.ts:75` — requireAdmin 对无效会话返回 401 并清 cookie，有效角色越权保留 cookie
- `src/app/api/admin/account/route.ts:6` — 合法 Next GET 导出显式调用真实 requireAdmin
- `src/lib/server/admin/account.ts:15` — AccountDTO 与 T14 最终响应计数；成功、拒绝和受控 5xx 都计一次，计数故障保留原业务响应
- `src/lib/server/composition.ts:36` — 组装设备服务和计数器，不保存当前用户
- `tests/admin-device-guard.http.test.ts:241` — 专用 PG、生产 Auth.js handler 验证失效设备优先于角色及真实新登录后的迟到撤销
- `tests/admin-device-session.db.test.ts:157` — 生产/开发混合 cookie 的唯一命名空间与账号隔离回归
- `tests/admin-device-session.db.test.ts:187` — 实际 Next mutable-cookie 解析/合并后，两种会话 cookie 仍有过去的 expires
- `e2e/admin-device-session.spec.ts:33` — 现有 CI standalone 网络入口覆盖失效设备、角色、SSR、真实 PATCH/新登录/迟到撤销及 signOut 重放
- `.github/workflows/ci.yml:78` — E2E 的专用 PostgreSQL 先执行设备协议回归，再运行同一构建产物的网络验收

### M5-T7 接通同意UI、页面事件与隐私说明
- `src/lib/client/analytics.ts:47` — 撤回立刻停止采集、清空内存队列并中止在途事件批（E-43）
- `src/lib/client/analytics.ts:122` — 把去掉语言前缀的产品路径映射成 `products.ts` 内部 key，不发送本地化 slug
- `src/lib/client/analytics.ts:172` — 文档第一次调用是加载。本地偏好 `analytics === true` 时恢复采集并发出这次 `page_view`；否则不发。事件批 403 停止采集（E-42）
- `src/lib/client/analytics.ts:227` — 同意写串行。false 在请求前停采。在途 false 时把 `nextIntent` 清成 null 再返回，后到的同意不会在这次撤回之后发出（E-43）
- `src/components/analytics/PageEvents.tsx:13` — 语言和路径变化时调用 `noteNavigation`
- `src/components/consent/CookieConsent.tsx:58` — 确认 toast 显示期间写入 `--pj-toast-h`（高度加 12px），消失时删除
- `src/components/consent/CookieConsent.tsx:79` — 保存、全部拒绝、全部接受先关面板并显示 toast，再发布同意选择
- `src/components/consent/consent-flat.css:52` — 设置开关：56×44 可点区域，44×24 平直轨道，16px 方形滑块，开启平移 20px，无勾，开启色 `--pj-accent`
- `src/components/consent/consent-flat.css:118` — 宽度不超过 767 且横幅已关时，悬浮按钮 bottom 加上 `--pj-consent-h`、`--pj-toast-h` 和安全区。横幅显示时仍走 `html.has-consent .fab`。不改 `--fab-h` 和页脚留白
- `src/app/globals.css:255` — 询价已满提示叠在确认 toast 之上。未改 `.fab` 基础定位
- `src/components/layout/SiteFooter.tsx:35` — `#analytics-preferences` 包住既有的 cookie 设置按钮
- `src/app/[locale]/layout.tsx:66` — 在语言布局里挂上页面事件
- `src/app/[locale]/privacy/page.tsx:64` — 必要聊天、分析同意、清理状态和站点时区；没有设置行时显示 UTC（E-45）
- `src/app/[locale]/privacy/retention-facts.ts:7` — 聊天 7/30 与原始分析 30 天取自现有常量；咨询 90 天、聚合 13 个月是同页命名常量
- `e2e/analytics-consent.spec.ts:165` — 未同意不采集、同意后去重、撤回丢队列、串行写、三视口和键盘
- `e2e/analytics-consent.spec.ts:470` — 拦住在途的撤回，再点同意、再拒绝，全程只有一次同意请求，采集停止，队列为 0
- `e2e/analytics-consent.spec.ts:512` — 同意后刷新，这次加载的 `page_view` 被接受
- `e2e/analytics-consent.spec.ts:533` — 390 宽度下，确认 toast 显示期间悬浮按钮中心命中自身，英文和俄文各一次
- `e2e/privacy-analytics.spec.ts:32` — 页脚进入隐私页，核对 en/ru 文案、期限、时区和 noindex
- `tests/analytics-ingest.test.ts` 与 `tests/analytics-ingest.http.db.test.ts` — 贺卡路径样例改为 `/en/products/custom-greeting-cards` 与 `/ru/products/otkrytki-na-zakaz`；本地化 slug 作为 `productSlug` 仍被拒绝

### M3-T14 接通新API配置、错误映射与脱敏计数
- `prisma/schema.prisma:402` — ApiDailyCounter 以站点日、timezoneRevision、routeId 为复合主键，只存 requestCount、errorCount、lastObservedAt。
- `src/lib/server/config.ts:5` — 冻结的后台会话 2h/7d/30d/15min 与 grant 5min、permit 15min、受限会话 10min。
- `src/lib/server/config.ts:68` — 配置失败只报告字段名和「未设置/无效」，不使用 Zod 自带的 issue.message。
- `src/lib/server/config.ts:112` — 生产环境缺既有秘密即拒绝；返回的冻结对象不复制秘密值。
- `src/lib/server/config.ts:129` — 进程内第一次成功解析后不再读取环境。
- `src/lib/server/http/errors.ts:12` — 第 10 节错误码到 HTTP 状态的唯一映射。
- `src/lib/server/http/errors.ts:85` — AppError 变成 `{error,requestId,fieldErrors?}`，429 可带受控 Retry-After。
- `src/lib/server/http/errors.ts:107` — 未知异常返回 internal_error，日志只留错误类别；日志回调失败不改变受控响应。
- `src/lib/server/http/errors.ts:138` — 已发出的 Response 和只有 `{error}` 的旧守卫体原样返回。
- `src/lib/server/http/metrics.ts:6` — 第 10 节新 API 的固定 routeId；不含 Auth.js 与既有 mail-queue。
- `src/lib/server/http/metrics.ts:86` — 用目标 IANA 时区的 formatToParts 计算站点自然日。
- `src/lib/server/http/metrics.ts:128` — 最终响应计数；白名单、设置或写入失败时原 status 与 body 不变。
- `src/lib/server/http/metrics.ts:149` — 单条 INSERT ON CONFLICT 递增 requestCount，5xx 才递增 errorCount。
- `src/lib/server/composition.ts:15` — createHttpServices 组装冻结配置、错误映射和计数适配。
- `prod-env-check.ts:41` — 生产运行时检查附带策略解析；缺省策略不新增问题行。
- `src/instrumentation.ts:9` — nodejs 启动在既有环境检查之后冻结配置，失败只打印安全文本并退出。
- `tests/admin-config.test.ts:21` — 缺字段、非法期限、生产缺秘密，以及错误文本不含输入值。
- `tests/admin-http-metrics.test.ts:49` — 新错误信封、旧信封、白名单拒绝、时区日和存储失败。
- `tests/admin-http-metrics.test.ts:231` — 专用 Postgres 上 200/4xx/5xx 的计数、列集合和并发递增。
- `src/lib/server/http/errors.ts:36` — HTTP 错误正文复用共享 AppErrorDTO。
- `src/lib/server/http/metrics.ts:113` — 白名单、设置和存储失败的日志回调均隔离异常，保留原响应。
- `tests/admin-http-metrics.test.ts:301` — 存储与日志同时失败、未知错误日志失败、白名单拒绝及坏设置的回归。
- `tests/admin-http-metrics.test.ts:354` — 真实 PostgreSQL 上旧响应晚写不倒退 lastObservedAt；非 UTC 会话按 UTC 保存观测时间。
- `tests/admin-http-metrics.test.ts:438` — 默认日志输出脱敏、未知错误日志与响应共用 requestId，以及 ERROR 级别。

## 相关契约（照它实现，改要走文档补丁）
| POST | /api/admin/cron/operations | jobKey固定白名单；dryRun?仅保留任务 | JobResultDTO：jobKey/status/counts/finishedAt | Bearer CRON_SECRET、常量时间校验，无任意job/代码 |
| POST /api/admin/cron/operations | 执行固定job的一轮/下一批，可能替换聚合、消费出箱或按已授权策略清理；串行重复可产生更多工作，租约只防重叠 | 调度HTTP不自动重试，job_busy/429/503/超时也不重发同轮；禁止改key绕租约 | 受控调度/运维通过固定作业的只读JobState仓储方法核generation、lastStartedAt/FinishedAt、lastStatus和租约，不重调触发接口探测；有效租约等待，未知结果留给下一计划；人工恢复须明确且先排除仍在运行。出箱重试由持久状态机负责 |
运行 python "docs/PackJoyU-开发文档/_run/maintain_docs.py" "docs/PackJoyU-开发文档" status --task M5-T8 读取当前版本与证据模板。
契约复核完成后，用同一维护命令的 verify --task M5-T8 --evidence <证据JSON> 登记真实证据。verify 只登记文档契约复核，不证明代码验收或 CI 通过，也不清除代码复验标记。
无需代码修改时，直接复验已合入代码并记录必要检查结果，不为复验补开代码 PR。确有代码差异才按正常修复流程处理：沿用本次修复的工作树和开放 PR；没有时使用实际修复分支和新 PR，不继续已经 MERGED 的历史 PR。
只有代码完成实际验收、必要检查通过，且所需修复已确认合入 main 后，才运行 python "docs/PackJoyU-开发文档/_run/build_docs.py" "docs/PackJoyU-开发文档" --landed M5-T8 清除本任务的代码复验标记；没有代码差异时以当前已合入代码为依据。不能靠手点状态、删除标记或契约 pass 代替代码验收。
输出 VERDICT: pass | rework | doc-issue；列明变化条款、代码位置、必要检查结果和代码复验是否完成。剩余代码错误给精确 rework；普通岔路口交 Jev，只有授权红线才给用户，不因已有 done 历史自动判 pass。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T8:landed-review" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。

## 附录：约定与架构（先做完上面的再看这里；只列与本任务相关的条款，完整版见 06/07/08/11 节）

## 全项目共用约定（前后端必须一致；出处 06 节，要改回文档改）
- 错误体系：src/lib/contracts/errors.ts是新增账号设置/恢复、聊天、统计、看板AppErrorCode与FieldError的唯一来源，第10节同名表逐项镜像；src/lib/server/http/errors.ts唯一映射HTTP，前端src/lib/client/api-errors.ts映射多语言文案；新增错误体为{error,requestId,fieldErrors?}、成功直接用有名DTO，现有Auth.js、{error}、邮件状态体、/api/rum空体及其他旧端点不改信封；禁止把未知码显示原始异常或用新码覆盖Auth.js协议。
- 环境变量：新增变量及本轮触及的安全参数接入src/lib/server/config.ts与prod-env-check.ts集中Zod验证，服务端变量沿AUTH_/ADMIN_/CHAT_/ANALYTICS_/CRON_命名，公开变量仅NEXT_PUBLIC_且不得含密钥或内网地址；业务代码禁止直接读取新增process.env，未触及旧适配器不借机全库重构；秘密只在服务器受权限保护的环境文件或CI secret，示例只写变量名/假值，禁止提交真实值。
- 共享类型：新增请求/响应Zod schema置src/lib/contracts/{account,recovery,chat,analytics,ops}.ts，z.infer手工导出DTO并从src/lib/contracts/index.ts统一出口，server解析和client只读同源schema；第10节字段表与DTO同名，Auth.js扩展仅src/types/next-auth.d.ts，Prisma实体不直接传客户端；既有admin/types与邮件契约保持原入口，禁止在组件/route复制新增接口类型或用any绕过契约。
- 命名与格式：文件kebab-case.ts、React组件PascalCase.tsx、函数/JSON字段camelCase、类型PascalCase、常量UPPER_SNAKE_CASE、Prisma模型PascalCase，既有枚举不改名；新HTTP路径小写kebab-case，时间ISO8601 UTC、日标签YYYY-MM-DD且携timezone/revision；沿eslint.config.mjs、tsconfig.json及实际可执行lint/type/build约束，禁止新加格式化库、批量改旧文件或用本机时区算今日。

## 框架架构（已定，照它组织代码；完整说明见 08-后端架构）
- 目录结构：src/app/api/**/route.ts保留路由、src/auth.ts保留Auth.js组合；src/lib/server/admin/{device-session,action-grant,recovery}.ts属M3，chat/属M4，analytics/属M5，ops/属M6，jobs/放固定作业；src/lib/contracts/放新契约，prisma/schema.prisma仍是数据源；禁止另建应用或迁移无关旧模块。
- 分层与调用方向：新路径route→service→repo单向；route收发HTTP和调用守卫，service管业务/事务，repo接显式Prisma依赖执行查询；M6只读M4/M5查询，禁止repo反调service、service返回NextResponse、客户端导入server、统计或聊天反调看板；未改旧路径不强制重分层。
- 数据层：复用db.ts唯一PrismaClient；新查询集中模块repo，锁/聚合用Prisma.sql参数化，禁止service拼SQL及拼接queryRawUnsafe；每实例connection_limit=5、pool_timeout=10s，总连接不超过数据库可用额度；schema只经现有deploy.sh备份/diff/plan-check/db push/零drift，禁止accept-data-loss、删改旧列或把prisma/sql参考计划当已执行迁移。
- 中间件链：后台新入口按requestId/脱敏计时→requireAdmin(当前User/sv/sid/角色)→写操作精确同源→await限流→限体/Zod strict→service→HTTP错误映射；公开聊天先同源/限流再cookie范围校验，恢复先限流再凭据，cron仅Bearer；既有邮件gate仍最先；禁止仅靠layout鉴权、漏await、日志含验证码/token/正文/email。
- 事务边界：仅service或顶层use-case开事务，嵌套调用复用tx，禁止事务内SMTP/HTTP/文件IO与嵌套事务；一次性凭据核销+动作、恢复核销+sv/设备撤销+受限session、消息+seq+出箱均原子；敏感写最终重查账号/设备/授权；固定User→Device→Grant锁序，聚合整组原子替换并核作业代次，禁止先报成功再补关键写。
- 工具层：contracts及lib/chat/rules.ts、lib/analytics/rules.ts只放无IO的schema/枚举/纯转换；授权、同意准入、时钟、cookie、加密、存储与通知留server；禁止将带请求/状态的业务判断塞入utils或从纯模块读env。
- 错误体系：新AppError仅含受控code/fieldErrors，service抛领域错误，repo只转已识别唯一冲突；仅server/http/errors.ts映射新HTTP，未知错误脱敏记录；Auth.js CredentialsSignin、旧{error}/邮件状态/rum空体保持协议；禁止全库换信封或外泄Prisma/SMTP原始异常。
- 配置装载：server/config.ts首次Node运行组合时集中读env、Zod验证并冻结，沿instrumentation.ts与startup/env-check.ts生产检查；测试显式传配置；环境改动需重启，站点时区从版本化SiteSetting按同一revision读取；禁止业务散读新增env、构建内联秘密或静默热改安全策略。
- 依赖注入：不加DI库；server/composition.ts组装createService({repo,config,clock,tokenCrypto,mailer})供route使用；仅Prisma、冻结配置与无请求状态服务可为进程级对象；禁止全局当前用户/恢复凭据/消息/计数和以Map代替跨实例事实；依赖测试显式注入。
- 后台任务：jobs/registry.ts固定注册聊天通知、5min分析聚合、分析/聊天保留、运维采样及既有mail-queue包装，deploy/cron.nbshiyan真实调度；复用service/repo，持久租约+代次、batch≤500、截止55s；ChatNotification与消息同事务，SMTP事务外且稳定Message-ID/至少一次有界重试；禁止setInterval、after承担持久交付、看板GET跑作业或只写接口不接调度。
