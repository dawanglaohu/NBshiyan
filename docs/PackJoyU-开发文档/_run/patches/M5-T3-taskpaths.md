# 文档补丁 M5-T3-taskpaths

任务：M5-T3
原分支：task/M5-T3
原 PR：None
依据：M5-T3 有效路径补登：把纯函数层 aggregate-plan.ts 与其测试并入 handoff.taskPaths，使无 PostgreSQL 环境也能验证 cutoff/迟到窗口/覆盖度

## 差异与复验范围

- M2-T7：上游契约变化或本次审查目标
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
- M5-T3：effectivePaths
- M5-T4：上游契约变化或本次审查目标
- M5-T5：上游契约变化或本次审查目标
- M5-T8：上游契约变化或本次审查目标
- M6-T1：上游契约变化或本次审查目标
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

### _run/presentation.json

````diff
--- before/_run/presentation.json
+++ after/_run/presentation.json
@@ -400,7 +400,9 @@
         "src/lib/server/analytics/aggregate.ts",
         "src/lib/server/analytics/aggregate-repo.ts",
         "prisma/schema.prisma",
-        "tests/analytics-aggregate.db.test.ts"
+        "tests/analytics-aggregate.db.test.ts",
+        "src/lib/analytics/aggregate-plan.ts",
+        "tests/analytics-aggregate-plan.test.ts"
       ],
       "M5-T4": [
         "src/app/api/admin/settings/analytics/route.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T3：以一致快照重算并原子替换日聚合
沿用分支 task/M5-T3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：eac5d5771eecc4d3510b445105efd0e58ad1c57793fe97a16b2c21c7470bfb01
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真Postgres同一重复事件仅计一次，聚合固定RepeatableRead快照/cutoff，新到事件留下一轮
同navigationId去重，整组目标日数据与watermark一次事务替换，进程中断保留上组（E-80、E-81）。2) 并发旧generation或旧timezoneRevision提交拒绝
只重算dayStart不早于完整原始覆盖起点的日，48h迟到重算该日，超范围保留原完整值并返回partial/unavailable及原口径，不延长原始保留、不用残片变小（E-82、E-83）。3) 聚合按站点IANA左闭右开日计算23/25小时DST及午夜单归属
变时区只用仍保留事件重算，30天外保留原标签/不可重算状态（E-56、E-57、E-58）。本服务由M5-T8接真实5分钟调度。
有效范围：
deploy/deploy.sh
prisma/schema.prisma
src/lib/analytics/aggregate-plan.ts
src/lib/server/analytics/aggregate-repo.ts
src/lib/server/analytics/aggregate.ts
tests/analytics-aggregate-plan.test.ts
tests/analytics-aggregate.db.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
