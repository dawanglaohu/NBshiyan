# 文档补丁 m5-t8-support-paths

任务：M5-T8
原分支：task/M5-T8
原 PR：None
依据：Chief授权：补已授权的三个支持路径(aggregate.ts/aggregate-repo.ts/cron-analytics-rollup.test.ts)；S1为授权已给、契约现补；不拆任务、不改验收/源码/M5-T3契约

## 差异与复验范围

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

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2694,7 +2694,11 @@
         "jobs",
         "migrations"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        "src/lib/server/analytics/aggregate.ts",
+        "src/lib/server/analytics/aggregate-repo.ts",
+        "tests/cron-analytics-rollup.test.ts"
+      ],
       "outputPaths": [
         "src/lib/server/jobs/registry.ts",
         "src/lib/server/composition.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T8：注册聚合作业并接通真实5分钟cron
沿用分支 task/M5-T8、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：d5b8e94fa6a2c7b3a0f5a6a2ea15d45eeffb7c72ff554707518087efeb9d24a8
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) composition只注册已实现analytics-aggregate，deploy/cron.nbshiyan每5分钟POST /api/admin/cron/operations
固定key/Bearer常量时间校验，未知key/无凭据拒绝，不允许任意脚本。2) 真调度在重启后实际运行并提交JobState/watermark，batch≤500、55s截止、旧代次不能覆盖
停cron/失败保持上次成功watermark并显示安全状态NEVER/FAILED/旧值，不凭路由存在或手动调用宣称刚更新（E-81、E-84）。3) 浏览器同意后同日同浏览器完成两次页面访问并刷新/重试同eventId，实际job后UV仍1、真实新访问PV增加且重复事件不增加（E-44）
看板GET不触发任务，通知/邮件由M4注册，不导入未来服务或登记空实现。4) 隔离服务使用可控时钟经事件HTTP入口分别提交now-48h-1ms、now-48h、now+5min、now+5min+1ms：超界两项返回event_time_out_of_range且无记录，边界两项可准入
准入未来事件在实际聚合作业时钟到其occurredAt前不计入，到时后才计入。48h内迟到事件仅重算仍具完整原始覆盖的所属日，已关闭/超窗口历史不受任意客户端时间污染
完整覆盖外保留原聚合并标partial/unavailable，不以残片写小或造未来日（E-60）。
有效范围：
deploy/cron.nbshiyan
deploy/deploy.sh
e2e/analytics-job-runtime.spec.ts
prisma/schema.prisma
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
src/lib/server/analytics/aggregate-repo.ts
src/lib/server/analytics/aggregate.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
tests/cron-analytics-rollup.test.ts
tests/jobs-runtime.http.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T8:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
