# 文档补丁 b9-m4t12-p2-evidence-support-20261109

任务：M4-T12
原分支：task/M4-T12
原 PR：none
依据：B9-M4T12-P2-SUPPORT-REGISTRATION：仅登记 P2 三项测试支撑路径 tests/evidence/local-smtp.mjs、tests/evidence/mail-cron-tick.sh、tests/evidence/mail-cron-phase.mjs（10->13），ci.yml 已有不重复；支撑原验收真实 crond 重启消费与隔离 SMTP，不改需求/边界，不实施 P2。

## 差异与复验范围

- M4-T12：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2225,7 +2225,10 @@
         "src/lib/server/mail/queue-job.ts",
         "tests/fixtures/mail-db.ts",
         "src/lib/server/cron-alert.ts",
-        ".github/workflows/ci.yml"
+        ".github/workflows/ci.yml",
+        "tests/evidence/local-smtp.mjs",
+        "tests/evidence/mail-cron-tick.sh",
+        "tests/evidence/mail-cron-phase.mjs"
       ],
       "outputPaths": [
         "src/app/api/admin/cron/mail-queue/route.ts"
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T12：注册既有邮件队列真实POST调度
沿用分支 task/M4-T12、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：6539686e252995da4a30f457cf8cf02c4f89cd660185655ff2d5a9120597cc47
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：deploy/cron.nbshiyan每分钟POST旧mail-queue→既有mail gate/Bearer→worker，重启后受控SMTP实际消费已提交邮件
原stale/sent/failed/deferred/dropped字段不改，不以GET预取触发（E-94）。2) GET/POST兼容入口共享租约/JobState摘要，HTTP超时不自动重放或换方法探测，SMTP结果未知保留旧unknown_delivery协议
无权限/未启用不发信，失败不冒SENT（E-35、E-41）。终态写回只在同一事务内以完整守卫（id/status/attempts/redactedAt=null）单条CAS完成，attempt 取自本次领取
提交未确认不重放、不计数。队列领取/处理受整轮预算约束，数据库收尾用独立短窗且不占用告警截止
告警调用前按正常 budget deadline 自查，过期则跳过
检查到调用非原子，不承诺 sendMail 的实际起始时刻。
有效范围：
.github/workflows/ci.yml
deploy/cron.nbshiyan
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
src/lib/server/composition.ts
src/lib/server/cron-alert.ts
src/lib/server/jobs/registry.ts
src/lib/server/mail.ts
src/lib/server/mail/queue-job.ts
src/lib/server/mail/send.ts
tests/evidence/local-smtp.mjs
tests/evidence/mail-cron-phase.mjs
tests/evidence/mail-cron-tick.sh
tests/fixtures/mail-db.ts
tests/mail-queue-schedule.integration.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T12:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
