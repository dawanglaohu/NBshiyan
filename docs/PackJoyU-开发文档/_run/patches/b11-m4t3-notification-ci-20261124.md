# 文档补丁 b11-m4t3-notification-ci-20261124

任务：M4-T3
原分支：task/M4-T3
原 PR：567
依据：Adopt Jev detail_sidecar ruling to define AdminChatSyncDTO.notifications in Section 10 for persisted ChatNotificationStatus (QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED) without altering ChatMessageDTO or visitor ChatSyncDTO, and declare src/lib/contracts/chat.ts, tests/contracts-foundation.test.ts, and .github/workflows/ci.yml in M4-T3 supportPaths so notification contract and CI PG17 regression gate are in scope.

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
- M4-T11：sections
- M4-T12：sections
- M4-T13：sections
- M4-T14：sections
- M4-T15：sections
- M4-T2：sections
- M4-T3：definition、effectivePaths、sections
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
@@ -36,7 +36,7 @@
 | POST | /api/chat/conversations/[id]/messages | clientMessageId、bodyText | MessageReceivedDTO：message、receivedAt、duplicate | 仅自己、OPEN、同源 |
 | POST | /api/chat/conversations/[id]/read | lastReadSeq | ReadDTO：lastReadSeq | 仅自己的访客cookie、同源，单调推进 |
 | GET | /api/admin/chat/conversations | status?、cursor?、limit=25(max100)、unreadOnly? | ChatSummaryPageDTO与本人未读总数 | ADMIN/SALES共享聊天范围；EDITOR拒绝 |
-| GET | /api/admin/chat/conversations/[id] | afterSeq=0、limit=50(max100) | AdminChatSyncDTO（正文按授权，不含访客cookie/token） | ADMIN/SALES |
+| GET | /api/admin/chat/conversations/[id] | afterSeq=0、limit=50(max100) | AdminChatSyncDTO（正文按授权，含同快照本页访客消息独立 notifications[{messageId,status}]，不含访客cookie/token） | ADMIN/SALES |
 | POST | /api/admin/chat/conversations/[id]/messages | clientMessageId、bodyText | MessageReceivedDTO；author由session确定 | ADMIN/SALES、OPEN、同源 |
 | POST | /api/admin/chat/conversations/[id]/read | lastReadSeq | ReadDTO | ADMIN/SALES且仅改自己的游标、同源 |
 | PATCH | /api/admin/chat/conversations/[id] | status=CLOSED、expectedVersion | ChatStatusDTO：status、version、updatedAt | ADMIN/SALES、同源，CAS |
@@ -84,6 +84,7 @@
 | from / to | YYYY-MM-DD站点自然日，闭区间用户参数，服务端转换左闭右开UTC边界 | 默认今日，最大连续400日且不能越13mo保留范围；非法或反向400 |
 | StatsSourceDTO | source、state、value:number/null、timezone、timezoneRevision、dataThrough、queriedAt、lastSucceededAt、coverage | 不含browserHash、联系人、聊天正文、token、服务器路径；零值必须是成功查询结果 |
 | 分页DTO（DevicePageDTO/ChatSummaryPageDTO） | items、nextCursor:string/null、hasMore:Boolean | 默认25/max100；cursor为受验证的最后sort键，不是SQL片段；设备/聊天列表按createdAt/id或updatedAt/id稳定排序，快照刷新不当增量日志 |
+| AdminChatSyncDTO.notifications（ChatNotificationSummaryDTO[]） | 数组≤100，项为 `{messageId,status}`；status 为 `QUEUED/SENDING/SENT/FAILED/UNKNOWN/DISABLED` | 仅后台详情同快照按本页访客消息 `messageId`（按 seq 升序唯一）独立返回持久通知状态，不含 `leaseOwner/stableMessageId` 等内部列；不改变 `ChatMessageDTO`、访客 `ChatSyncDTO`、消息 received 或收件箱可处理状态 |
 
 ## 幂等、重试、限流与版本
 
````

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -1801,9 +1801,12 @@
         "container"
       ],
       "supportPaths": [
+        "src/lib/contracts/chat.ts",
         "src/lib/server/chat/read-cursor.ts",
         "src/lib/server/composition.ts",
-        "tests/chat-operator-read.http.test.ts"
+        "tests/chat-operator-read.http.test.ts",
+        "tests/contracts-foundation.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "outputPaths": [
         "src/lib/server/chat/operator-read.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T3：查询当前授权运营的收件箱及读状态
沿用分支 task/M4-T3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：45132b347bcdc61f1f800585e7a30aa33c29cbd67179ad620b7781f2bea9086a
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实后台read handlers→requireAdmin(ADMIN/SALES)→inbox服务
未登录/EDITOR/撤权账号/访客直接读取不返回正文
当前角色每次重验、不会凭隐藏按钮放行（E-19、E-32、E-78）。2) 列表快照按updatedAt/id游标、正文seq分页max100，插页消息完整恰一次
本人read MAX不影响另一运营游标，未展示的新seq仍未读
真实queued/sending/sent/failed/unknown/disabled通知独立返回，不改received（E-34、E-35、E-79）。3) GET/read/通知不延长90d，cookie失效仅访客401，ADMIN/SALES仍读期内咨询
通知失败不改变收件箱可处理状态（E-41、E-86、E-89）。
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
src/lib/server/chat/inbox-repo.ts
src/lib/server/chat/operator-read.ts
src/lib/server/chat/read-cursor.ts
src/lib/server/composition.ts
src/lib/server/db.ts
tests/chat-operator-read.http.test.ts
tests/contracts-foundation.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
