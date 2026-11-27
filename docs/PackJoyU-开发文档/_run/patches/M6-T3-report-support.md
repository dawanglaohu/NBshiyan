# 文档补丁 M6-T3-report-support

任务：M6-T3
原分支：task/M6-T3
原 PR：577
依据：第09节 OpsSourceSnapshot 持久化、M5-T8 既有注册断言和第17节 PG17 门禁需要登记三个现有支持文件；保持既定验收与来源矩阵。

## 差异与复验范围

- M6-T3：definition、effectivePaths
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
@@ -3143,7 +3143,11 @@
         "container",
         "jobs"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        ".github/workflows/ci.yml",
+        "prisma/schema.prisma",
+        "tests/jobs-runtime.http.test.ts"
+      ],
       "outputPaths": [
         "src/lib/server/ops/ops-report.ts",
         "src/lib/server/ops/ops-sample.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M6-T3：登记存储备份报告与运维采样
沿用分支 task/M6-T3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：832188de158a12d800579012760f29eb372dfe14d4090faed44fd8f3d943aca9
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 受控deploy脚本→真实POST /api/internal/ops-report，Bearer与白名单严格
仅空间计数/备份完成验证元数据，拒任意路径和内容
同source+measuredAt同载荷幂等、异载荷409、旧时间不覆盖新值
无验证来源not_connected
SALES/EDITOR直接GET stats的STORAGE/BACKUP来源403且无计数，后台session不能替代report Bearer（E-65、E-66）。2) ops-sample在registry、composition、cron实际注册每15分钟，重启后按计划运行
真实measuredAt/lastSucceededAt读取到stats，停止报告显示原时间/旧值，未做恢复验证不能标可恢复
辅助源异常不阻断核心（E-67）。
有效范围：
.github/workflows/ci.yml
deploy/cron.nbshiyan
deploy/ops-report.py
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
src/app/api/internal/ops-report/
src/app/api/internal/ops-report/route.ts
src/auth.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/lib/server/jobs/registry.ts
src/lib/server/ops/ops-report.ts
src/lib/server/ops/ops-sample.ts
tests/jobs-runtime.http.test.ts
tests/ops-report.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M6-T3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
