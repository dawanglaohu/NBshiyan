# 文档补丁 b9-m5t12-registration-20261109

任务：M6-T1
原分支：task/M5-T12
原 PR：none
依据：B9-M5T12-FORMAL-REGISTRATION：docs-only 登记 M5-T12（19/09/08/18/data-retention/task-contracts/presentation），并同笔更新 M6-T1 依赖与口径；不实施、不 push。

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
- M5-T12：architecture、definition、edges、effectivePaths、handoff、module、project、sections、task、wiring
- M5-T2：sections
- M5-T3：sections
- M5-T4：sections
- M5-T5：sections
- M5-T6：sections
- M5-T7：sections
- M5-T8：sections
- M5-T9：sections
- M6-T1：definition、sections、task
- M6-T2：sections
- M6-T3：sections
- M6-T4：sections
- M6-T5：sections
- M6-T6：sections、task
- M6-T7：sections
- M7-T1：sections
- M7-T10：sections
- M7-T2：sections
- M7-T3：sections、task
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
 
-jobs/registry.ts固定注册聊天通知、5min分析聚合、分析/聊天保留、运维采样及既有mail-queue包装，deploy/cron.nbshiyan真实调度；复用service/repo，持久租约+代次、总截止55s；聚合的批次以站点自然日计（maxBatchDays≤500），分析保留的批次以删除行计（生产配置5,000行/DELETE批次、20,000行/轮，三表合计，每批独立事务），其他作业沿用各自既定的500工作单位限制；ChatNotification与消息同事务，SMTP事务外且稳定Message-ID/至少一次有界重试；禁止setInterval、after承担持久交付、看板GET跑作业或只写接口不接调度。
+jobs/registry.ts固定注册聊天通知、5min分析聚合、分析/聊天保留、运维采样及既有mail-queue包装，deploy/cron.nbshiyan真实调度；复用service/repo，持久租约+代次、总截止55s；聚合的批次以站点自然日计（maxBatchDays≤500），分析保留的批次以删除行计（四类数据表合计20,000行/轮、DELETE单批5,000行、AnalyticsDaily≤1,000行；两元数据表各500行/轮、合计1,000/轮，独立于四表，每批独立事务）；实施后04:30 analytics-retention成为AnalyticsDaily、AnalyticsAggregateDayState、AnalyticsDayChange唯一清理者，03:30旧链只跑既有三表，两链共用analytics-aggregate租约、不新增cron，其他作业沿用各自既定的500工作单位限制；ChatNotification与消息同事务，SMTP事务外且稳定Message-ID/至少一次有界重试；禁止setInterval、after承担持久交付、看板GET跑作业或只写接口不接调度。
 
 ## 会话与恢复适配
 
````

### 02-设计/09-数据模型.md

````diff
--- before/02-设计/09-数据模型.md
+++ after/02-设计/09-数据模型.md
@@ -23,7 +23,9 @@
 | ChatReadCursor（M4） | `conversationId` FK，`userId` FK，`lastReadSeq Int`，`updatedAt` | 复合PK conversationId/userId；后台未读按当前运营人员游标计算。读标记只允许前进到已存在seq，MAX/CAS，不能回退或越过lastSeq。访客游标单独在Conversation。 |
 | ChatNotification（M4） | `id`，`conversationId`，`messageId`（对应访客消息），`status QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED`，`attempts Int`，`availableAt`，`leaseVersion Int`，`leaseOwner String?`，`stableMessageId String`，`lockedUntil DateTime?`，`requestStartedAt DateTime?`，`lastErrorCode String?`，`providerMessageId String?`，`sentAt DateTime?`，`createdAt`，`updatedAt` | messageId唯一；每条成功访客消息一条幂等通知，无定时催办产品；通知只含收件事实与受保护后台链接，不复制正文/email/token。租约认领与状态条件更新，SMTP在事务外。按至少一次策略最多3次退避1m/5m/30m；已开始SMTP后结果不明或租约过期记UNKNOWN并可用同一stableMessageId有界重领，故可能重复；CAS核leaseOwner/version防旧worker回写。SMTP适配器新增可选messageId保持旧调用兼容。未配置→DISABLED，绝不报SENT。 |
 | AnalyticsEvent（M5） | `eventId UUID`，`semanticKey String`，`payloadHash`，`browserHash`，`kind` 白名单枚举，`occurredAt UTC`，`receivedAt UTC`，`locale en/ru`，`path String?`，`productSlug String?`，`navigationId UUID?`，`viewId UUID?`，`durationMs Int?`（终态0..600000），`failureReason String?`（LOAD_ERROR/TIMEOUT/WEBGL_UNAVAILABLE） | eventId PK，semanticKey唯一；索引occurredAt、receivedAt、productSlug/occurredAt、viewId。只收服务器验过的同意cookie；browserHash由服务端域分离HMAC派生，不收IP/UA原文/email/正文/完整URL。原始按receivedAt保留30天。eventId和semanticKey均在原始窗口保留，旧于48h的事件拒绝，不能在30d清理后重放旧事件。 |
-| AnalyticsDaily（M5） | `localDate String YYYY-MM-DD`，`timezoneRevision Int`，`timezone String`，`dimension String`（site或product:已发布产品slug），`visitors Int`，`pageViews Int`，`productViews Int`，`modelStarts Int`，`modelSuccesses Int`，`modelFailures Int`，`meanLoadDurationMs Float?`，`loadDurationSamples Int`，`chatStarts Int`，`sourceThrough DateTime`，`aggregatedAt DateTime`，`expiresAt` | 复合PK localDate/timezoneRevision/dimension；计数非负；整站访客与产品访客各自distinct，不可累加产品访客冒充全站UV。不得含browserHash、IP或可回连身份；按自然月保留13个月。不新增按浏览器长期去重账本，直接从仍保留的原始事实重算。 |
+| AnalyticsDaily（M5） | `localDate String YYYY-MM-DD`，`timezoneRevision Int`，`timezone String`，`dimension String`（site或product:已发布产品slug），`visitors Int`，`pageViews Int?`（product为NULL），`productViews Int`，`modelStarts Int`，`modelSuccesses Int`，`modelFailures Int`，`chatStarts Int`，`durationMsSum BigInt`，`loadDurationSamples Int`，`sourceThrough DateTime?`（零事实不造时间），`aggregatedAt DateTime`，`expiresAt DateTime` | 复合PK localDate/timezoneRevision/dimension；索引expiresAt与(dimension, localDate)；计数非负；整站访客与产品访客各自distinct，不可累加产品访客冒充全站UV；耗时只存精确总和与有效样本数，均值读侧加权计算，不存日均值；不得含browserHash、IP或可回连身份；无关联聚合保留13个自然月，按行内timezone的expiresAt（等号到期、月末/闰年夹取）删除。不新增按浏览器长期去重账本，直接从仍保留的原始事实重算。 |
+| AnalyticsAggregateDayState（M5） | `localDate String`，`timezoneRevision Int`，`timezone String`（该revision的IANA时区），`markerVersions Json`，`deferUntil DateTime?`，`gapKind String?`，`gapSince DateTime?`，`updatedAt` | 复合PK localDate/timezoneRevision；索引(timezoneRevision, localDate)；marker/defer/gap 的无身份辅助状态，不含事件/身份字段。`deferUntil` 存最早未到期值；gap只是证据。按自身timezone正推13自然月到期；同键还有未到期AnalyticsDaily时保留；13月到期优先于永久gap/远期defer/live-ahead；坏timezone只诊断并定向保守保留。被GC与所有state写者共用租约/代次守卫。 |
+| AnalyticsDayChange（M5） | `utcDate String YYYY-MM-DD`（主键，无id），`version BigInt @default(0)`，`updatedAt` | 每UTC日的live版本；ingest在同一事务bump，聚合消费后记录markerVersions。按UTC日反推13自然月＋2天GC，删除前排除仍存续state覆盖的UTC日与markerVersions键；先state后marker。不含事件/身份字段。 |
 | JobState（M5作业基础，先于消费者交付） | `key` 注册白名单，`leaseOwner String?`，`generation Int`，`lockedUntil DateTime?`，`lastStartedAt DateTime?`，`lastSucceededAt DateTime?`，`lastFinishedAt DateTime?`，`lastStatus` NEVER/RUNNING/SUCCEEDED/FAILED/PARTIAL，`lastErrorCode String?`，`summary Json?` | PK key，仅固定registry接受值；租约CAS，时钟取服务端；summary严格白名单计数/时间/版本，不接任意日志。提交同时核代次/租约和当前时区revision；旧任务不得覆盖新结果。没有任意代码/脚本/调度创建API。任务失败不覆盖最近成功数据时间。 |
 | ApiDailyCounter（M3共享HTTP生产者，M6只读） | `localDate`、`timezoneRevision`、`routeId`固定白名单、`requestCount Int`、`errorCount Int`、`lastObservedAt` | 复合PK日/revision/routeId；仅本轮已接线新API的最终状态记录，error为5xx，upsert原子递增；不含请求体/IP/用户/完整URL。计数写失败不改变核心业务响应，来源标部分覆盖/失败并保留安全告警；无真实总数不展示错误率。保留13个月，不冒充全站监控。 |
 | OpsSourceSnapshot（M6） | `source STORAGE/BACKUP` PK，`status OK/FAILED/NOT_CONNECTED`，`measuredAt`，`lastSucceededAt DateTime?`，`values Json?`（只允许bytesUsed/bytesFree或backupCompletedAt/backupAgeSeconds/verified），`safeErrorCode String?` | 仅由M6交付的固定受鉴权report脚本/ops-sample任务写，M3/M4/M5不调用该来源，JSON schema限定数字/布尔/时间；浏览器看板只读，无路径、文件名、主机地址、dump内容或密钥。报告按source+measuredAt单调CAS，同时间同载荷复用原结果、同时间异载荷409、旧时间忽略；failed保留最后成功values并明确旧值，未配置无虚假成功时间。 |
@@ -70,7 +72,7 @@
 - 统计自然日是站点IANA时区的`[dayStart,nextDayStart)`，DST日不能固定加86400000ms；原始保存UTC发生与接收时间。相同browserHash在该时区同自然日全站去重，产品维度另去重，同浏览器不同日可各计一次，绝不称跨设备唯一真人。
 - 每轮采用PostgreSQL一致快照：每5min固定任务捕获cutoff与RepeatableRead快照，按receivedAt≤cutoff且该快照可见的原始事实重算当前日与48h迟到可能影响的日，按`timezoneRevision+day+dimension`事务替换；只有完成提交才推进sourceThrough/aggregatedAt。每次捕获同一settings revision，提交前重查revision；变化则丢弃本次结果、下次重算。不能先删旧结果后分批填充可见半成品。
 - 时区变更CAS生成新revision并登记30d内可重算范围。新时区无法重算原始已清理历史：返回coverage=partial/unavailable及最早可重算时间，旧revision仍标原时区，仅显式查询旧revision可读，不能混算或填0。接近30天清理边界先尝试完成整日聚合；失败显明覆盖缺口，但不能无限延长原始30天保留。只重算dayStart不早于完整原始覆盖起点的自然日，禁止用已部分清理日的残片替换完整旧聚合；时区重算同理。
-- 原始及其eventId/semanticKey去重记录按receivedAt保留30天；48h发生时间准入使已清理的旧请求不可重放。无浏览器关联的AnalyticsDaily保留13个自然月，边界值含义由expiresAt给出；清理按注册任务、有限批次、dry-run与计数证据完成（批量以删除行计：生产配置5,000行/DELETE批次、20,000行/轮且为三表合计，每批独立事务），不清理既有备份。禁止因UV去重无限保存身份；90d聊天清理启用需另有明确生产保留授权，未获授权时保持dry-run并显明未启用，文档与隔离测试不代授不可逆清理。
+- 原始及其eventId/semanticKey去重记录按receivedAt保留30天；48h发生时间准入使已清理的旧请求不可重放。无浏览器关联的AnalyticsDaily保留13个自然月，边界值含义由expiresAt给出；清理按注册任务、有限批次、dry-run与计数证据完成（按行内timezone的expiresAt<=now等号到期；四类数据表合计20,000行/轮、DELETE单批5,000、AnalyticsDaily≤1,000；两元数据表各500行/轮、合计1,000/轮，独立于四表；配额是删除/批次上限、不约束候选总数，candidateCount/deletedCount分列，每批独立事务），不清理既有备份。禁止因UV去重无限保存身份；90d聊天清理启用需另有明确生产保留授权，未获授权时保持dry-run并显明未启用，文档与隔离测试不代授不可逆清理。
 
 ## 看板只读与来源
 
@@ -83,7 +85,7 @@
 ## 固定作业接线与可逆schema增量
 
 - M5首次交付registry基础及analytics-aggregate（每5分钟）、analytics-retention（每日）的实际注册/cron；M4交付时追加chat-notifications（每分钟）、chat-retention（每日），并补现有mail-queue每分钟调度；M6交付时追加ops-sample（每15分钟）与受控报告入口。各任务随所属模块立即接通，不等待M7；尚未交付的key不得注册空实现或导入未来服务。生产组合点依次添加注册，保留原cleanup/backup；cron操作系统时区只决定触发，统计日始终用SiteSetting时区。
-- 应用内工作每次max55s（时间预算，不等于行数上限）、租约90s、必要时续租；聚合作业的batch≤500按站点自然日计（maxBatchDays），分析保留按删除行计批量（5,000行/DELETE批次、20,000行/轮且为三表合计，每批独立事务）；其他作业沿用各自既定的500工作单位限制。不让一个租约跨SMTP长事务。lease过期的通知先辨别requestStartedAt，未知投递可能重复；同一stableMessageId重试且受次数上限限制，旧代次不能覆盖当前结果。JobState仅固定工作状态，不新增可执行任意任务的产品。
+- 应用内工作每次max55s（时间预算，不等于行数上限）、租约90s、必要时续租；聚合作业的batch≤500按站点自然日计（maxBatchDays），分析保留按删除行计批量（四类数据表合计20,000行/轮、DELETE单批5,000行、AnalyticsDaily≤1,000行；两元数据表各500行/轮、合计1,000/轮，独立于四表，每批独立事务）；其他作业沿用各自既定的500工作单位限制。不让一个租约跨SMTP长事务。lease过期的通知先辨别requestStartedAt，未知投递可能重复；同一stableMessageId重试且受次数上限限制，旧代次不能覆盖当前结果。JobState仅固定工作状态，不新增可执行任意任务的产品。
 - 部署仍以prisma/schema.prisma为源；新增表与有default/nullable列先上线、功能默认关闭；聊天不可逆清理默认dry-run，启用需明确生产保留授权；在专用Postgres验证diff、锁、回填、并发和旧版应用读取。沿现有deploy.sh备份→diff SQL→plan-check→db push→零drift→新应用冒烟，不能把prisma/sql参考文件当自动迁移。
 - User.passwordlessEnabled默认false；设备行不从旧JWT回填，上线要求已有管理员重新登录。设置初值以幂等脚本/服务upsert创建，旧账号/内容不批量修改。约束与索引可能触发现有plan-check审查，给出精确plan哈希与回滚演练，不用accept-data-loss绕过。
 - 回滚只回应用：新增表/列保留，功能开关关闭，旧代码忽略增量；普通Credentials拒绝恢复码的兼容安全层不得随UI回滚撤掉，恢复凭据/新cookie不能落回旧版宽松登录，必要时先全账号sv递增并清新cookie。上线前按候选/旧版真实兼容验证。任何删除、改名、非空强制、旧字段清理另立后续范围，不在本轮发布中做。生产部署/迁移未由本文自动授权。
````

### 04-执行/18-部署与运维.md

````diff
--- before/04-执行/18-部署与运维.md
+++ after/04-执行/18-部署与运维.md
@@ -93,10 +93,10 @@
 | 聊天凭据与内容保留 | M4；必要cookie7d闲置/30d绝对；咨询消息/主动邮箱最后成功收发后90d | 两项独立配置；不以轮询续内容期限；没有cookie不能凭邮箱恢复会话 |
 | 聊天可用性/通知策略 | M4；站内收件与通知分别判断；通知持久出箱最多3次、退避1m/5m/30m、SMTP截止20s | 配置/依赖缺失呈真实不可用或DISABLED，不能显示SENT；不影响已成功保存的received |
 | 分析同意与凭据 | M5；签名cookie版本、同意有效期不超既有一年；既有秘密按用途域分离 | 未明确同意不建ID/事件；签名无效/版本/期限非法拒绝采集；没有新增线上AI密钥 |
-| 分析事件/保留 | M5；occurredAt接收窗口48h迟到/+5min；原始与去重30d、无关联聚合13自然月 | 非法字段拒绝；过覆盖范围明确partial/unavailable，不用残片重算完整历史 |
+| 分析事件/保留 | M5；occurredAt接收窗口48h迟到/+5min；原始与去重30d、无关联聚合13自然月；AnalyticsDaily按行内timezone的expiresAt到期，两元数据表按各自公式GC（state自身时区13月、marker UTC日13月＋2天）；实施后04:30为三张新表唯一清理者 | 非法字段拒绝；过覆盖范围明确partial/unavailable，不用残片重算完整历史；实施前仍三表运行，不写已建表 |
 | 新增保留任务授权策略 | M4/M5分别持有当前策略version与受保护授权依据；生产实际清理默认disabled、dry-run=true | 文档/任务/代理结论不构成授权；缺另行明确保留授权时拒绝真实删除，返回未启用/候选数/实际数0。只在一次性测试库验候选选择与并发，不碰生产/恢复/备份 |
 | 站点分析设置 | M5；SiteSetting持合法IANA timezone与revision、初始UTC；ADMIN通过10节CAS设置 | 无记录幂等创建初值；非法时区/冲突拒绝并保留原值，查看者操作系统时区不替代公司设置 |
-| 固定作业策略 | M5基础，M4/M6注册自己的key；聚合batch≤500按站点自然日计、总截止55s、租约90s、代次CAS；分析保留按删除行计（5,000行/批、20,000行/轮，三表合计） | 未注册key拒绝；没有成功记录不伪造心跳；尚未交付的模块不注册空函数；其他作业的既定批量限制不放宽 |
+| 固定作业策略 | M5基础，M4/M6注册自己的key；聚合batch≤500按站点自然日计、总截止55s、租约90s、代次CAS；分析保留按删除行计（四类数据表合计20,000行/轮、DELETE单批5,000行、AnalyticsDaily≤1,000；两元数据表各500行/轮、合计1,000/轮，独立于四表） | 未注册key拒绝；没有成功记录不伪造心跳；尚未交付的模块不注册空函数；其他作业的既定批量限制不放宽；metadata两表上限不得并入四表额度 |
 | 新接口体积/速率/超时 | 10节为协议源；账号8KiB、聊天16KiB、分析32KiB；普通客户端15s、DB5s、聚合事务30s | 限体先于解析；非法集中配置拒绝；429带Retry-After，DB/超时503，副作用请求按逐路径规则不自动重发 |
 | 看板新鲜度与来源 | M6；分析15min、聊天/邮件5min、存储45min、备份36h | 按真实lastSucceededAt标旧值；辅助来源缺配置为not_connected，核心访问/3D必须随功能接通 |
 
````

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -76,16 +76,17 @@
 | M5-T9 | 建立版本化IANA时区与自然日仓储规则 | M5 | M1-T2、M3-T1 | SiteSetting既有CAS、09节timezoneRevision与UTC事件规则 | analytics-settings-domain；时区校验、版本CAS及本地日UTC边界服务 | 1) 用Intl/IANA计算本地午夜至次日午夜的左闭右开UTC边界，测试23/25小时DST、午夜归属唯一和两种浏览器时区输入不影响站点日。2) 隔离Postgres中ADMIN当前角色通过版本CAS改有效timezone/revision并记录重算待办，非法IANA/旧version/非ADMIN拒绝且原值不变；保持UTC事件不改写；HTTP接线由M5-T4完成。 | 1d |
 | M5-T10 | 呈现ADMIN时区表单与保存反馈 | M5 | M5-T4、M3-T7、M1-T7 | analytics-settings-api、admin-shell-profile-ui及visual-components | analytics-settings-ui；后台settings的analytics分区表单 本卡只在ops.ts增加settings/analytics的GET/PATCH方法，M6-T4另追加stats方法，互不覆盖。 | 1) 真浏览器点settings-link→/admin/settings的analytics分区，GET读取后点击保存PATCH发送expectedVersion，显示服务端新revision/recomputableFrom及重算partial；非法IANA字段错误不清原值，非ADMIN不可进入且直接接口403（E-59）。2) 页面标明共同站点IANA时区，两种浏览器时区查看同一设置得到同值，此任务只验设置页，指标图表/导出由M6集成验共同标签；1920×1080/1440×900/390×844按form运行D1–D6与overflow，保留实际请求GIF/computed style，消费11节唯一风格。 | 1d |
 | M5-T11 | 注册默认dry-run的分析保留任务 | M5 | M5-T5、M5-T8 | analytics-retention-plan、job-foundation与明确保留授权门禁 | analytics-retention；固定每日job、候选/实际计数与授权拒绝 | 1) operations固定analytics-retention→已实现服务→registry/每日cron实际注册；默认dryRun且真实清理关闭，无另行明确生产保留授权时启用/删除请求拒绝、实际删除0，只返回候选计数。2) 仅隔离Postgres数据验证receivedAt30天/聚合13自然月目标集合、计数与去标识；显示查询覆盖、不重建过期明细，不扩备份/既有数据删除权限（E-48）。3) 清理后调用既有聚合服务：只重算dayStart≥完整原始覆盖起点，48h迟到仍在完整范围时重算；部分清理日保留旧完整聚合并返回partial/unavailable与原口径，不用残片替换、不延长保留（E-82）；租约旧代次拒绝且不接触生产/恢复/备份数据。 | 1d |
-| M6-T1 | 定义统计查询范围与核心来源DTO | M6 | M5-T3、M2-T4、M2-T7 | 真实AnalyticsDaily及JobState结构、09来源矩阵、10 StatsDTO | stats-query-rules；核心来源DTO与只读聚合查询规则，接线由M6-T6交付 | 1) 专用PG测试按同一timezoneRevision与左闭右开日区间读取AnalyticsDaily；成功且确有0输出zero并有成功查询时间与授权覆盖，未覆盖区间输出no_data/null，来源未配置或任务未接通输出not_connected，不从产品UV相加算全站UV（E-49、E-50）。2) 对真实modelStarts/successes/failures/duration samples计算：无样本null、有样本零成功为0%、终态样本平均值正确且分母仅授权start；不同查看者时区读到相同站点日和值（E-55、E-63）。 | 1d |
+| M5-T12 | 补齐13个自然月无身份日聚合的3D耗时、配对终态与日级独立访客 | M5 | M5-T3、M5-T11 | 原始AnalyticsEvent（30天durationMs/viewId/browserHash事实）、既有AnalyticsDailyRollup/AnalyticsRollupDay、M5-T3快照日替换、M5-T11 13月保留、09/10与M5-T6原始事件语义（start/terminal字段与终态约定按数据事实消费）、已审r5r3设计与独审PASS | analytics-anon-aggregate；AnalyticsDaily（durationMsSum BigInt/loadDurationSamples/可空pageViews/行内timezone/expiresAt）＋AnalyticsAggregateDayState（含revision timezone）＋AnalyticsDayChange（utcDate主键、无id）；共享utcDatesCovered；ingest marker bump、day-state、defer/gap/CAS | 1) 真PG按(localDate,timezoneRevision,dimension)写13个自然月无身份聚合；durationMsSum为精确BigInt总和、loadDurationSamples只计配对终态有效样本；distinct可用SQL/DB COUNT(DISTINCT)，落库只留计数；不落browserHash/eventId/viewId/navigationId/IP/UA或任何可回连身份。2) 配对按(browserHash,viewId)；终态读取不受occurredAt窗口限制，但按occurredAt<=notAfter分区（计入/并入最早defer），跨午夜/DST终态归start所在站点日；不得出现终态日starts=0而successes>0；Q2/Q5用与Q1/Q3/Q4同一真实路径冒烟谓词（去query/fragment后，仅整条路径或任一路径段以nbs-smoke-开头才排除，段中出现不匹配，NULL放行），冒烟-only start→late_unattributable gap，真实start不被更早冒烟start遮蔽。3) 均值=ΣdurationMsSum/ΣloadDurationSamples，不对日均值再平均；samples=0→null/no_data；有start分母(modelStarts>0)且successes=0→0%；samples不是成功率分母；拒绝/撤回/未同意/无start不补分母、不进样本；product pageViews=NULL、M6返回no_data。4) 站点/产品日UV各自distinct；同一浏览器跨locale/跨产品在每个维度只计一次，同产品en+ru仍product UV=1；locale/产品/日UV不可相加，产品UV不得相加成站点UV。5) marker/live＋day-state：ingest在同一事务bump AnalyticsDayChange(utcDate,version)（该表无id、只以utcDate为键）；聚合日事务写day-state(markerVersions/deferUntil/gapKind/timezone)，deferUntil存最早未到期值（旧defer仅在>notAfter时保留，与Q1/Q3新延期事实取min；到期未重算仍partial）；所有写state的事务（commit/gap/coverage/bootstrap）与GC同受租约/代次守卫；M6同一读快照三查site行（取该revision行内timezone）、day-state、映射UTC日live marker；complete=site行＋无gap＋defer空＋映射UTC日的live与consumed按缺省0比较相等（缺键即0；零事件日不因此partial）；无site行no_data（+gap），缺state/gap/defer/live前进partial；旧revision按行内timezone映射；产品状态继承站点日，只有complete日缺产品行才可证0。6) 覆盖：coverageStart=max(recomputableFrom(now,tz),首个dayStart>eventCutoff+5min的本地日界)；覆盖检查作用于base/脏日/闭包；不可重算→独立CAS元数据事务消费marker置raw_partial、保留旧行、不读raw不改指标；bootstrap用ON CONFLICT DO NOTHING写state＋not_backfilled、不写指标；成功先提交后迟到gap CAS 0行不复活、commit未知不宣称必回滚或绝不消费；历史残片不改写旧完整行。7) 保留：AnalyticsDaily仅按行内timezone的expiresAt＝13个自然月到期（等号到期、月末/闰年夹取），扫描域缓冲13个自然月＋2天单列；state按自身timezone的13个自然月到期（无未到期AnalyticsDaily才删；13月到期优先于永久gap/远期defer/live-ahead；合法终止gap不是损坏；坏timezone只诊断并定向保守保留、不宣称其有界删除）；marker按UTC日反推shiftLocalDays(shiftCalendarMonths(utcToday,-13),-2)、删utcDate<cutoffUtc，并保留仍存续state覆盖的UTC日∪markerVersions键；先state后marker；03:30旧链保持三表，04:30 analytics-retention在实施后才是新三表唯一清理者（共用租约、每批事务＋续租＋revision守卫），不新增cron行；500是聚合站点日/目标日上限（不是行数），DELETE单批5,000行，四类数据表每轮删除总上限20,000行，AnalyticsDaily≤1,000行；两元数据表各500行/轮（=单批上限、整轮实际删除总额）、合计1,000/轮、独立于四表；读页与删除额度分开，覆盖读取＋安全集合删除在同一批事务内完成，分页仅在本轮剩余额度内继续、用尽即结束该表本轮，下一轮从空游标重扫；candidateCount与deletedCount分列、实际删除数单列，不承诺每轮必删19,000行；只有已确认提交批次计数，提交未知不计数并停止metadata阶段；不延长原始30天、不重建历史、不填0。8) 纯函数测试＋真PG测试全绿；不改统计HTTP路由/contracts/ops/生产开关/cron时刻；product pageViews跨导航扩展不在本任务（E-48、E-55、E-56、E-57、E-63、E-80、E-81、E-82、E-83）。 | 2d |
+| M6-T1 | 定义统计查询范围与核心来源DTO | M6 | M5-T3、M2-T4、M2-T7、M5-T12 | 真实AnalyticsDaily及JobState结构、M5-T12的AnalyticsDaily（localDate/timezoneRevision/timezone/dimension/visitors/pageViews/productViews/modelStarts/modelSuccesses/modelFailures/chatStarts/durationMsSum/loadDurationSamples/sourceThrough/expiresAt）与AnalyticsAggregateDayState（markerVersions/deferUntil/gapKind）、部署前既有AnalyticsDailyRollup计数按阶段合并不双计、09来源矩阵、10 StatsDTO | stats-query-rules；核心来源DTO与只读聚合查询规则，接线由M6-T6交付 | 1) 专用PG测试按同一timezoneRevision与左闭右开日区间读取AnalyticsDaily；成功且确有0输出zero并有成功查询时间与授权覆盖，未覆盖区间输出no_data/null，来源未配置或任务未接通输出not_connected，不从产品UV相加算全站UV（E-49、E-50）。读取M5-T12新表（部署后）与既有AnalyticsDailyRollup（部署前），按阶段合并不双计；旧rollup不冒充新表覆盖；覆盖起点前no_data/partial，不填0。2) 对真实modelStarts/successes/failures/duration samples计算：无样本null、有样本零成功为0%、终态样本平均值正确且分母仅授权start；不同查看者时区读到相同站点日和值（E-55、E-63）。均值按ΣdurationMsSum/ΣloadDurationSamples加权，不对日均值再平均；只计有start的配对终态；samples=0→null/no_data；有start分母且success=0→0%；product pageViews返回no_data，不填0；M6分类按site行＋day-state＋live marker（live/consumed缺键按0比较），旧revision用行内timezone。 | 1d |
 | M6-T2 | 接入询盘与聊天只读业务计数 | M6 | M6-T6、M4-T4 | stats-core、真实Inquiry/ChatConversation/ChatMessage与既有SALES scope | stats-business；统计入口business来源适配器 | 1) 通过真实POST /api/inquiries及POST /api/chat/conversations保存合成询盘/消息，再GET /api/admin/stats请求business来源核持久且不变业务ID计数；同消息UUID重试及被拒垃圾不增加计数，结果不含email/body（E-62）。2) ADMIN/SALES按既有询盘scope只读查询；统计查询故障不能回滚或阻断咨询保存，业务计数不要求M4导入M6；未登录及EDITOR直接请求业务来源拒绝（E-62、E-66）。 | 1d |
 | M6-T3 | 登记存储备份报告与运维采样 | M6 | M6-T6、M5-T1、M5-T8 | job-foundation、受控服务器脚本、既有备份元数据、10报告契约 | ops-sources；ops-sample、POST /api/internal/ops-report与只读报告脚本 | 1) 受控deploy脚本→真实POST /api/internal/ops-report，Bearer与白名单严格；仅空间计数/备份完成验证元数据，拒任意路径和内容；同source+measuredAt同载荷幂等、异载荷409、旧时间不覆盖新值；无验证来源not_connected；SALES/EDITOR直接GET stats的STORAGE/BACKUP来源403且无计数，后台session不能替代report Bearer（E-65、E-66）。2) ops-sample在registry、composition、cron实际注册每15分钟，重启后按计划运行；真实measuredAt/lastSucceededAt读取到stats，停止报告显示原时间/旧值，未做恢复验证不能标可恢复；辅助源异常不阻断核心（E-67）。 | 2d |
 | M6-T4 | 交付可导航的核心数据看板页面 | M6 | M6-T6、M3-T7 | stats-core、后台壳、07页面入口与11样式密度 | stats-base-ui；后台stats-link、日期/产品/刷新与核心指标页面 | 1) 真登录后点击后台壳stats-link到/admin/stats；日期/产品/刷新控件发真实GET /api/admin/stats并渲染对应core DTO，授权浏览器/PV/产品/3D有真实来源，样本数与时区标签可见（E-61、E-63）。2) ADMIN/SALES/EDITOR页面仅呈其权限来源，直接请求越权仍403且响应不含隐藏计数；1920×1080、1440×900、390×844以真实会话留GIF与density=7/gutter16/gap16/pad16报告，work面按D1-D6且手机保留真实n/a（E-66）。 | 1.5d |
 | M6-T5 | 接入HTTP和邮件可靠性来源 | M6 | M6-T6、M4-T4 | stats-core、M3真实ApiDailyCounter、MailMessage与ChatNotification状态 | stats-reliability；明确覆盖的HTTP与通知计数适配器 | 1) 对已接线API产生真实2xx/5xx响应后GET /api/admin/stats的http来源，分母为同范围真实requestCount且错误为5xx；覆盖标签仅本轮instrumented routes，无分母为null、未接入为not_connected，禁止声称全站错误率（E-64）。2) 通过真实通知作业产生queued/sending/sent/failed/unknown结果，mail来源按真实尝试/SMTP接受计数，不把排队或咨询received算投递；某来源查询失败保留其原成功时间/旧值或显示无旧值失败，其他来源继续成功（E-51、E-52、E-53、E-64、E-67）。 | 1.5d |
-| M6-T6 | 接通受角色限制的真实统计HTTP入口 | M6 | M6-T1、M5-T4 | stats-query-rules、现行requireAdmin与scope、10 GET stats契约 | stats-core；GET /api/admin/stats与生产组合注册 | 1) 真实登录后GET /api/admin/stats→route→ops查询真实聚合，核HTTP状态、DTO与数据时间；同意→真实页面/产品访问→真实GLB start/terminal→已注册五分钟作业提交后，逐项核当日授权浏览器、PV、产品归因、3D次数，核心来源不能固定返回或未接入（E-61）。2) 未登录401；ADMIN全来源、SALES既有业务范围、EDITOR仅公开流量/产品/3D；直接请求敏感系统来源403，混合来源在查询前裁剪且无隐藏计数（E-66）。3) 切换有效时区后返回当前revision与重算状态，仅保留期完整覆盖可重算；超30天历史保留原标签或明确不可重算，不拼接趋势；不同浏览器时区同站点日一致（E-55、E-58）。 | 1.5d |
+| M6-T6 | 接通受角色限制的真实统计HTTP入口 | M6 | M6-T1、M5-T4 | stats-query-rules、现行requireAdmin与scope、10 GET stats契约 | stats-core；GET /api/admin/stats与生产组合注册 | 1) 真实登录后GET /api/admin/stats→route→ops查询真实聚合，核HTTP状态、DTO与数据时间；同意→真实页面/产品访问→真实GLB start/terminal→已注册五分钟作业提交后，逐项核当日授权浏览器、PV、产品归因、3D次数，核心来源不能固定返回或未接入（E-61）。2) 未登录401；ADMIN全来源、SALES既有业务范围、EDITOR仅公开流量/产品/3D；直接请求敏感系统来源403，混合来源在查询前裁剪且无隐藏计数（E-66）。3) 切换有效时区后返回当前revision与重算状态，仅保留期完整覆盖可重算；超30天历史保留原标签或明确不可重算，不拼接趋势；不同浏览器时区同站点日一致（E-55、E-58）。读取口径：M5-T12 新表与旧 rollup 按阶段合并不双计；product pageViews 返回 no_data 不填 0；0% 按 start 分母；M6 分类按 site 行＋day-state＋live marker（live/consumed 缺键按 0 比较），旧 revision 用行内 timezone；覆盖起点前 no_data/partial。 | 1.5d |
 | M6-T7 | 完成看板逐源状态与故障呈现 | M6 | M6-T4、M6-T2、M6-T5、M6-T3 | stats-base-ui、business/reliability/ops来源及10状态DTO | stats-ui；SourceCard状态、独立时间、趋势覆盖与安全重试 | 1) 从/admin/stats的真实GET响应分别验成功0、no_data、not_connected、无旧值query_failed、有旧值stale、单来源失败和重算partial；每源保留原dataThrough/lastSucceededAt，失败刷新不更新旧数据时间，其他指标可继续读取（E-49、E-50、E-51、E-52、E-53、E-67）。2) 查询成功但没有事件接收链路证据时，仅显示实际配置/最近接收/查询结果与未知或最后已知时间；零流量不产生健康心跳或全链路正常徽标（E-54）。3) 三尺寸真实页面复验D1-D6和可辨时间/来源标签、键盘刷新，保存GIF；手动刷新仅GET stats，不调cron/备份/发信。 | 1.5d |
 | M7-T1 | 终验公开媒体与3D访客路径 | M7 | M1-T5、M2-T5、M2-T8 | docs/brand-media/static/selected-media-release.json与M1-T6/M1-T9实际发布清单、来源/帧报告、首页现有BRAND_MEDIA及产品GLB链；参考原件仅历史核对 | visitor-media-acceptance；真实访客浏览GIF与媒体来源终验报告 | 1) 先核docs/brand-media/static/selected-media-release.json的选定成品；en/ru首页点产品入口，加载真实GLB、拖动/复位并核productSlug和询盘入口；视频用选定v3及对应帧海报，工业场景用确认PNG/GIF，核src/网络文件SHA与选定发布清单一致，不加载旧参考附件/hero。回归暂停、隐藏/减少动态，1920/1440/390无媒体遮挡操作（E-21、E-24、E-104）。2) 复核M1对选定工业GIF的361帧品牌/透视、每帧时序/顺序、30.08秒/无限循环及同尺寸暂停帧；保留原附件SHA，只把旧原件作历史/时序证据，不强制新场景与参考画面相同；不用候选标（E-26、E-30）。3) 核实际授权渠道的输入/调用或软件操作/输出/SHA与成品证据；用Dot才核对应调用，未用不能否定已有授权成品。缺必需产物/核验逐项保持未完成，不补造渠道；PNG/GIF的已确认不代表公司工程/事实已完成（E-29、E-111）。 | 1.5d |
 | M7-T2 | 终验真实会话跨路径持久与撤销 | M7 | M3-T8、M3-T6、M3-T10、M3-T11、M3-T13 | 设备/API/UI及Auth.js锁定版本、17真实会话检查 | session-acceptance；初登/活动刷新/SSR/退出与浏览器恢复证据 | 1) 真实登录并核rememberDevice=false的2h活动滑动；实际活动POST /api/admin/account/session/activity写Set-Cookie续期而SSR只读不冒称已续；记住设备7d闲置与30d绝对边界的HTTP测试拒绝等号/过期，连续活动不越30d（E-01、E-02、E-69、E-71）。2) 有效记住cookie关闭重开同浏览器可恢复；分别实际改密码、重置验证器、退出所有设备、撤销设备、禁用/改sv后旧cookie下一真实受保护HTTP被拒，刷新不复活；普通Auth.js signOut同步撤销sid，数据库不可校验时拒绝；mode非法/未启用totp/非空recoveryCode均通用登录失败（E-03、E-04、E-70、E-96）。 | 1.5d |
-| M7-T3 | 终验同意到分析看板及统计日界线 | M7 | M5-T5、M5-T4、M6-T7、M2-T4、M5-T11、M5-T10、M2-T7 | analytics-ingest/aggregate/retention、真实产品event与最终stats-ui | analytics-acceptance；真实采集聚合、时区与保留授权链报告 | 1) 从真实同意控件→真实页面/产品/GLB start与唯一终态→计划聚合提交→/admin/stats读取同productSlug/viewId来源；拒绝或撤回不采集，成功率只用授权start，真实失败/超时不算success，无样本null且均值带samples（E-42、E-61、E-63）。2) 专用PG与HTTP链覆盖DST23/25小时、午夜、48h迟到、同revision快照以及旧租约晚提交被拒；时区改变不拼接超原始覆盖趋势；原始30d/聚合13月候选边界可测，生产无保留授权时请求真实清理被拒且删除0（E-48、E-56、E-81、E-88）。 | 2d |
+| M7-T3 | 终验同意到分析看板及统计日界线 | M7 | M5-T5、M5-T4、M6-T7、M2-T4、M5-T11、M5-T10、M2-T7 | analytics-ingest/aggregate/retention、真实产品event与最终stats-ui | analytics-acceptance；真实采集聚合、时区与保留授权链报告 | 1) 从真实同意控件→真实页面/产品/GLB start与唯一终态→计划聚合提交→/admin/stats读取同productSlug/viewId来源；拒绝或撤回不采集，成功率只用授权start，真实失败/超时不算success，无样本null且均值带samples（E-42、E-61、E-63）。2) 专用PG与HTTP链覆盖DST23/25小时、午夜、48h迟到、同revision快照以及旧租约晚提交被拒；时区改变不拼接超原始覆盖趋势；原始30d/聚合13月候选边界可测，生产无保留授权时请求真实清理被拒且删除0（E-48、E-56、E-81、E-88）。终验读取口径：按阶段合并新旧聚合不双计；product pageViews no_data、0% 按 start 分母、live/consumed 缺键按 0 比较；旧 revision 用行内 timezone。 | 2d |
 | M7-T4 | 终验询盘聊天闭环与容量降级 | M7 | M7-T1、M4-T6、M4-T7、M4-T14、M4-T12、M4-T13 | product-contact、访客/运营聊天和现有联系渠道、独立可用性开关 | visitor-acceptance；带产品上下文的询盘/聊天收发及容量边界报告 | 1) 从产品可见联系入口提交真实POST /api/inquiries及POST /api/chat/conversations，核productSlug/持久且不变消息ID；ADMIN/SALES从收件箱回复，访客seq同步收到；网络失败保留当前标签草稿，同UUID重试仅一消息；收件与通知失败独立，拒分析也可咨询（E-16、E-18、E-31、E-37、E-40）。2) 在隔离目标环境实测聊天开启前后内存/并发/延迟并记录限制；不足时实际关闭独立聊天可用性开关并保留可见原联系/询盘入口，前端显示不可用而非虚假在线；不使用旧约2.7GB快照当当前容量，不自动购买扩容（E-20）。 | 1.5d |
 | M7-T5 | 终验受限恢复与单管理员兜底 | M7 | M7-T6、M3-T9、M3-T11、M3-T18、M3-T20 | 已交付恢复向导/OS-owner CLI、一次性码和受限cookie协议 | admin-acceptance；恢复并发、不可越权及本地兜底证据 | 1) 从独立恢复入口POST /api/auth-admin/recovery/start→enroll→confirm；同码、不同码并发核销不复活已用码，restricted cookie不能访问后台；中断/过期保留旧有效因素，重入返回同URI/期限，新确认才替换因素且必须普通登录（E-10、E-11、E-14）。2) 无第二管理员且恢复码丢失时，隔离服务器OS-owner实际TTY CLI明确target/reason生成permit，隐藏密码预授权只在新TOTP最终确认提交且审计；旧首次绑定reset脚本guard不放宽，匿名浏览器不能签permit/改密码；最终confirm撤销旧会话/旧绑定/旧恢复材料、新恢复码仅展示一次，旧设备下一请求被拒（E-15）。 | 2d |
 | M7-T6 | 终验新鲜本人授权与忘密码隔离 | M7 | M3-T7、M3-T9、M3-T12、M3-T13 | reauth-dialog、单用途ActionGrant、安全变更与受限恢复入口 | fresh-auth-acceptance；新鲜授权/并发核销/无现密码负例报告 | 1) 从真实个人信息操作发POST /api/admin/account/reauth，当前密码+新TOTP才得5min grant；同TOTP步并发最多一成功，同grant并发最多一变更，跨purpose/target/device、过期或撤销后变更均拒且状态未变（E-72、E-73、E-74）。2) 用真实绑定/模式切换入口分别提交错码、过期码、重放与两次并发切换，最终事务重查pending/期限/sv且错误不提交、并发最多一成功，失败后仍有至少一种已验证方式（E-08）。3) 已启用无密码且忘现密码者可正常email+totp登录处理非敏感业务；仅会话或仅TOTP请求reauth及直接敏感变更均被拒且不签普通grant，界面引导独立受限恢复；受限路径只允许新绑定并有审计，HTTP不能写pendingPasswordHash（E-75）。 | 1.5d |
````

### _run/presentation.json

````diff
--- before/_run/presentation.json
+++ after/_run/presentation.json
@@ -459,6 +459,17 @@
         "deploy/cron.nbshiyan",
         "tests/analytics-retention.db.test.ts"
       ],
+      "M5-T12": [
+        "src/lib/analytics/daily-aggregate.ts",
+        "src/lib/server/analytics/aggregate.ts",
+        "src/lib/server/analytics/aggregate-repo.ts",
+        "src/lib/server/analytics/aggregate-day-state.ts",
+        "src/lib/server/analytics/ingest.ts",
+        "src/lib/server/analytics/retention-plan.ts",
+        "tests/analytics-daily.test.ts",
+        "tests/analytics-daily.db.test.ts",
+        "tests/analytics-day-state.db.test.ts"
+      ],
       "M6-T1": [
         "src/lib/server/ops/stats-query.ts",
         "src/lib/server/ops/source-dto.ts",
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2538,6 +2538,60 @@
         18
       ]
     },
+    "M5-T12": {
+      "provides": [
+        "analytics-anon-aggregate"
+      ],
+      "requires": [
+        {
+          "task": "M5-T3",
+          "capability": "analytics-aggregate"
+        },
+        {
+          "task": "M5-T11",
+          "capability": "analytics-retention"
+        }
+      ],
+      "stage": "primitive",
+      "wiring": [
+        "migrations"
+      ],
+      "supportPaths": [
+        ".github/workflows/ci.yml",
+        "docs/data-retention.md",
+        "src/lib/analytics/day-boundaries.ts",
+        "src/lib/server/analytics/retention.ts",
+        "tests/analytics-retention.db.test.ts",
+        "tests/analytics-aggregate.db.test.ts"
+      ],
+      "outputPaths": [
+        "prisma/schema.prisma",
+        "src/lib/analytics/daily-aggregate.ts",
+        "src/lib/server/analytics/aggregate.ts",
+        "src/lib/server/analytics/aggregate-repo.ts",
+        "src/lib/server/analytics/aggregate-day-state.ts",
+        "src/lib/server/analytics/ingest.ts",
+        "src/lib/server/analytics/retention-plan.ts",
+        "tests/analytics-daily.test.ts",
+        "tests/analytics-daily.db.test.ts",
+        "tests/analytics-day-state.db.test.ts"
+      ],
+      "sections": [
+        1,
+        2,
+        4,
+        5,
+        6,
+        8,
+        9,
+        10,
+        14,
+        16,
+        17,
+        18
+      ],
+      "integrationTask": "M6-T1"
+    },
     "M5-T5": {
       "provides": [
         "analytics-retention-plan"
@@ -2886,6 +2940,10 @@
         {
           "task": "M2-T7",
           "capability": "model-events"
+        },
+        {
+          "task": "M5-T12",
+          "capability": "analytics-anon-aggregate"
         }
       ],
       "stage": "primitive",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M6-T1：定义统计查询范围与核心来源DTO
沿用分支 task/M6-T1、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：dc37e6fe7455b9c839dca1964d2b4d602682dc07d24d1490bca738019391f347
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 专用PG测试按同一timezoneRevision与左闭右开日区间读取AnalyticsDaily
成功且确有0输出zero并有成功查询时间与授权覆盖，未覆盖区间输出no_data/null，来源未配置或任务未接通输出not_connected，不从产品UV相加算全站UV（E-49、E-50）。读取M5-T12新表（部署后）与既有AnalyticsDailyRollup（部署前），按阶段合并不双计
旧rollup不冒充新表覆盖
覆盖起点前no_data/partial，不填0。2) 对真实modelStarts/successes/failures/duration samples计算：无样本null、有样本零成功为0%、终态样本平均值正确且分母仅授权start
不同查看者时区读到相同站点日和值（E-55、E-63）。均值按ΣdurationMsSum/ΣloadDurationSamples加权，不对日均值再平均
只计有start的配对终态
samples=0→null/no_data
有start分母且success=0→0%
product pageViews返回no_data，不填0
M6分类按site行＋day-state＋live marker（live/consumed缺键按0比较），旧revision用行内timezone。
有效范围：
src/lib/server/ops/source-dto.ts
src/lib/server/ops/stats-query.ts
tests/stats-query.db.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M6-T1:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
