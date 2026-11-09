# 文档补丁 m5t11-batch-units-20261109

任务：M5-T11
原分支：task/M5-T11
原 PR：None
依据：批量单位澄清（Jev A）：聚合批次按站点自然日 maxBatchDays≤500；分析保留按删除行（5,000行/批、20,000行/轮，三表合计）；其他作业既定批量限制不放宽；55s 只是时间预算，不是行数上限。

## 差异与复验范围

- ANALYTICS-ROLLUP：sections
- BACKFILL-MJS：sections
- BE-350A：sections
- BE-350B：sections
- BE-I18N-P0：sections
- BE-RATELIMIT-P3：sections
- BE-RESET-STDIN-TTY：sections
- BE-RESET-TTY：sections
- CATALOG-MERGE：sections
- CI-DB-TESTS：sections
- CI-DEVICE-SERIAL：sections
- CITY-STILL-WEBP：sections
- CLIENT-API-DEADLINE：sections
- DEP-AUDIT-1：sections
- DEPLOY-FIX-1：sections
- DOCKER-UPLOADS-1：sections
- E2E-CONSENT-FIX：sections
- FE-347：sections
- FE-378：sections
- FE-404-TITLE：sections
- FE-FAB-390：sections
- GATE-HARDEN：sections
- GATE-HARDEN-2：sections
- GATE-PATHS-1：sections
- GATE-PATHS-2：sections
- GIFT-CARD-ASSETS：sections
- GIFT-CARDS-RENAME：sections
- GUARD-503：sections
- HOTFIX-LOGIN-EMPTY：sections
- M1-T1：sections
- M1-T2：sections
- M1-T3：sections
- M1-T4：sections
- M1-T5：sections
- M1-T6：sections
- M1-T7：sections
- M1-T8：sections
- M1-T9：sections
- M2-T1：sections
- M2-T2：sections
- M2-T3：sections
- M2-T4：sections
- M2-T5：sections
- M2-T6：sections
- M2-T7：sections
- M2-T8：sections
- M3-T1：sections
- M3-T10：sections
- M3-T11：sections
- M3-T12：sections
- M3-T13：sections
- M3-T14：sections
- M3-T15：sections
- M3-T16：sections
- M3-T17：sections
- M3-T18：sections
- M3-T19：sections
- M3-T2：sections
- M3-T20：sections
- M3-T21：sections
- M3-T22：sections
- M3-T23：sections
- M3-T24：sections
- M3-T25：sections
- M3-T3：sections
- M3-T4：sections
- M3-T5：sections
- M3-T6：sections
- M3-T7：sections
- M3-T8：sections
- M3-T9：sections
- M4-T1：sections
- M4-T10：sections
- M4-T11：sections
- M4-T12：sections
- M4-T13：sections
- M4-T14：sections
- M4-T15：sections
- M4-T2：sections
- M4-T3：sections
- M4-T4：sections
- M4-T5：sections
- M4-T6：sections
- M4-T7：sections
- M4-T8：sections
- M4-T9：sections
- M5-T1：sections
- M5-T10：sections
- M5-T11：sections
- M5-T2：sections
- M5-T3：sections
- M5-T4：sections
- M5-T5：sections
- M5-T6：sections
- M5-T7：sections
- M5-T8：sections
- M5-T9：sections
- M6-T1：sections
- M6-T2：sections
- M6-T3：sections
- M6-T4：sections
- M6-T5：sections
- M6-T6：sections
- M6-T7：sections
- M7-T1：sections
- M7-T10：sections
- M7-T2：sections
- M7-T3：sections
- M7-T4：sections
- M7-T5：sections
- M7-T6：sections
- M7-T7：sections
- M7-T8：sections
- M7-T9：sections
- MAIN-E2E-FIX：sections
- POST-LAUNCH-P3：sections
- R3-T09233008：sections
- R3-T09598683：sections
- R3-T12074461：sections
- R3-T21757567：sections
- R3-T22883505：sections
- R3-T56876634：sections
- R3-T71889698：sections
- R3-T75625096：sections
- R3-T86511435：sections
- R3-T87287564：sections
- R3-T92231765：sections
- R4-T16305211：sections
- R4-T64765902：sections
- R4-T76958784：sections
- R4-T78812657：sections
- R5-T10248697：sections
- R5-T59021355：sections
- R7-T14077261：sections
- R7-T21418022：sections
- R7-T31416198：sections
- RETENTION-CLEANUP：sections
- SEO-1：sections
- SEO-2：sections
- SEO-3：sections
- SEO-4：sections
- SEO-5：sections
- SEO-6：sections
- SEO-7：sections

### 02-设计/08-后端架构.md

````diff
--- before/02-设计/08-后端架构.md
+++ after/02-设计/08-后端架构.md
@@ -59,7 +59,7 @@
 
 ## jobs
 
-jobs/registry.ts固定注册聊天通知、5min分析聚合、分析/聊天保留、运维采样及既有mail-queue包装，deploy/cron.nbshiyan真实调度；复用service/repo，持久租约+代次、batch≤500、截止55s；ChatNotification与消息同事务，SMTP事务外且稳定Message-ID/至少一次有界重试；禁止setInterval、after承担持久交付、看板GET跑作业或只写接口不接调度。
+jobs/registry.ts固定注册聊天通知、5min分析聚合、分析/聊天保留、运维采样及既有mail-queue包装，deploy/cron.nbshiyan真实调度；复用service/repo，持久租约+代次、总截止55s；聚合的批次以站点自然日计（maxBatchDays≤500），分析保留的批次以删除行计（生产配置5,000行/DELETE批次、20,000行/轮，三表合计，每批独立事务），其他作业沿用各自既定的500工作单位限制；ChatNotification与消息同事务，SMTP事务外且稳定Message-ID/至少一次有界重试；禁止setInterval、after承担持久交付、看板GET跑作业或只写接口不接调度。
 
 ## 会话与恢复适配
 
````

### 02-设计/09-数据模型.md

````diff
--- before/02-设计/09-数据模型.md
+++ after/02-设计/09-数据模型.md
@@ -70,7 +70,7 @@
 - 统计自然日是站点IANA时区的`[dayStart,nextDayStart)`，DST日不能固定加86400000ms；原始保存UTC发生与接收时间。相同browserHash在该时区同自然日全站去重，产品维度另去重，同浏览器不同日可各计一次，绝不称跨设备唯一真人。
 - 每轮采用PostgreSQL一致快照：每5min固定任务捕获cutoff与RepeatableRead快照，按receivedAt≤cutoff且该快照可见的原始事实重算当前日与48h迟到可能影响的日，按`timezoneRevision+day+dimension`事务替换；只有完成提交才推进sourceThrough/aggregatedAt。每次捕获同一settings revision，提交前重查revision；变化则丢弃本次结果、下次重算。不能先删旧结果后分批填充可见半成品。
 - 时区变更CAS生成新revision并登记30d内可重算范围。新时区无法重算原始已清理历史：返回coverage=partial/unavailable及最早可重算时间，旧revision仍标原时区，仅显式查询旧revision可读，不能混算或填0。接近30天清理边界先尝试完成整日聚合；失败显明覆盖缺口，但不能无限延长原始30天保留。只重算dayStart不早于完整原始覆盖起点的自然日，禁止用已部分清理日的残片替换完整旧聚合；时区重算同理。
-- 原始及其eventId/semanticKey去重记录按receivedAt保留30天；48h发生时间准入使已清理的旧请求不可重放。无浏览器关联的AnalyticsDaily保留13个自然月，边界值含义由expiresAt给出；清理按注册任务、有限批次、dry-run与计数证据完成，不清理既有备份。禁止因UV去重无限保存身份；90d聊天清理启用需另有明确生产保留授权，未获授权时保持dry-run并显明未启用，文档与隔离测试不代授不可逆清理。
+- 原始及其eventId/semanticKey去重记录按receivedAt保留30天；48h发生时间准入使已清理的旧请求不可重放。无浏览器关联的AnalyticsDaily保留13个自然月，边界值含义由expiresAt给出；清理按注册任务、有限批次、dry-run与计数证据完成（批量以删除行计：生产配置5,000行/DELETE批次、20,000行/轮且为三表合计，每批独立事务），不清理既有备份。禁止因UV去重无限保存身份；90d聊天清理启用需另有明确生产保留授权，未获授权时保持dry-run并显明未启用，文档与隔离测试不代授不可逆清理。
 
 ## 看板只读与来源
 
@@ -83,7 +83,7 @@
 ## 固定作业接线与可逆schema增量
 
 - M5首次交付registry基础及analytics-aggregate（每5分钟）、analytics-retention（每日）的实际注册/cron；M4交付时追加chat-notifications（每分钟）、chat-retention（每日），并补现有mail-queue每分钟调度；M6交付时追加ops-sample（每15分钟）与受控报告入口。各任务随所属模块立即接通，不等待M7；尚未交付的key不得注册空实现或导入未来服务。生产组合点依次添加注册，保留原cleanup/backup；cron操作系统时区只决定触发，统计日始终用SiteSetting时区。
-- 应用内工作每次max55s、batch≤500、租约90s、必要时续租；不让一个租约跨SMTP长事务。lease过期的通知先辨别requestStartedAt，未知投递可能重复；同一stableMessageId重试且受次数上限限制，旧代次不能覆盖当前结果。JobState仅固定工作状态，不新增可执行任意任务的产品。
+- 应用内工作每次max55s（时间预算，不等于行数上限）、租约90s、必要时续租；聚合作业的batch≤500按站点自然日计（maxBatchDays），分析保留按删除行计批量（5,000行/DELETE批次、20,000行/轮且为三表合计，每批独立事务）；其他作业沿用各自既定的500工作单位限制。不让一个租约跨SMTP长事务。lease过期的通知先辨别requestStartedAt，未知投递可能重复；同一stableMessageId重试且受次数上限限制，旧代次不能覆盖当前结果。JobState仅固定工作状态，不新增可执行任意任务的产品。
 - 部署仍以prisma/schema.prisma为源；新增表与有default/nullable列先上线、功能默认关闭；聊天不可逆清理默认dry-run，启用需明确生产保留授权；在专用Postgres验证diff、锁、回填、并发和旧版应用读取。沿现有deploy.sh备份→diff SQL→plan-check→db push→零drift→新应用冒烟，不能把prisma/sql参考文件当自动迁移。
 - User.passwordlessEnabled默认false；设备行不从旧JWT回填，上线要求已有管理员重新登录。设置初值以幂等脚本/服务upsert创建，旧账号/内容不批量修改。约束与索引可能触发现有plan-check审查，给出精确plan哈希与回滚演练，不用accept-data-loss绕过。
 - 回滚只回应用：新增表/列保留，功能开关关闭，旧代码忽略增量；普通Credentials拒绝恢复码的兼容安全层不得随UI回滚撤掉，恢复凭据/新cookie不能落回旧版宽松登录，必要时先全账号sv递增并清新cookie。上线前按候选/旧版真实兼容验证。任何删除、改名、非空强制、旧字段清理另立后续范围，不在本轮发布中做。生产部署/迁移未由本文自动授权。
````

### 04-执行/18-部署与运维.md

````diff
--- before/04-执行/18-部署与运维.md
+++ after/04-执行/18-部署与运维.md
@@ -96,7 +96,7 @@
 | 分析事件/保留 | M5；occurredAt接收窗口48h迟到/+5min；原始与去重30d、无关联聚合13自然月 | 非法字段拒绝；过覆盖范围明确partial/unavailable，不用残片重算完整历史 |
 | 新增保留任务授权策略 | M4/M5分别持有当前策略version与受保护授权依据；生产实际清理默认disabled、dry-run=true | 文档/任务/代理结论不构成授权；缺另行明确保留授权时拒绝真实删除，返回未启用/候选数/实际数0。只在一次性测试库验候选选择与并发，不碰生产/恢复/备份 |
 | 站点分析设置 | M5；SiteSetting持合法IANA timezone与revision、初始UTC；ADMIN通过10节CAS设置 | 无记录幂等创建初值；非法时区/冲突拒绝并保留原值，查看者操作系统时区不替代公司设置 |
-| 固定作业策略 | M5基础，M4/M6注册自己的key；batch≤500、总截止55s、租约90s、代次CAS | 未注册key拒绝；没有成功记录不伪造心跳；尚未交付的模块不注册空函数 |
+| 固定作业策略 | M5基础，M4/M6注册自己的key；聚合batch≤500按站点自然日计、总截止55s、租约90s、代次CAS；分析保留按删除行计（5,000行/批、20,000行/轮，三表合计） | 未注册key拒绝；没有成功记录不伪造心跳；尚未交付的模块不注册空函数；其他作业的既定批量限制不放宽 |
 | 新接口体积/速率/超时 | 10节为协议源；账号8KiB、聊天16KiB、分析32KiB；普通客户端15s、DB5s、聚合事务30s | 限体先于解析；非法集中配置拒绝；429带Retry-After，DB/超时503，副作用请求按逐路径规则不自动重发 |
 | 看板新鲜度与来源 | M6；分析15min、聊天/邮件5min、存储45min、备份36h | 按真实lastSucceededAt标旧值；辅助来源缺配置为not_connected，核心访问/3D必须随功能接通 |
 
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T11：注册默认dry-run的分析保留任务
沿用分支 task/M5-T11、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：67056941490af50ad3bf52c429ea488c4ebf00af1e007ba0611ba1bc7e85a8af
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) operations固定analytics-retention→已实现服务→registry/每日cron实际注册
默认dryRun且真实清理关闭，无另行明确生产保留授权时启用/删除请求拒绝、实际删除0，只返回候选计数。2) 仅隔离Postgres数据验证receivedAt30天/聚合13自然月目标集合、计数与去标识
显示查询覆盖、不重建过期明细，不扩备份/既有数据删除权限（E-48）。3) 清理后调用既有聚合服务：只重算dayStart≥完整原始覆盖起点，48h迟到仍在完整范围时重算
部分清理日保留旧完整聚合并返回partial/unavailable与原口径，不用残片替换、不延长保留（E-82）
租约旧代次拒绝且不接触生产/恢复/备份数据。
有效范围：
.github/workflows/ci.yml
deploy/cron.nbshiyan
src/auth.ts
src/lib/server/analytics/aggregate.ts
src/lib/server/analytics/retention.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
tests/analytics-retention.db.test.ts
tests/jobs-runtime.http.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T11:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
