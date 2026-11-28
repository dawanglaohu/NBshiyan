# 文档补丁 M6-T4-R2-ci-collection

任务：M6-T4
原分支：task/M6-T4
原 PR：579
依据：已合入主干的 M6-T5 在 tests/stats-reliability.test.ts 校验 A3 精确收集数。新增两条看板用例后须同步 265/234。

## 差异与复验范围

- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M6-T4：definition、effectivePaths
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
@@ -3196,6 +3196,7 @@
         "src/lib/server/admin/layout-gate.ts",
         "tests/admin-layout-guard.test.ts",
         "tests/admin-page-outage.test.ts",
+        "tests/stats-reliability.test.ts",
         "tests/stats-route.test.ts"
       ],
       "outputPaths": [
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M6-T4：交付可导航的核心数据看板页面
沿用分支 task/M6-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：c7b7ab2bf05bde030687ab7b433001005e7ecbbf8bf5d330205151af3eb79f4c
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真登录后点击后台壳stats-link到/admin/stats
日期/产品/刷新控件发真实GET /api/admin/stats并渲染对应core DTO，授权浏览器/PV/产品/3D有真实来源，样本数与时区标签可见（E-61、E-63）。2) ADMIN/SALES/EDITOR页面仅呈其权限来源，直接请求越权仍403且响应不含隐藏计数
1920×1080、1440×900、390×844以真实会话留GIF与density=7/gutter16/gap16/pad16报告，work面按D1-D6且手机保留真实n/a（E-66）。
有效范围：
.github/workflows/ci.yml
e2e/brand-smoke.spec.ts
e2e/stats-page.spec.ts
src/app/
src/app/admin-enroll/
src/app/admin-login/
src/app/admin-recovery/
src/app/admin/account/
src/app/admin/chat/
src/app/admin/settings/
src/app/admin/stats/
src/app/admin/users/
src/components/admin/AdminShell.tsx
src/components/admin/stats/StatsContainer.tsx
src/components/admin/stats/StatsFilters.tsx
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/client/ops.ts
src/lib/navigation/routes.ts
src/lib/server/admin/layout-gate.ts
tests/admin-layout-guard.test.ts
tests/admin-page-outage.test.ts
tests/stats-reliability.test.ts
tests/stats-route.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M6-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
