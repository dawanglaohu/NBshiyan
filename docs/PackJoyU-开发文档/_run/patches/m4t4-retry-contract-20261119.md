# 文档补丁 m4t4-retry-contract-20261119

任务：M4-T4
原分支：task/M4-T4
原 PR：None
依据：落实聊天通知租约、退避、重试上限与配置缺失状态；补充 DB1-G5 状态图标签。

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
- M4-T4：edges、sections、task
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
- R9-T71605271：sections
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
@@ -21,7 +21,7 @@
 | ChatConversation（M4） | `id` 随机ID，`visitorSessionId` FK，`clientConversationId UUID`，`createPayloadHash`，`locale en/ru`，`productSlug String?`，`sourcePath String?`，`email String?`，`status OPEN/CLOSED`，`version Int`，`lastSeq Int @default(0)`，`visitorReadSeq Int @default(0)`，`createdAt`，`updatedAt`，`lastActivityAt`，`retainUntil`，`anonymizedAt DateTime?` | 唯一visitorSessionId/clientConversationId；索引status/updatedAt/id、retainUntil/anonymizedAt。sourcePath只站内路径无query；email主动填写且只用于本次咨询，规范化不扩展身份画像；每条访客消息、seq及对应通知同事务。ADMIN/SALES是共享人工收件箱，EDITOR不得访问；不改变原询盘SALES分配规则，不加坐席分配/绩效。 |
 | ChatMessage（M4） | `id`，`conversationId` FK，`seq Int`，`sender VISITOR/OPERATOR`，`authorId String?`，`clientMessageId UUID`，`payloadHash`，`bodyText`，`createdAt`，`redactedAt DateTime?` | 唯一conversationId/seq、conversationId/sender/clientMessageId；作者由cookie/session确定，禁客户端自报；正文纯文本1～4000 code points，拒控制字符，仅转义展示，不接受HTML或附件。每会话锁行递增seq后插入；同key同hash返回原消息，不同hash409。保留期匿名化正文，不凭通知成功删除消息。 |
 | ChatReadCursor（M4） | `conversationId` FK，`userId` FK，`lastReadSeq Int`，`updatedAt` | 复合PK conversationId/userId；后台未读按当前运营人员游标计算。读标记只允许前进到已存在seq，MAX/CAS，不能回退或越过lastSeq。访客游标单独在Conversation。 |
-| ChatNotification（M4） | `id`，`conversationId`，`messageId`（对应访客消息），`status QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED`，`attempts Int`，`availableAt`，`leaseVersion Int`，`leaseOwner String?`，`stableMessageId String`，`lockedUntil DateTime?`，`requestStartedAt DateTime?`，`lastErrorCode String?`，`providerMessageId String?`，`sentAt DateTime?`，`createdAt`，`updatedAt` | messageId唯一；每条成功访客消息一条幂等通知，无定时催办产品；通知只含收件事实与受保护后台链接，不复制正文/email/token。租约认领与状态条件更新，SMTP在事务外。按至少一次策略最多3次退避1m/5m/30m；已开始SMTP后结果不明或租约过期记UNKNOWN并可用同一stableMessageId有界重领，故可能重复；CAS核leaseOwner/version防旧worker回写。SMTP适配器新增可选messageId保持旧调用兼容。未配置→DISABLED，绝不报SENT。 |
+| ChatNotification（M4） | `id`，`conversationId`，`messageId`（对应访客消息），`status QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED`，`attempts Int`，`availableAt`，`leaseVersion Int`，`leaseOwner String?`，`stableMessageId String`，`lockedUntil DateTime?`，`requestStartedAt DateTime?`，`lastErrorCode String?`，`providerMessageId String?`，`sentAt DateTime?`，`createdAt`，`updatedAt` | messageId唯一；每条成功访客消息一条幂等通知，无定时催办产品；通知只含收件事实与受保护后台链接，不复制正文/email/token。租约认领与状态条件更新，SMTP在事务外。按至少一次策略首次发送后最多重试3次，每条出箱最多4次已标记开始的发送尝试，attempts只计已标记开始的尝试。领取新租约时清空requestStartedAt，领取本身不计次；发送前须以有效租约为条件在同一次原子更新中写入requestStartedAt并递增attempts，该更新为0行则不发送。该标记只表示发送可能已开始，不证明SMTP已接收；UNKNOWN、SENT、FAILED及回队的QUEUED保留最后一次标记供审计，直到下一次领取。已调用SMTP后结果不明→UNKNOWN；worker确知未调用SMTP，以及暂拒、不可达等已知失败，未达上限→QUEUED；达到上限即第4次确知失败时，在同一次结果写回CAS中直接写FAILED、不经QUEUED，lastErrorCode只记脱敏错误码；永久失败→FAILED。失败或未知结果写入时，以该次写入的时钟t设availableAt=t+1m/5m/30m，分别对应attempts=1/2/3，表示结果写入后至少等待该档，不是两次发送的精确间隔；attempts=4不设下一档。清扫过期SENDING时，本次requestStartedAt非空→UNKNOWN并按同一公式设availableAt；为空→QUEUED、attempts不变、availableAt=t，可立即领取。认领QUEUED与把UNKNOWN提升为QUEUED都须attempts<4且availableAt<=当前时钟；提升不改availableAt，并以同一stableMessageId重发，故可能重复。attempts=4的UNKNOWN保持UNKNOWN并停止自动重试；不变量：不存在attempts>=4的QUEUED；上限确知失败直写FAILED，空标记回队与UNKNOWN提升只作用于attempts<4的行，认领守卫attempts<4保留作防线；万一出现该行，不认领、不发送、不自动迁移，验收按不变量违例检出。结果写回与清扫使用同一个应用注入的服务端时钟，与jobs租约仓储一致，并在取得行锁后读取当前值判定；写回CAS须核status=SENDING、leaseOwner/leaseVersion及lockedUntil>该当前值；过期＝lockedUntil<=当前时钟，等于即视为已释放，与M5-T1一致，清扫只处理该条件成立的SENDING；当前时钟在取得行锁后采样，不得用等锁前的时间或事务开始时间now()。旧worker租约过期即不能写，也不能覆盖新租约。SMTP适配器新增可选messageId保持旧调用兼容。SMTP未配置时只把attempts=0且requestStartedAt为空的QUEUED置DISABLED，绝不报SENT；DISABLED为终态，恢复配置后新出箱可处理，已DISABLED行不自动补发。配置缺失期间仍先清扫过期SENDING，再暂停认领与UNKNOWN提升；已有UNKNOWN与attempts>0的QUEUED保持原状态和availableAt，配置恢复后按到期与上限处理。 |
 | AnalyticsEvent（M5） | `eventId UUID`，`semanticKey String`，`payloadHash`，`browserHash`，`kind` 白名单枚举，`occurredAt UTC`，`receivedAt UTC`，`locale en/ru`，`path String?`，`productSlug String?`，`navigationId UUID?`，`viewId UUID?`，`durationMs Int?`（终态0..600000），`failureReason String?`（LOAD_ERROR/TIMEOUT/WEBGL_UNAVAILABLE） | eventId PK，semanticKey唯一；索引occurredAt、receivedAt、productSlug/occurredAt、viewId。只收服务器验过的同意cookie；browserHash由服务端域分离HMAC派生，不收IP/UA原文/email/正文/完整URL。原始按receivedAt保留30天。eventId和semanticKey均在原始窗口保留，旧于48h的事件拒绝，不能在30d清理后重放旧事件。 |
 | AnalyticsDaily（M5） | `localDate String YYYY-MM-DD`，`timezoneRevision Int`，`timezone String`，`dimension String`（site或product:已发布产品slug），`visitors Int`，`pageViews Int?`（product为NULL），`productViews Int`，`modelStarts Int`，`modelSuccesses Int`，`modelFailures Int`，`chatStarts Int`，`durationMsSum BigInt`，`loadDurationSamples Int`，`sourceThrough DateTime?`（零事实不造时间），`aggregatedAt DateTime`，`expiresAt DateTime` | **由 M5-T12 实施后生效；当前 schema 尚无此表。** 复合PK localDate/timezoneRevision/dimension；索引expiresAt与(dimension, localDate)；计数非负；整站访客与产品访客各自distinct，不可累加产品访客冒充全站UV；耗时只存精确总和与有效样本数，均值读侧加权计算，不存日均值；不得含browserHash、IP或可回连身份；无关联聚合保留13个自然月，按行内timezone的expiresAt（等号到期、月末/闰年夹取）删除。不新增按浏览器长期去重账本，直接从仍保留的原始事实重算。 |
 | AnalyticsAggregateDayState（M5） | `localDate String`，`timezoneRevision Int`，`timezone String`（该revision的IANA时区），`markerVersions Json`，`deferUntil DateTime?`，`gapKind String?`，`gapSince DateTime?`，`updatedAt` | **由 M5-T12 实施后生效；当前 schema 尚无此表。** 复合PK localDate/timezoneRevision；索引(timezoneRevision, localDate)；marker/defer/gap 的无身份辅助状态，不含事件/身份字段。`deferUntil` 存最早未到期值；gap只是证据。按自身timezone正推13自然月到期；同键还有未到期AnalyticsDaily时保留；13月到期优先于永久gap/远期defer/live-ahead；坏timezone只诊断并定向保守保留。被GC与所有state写者共用租约/代次守卫。 |
@@ -171,13 +171,14 @@
 ```mermaid
 stateDiagram-v2
   [*] --> NotificationQueued: E-90 消息原子入库
-  NotificationQueued --> NotificationSending: E-91 领取新租约代次
+  NotificationQueued --> NotificationSending: E-91 已配置且 attempts < 4、availableAt 到期，领取新租约代次
   NotificationSending --> NotificationSent: E-92 SMTP接受并CAS提交
-  NotificationSending --> NotificationUnknown: E-92 已发送结果未知
-  NotificationSending --> NotificationQueued: E-93 可重试且未超上限
-  NotificationUnknown --> NotificationQueued: E-92 稳定Message-ID有界重试
-  NotificationSending --> NotificationFailed: E-93 永久失败或上限
-  NotificationQueued --> NotificationDisabled: E-93 未配置发送能力
+  NotificationSending --> NotificationUnknown: E-92 已调用SMTP结果不明或过期且已标记
+  NotificationSending --> NotificationQueued: E-93 已知失败且未达上限，或租约过期且未标记
+  NotificationUnknown --> NotificationQueued: E-92 attempts<4且availableAt到期并已配置，稳定Message-ID重试
+  NotificationUnknown --> [*]: E-92 attempts=4，保留 UNKNOWN 并停止自动重试
+  NotificationSending --> NotificationFailed: E-93 永久失败或第4次确知失败同一CAS直写
+  NotificationQueued --> NotificationDisabled: E-93 未配置且从未开始尝试
   NotificationSent --> [*]
   NotificationFailed --> [*]
   NotificationDisabled --> [*]
````

### 03-质量/13-边界问题与异常处理.md

````diff
--- before/03-质量/13-边界问题与异常处理.md
+++ after/03-质量/13-边界问题与异常处理.md
@@ -94,9 +94,9 @@
 | E-88 | 聊天凭据及数据保留期限 | 本轮文档被生成或实施者拿到派发任务 | 新增纯授权门禁的可测表述：生产真实清理默认关闭且 dry-run 为默认模式；不存在另行明确的保留策略授权时，启用或请求真实删除必须拒绝且删除计数为0，可返回候选计数/未启用状态。文档、任务派发、模型或代理结论均不能充当授权。只用隔离数据验证，不触碰生产/恢复/备份现有数据。 | M4 |
 | E-89 | 聊天凭据及数据保留期限 | 聊天 cookie 失效但消息尚未到 90 天 | 访客历史访问立即受阻，运营仍依现有 ADMIN/SALES 权限处理保留中的咨询；不连带改变既有询盘 730 天、分析 30 天/13 个月或备份策略。 | M4 |
 | E-90 | 聊天通知持久队列 | 保存消息后进程立即中断，或客户端因超时重发同一消息 | 在同一数据库事务内保存消息及 messageId 唯一的出箱记录；已提交消息可在重启后继续通知，消息幂等命中不能新增第二条通知。 | M4 |
-| E-91 | 聊天通知持久队列 | 多个 cron worker 并发领取，或领取者崩溃直到租约到期 | 原子领取并携带租约/代次提交状态；过期工作可重新领取，旧 worker 不能覆盖新租约的处理结果，通知失败不得撤回已经成功保存的聊天消息。 | M4 |
-| E-92 | 聊天通知持久队列 | SMTP 已接收但发送进程在写回成功状态前中断 | 用隔离 SMTP 受控接收后中断 worker，再重启验证可按至少一次重试并复用 stable Message-ID；允许 SMTP 实际重复，但本地状态不标精确一次或客服已读，聊天 received 不变；按09节 unknown-delivery/租约规则呈现真实状态。 | M4 |
-| E-93 | 聊天通知持久队列 | SMTP 不可达、配置缺失或暂时拒绝 | 把有界重试引用到09/10节持久任务/次数上限和退避规则，注入 SMTP不可达/缺配置/暂拒后重启验证从持久出箱恢复；日志和计数只含脱敏错误码及数量，不含主动邮箱/body；不得用 Next after() 的完成代替持久记录。 | M4 |
+| E-91 | 聊天通知持久队列 | 多个 cron worker 并发领取，或领取者崩溃直到租约到期 | 原子领取并携带租约/代次提交状态；过期后按本次requestStartedAt分类，可重试工作须attempts<4且availableAt到期方可重领。清扫与旧worker写回在取得行锁后按同一注入时钟判定，租约过期即不能回写，也不能覆盖新租约的处理结果；通知失败不得撤回已经成功保存的聊天消息。 | M4 |
+| E-92 | 聊天通知持久队列 | SMTP 已接收但发送进程在写回成功状态前中断 | 对尚未到上限的通知，用隔离 SMTP 受控接收后中断 worker，再重启验证可按至少一次重试并复用 stable Message-ID，且重试不早于未知结果写入后的对应退避档；达到上限仍未知时保留UNKNOWN并停止自动重试。允许 SMTP 实际重复，但本地状态不标精确一次或客服已读，聊天 received 不变；按09节 unknown-delivery/租约规则呈现真实状态。 | M4 |
+| E-93 | 聊天通知持久队列 | SMTP 不可达、配置缺失或暂时拒绝 | 把有界重试引用到09/10节持久任务/次数上限和退避规则，注入SMTP不可达/暂拒后重启验证可重试工作从持久出箱恢复；缺配置时仅从未开始尝试的QUEUED置DISABLED，已有UNKNOWN与已尝试的QUEUED暂停并保持原状态，配置恢复后按到期与上限处理；DISABLED为终态，恢复后新出箱可处理、旧DISABLED行不自动补发；日志和计数只含脱敏错误码及数量，不含主动邮箱/body；不得用 Next after() 的完成代替持久记录。 | M4 |
 | E-94 | 聊天通知持久队列 | 出箱/通知接口被无聊天权限角色调用，或 SMTP 适配器仅能发送既有询盘格式 | 分别验无权限调用拒绝、chat-notifications 使用独立受限适配器且不扩展旧 mail UI；deploy/cron.nbshiyan 确有每分钟注册，重启后实际消费已提交出箱，不能只有手工调用或未来空注册。M4随交付注册，M7仅最终验收。 | M4 |
 | E-95 | 登录记住设备字段 | Auth.js表单rememberDevice为字面false、缺值或布尔false | 明确解析为false并使用普通2小时策略；不能用Boolean或无约束coerce变成记住设备；其他非法值拒绝 | M3 |
 | E-96 | 登录方式枚举与账号隐私 | mode未知、totp模式未获账号本人启用或普通Credentials携非空recoveryCode | 列明每种非法 mode、未由本人开启的totp、普通Credentials带非空recoveryCode都沿同一通用Auth.js失败结果，不签后台会话且响应不区分账号存在；合法password/totp只校验相应方式，并按既定限流/错误协议测试，保留有效用户登录。 | M3 |
````

### 03-质量/15-性能与容量假设.md

````diff
--- before/03-质量/15-性能与容量假设.md
+++ after/03-质量/15-性能与容量假设.md
@@ -28,7 +28,7 @@
 | 数据库连接 | 每实例`connection_limit=5`、`pool_timeout=10s`；总连接不越数据库实际可用额度 | 实例数和其他消费者额度上线前实测；连接不足先限制并发或关闭可选入口，不自动扩容 |
 | 聚合 | 每5分钟触发；快照/替换事务单批不超过30秒，总轮次不超过55秒 | 事务中断保留上次完整值；数据源超15分钟按stale说明，不能承诺故障期仍按5分钟更新 |
 | 固定作业 | 每批最多500项、总55秒、租约90秒，按需受控续租 | 未完成工作留到下轮；旧代次不得覆盖新结果，超时不由HTTP客户端重复触发 |
-| 聊天通知与既有邮件队列 | 每分钟真实cron；SMTP单次20秒截止；聊天通知最多3次，退避1/5/30分钟 | 持久状态恢复；未知投递允许至少一次策略的重复，不承诺精确一次；消息收件独立于邮件结果 |
+| 聊天通知与既有邮件队列 | 每分钟真实cron；SMTP单次20秒截止；聊天通知首次发送后最多重试3次（最多4次已标记开始的发送尝试），失败或未知结果写入后依次至少等待1/5/30分钟 | 持久状态恢复；未知投递允许至少一次策略的重复，不承诺精确一次；消息收件独立于邮件结果 |
 | 后台列表与统计查询 | 设备最多50项；聊天列表默认25、最多100；统计最多连续400日且受13个月范围限制 | 参数越界400；游标受验证；大范围查询不返回无界明细，不在看板GET运行作业 |
 | 滥用隔离 | 各接口沿10节身份/IP-HMAC限流与8/16/32KiB体积上限 | 429给Retry-After、413拒绝超体，不把拒绝写入算成功消息或分析事件 |
 
````

### 04-执行/18-部署与运维.md

````diff
--- before/04-执行/18-部署与运维.md
+++ after/04-执行/18-部署与运维.md
@@ -91,7 +91,7 @@
 | 设备会话策略 | M3；普通2h滑动、记住设备7d闲置/30d绝对，活动15min节流 | 集中默认；非法期限拒绝启动；设备行不存在/过期/撤销时拒绝，不从旧JWT回填设备 |
 | ActionGrant与受限恢复策略 | M3；grant5min一次用途、permit15min、restricted10min；既有首次绑定窗口保留 | 默认按09节；任何因素缺失/过期失败关闭；HTTP不能改OS-owner预授权密码摘要 |
 | 聊天凭据与内容保留 | M4；必要cookie7d闲置/30d绝对；咨询消息/主动邮箱最后成功收发后90d | 两项独立配置；不以轮询续内容期限；没有cookie不能凭邮箱恢复会话 |
-| 聊天可用性/通知策略 | M4；站内收件与通知分别判断；通知持久出箱最多3次、退避1m/5m/30m、SMTP截止20s | 配置/依赖缺失呈真实不可用或DISABLED，不能显示SENT；不影响已成功保存的received |
+| 聊天可用性/通知策略 | M4；站内收件与通知分别判断；通知持久出箱首次发送后最多重试3次（最多4次已标记开始的发送尝试）、失败或未知结果写入后依次退避1m/5m/30m、SMTP截止20s | 配置/依赖缺失呈真实不可用或DISABLED，不能显示SENT；SMTP缺配置时仅从未开始尝试的出箱置DISABLED且为终态，已尝试或UNKNOWN的行暂停并在配置恢复后按09节规则处理，旧DISABLED行不自动补发；不影响已成功保存的received |
 | 分析同意与凭据 | M5；签名cookie版本、同意有效期不超既有一年；既有秘密按用途域分离 | 未明确同意不建ID/事件；签名无效/版本/期限非法拒绝采集；没有新增线上AI密钥 |
 | 分析事件/保留 | M5；occurredAt接收窗口48h迟到/+5min；原始与去重30d、无关联聚合13自然月；AnalyticsDaily按行内timezone的expiresAt到期，两元数据表按各自公式GC（state自身时区13月、marker UTC日13月＋2天）；实施后04:30为三张新表唯一清理者 | 非法字段拒绝；过覆盖范围明确partial/unavailable，不用残片重算完整历史；实施前仍三表运行，不写已建表 |
 | 新增保留任务授权策略 | M4/M5分别持有当前策略version与受保护授权依据；生产实际清理默认disabled、dry-run=true | 文档/任务/代理结论不构成授权；缺另行明确保留授权时拒绝真实删除，返回未启用/候选数/实际数0。只在一次性测试库验候选选择与并发，不碰生产/恢复/备份 |
````

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -53,7 +53,7 @@
 | M4-T1 | 原子保存咨询首消息及唯一通知出箱 | M4 | M4-T8、M5-T1、M5-T8 | M4-T8真实必要cookie、M5作业基础、09/10消息/会话/出箱约束。 | ChatConversation/Message/ReadCursor/Notification schema；POST /api/chat/conversations及持久首消息服务。 | 1) 调用方/接线点：真实POST conversations→cookie范围服务→会话+首消息+seq+messageId唯一出箱同事务，成功才返持久不变id/seq/receivedAt；数据库失败无部分记录，同UUID同payload返回原结果、异payload409、并发仅一消息一通知（E-18、E-31、E-90）。2) 16KiB限体后strict schema，正文1..4000code points纯文本，email省略/空值可发送，trim后超254、CRLF/显示名/非法格式字段错误；身份取cookie，不能关联他人session，拒分析仍接收且不建分析身份（E-39、E-40）。 | 1.5d |
 | M4-T2 | 读取访客消息页并单调推进读位置 | M4 | M4-T1、M4-T8 | M4-T1持久seq消息与M4-T8必要cookie；09/10分页和read MAX。 | GET /api/chat/conversations/[id]与POST /api/chat/conversations/[id]/read，访客范围/稳定分页。 | 1) 调用方/接线点：真实GET/read handlers→cookie范围repo；仅本人，afterSeq升序max100，页间插入后补齐ID恰一次，read MAX不越lastSeq、不回退，轮询仅receipt不标用户read；猜ID/seq/email无权（E-19、E-34、E-77、E-79）。2) 先以已完成POST conversations真实存首消息，再记录retainUntil/lastActivityAt；反复GET/POST read前后90d截止不变；复用M4-T8期限前置，过期cookie请求401且保留中的消息记录与正文不变（E-85）。 | 1d |
 | M4-T3 | 查询当前授权运营的收件箱及读状态 | M4 | M4-T2、M3-T1 | 真实聊天事实与M3当前角色；09/10共享聊天范围及运营read cursor。 | GET /api/admin/chat/conversations、GET /api/admin/chat/conversations/[id]、POST /api/admin/chat/conversations/[id]/read。 | 1) 调用方/接线点：真实后台read handlers→requireAdmin(ADMIN/SALES)→inbox服务；未登录/EDITOR/撤权账号/访客直接读取不返回正文；当前角色每次重验、不会凭隐藏按钮放行（E-19、E-32、E-78）。2) 列表快照按updatedAt/id游标、正文seq分页max100，插页消息完整恰一次；本人read MAX不影响另一运营游标，未展示的新seq仍未读；真实queued/sending/sent/failed/unknown/disabled通知独立返回，不改received（E-34、E-35、E-79）。3) GET/read/通知不延长90d，cookie失效仅访客401，ADMIN/SALES仍读期内咨询；通知失败不改变收件箱可处理状态（E-41、E-86、E-89）。 | 1d |
-| M4-T4 | 消费持久聊天通知并注册每分钟作业 | M4 | M4-T1、M5-T1、M5-T8 | 原子聊天出箱、M5固定作业基础与现有SMTP安全适配。 | chat-notifications固定job、独立SMTP内容适配/稳定Message-ID、真实每分钟cron；不包含旧mail-queue包装。 | 1) 调用方/接线点：每分钟真实cron POST /api/admin/cron/operations(jobKey=chat-notifications)→registry→持久通知服务；保存后重启仍消费、无Bearer触发拒绝；messageId唯一出箱不因重试增项，通知只收件事实/受保护链接（E-90、E-94）。2) leaseOwner/version原子认领/CAS提交；旧worker不能覆盖新租约；SMTP事务外20s，隔离SMTP接收后中断→UNKNOWN→同stable Message-ID至少一次有界重试，最多3次并1m/5m/30m退避；明确允许SMTP重复（E-91、E-92）。3) SMTP缺配置DISABLED，不可达/暂拒/达到上限真实状态脱敏持久保存，重启按出箱恢复；body/email/token不进通知/日志，失败不撤聊天received，HTTP触发未知不自动再触发（E-35、E-41、E-93）。 | 2d |
+| M4-T4 | 消费持久聊天通知并注册每分钟作业 | M4 | M4-T1、M5-T1、M5-T8 | 原子聊天出箱、M5固定作业基础与现有SMTP安全适配。 | chat-notifications固定job、独立SMTP内容适配/稳定Message-ID、真实每分钟cron；不包含旧mail-queue包装。 | 1) 调用方/接线点：每分钟真实cron POST /api/admin/cron/operations(jobKey=chat-notifications)→registry→持久通知服务；保存后重启仍消费、无Bearer触发拒绝；messageId唯一出箱不因重试增项，通知只收件事实/受保护链接（E-90、E-94）。2) leaseOwner/leaseVersion原子认领并清空requestStartedAt，领取不计次；发送前以同一有效租约CAS写requestStartedAt并递增attempts，该CAS为0行不发送；SMTP事务外20s。清扫与结果写回用同一注入时钟并在取锁后判定：过期且本次标记为空→QUEUED、次数不增且立即可领，非空→UNKNOWN；写回须核status=SENDING、leaseOwner/leaseVersion及lockedUntil>当前时钟；过期＝lockedUntil<=当前时钟，等于即视为已释放，清扫只处理过期行，时钟在取锁后采样；写入方等锁期间跨过期点的写回为0行，旧worker亦不能覆盖新租约；worker确知未调用SMTP按已知失败处理、不记UNKNOWN。未达上限时，隔离SMTP接收后中断→UNKNOWN→重启后复用同stable Message-ID有界重试；首次发送后最多重试3次，最多4次已标记开始的发送尝试，明确允许SMTP重复（E-91、E-92）。3) 失败或未知结果写入时availableAt=该次写入时钟+1m/5m/30m（attempts=1/2/3），隔离测试含延迟清扫，下一档从清扫写入起算；认领与UNKNOWN提升均须attempts<4且availableAt到期；连续4次暂拒时第4次确知失败在同一结果CAS直写FAILED、不经QUEUED且lastErrorCode为脱敏码，另测第4次SMTP接收后写回前中断→UNKNOWN且停止自动重试，两案均无第5次自动尝试，全程最多4次已开始尝试；任何时刻不存在attempts>=4的QUEUED，人为植入该行时不认领、不发送、不自动迁移，按不变量违例检出。SMTP缺配置时仅attempts=0且未标记的QUEUED置DISABLED，不为同一messageId补建通知；已有UNKNOWN与attempts>0的QUEUED在缺配置期间不发送、不提升，状态与availableAt不变，恢复后按到期与上限继续；DISABLED在恢复后保持原状态。不可达/暂拒等真实状态脱敏持久保存，重启按出箱恢复；body/email/token不进通知/日志，失败不撤聊天received，HTTP触发未知不自动再触发（E-35、E-41、E-93）。 | 2d |
 | M4-T5 | 接通访客聊天打开与消息编辑器 | M4 | M4-T10、M4-T15、M1-T8、M5-T6、M5-T7 | M4必要session/首消息/追加/读取API，M1 UI/client基础、既有InquiryWizard。 | ContactChatEntry/ChatContainer/Composer/MessageList，主动打开、首次/后续提交和明确Refresh messages读取；自动同步另由M4-T9交付。 成功收件后的同意门控chat_start生产者，复用M5客户端队列与当前navigationId。 | 1) 入口：主页Request a quote→/[locale]/contact→Contact a person（contact-human-chat）；点开才POST /api/chat/session；Send message（chat-send）调用POST /api/chat/conversations或对应messages，数据源还含GET /api/chat/conversations/[id]；实际点击断言id/seq/receivedAt，成功前不显示received（E-31）。2) 服务可达但无人值守显示Offline message，无在线灯，保存成功文案Received, awaiting human handling且无即时答复承诺；email空/省略可发、非法/超长错误保留消息，关闭未发送草稿不持久化（E-17、E-36、E-38、E-39）。3) 首次cookie401/404或关闭线程时停止旧提交并显示Start a new conversation按钮，不自动把旧草稿发新会话；拒分析照常咨询且网络无第三方脚本（E-40、E-85）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 4) 当前导航首次新咨询收件成功且当时有效同意后，POST /api/analytics/events发kind=chat_start、原navigationId、随机eventId/occurredAt及可选已发布productSlug/净化path；同次成功回调/响应重试复用eventId且只计一次。回复、失败、仅开窗口、拒绝/撤回及后补同意不补发历史；事件不含email/body/会话或消息ID/cookie凭据。真实聊天→事件→聚合chatStarts有端到端断言，必要聊天不依赖分析同意（E-40、E-47）。 | 1.5d |
 | M4-T6 | 接通运营收件箱和只读会话页 | M4 | M4-T3、M3-T7、M4-T9 | M4运营读取API、M3后台壳、已完成seq轮询组件。 | /admin/chat、/admin/chat/[id]读容器、实际未读导航/分页/状态；人工发送控制由M4-T14添加。 | 1) 入口：后台Human conversations（admin-chat-link）→/admin/chat→真实行chat-thread-link-{id}→/admin/chat/[id]；数据源GET /api/admin/chat/conversations及id GET/POST read；点击真实持久会话可读body/author，已显示消息才read；新到未展示seq仍未读，筛选分页快照不当增量日志（E-31、E-34、E-79）。2) 复用3s/hidden/退避/单在途组件，切线程取消旧请求且乱序不覆盖；ADMIN/SALES读，EDITOR入口不可见且直达API403，已登录人员角色改EDITOR后下一poll/send测试请求均无body无写，UI清线程/停止计时器；访客threadId/seq/email变更仍无权（E-32、E-76、E-77、E-78）。3) 查询失败不是空items成功态，通知failed/unknown/disabled显示原真实状态且message received不变；不显示客服在线/已读承诺（E-35、E-41）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 1d |
 | M4-T7 | 注册聊天保留候选与默认拒绝真实清理 | M4 | M4-T3、M5-T1、M5-T8 | 聊天活动/retainUntil、M5固定job和生产清理另行授权边界。 | chat-retention每日cron、只读候选计数、策略version、默认dry-run与授权门禁。 | 1) 调用方/接线点：每日真实cron POST /api/admin/cron/operations(jobKey=chat-retention)→registry→候选查询；无另行保留授权或开关未启用时仅dry-run，真实删除请求拒绝且deletedCount=0，文档/模型/派发不能作授权；隔离库前后行内容hash不变（E-88）。2) 查询候选按90d retainUntil，7d/30d cookie失效不提前选中期内内容，read/轮询/通知不延长期限；结果只计数/安全时间无正文/email，既有询盘730d/分析/备份不纳入查询（E-85、E-86）。 | 1d |
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T4：消费持久聊天通知并注册每分钟作业
沿用分支 task/M4-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：79fdde72572e20a63a00beeba04b4d7dcd79361ce99c4d8339d07674b5d3eb6d
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：每分钟真实cron POST /api/admin/cron/operations(jobKey=chat-notifications)→registry→持久通知服务
保存后重启仍消费、无Bearer触发拒绝
messageId唯一出箱不因重试增项，通知只收件事实/受保护链接（E-90、E-94）。2) leaseOwner/leaseVersion原子认领并清空requestStartedAt，领取不计次
发送前以同一有效租约CAS写requestStartedAt并递增attempts，该CAS为0行不发送
SMTP事务外20s。清扫与结果写回用同一注入时钟并在取锁后判定：过期且本次标记为空→QUEUED、次数不增且立即可领，非空→UNKNOWN
写回须核status=SENDING、leaseOwner/leaseVersion及lockedUntil>当前时钟
过期＝lockedUntil<=当前时钟，等于即视为已释放，清扫只处理过期行，时钟在取锁后采样
写入方等锁期间跨过期点的写回为0行，旧worker亦不能覆盖新租约
worker确知未调用SMTP按已知失败处理、不记UNKNOWN。未达上限时，隔离SMTP接收后中断→UNKNOWN→重启后复用同stable Message-ID有界重试
首次发送后最多重试3次，最多4次已标记开始的发送尝试，明确允许SMTP重复（E-91、E-92）。3) 失败或未知结果写入时availableAt=该次写入时钟+1m/5m/30m（attempts=1/2/3），隔离测试含延迟清扫，下一档从清扫写入起算
认领与UNKNOWN提升均须attempts<4且availableAt到期
连续4次暂拒时第4次确知失败在同一结果CAS直写FAILED、不经QUEUED且lastErrorCode为脱敏码，另测第4次SMTP接收后写回前中断→UNKNOWN且停止自动重试，两案均无第5次自动尝试，全程最多4次已开始尝试
任何时刻不存在attempts>=4的QUEUED，人为植入该行时不认领、不发送、不自动迁移，按不变量违例检出。SMTP缺配置时仅attempts=0且未标记的QUEUED置DISABLED，不为同一messageId补建通知
已有UNKNOWN与attempts>0的QUEUED在缺配置期间不发送、不提升，状态与availableAt不变，恢复后按到期与上限继续
DISABLED在恢复后保持原状态。不可达/暂拒等真实状态脱敏持久保存，重启按出箱恢复
body/email/token不进通知/日志，失败不撤聊天received，HTTP触发未知不自动再触发（E-35、E-41、E-93）。
有效范围：
deploy/cron.nbshiyan
prod-env-check.ts
src/app/api/admin/account/
src/app/api/admin/chat/
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
src/lib/server/chat/notification-mailer.ts
src/lib/server/chat/notification-repo.ts
src/lib/server/chat/notification-service.ts
src/lib/server/composition.ts
src/lib/server/config.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
src/lib/server/mail/smtp.ts
tests/chat-notification-smtp.integration.test.ts
tests/chat-notification-worker.db.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
