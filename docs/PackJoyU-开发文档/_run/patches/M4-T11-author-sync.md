# 文档补丁 M4-T11-author-sync

任务：M4-T11
原分支：task/M4-T11
原 PR：570
依据：验收2及E-33要求双端读取真实回复作者。现有第10节同步DTO缺少作者关联，补齐读取投影、持久层和真库CI的必要支持路径。

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
- M4-T11：definition、effectivePaths、sections、task
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
- R9-T71605271：sections
- RETENTION-CLEANUP：sections
- SEO-1：sections
- SEO-2：sections
- SEO-3：sections
- SEO-4：sections
- SEO-5：sections
- SEO-6：sections
- SEO-7：sections

### 02-设计/10-接口约定.md

````diff
--- before/02-设计/10-接口约定.md
+++ after/02-设计/10-接口约定.md
@@ -32,11 +32,11 @@
 | POST | /api/auth-admin/recovery/confirm | totp | RecoveryCompleteDTO：completed、recoveryCodes，清受限cookie；不直接发ADMIN权限 | 仅有效受限session与新TOTP |
 | POST | /api/chat/session | locale en/ru；仅主动联系 | ChatSessionDTO：available、expiresAt；设必要cookie | 精确同源+限流；不依赖分析同意 |
 | POST | /api/chat/conversations | clientConversationId、clientMessageId、locale、bodyText、email?、productSlug?、sourcePath? | ConversationReceivedDTO：conversationId、message、receivedAt、duplicate | 有效访客cookie且同源 |
-| GET | /api/chat/conversations/[id] | afterSeq=0、limit=50(max100) | ChatSyncDTO：conversation、messages、lastSeq、nextAfterSeq、hasMore、read | 仅自己的有效访客cookie |
+| GET | /api/chat/conversations/[id] | afterSeq=0、limit=50(max100) | ChatSyncDTO：conversation、messages、authors、lastSeq、nextAfterSeq、hasMore、read | 仅自己的有效访客cookie |
 | POST | /api/chat/conversations/[id]/messages | clientMessageId、bodyText | MessageReceivedDTO：message、receivedAt、duplicate | 仅自己、OPEN、同源 |
 | POST | /api/chat/conversations/[id]/read | lastReadSeq | ReadDTO：lastReadSeq | 仅自己的访客cookie、同源，单调推进 |
 | GET | /api/admin/chat/conversations | status?、cursor?、limit=25(max100)、unreadOnly? | ChatSummaryPageDTO与本人未读总数 | ADMIN/SALES共享聊天范围；EDITOR拒绝 |
-| GET | /api/admin/chat/conversations/[id] | afterSeq=0、limit=50(max100) | AdminChatSyncDTO（正文按授权，含同快照本页访客消息独立 notifications[{messageId,status}]，不含访客cookie/token） | ADMIN/SALES |
+| GET | /api/admin/chat/conversations/[id] | afterSeq=0、limit=50(max100) | AdminChatSyncDTO（正文按授权，含本页人工回复的 authors 与同快照本页访客消息的 notifications[{messageId,status}]，不含访客cookie/token） | ADMIN/SALES |
 | POST | /api/admin/chat/conversations/[id]/messages | clientMessageId、bodyText | MessageReceivedDTO；author由session确定 | ADMIN/SALES、OPEN、同源 |
 | POST | /api/admin/chat/conversations/[id]/read | lastReadSeq | ReadDTO | ADMIN/SALES且仅改自己的游标、同源 |
 | PATCH | /api/admin/chat/conversations/[id] | status=CLOSED、expectedVersion | ChatStatusDTO：status、version、updatedAt | ADMIN/SALES、同源，CAS |
@@ -84,6 +84,7 @@
 | from / to | YYYY-MM-DD站点自然日，闭区间用户参数，服务端转换左闭右开UTC边界 | 默认今日，最大连续400日且不能越13mo保留范围；非法或反向400 |
 | StatsSourceDTO | source、state、value:number/null、timezone、timezoneRevision、dataThrough、queriedAt、lastSucceededAt、coverage | 不含browserHash、联系人、聊天正文、token、服务器路径；零值必须是成功查询结果 |
 | 分页DTO（DevicePageDTO/ChatSummaryPageDTO） | items、nextCursor:string/null、hasMore:Boolean | 默认25/max100；cursor为受验证的最后sort键，不是SQL片段；设备/聊天列表按createdAt/id或updatedAt/id稳定排序，快照刷新不当增量日志 |
+| ChatSyncDTO.authors / AdminChatSyncDTO.authors | 必返数组，最多 100 项。每条本页 OPERATOR 消息按 seq 升序对应唯一的 `{messageId,authorRef}`，空页或纯访客页返回 `[]`。 | 两端从同一条已保存消息的 authorId 和咨询 ID 用服务端专用域密钥派生不透明引用。同一咨询内同一作者引用稳定，两名作者可区分，不同咨询不能关联。历史人工消息缺少 authorId 时该项返回 null authorRef。两端均只返回引用，不含原始账号 ID、邮箱或设备标识。写入回执和 ChatMessageDTO 保持既有字段。 |
 | AdminChatSyncDTO.notifications（ChatNotificationSummaryDTO[]） | 数组≤100，项为 `{messageId,status}`；status 为 `QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED` | 仅后台详情同快照按本页访客消息 `messageId`（按 seq 升序唯一）独立返回持久通知状态，不含 `leaseOwner/stableMessageId` 等内部列；不改变 `ChatMessageDTO`、访客 `ChatSyncDTO`、消息 received 或收件箱可处理状态 |
 
 ## 幂等、重试、限流与版本
````

### 04-执行/19-模块任务拆分.md

````diff
--- before/04-执行/19-模块任务拆分.md
+++ after/04-执行/19-模块任务拆分.md
@@ -60,7 +60,7 @@
 | M4-T8 | 建立主动联系才签发的必要cookie | M4 | M3-T14、M1-T2 | 共享HTTP/config和ChatSessionDTO；09/10必要会话/同源/期限。 | ChatVisitorSession；POST /api/chat/session及cookie校验/有限touch。 | 1) 调用方/接线点：真实POST /api/chat/session→visitor-session；主动联系才创建随机256bit token/hash库记录，Secure/HttpOnly/SameSite=Lax/Path=/api/chat、无Domain/PII；缺/拒分析不阻止，GET普通网页不签聊天cookie（E-40）。2) 7d闲置/首次30d绝对、等号/撤销即拒，先验有效再touch；有效cookie可复用，无cookie结果未知不自动循环创建，相同email不恢复旧session；精确Origin和10次/10min cookie、20次/10min IP-HMAC限流生效（E-85）。 | 1d |
 | M4-T9 | 集成聊天轮询、断网重试与失权停止 | M4 | M4-T5、M4-T11 | M4-T5实际访客UI、全部消息API，09/10 seq与1/2/4/8/16/30s协议。 | chat-poller与ChatContainer真实装配；3s同步、原key消息重试、失效/断网分支。 | 1) 入口：/contact联系人工→chat窗口；数据源GET /api/chat/conversations/[id]、POST messages/read；可见正常3s、hidden零轮询、恢复即补页，单在途，慢网失败退避1/2/4/8/16/30s；乱序/跨页插入每ID恰一次、seq不退、read仅实际可见最大完整seq（E-76、E-77）。2) 实际服务成功存消息后截断响应，UI待确认保留原UUID/body/email，点chat-retry重发原payload返回原receipt；运营实际GET只有一消息/出箱一条；未落库断网草稿仅标签页内存、刷新不承诺恢复（E-18、E-37、E-38）。3) cookie过期/撤销及运营角色撤权后下一poll和send均服务器拒绝且无正文/无写；改threadId/seq/email不能越权，UI停止定时器和旧发送、保留当前草稿并显示明确新咨询，不自动换UUID或跨线程重发（E-78、E-85）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 1.5d |
 | M4-T10 | 幂等追加访客消息并更新咨询保留期限 | M4 | M4-T2、M4-T1 | M4持久conversation/seq/出箱及只读/已读API。 | POST /api/chat/conversations/[id]/messages；可复用消息追加服务。 | 1) 调用方/接线点：真实POST messages→cookie范围/OPEN校验→锁行seq+消息+出箱+90d期限同事务；同clientMessageId同payload返回原id/seq且通知一条，异payload409、closed/anonymized拒绝，写失败无变更（E-18、E-33、E-90）。2) 成功存储后丢弃HTTP响应，用原UUID/payload重试返回相同receipt；只有首次提交推进90d，读/通知不推进；过期/撤销或换别人的id/email不能读写（E-37、E-78、E-86）。 | 0.5d |
-| M4-T11 | 保存真实人工回复并关闭咨询 | M4 | M4-T3、M4-T10 | M4-T3运营权限/读取与M4-T10消息追加。 | POST /api/admin/chat/conversations/[id]/messages、PATCH /api/admin/chat/conversations/[id]；当前作者和关闭CAS。 | 1) 调用方/接线点：真实ADMIN/SALES message handler→当前身份→共享消息追加；author来自session，两人并发回复各保留唯一seq和作者，重复UUID同载荷只一条，客户端自报author不采信（E-33）。2) 访客POST保存后运营GET实际读取、POST人工回复后访客GET读到相同body/作者，整个过程无AI自动回复；先落库才received（E-16、E-31）。3) close以expectedVersion CAS，竞争只有匹配者成功，关闭后访客/人工消息409；撤权后下一poll/send均无正文无写入，threadId/seq/email篡改不得读他人（E-32、E-78）。 | 1d |
+| M4-T11 | 保存真实人工回复并关闭咨询 | M4 | M4-T3、M4-T10 | M4-T3运营权限/读取与M4-T10消息追加。 | POST /api/admin/chat/conversations/[id]/messages、PATCH /api/admin/chat/conversations/[id]；当前作者、双端同步的 authors 和关闭CAS。 | 1) 调用方/接线点：真实ADMIN/SALES message handler→当前身份→共享消息追加；author来自session，两人并发回复各保留唯一seq和作者，重复UUID同载荷只一条，客户端自报author不采信（E-33）。2) 访客POST保存后运营GET实际读取、POST人工回复后访客GET读到相同body/作者，整个过程无AI自动回复；先落库才received。双端按10节 authors 对应本页两名真实作者及正文，核对跨页隔离（E-16、E-31、E-33）。3) close以expectedVersion CAS，竞争只有匹配者成功，关闭后访客/人工消息409；撤权后下一poll/send均无正文无写入，threadId/seq/email篡改不得读他人（E-32、E-78）。CI 的 PostgreSQL 17 步骤须实际运行运营写入 HTTP 用例，逐文件核验有通过用例且零跳过。 | 1d |
 | M4-T12 | 注册既有邮件队列真实POST调度 | M4 | M5-T1、M5-T8 | 现有mail-queue handler/worker、mail gate、M5 JobState；不修改旧邮件状态协议。 | 既有POST /api/admin/cron/mail-queue每分钟cron与同源固定JobState摘要。 | 1) 调用方/接线点：deploy/cron.nbshiyan每分钟POST旧mail-queue→既有mail gate/Bearer→worker，重启后受控SMTP实际消费已提交邮件；原stale/sent/failed/deferred/dropped字段不改，不以GET预取触发（E-94）。2) GET/POST兼容入口共享租约/JobState摘要，HTTP超时不自动重放或换方法探测，SMTP结果未知保留旧unknown_delivery协议；无权限/未启用不发信，失败不冒SENT（E-35、E-41）。终态写回只在同一事务内以完整守卫（id/status/attempts/redactedAt=null）单条CAS完成，attempt 取自本次领取；提交未确认不重放、不计数。队列领取/处理受整轮预算约束，数据库收尾用独立短窗且不占用告警截止；告警调用前按正常 budget deadline 自查，过期则跳过；检查到调用非原子，不承诺 sendMail 的实际起始时刻。 | 0.5d |
 | M4-T13 | 在隔离授权策略下原子匿名化过期咨询 | M4 | M4-T7、M4-T11、M4-T4、M4-T9 | M4-T7保留策略/固定job、M4-T11真实活动写入与09事务再校验。 | retention-service/repo匿名化分支、策略version及新活动竞争保护；仍默认dry-run且不执行生产清理。 | 1) 调用方/接线点：既有chat-retention→当前授权策略分支→事务重读lastActivityAt/retainUntil/policyVersion；只用隔离授权数据执行，扫描后新成功收发使旧候选跳过；未变的过期目标正文/email/敏感context匿名化并禁继续回复（E-87）。2) 复用M4-T9隐藏轮询/断网与M4-T4通知重试前置，仅新增retainUntil断言：重复GET刷新、隐藏页轮询、read、SMTP通知重试/回执均不改90d截止，成功保存访客消息或人工回复才推进；cookie到期不级联删内容；外键Restrict，全部咨询匿名化后才回收空session；无明确授权仍拒绝真实写且deletedCount0，既有询盘/分析/恢复/备份不变（E-86、E-88、E-89）。 | 1d |
 | M4-T14 | 在真实双端会话接通人工回复与关闭 | M4 | M4-T6、M4-T11、M4-T4 | M4-T6真实收件页、M4-T11人工写API、M4-T9访客同步、通知job。 | OperatorReplyComposer/关闭控件、访客到运营到访客的真实可操作闭环。 | 1) 入口：访客contact窗口Send→received，运营后台Human conversations→实际会话行→Send reply（operator-chat-send）；数据源POST /api/admin/chat/conversations/[id]/messages及双方GET；点发后真实保存作者body，访客轮询显示同条人工消息，期间无AI生成回复；DB保存失败没有received（E-16、E-31）。2) 两名真实运营并发回复各保留seq/author，点击Close conversation（operator-chat-close）PATCH expectedVersion，冲突读最新不自动改写、关闭后两端发信409；撤权下一send403且无新行；通知失败只改变通知态（E-33、E-35、E-41、E-78）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700；后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。 | 1d |
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2212,10 +2212,18 @@
         "container"
       ],
       "supportPaths": [
+        ".github/workflows/ci.yml",
         "src/app/api/admin/chat/conversations/",
+        "src/lib/contracts/chat.ts",
+        "src/lib/server/chat/author-ref.ts",
+        "src/lib/server/chat/inbox-repo.ts",
         "src/lib/server/chat/message-service.ts",
+        "src/lib/server/chat/operator-read.ts",
+        "src/lib/server/chat/repo.ts",
+        "src/lib/server/chat/visitor-read.ts",
         "src/lib/server/composition.ts",
-        "tests/chat-operator-write.http.test.ts"
+        "tests/chat-operator-write.http.test.ts",
+        "tests/contracts-foundation.test.ts"
       ],
       "outputPaths": [
         "src/lib/server/chat/operator-write.ts"
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T11：保存真实人工回复并关闭咨询
沿用分支 task/M4-T11、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：678bfc29914055576bb5b44ac78a6cfb7fa9d37ebc4fd21a7924db9b7ea9681a
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实ADMIN/SALES message handler→当前身份→共享消息追加
author来自session，两人并发回复各保留唯一seq和作者，重复UUID同载荷只一条，客户端自报author不采信（E-33）。2) 访客POST保存后运营GET实际读取、POST人工回复后访客GET读到相同body/作者，整个过程无AI自动回复
先落库才received。双端按10节 authors 对应本页两名真实作者及正文，核对跨页隔离（E-16、E-31、E-33）。3) close以expectedVersion CAS，竞争只有匹配者成功，关闭后访客/人工消息409
撤权后下一poll/send均无正文无写入，threadId/seq/email篡改不得读他人（E-32、E-78）。CI 的 PostgreSQL 17 步骤须实际运行运营写入 HTTP 用例，逐文件核验有通过用例且零跳过。
有效范围：
.github/workflows/ci.yml
src/app/api/admin/account/
src/app/api/admin/chat/
src/app/api/admin/chat/conversations/
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
src/lib/contracts/chat.ts
src/lib/server/chat/author-ref.ts
src/lib/server/chat/inbox-repo.ts
src/lib/server/chat/message-service.ts
src/lib/server/chat/operator-read.ts
src/lib/server/chat/operator-write.ts
src/lib/server/chat/repo.ts
src/lib/server/chat/visitor-read.ts
src/lib/server/composition.ts
src/lib/server/db.ts
tests/chat-operator-write.http.test.ts
tests/contracts-foundation.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T11:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
