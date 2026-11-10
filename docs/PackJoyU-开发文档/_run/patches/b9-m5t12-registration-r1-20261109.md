# 文档补丁 b9-m5t12-registration-r1-20261109

任务：M5-T12
原分支：task/M5-T12
原 PR：none
依据：B9-M5T12-REGISTRATION-R1：只补 09 三行‘由 M5-T12 实施后生效；当前 schema 尚无此表’标注，不改设计/契约；保留 ff2 原补丁记录。

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
- M1-T9：上游契约变化或本次审查目标
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
- M3-T21：上游契约变化或本次审查目标
- M3-T22：上游契约变化或本次审查目标
- M3-T23：上游契约变化或本次审查目标
- M3-T24：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
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
- M5-T12：sections
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

### 02-设计/09-数据模型.md

````diff
--- before/02-设计/09-数据模型.md
+++ after/02-设计/09-数据模型.md
@@ -23,9 +23,9 @@
 | ChatReadCursor（M4） | `conversationId` FK，`userId` FK，`lastReadSeq Int`，`updatedAt` | 复合PK conversationId/userId；后台未读按当前运营人员游标计算。读标记只允许前进到已存在seq，MAX/CAS，不能回退或越过lastSeq。访客游标单独在Conversation。 |
 | ChatNotification（M4） | `id`，`conversationId`，`messageId`（对应访客消息），`status QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED`，`attempts Int`，`availableAt`，`leaseVersion Int`，`leaseOwner String?`，`stableMessageId String`，`lockedUntil DateTime?`，`requestStartedAt DateTime?`，`lastErrorCode String?`，`providerMessageId String?`，`sentAt DateTime?`，`createdAt`，`updatedAt` | messageId唯一；每条成功访客消息一条幂等通知，无定时催办产品；通知只含收件事实与受保护后台链接，不复制正文/email/token。租约认领与状态条件更新，SMTP在事务外。按至少一次策略最多3次退避1m/5m/30m；已开始SMTP后结果不明或租约过期记UNKNOWN并可用同一stableMessageId有界重领，故可能重复；CAS核leaseOwner/version防旧worker回写。SMTP适配器新增可选messageId保持旧调用兼容。未配置→DISABLED，绝不报SENT。 |
 | AnalyticsEvent（M5） | `eventId UUID`，`semanticKey String`，`payloadHash`，`browserHash`，`kind` 白名单枚举，`occurredAt UTC`，`receivedAt UTC`，`locale en/ru`，`path String?`，`productSlug String?`，`navigationId UUID?`，`viewId UUID?`，`durationMs Int?`（终态0..600000），`failureReason String?`（LOAD_ERROR/TIMEOUT/WEBGL_UNAVAILABLE） | eventId PK，semanticKey唯一；索引occurredAt、receivedAt、productSlug/occurredAt、viewId。只收服务器验过的同意cookie；browserHash由服务端域分离HMAC派生，不收IP/UA原文/email/正文/完整URL。原始按receivedAt保留30天。eventId和semanticKey均在原始窗口保留，旧于48h的事件拒绝，不能在30d清理后重放旧事件。 |
-| AnalyticsDaily（M5） | `localDate String YYYY-MM-DD`，`timezoneRevision Int`，`timezone String`，`dimension String`（site或product:已发布产品slug），`visitors Int`，`pageViews Int?`（product为NULL），`productViews Int`，`modelStarts Int`，`modelSuccesses Int`，`modelFailures Int`，`chatStarts Int`，`durationMsSum BigInt`，`loadDurationSamples Int`，`sourceThrough DateTime?`（零事实不造时间），`aggregatedAt DateTime`，`expiresAt DateTime` | 复合PK localDate/timezoneRevision/dimension；索引expiresAt与(dimension, localDate)；计数非负；整站访客与产品访客各自distinct，不可累加产品访客冒充全站UV；耗时只存精确总和与有效样本数，均值读侧加权计算，不存日均值；不得含browserHash、IP或可回连身份；无关联聚合保留13个自然月，按行内timezone的expiresAt（等号到期、月末/闰年夹取）删除。不新增按浏览器长期去重账本，直接从仍保留的原始事实重算。 |
-| AnalyticsAggregateDayState（M5） | `localDate String`，`timezoneRevision Int`，`timezone String`（该revision的IANA时区），`markerVersions Json`，`deferUntil DateTime?`，`gapKind String?`，`gapSince DateTime?`，`updatedAt` | 复合PK localDate/timezoneRevision；索引(timezoneRevision, localDate)；marker/defer/gap 的无身份辅助状态，不含事件/身份字段。`deferUntil` 存最早未到期值；gap只是证据。按自身timezone正推13自然月到期；同键还有未到期AnalyticsDaily时保留；13月到期优先于永久gap/远期defer/live-ahead；坏timezone只诊断并定向保守保留。被GC与所有state写者共用租约/代次守卫。 |
-| AnalyticsDayChange（M5） | `utcDate String YYYY-MM-DD`（主键，无id），`version BigInt @default(0)`，`updatedAt` | 每UTC日的live版本；ingest在同一事务bump，聚合消费后记录markerVersions。按UTC日反推13自然月＋2天GC，删除前排除仍存续state覆盖的UTC日与markerVersions键；先state后marker。不含事件/身份字段。 |
+| AnalyticsDaily（M5） | `localDate String YYYY-MM-DD`，`timezoneRevision Int`，`timezone String`，`dimension String`（site或product:已发布产品slug），`visitors Int`，`pageViews Int?`（product为NULL），`productViews Int`，`modelStarts Int`，`modelSuccesses Int`，`modelFailures Int`，`chatStarts Int`，`durationMsSum BigInt`，`loadDurationSamples Int`，`sourceThrough DateTime?`（零事实不造时间），`aggregatedAt DateTime`，`expiresAt DateTime` | **由 M5-T12 实施后生效；当前 schema 尚无此表。** 复合PK localDate/timezoneRevision/dimension；索引expiresAt与(dimension, localDate)；计数非负；整站访客与产品访客各自distinct，不可累加产品访客冒充全站UV；耗时只存精确总和与有效样本数，均值读侧加权计算，不存日均值；不得含browserHash、IP或可回连身份；无关联聚合保留13个自然月，按行内timezone的expiresAt（等号到期、月末/闰年夹取）删除。不新增按浏览器长期去重账本，直接从仍保留的原始事实重算。 |
+| AnalyticsAggregateDayState（M5） | `localDate String`，`timezoneRevision Int`，`timezone String`（该revision的IANA时区），`markerVersions Json`，`deferUntil DateTime?`，`gapKind String?`，`gapSince DateTime?`，`updatedAt` | **由 M5-T12 实施后生效；当前 schema 尚无此表。** 复合PK localDate/timezoneRevision；索引(timezoneRevision, localDate)；marker/defer/gap 的无身份辅助状态，不含事件/身份字段。`deferUntil` 存最早未到期值；gap只是证据。按自身timezone正推13自然月到期；同键还有未到期AnalyticsDaily时保留；13月到期优先于永久gap/远期defer/live-ahead；坏timezone只诊断并定向保守保留。被GC与所有state写者共用租约/代次守卫。 |
+| AnalyticsDayChange（M5） | `utcDate String YYYY-MM-DD`（主键，无id），`version BigInt @default(0)`，`updatedAt` | **由 M5-T12 实施后生效；当前 schema 尚无此表。** 每UTC日的live版本；ingest在同一事务bump，聚合消费后记录markerVersions。按UTC日反推13自然月＋2天GC，删除前排除仍存续state覆盖的UTC日与markerVersions键；先state后marker。不含事件/身份字段。 |
 | JobState（M5作业基础，先于消费者交付） | `key` 注册白名单，`leaseOwner String?`，`generation Int`，`lockedUntil DateTime?`，`lastStartedAt DateTime?`，`lastSucceededAt DateTime?`，`lastFinishedAt DateTime?`，`lastStatus` NEVER/RUNNING/SUCCEEDED/FAILED/PARTIAL，`lastErrorCode String?`，`summary Json?` | PK key，仅固定registry接受值；租约CAS，时钟取服务端；summary严格白名单计数/时间/版本，不接任意日志。提交同时核代次/租约和当前时区revision；旧任务不得覆盖新结果。没有任意代码/脚本/调度创建API。任务失败不覆盖最近成功数据时间。 |
 | ApiDailyCounter（M3共享HTTP生产者，M6只读） | `localDate`、`timezoneRevision`、`routeId`固定白名单、`requestCount Int`、`errorCount Int`、`lastObservedAt` | 复合PK日/revision/routeId；仅本轮已接线新API的最终状态记录，error为5xx，upsert原子递增；不含请求体/IP/用户/完整URL。计数写失败不改变核心业务响应，来源标部分覆盖/失败并保留安全告警；无真实总数不展示错误率。保留13个月，不冒充全站监控。 |
 | OpsSourceSnapshot（M6） | `source STORAGE/BACKUP` PK，`status OK/FAILED/NOT_CONNECTED`，`measuredAt`，`lastSucceededAt DateTime?`，`values Json?`（只允许bytesUsed/bytesFree或backupCompletedAt/backupAgeSeconds/verified），`safeErrorCode String?` | 仅由M6交付的固定受鉴权report脚本/ops-sample任务写，M3/M4/M5不调用该来源，JSON schema限定数字/布尔/时间；浏览器看板只读，无路径、文件名、主机地址、dump内容或密钥。报告按source+measuredAt单调CAS，同时间同载荷复用原结果、同时间异载荷409、旧时间忽略；failed保留最后成功values并明确旧值，未配置无虚假成功时间。 |
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T12：补齐13个自然月无身份日聚合的3D耗时、配对终态与日级独立访客
沿用分支 task/M5-T12、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：160976ad5a9f3d8dbe2b32f64628f99268968e1abf54fde98acb7a68a98e23f7
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真PG按(localDate,timezoneRevision,dimension)写13个自然月无身份聚合
durationMsSum为精确BigInt总和、loadDurationSamples只计配对终态有效样本
distinct可用SQL/DB COUNT(DISTINCT)，落库只留计数
不落browserHash/eventId/viewId/navigationId/IP/UA或任何可回连身份。2) 配对按(browserHash,viewId)
终态读取不受occurredAt窗口限制，但按occurredAt<=notAfter分区（计入/并入最早defer），跨午夜/DST终态归start所在站点日
不得出现终态日starts=0而successes>0
Q2/Q5用与Q1/Q3/Q4同一真实路径冒烟谓词（去query/fragment后，仅整条路径或任一路径段以nbs-smoke-开头才排除，段中出现不匹配，NULL放行），冒烟-only start→late_unattributable gap，真实start不被更早冒烟start遮蔽。3) 均值=ΣdurationMsSum/ΣloadDurationSamples，不对日均值再平均
samples=0→null/no_data
有start分母(modelStarts>0)且successes=0→0%
samples不是成功率分母
拒绝/撤回/未同意/无start不补分母、不进样本
product pageViews=NULL、M6返回no_data。4) 站点/产品日UV各自distinct
同一浏览器跨locale/跨产品在每个维度只计一次，同产品en+ru仍product UV=1
locale/产品/日UV不可相加，产品UV不得相加成站点UV。5) marker/live＋day-state：ingest在同一事务bump AnalyticsDayChange(utcDate,version)（该表无id、只以utcDate为键）
聚合日事务写day-state(markerVersions/deferUntil/gapKind/timezone)，deferUntil存最早未到期值（旧defer仅在>notAfter时保留，与Q1/Q3新延期事实取min
到期未重算仍partial）
所有写state的事务（commit/gap/coverage/bootstrap）与GC同受租约/代次守卫
M6同一读快照三查site行（取该revision行内timezone）、day-state、映射UTC日live marker
complete=site行＋无gap＋defer空＋映射UTC日的live与consumed按缺省0比较相等（缺键即0
零事件日不因此partial）
无site行no_data（+gap），缺state/gap/defer/live前进partial
旧revision按行内timezone映射
产品状态继承站点日，只有complete日缺产品行才可证0。6) 覆盖：coverageStart=max(recomputableFrom(now,tz),首个dayStart>eventCutoff+5min的本地日界)
覆盖检查作用于base/脏日/闭包
不可重算→独立CAS元数据事务消费marker置raw_partial、保留旧行、不读raw不改指标
bootstrap用ON CONFLICT DO NOTHING写state＋not_backfilled、不写指标
成功先提交后迟到gap CAS 0行不复活、commit未知不宣称必回滚或绝不消费
历史残片不改写旧完整行。7) 保留：AnalyticsDaily仅按行内timezone的expiresAt＝13个自然月到期（等号到期、月末/闰年夹取），扫描域缓冲13个自然月＋2天单列
state按自身timezone的13个自然月到期（无未到期AnalyticsDaily才删
13月到期优先于永久gap/远期defer/live-ahead
合法终止gap不是损坏
坏timezone只诊断并定向保守保留、不宣称其有界删除）
marker按UTC日反推shiftLocalDays(shiftCalendarMonths(utcToday,-13),-2)、删utcDate<cutoffUtc，并保留仍存续state覆盖的UTC日∪markerVersions键
先state后marker
03:30旧链保持三表，04:30 analytics-retention在实施后才是新三表唯一清理者（共用租约、每批事务＋续租＋revision守卫），不新增cron行
500是聚合站点日/目标日上限（不是行数），DELETE单批5,000行，四类数据表每轮删除总上限20,000行，AnalyticsDaily≤1,000行
两元数据表各500行/轮（=单批上限、整轮实际删除总额）、合计1,000/轮、独立于四表
读页与删除额度分开，覆盖读取＋安全集合删除在同一批事务内完成，分页仅在本轮剩余额度内继续、用尽即结束该表本轮，下一轮从空游标重扫
candidateCount与deletedCount分列、实际删除数单列，不承诺每轮必删19,000行
只有已确认提交批次计数，提交未知不计数并停止metadata阶段
不延长原始30天、不重建历史、不填0。8) 纯函数测试＋真PG测试全绿
不改统计HTTP路由/contracts/ops/生产开关/cron时刻
product pageViews跨导航扩展不在本任务（E-48、E-55、E-56、E-57、E-63、E-80、E-81、E-82、E-83）。
有效范围：
.github/workflows/ci.yml
deploy/deploy.sh
docs/data-retention.md
prisma/schema.prisma
src/lib/analytics/daily-aggregate.ts
src/lib/analytics/day-boundaries.ts
src/lib/server/analytics/aggregate-day-state.ts
src/lib/server/analytics/aggregate-repo.ts
src/lib/server/analytics/aggregate.ts
src/lib/server/analytics/ingest.ts
src/lib/server/analytics/retention-plan.ts
src/lib/server/analytics/retention.ts
tests/analytics-aggregate.db.test.ts
tests/analytics-daily.db.test.ts
tests/analytics-daily.test.ts
tests/analytics-day-state.db.test.ts
tests/analytics-retention.db.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T12:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
