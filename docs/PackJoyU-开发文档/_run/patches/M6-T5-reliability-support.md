# 文档补丁 M6-T5-reliability-support

任务：M6-T5
原分支：task/M6-T5
原 PR：578
依据：第10节统计 DTO 与查询服务、第17节专库和 A3 分区镜像测试需要登记四个已用支持路径。

## 差异与复验范围

- M6-T5：definition、effectivePaths
- M6-T7：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -3234,7 +3234,12 @@
       "wiring": [
         "container"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        ".github/workflows/ci.yml",
+        "src/lib/contracts/ops.ts",
+        "src/lib/server/ops/stats-service.ts",
+        "tests/stats-route.test.ts"
+      ],
       "outputPaths": [
         "src/lib/server/ops/reliability-source.ts",
         "src/lib/server/composition.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M6-T5：接入HTTP和邮件可靠性来源
沿用分支 task/M6-T5、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：f71208e6f8991e6353506751477014356eda20b83f1f1e5797d5578e9c0f5697
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 对已接线API产生真实2xx/5xx响应后GET /api/admin/stats的http来源，分母为同范围真实requestCount且错误为5xx
覆盖标签仅本轮instrumented routes，无分母为null、未接入为not_connected，禁止声称全站错误率（E-64）。2) 通过真实通知作业产生queued/sending/sent/failed/unknown结果，mail来源按真实尝试/SMTP接受计数，不把排队或咨询received算投递
某来源查询失败保留其原成功时间/旧值或显示无旧值失败，其他来源继续成功（E-51、E-52、E-53、E-64、E-67）。
有效范围：
.github/workflows/ci.yml
e2e/stats-reliability-api.spec.ts
src/auth.ts
src/lib/contracts/ops.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/ops/reliability-source.ts
src/lib/server/ops/stats-service.ts
tests/stats-reliability.test.ts
tests/stats-route.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M6-T5:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
