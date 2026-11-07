# 文档补丁 m5-t5-ci-support-path

任务：M5-T5
原分支：task/M5-T5
原 PR：None
依据：Chief授权：补已授权的CI接线支持路径 .github/workflows/ci.yml；仅路径与必要派生，不改验收语义

## 差异与复验范围

- M5-T11：上游契约变化或本次审查目标
- M5-T5：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2540,7 +2540,9 @@
       ],
       "stage": "primitive",
       "wiring": [],
-      "supportPaths": [],
+      "supportPaths": [
+        ".github/workflows/ci.yml"
+      ],
       "outputPaths": [
         "src/lib/server/analytics/retention-plan.ts",
         "tests/analytics-retention-plan.test.ts"
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M5-T5：实现分析保留候选与覆盖边界计划器
沿用分支 task/M5-T5、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：b3d6f9d40f3cb4a5a475fe406b88644e74af212282fee857f2e1b8e07c46f0d0
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 注入时钟验证receivedAt+30天与13自然月expiresAt边界和等号到期
只读查询返回候选ID/数量，不执行删除，不含browserHash导出或业务PII。2) 计划器同时返回完整原始覆盖起点/不可重算自然日，部分清理日不得被标可重算
输出由M5-T11消费，真实事务/生产授权门禁由其集成。
有效范围：
.github/workflows/ci.yml
src/lib/server/analytics/retention-plan.ts
tests/analytics-retention-plan.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M5-T5:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
