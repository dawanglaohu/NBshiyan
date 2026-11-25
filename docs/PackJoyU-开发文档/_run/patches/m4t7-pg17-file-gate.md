# 文档补丁 m4t7-pg17-file-gate

任务：M4-T7
原分支：task/M4-T7
原 PR：572
依据：M4-T7 六条真库用例在无专用连接时跳过，PG17 CI 未登记该文件。依据第17节隔离库验收，为原 PR 补入 .github/workflows/ci.yml 支持路径。

## 差异与复验范围

- M4-T13：上游契约变化或本次审查目标
- M4-T7：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2037,7 +2037,8 @@
         "src/lib/server/config.ts",
         "prod-env-check.ts",
         "deploy/cron.nbshiyan",
-        "tests/chat-retention-dryrun.http.test.ts"
+        "tests/chat-retention-dryrun.http.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "outputPaths": [
         "src/lib/server/chat/retention-candidates.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T7：注册聊天保留候选与默认拒绝真实清理
沿用分支 task/M4-T7、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：928de3a69f43863bab8639bd8b6f8795c0ce8c72ba7e1bb967798794fbac43e7
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：每日真实cron POST /api/admin/cron/operations(jobKey=chat-retention)→registry→候选查询
无另行保留授权或开关未启用时仅dry-run，真实删除请求拒绝且deletedCount=0，文档/模型/派发不能作授权
隔离库前后行内容hash不变（E-88）。2) 查询候选按90d retainUntil，7d/30d cookie失效不提前选中期内内容，read/轮询/通知不延长期限
结果只计数/安全时间无正文/email，既有询盘730d/分析/备份不纳入查询（E-85、E-86）。
有效范围：
.github/workflows/ci.yml
deploy/cron.nbshiyan
prod-env-check.ts
src/auth.ts
src/lib/server/chat/retention-candidates.ts
src/lib/server/chat/retention-policy.ts
src/lib/server/composition.ts
src/lib/server/config.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
tests/chat-retention-dryrun.http.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T7:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
