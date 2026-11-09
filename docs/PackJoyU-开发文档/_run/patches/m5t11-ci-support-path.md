# 文档补丁 m5t11-ci-support-path

任务：M5-T11
原分支：task/M5-T11
原 PR：None
依据：M5-T11 CI 接线：把 .github/workflows/ci.yml 列入 supportPaths（公共 CI 支持路径），并在现有 PG 回归 step 接入 tests/analytics-retention.db.test.ts 的专属 URL/REQUIRE 与三清单。

## 差异与复验范围

- M5-T11：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2847,7 +2847,8 @@
       ],
       "supportPaths": [
         "src/lib/server/analytics/aggregate.ts",
-        "tests/jobs-runtime.http.test.ts"
+        "tests/jobs-runtime.http.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "outputPaths": [
         "src/lib/server/analytics/retention.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T11：注册默认dry-run的分析保留任务
沿用分支 task/M5-T11、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：6a8c38d793c917a451ea54465a64eb0a24b66986211ac42313d0e5e9704b00e2
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
