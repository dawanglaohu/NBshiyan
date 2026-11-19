# 文档补丁 m4t4-support-paths-20261119

任务：M4-T4
原分支：task/M4-T4
原 PR：None
依据：R1-O1；G10 F2/F4

## 差异与复验范围

- M2-T8：上游契约变化或本次审查目标
- M4-T13：上游契约变化或本次审查目标
- M4-T14：上游契约变化或本次审查目标
- M4-T4：definition、effectivePaths
- M6-T2：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -1853,7 +1853,19 @@
         "src/lib/server/config.ts",
         "prod-env-check.ts",
         "tests/chat-notification-worker.db.test.ts",
-        "tests/chat-notification-smtp.integration.test.ts"
+        "tests/chat-notification-smtp.integration.test.ts",
+        ".github/workflows/ci.yml",
+        "tests/jobs-runtime.http.test.ts",
+        "tests/prod-env-check.test.ts",
+        "tests/evidence/local-smtp.mjs",
+        "tests/evidence/chat-notifications-phase.mjs",
+        "tests/evidence/chat-notifications-tick.sh",
+        "src/lib/server/chat/notification-job.ts",
+        "src/lib/server/chat/notification-policy.ts",
+        "tests/chat-notifications.worker.test.ts",
+        "docs/PackJoyU-开发文档/图谱/任务/M4-T4.md",
+        "next.config.ts",
+        "tests/startup-env-check.test.ts"
       ],
       "outputPaths": [
         "src/lib/server/chat/notification-service.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T4：消费持久聊天通知并注册每分钟作业
沿用分支 task/M4-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：3bd5901b682f61d659ff52584c9d69a6c5c1fe07610b4f1ee8a4b4be4d9afb2f
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
.github/workflows/ci.yml
deploy/cron.nbshiyan
docs/PackJoyU-开发文档/图谱/任务/M4-T4.md
next.config.ts
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
src/lib/server/chat/notification-job.ts
src/lib/server/chat/notification-mailer.ts
src/lib/server/chat/notification-policy.ts
src/lib/server/chat/notification-repo.ts
src/lib/server/chat/notification-service.ts
src/lib/server/composition.ts
src/lib/server/config.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
src/lib/server/mail/smtp.ts
tests/chat-notification-smtp.integration.test.ts
tests/chat-notification-worker.db.test.ts
tests/chat-notifications.worker.test.ts
tests/evidence/chat-notifications-phase.mjs
tests/evidence/chat-notifications-tick.sh
tests/evidence/local-smtp.mjs
tests/jobs-runtime.http.test.ts
tests/prod-env-check.test.ts
tests/startup-env-check.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
