# 文档补丁 M6-T2-business-scope

任务：M6-T2
原分支：task/M6-T2
原 PR：576
依据：真实统计入口需要按请求传递 SALES 用户标识，接入业务源后必须更新相邻路由断言、PG17 专库与 A3 收集分母。仅补三项 supportPaths。

## 差异与复验范围

- M6-T2：definition、effectivePaths
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
@@ -3097,7 +3097,11 @@
       "wiring": [
         "container"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        "src/lib/server/ops/stats-service.ts",
+        "tests/stats-route.test.ts",
+        ".github/workflows/ci.yml"
+      ],
       "outputPaths": [
         "src/lib/server/ops/business-source.ts",
         "src/lib/server/composition.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M6-T2：接入询盘与聊天只读业务计数
沿用分支 task/M6-T2、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：d7243dbe4b2928c23c14b2186b189035d79f2a0d5938b9b8364d412636cc7f83
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 通过真实POST /api/inquiries及POST /api/chat/conversations保存合成询盘/消息，再GET /api/admin/stats请求business来源核持久且不变业务ID计数
同消息UUID重试及被拒垃圾不增加计数，结果不含email/body（E-62）。2) ADMIN/SALES按既有询盘scope只读查询
统计查询故障不能回滚或阻断咨询保存，业务计数不要求M4导入M6
未登录及EDITOR直接请求业务来源拒绝（E-62、E-66）。
有效范围：
.github/workflows/ci.yml
e2e/stats-business-api.spec.ts
src/auth.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/ops/business-source.ts
src/lib/server/ops/stats-service.ts
tests/stats-business.test.ts
tests/stats-route.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M6-T2:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
