# 文档补丁 b9-m5t4-k-mail-fixture-20261110

任务：M5-T4
原分支：task/M5-T4
原 PR：549
依据：K CI 失败：tests/mail-queue-schedule.integration.test.ts 的 4 个正向/失败映射用例在 CI 默认 off 下期待执行；按方案 A 仅修夹具作用域与恢复，并补 M5-T4 必要支持路径。

## 差异与复验范围

- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M5-T10：上游契约变化或本次审查目标
- M5-T4：definition、effectivePaths
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2549,6 +2549,7 @@
         "tests/analytics-aggregate-plan.test.ts",
         "tests/jobs-runtime.http.test.ts",
         "tests/operations-mail-switch.test.ts",
+        "tests/mail-queue-schedule.integration.test.ts",
         "tests/analytics-settings.db.test.ts",
         "tests/analytics-aggregate.db.test.ts",
         ".github/workflows/ci.yml",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T4：接通时区设置HTTP与重算范围查询
沿用分支 task/M5-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：5057dca01f29e10fa87f67c161a1201665f6a1170b1cae90047d813aa6086e24
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真HTTP GET返回当前version/timezone/revision/recomputableFrom：pending存在、revision/timezone匹配且重算起点非未来时为读时实时起点
null只表示读时无可用pending，不证明重建完成
坏settings仍503，DTO仍四字段。PATCH携expectedVersion
ADMIN修改有效IANA后新revision及重算待办与审计同事务
settings与待办单语句同快照读取，下一真实作业在同一事务完成整组聚合、完整待办值CAS删除与JobState终态提交，只重算仍保留完整30天原始覆盖的窗口，更早范围保留原标签/partial，不新增分页或分块推进（E-58）。2) 不存在IANA、旧version、SALES/EDITOR/未登录直接请求拒绝且原配置完全不变，不回退浏览器时区（E-59）
GET与作业共用同一可用pending判定，缺settings按默认UTC/rev1
旧about/org设置不变，响应按10节schema通过。
有效范围：
.github/workflows/ci.yml
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
src/lib/analytics/aggregate-plan.ts
src/lib/contracts/analytics.ts
src/lib/server/analytics/aggregate.ts
src/lib/server/analytics/settings-repo.ts
src/lib/server/analytics/settings.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
tests/analytics-aggregate-plan.test.ts
tests/analytics-aggregate.db.test.ts
tests/analytics-settings.db.test.ts
tests/analytics-settings.http.test.ts
tests/jobs-runtime.http.test.ts
tests/mail-queue-schedule.integration.test.ts
tests/operations-mail-switch.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
