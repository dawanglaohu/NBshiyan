# 文档补丁 M6-T6-r1-stats-http-paths

任务：M6-T6
原分支：task/M6-T6
原 PR：573
依据：成功率和重算信息需经共享 StatsDTO 输出；新增真浏览器用例触发 CI 分区核对，并需执行专库测试。补齐本任务两个必要支持文件。

## 差异与复验范围

- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：definition、effectivePaths
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
@@ -3262,7 +3262,10 @@
         "backendRoutes",
         "container"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        "src/lib/contracts/ops.ts",
+        ".github/workflows/ci.yml"
+      ],
       "outputPaths": [
         "src/app/api/admin/stats/",
         "src/lib/server/ops/stats-service.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M6-T6：接通受角色限制的真实统计HTTP入口
沿用分支 task/M6-T6、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：8d450411d1e7d60896dbe7105cc52a15d734a24956d209504050128c6be7f9e7
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真实登录后GET /api/admin/stats→route→ops查询真实聚合，核HTTP状态、DTO与数据时间
同意→真实页面/产品访问→真实GLB start/terminal→已注册五分钟作业提交后，逐项核当日授权浏览器、PV、产品归因、3D次数，核心来源不能固定返回或未接入（E-61）。3D耗时均值须携有效终态样本数samples，耗时无样本时均值为null
成功率以同意后真实start为分母，零成功与无样本的输出按09节、E-63及M6-T1既有口径逐项核对，samples不作成功率分母。DTO须与M6-T1同源，不得用0冒充未知值，不得对每日均值再平均。2) 未登录401
ADMIN全来源、SALES既有业务范围、EDITOR仅公开流量/产品/3D
直接请求敏感系统来源403，混合来源在查询前裁剪且无隐藏计数（E-66）。3) 切换有效时区后返回当前revision与重算状态，仅保留期完整覆盖可重算
超30天历史保留原标签或明确不可重算，不拼接趋势
不同浏览器时区同站点日一致（E-55、E-58）。读取口径：M5-T12 新表与旧 rollup 按阶段合并不双计
product pageViews 返回 no_data 不填 0
0% 按 start 分母
M6 分类按 site 行＋day-state＋live marker（live/consumed 缺键按 0 比较），旧 revision 用行内 timezone
覆盖起点前 no_data/partial。
有效范围：
.github/workflows/ci.yml
e2e/stats-core-api.spec.ts
src/app/api/admin/account/
src/app/api/admin/chat/
src/app/api/admin/cron/mail-queue/route.ts
src/app/api/admin/cron/operations/route.ts
src/app/api/admin/settings/analytics/route.ts
src/app/api/admin/stats/
src/app/api/admin/stats/route.ts
src/app/api/admin/users/
src/app/api/analytics/
src/app/api/auth-admin/
src/app/api/auth/
src/app/api/chat/
src/app/api/internal/ops-report/route.ts
src/auth.ts
src/lib/contracts/ops.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/ops/stats-service.ts
tests/stats-route.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M6-T6:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
