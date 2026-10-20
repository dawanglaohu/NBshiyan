# 文档补丁 m1-t1-review-standalone-config

任务：M1-T1
原分支：task/M1-T1
原 PR：393
依据：CI 浏览器套件统一使用 standalone 需要修改 playwright.config.ts；补齐本任务必要测试配置路径，保持原验收不变

## 差异与复验范围

- M1-T1：definition、effectivePaths
- M1-T2：上游契约变化或本次审查目标
- M1-T3：上游契约变化或本次审查目标
- M1-T4：上游契约变化或本次审查目标
- M1-T5：上游契约变化或本次审查目标
- M1-T6：上游契约变化或本次审查目标
- M1-T7：上游契约变化或本次审查目标
- M1-T8：上游契约变化或本次审查目标
- M1-T9：上游契约变化或本次审查目标
- M2-T1：上游契约变化或本次审查目标
- M2-T2：上游契约变化或本次审查目标
- M2-T3：上游契约变化或本次审查目标
- M2-T4：上游契约变化或本次审查目标
- M2-T5：上游契约变化或本次审查目标
- M2-T6：上游契约变化或本次审查目标
- M2-T7：上游契约变化或本次审查目标
- M2-T8：上游契约变化或本次审查目标
- M3-T1：上游契约变化或本次审查目标
- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T14：上游契约变化或本次审查目标
- M3-T15：上游契约变化或本次审查目标
- M3-T16：上游契约变化或本次审查目标
- M3-T17：上游契约变化或本次审查目标
- M3-T18：上游契约变化或本次审查目标
- M3-T19：上游契约变化或本次审查目标
- M3-T2：上游契约变化或本次审查目标
- M3-T20：上游契约变化或本次审查目标
- M3-T21：上游契约变化或本次审查目标
- M3-T22：上游契约变化或本次审查目标
- M3-T23：上游契约变化或本次审查目标
- M3-T24：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T3：上游契约变化或本次审查目标
- M3-T4：上游契约变化或本次审查目标
- M3-T5：上游契约变化或本次审查目标
- M3-T6：上游契约变化或本次审查目标
- M3-T7：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M4-T1：上游契约变化或本次审查目标
- M4-T10：上游契约变化或本次审查目标
- M4-T11：上游契约变化或本次审查目标
- M4-T12：上游契约变化或本次审查目标
- M4-T13：上游契约变化或本次审查目标
- M4-T14：上游契约变化或本次审查目标
- M4-T15：上游契约变化或本次审查目标
- M4-T2：上游契约变化或本次审查目标
- M4-T3：上游契约变化或本次审查目标
- M4-T4：上游契约变化或本次审查目标
- M4-T5：上游契约变化或本次审查目标
- M4-T6：上游契约变化或本次审查目标
- M4-T7：上游契约变化或本次审查目标
- M4-T8：上游契约变化或本次审查目标
- M4-T9：上游契约变化或本次审查目标
- M5-T1：上游契约变化或本次审查目标
- M5-T10：上游契约变化或本次审查目标
- M5-T11：上游契约变化或本次审查目标
- M5-T2：上游契约变化或本次审查目标
- M5-T3：上游契约变化或本次审查目标
- M5-T4：上游契约变化或本次审查目标
- M5-T5：上游契约变化或本次审查目标
- M5-T6：上游契约变化或本次审查目标
- M5-T7：上游契约变化或本次审查目标
- M5-T8：上游契约变化或本次审查目标
- M5-T9：上游契约变化或本次审查目标
- M6-T1：上游契约变化或本次审查目标
- M6-T2：上游契约变化或本次审查目标
- M6-T3：上游契约变化或本次审查目标
- M6-T4：上游契约变化或本次审查目标
- M6-T5：上游契约变化或本次审查目标
- M6-T6：上游契约变化或本次审查目标
- M6-T7：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T3：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T7：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -12,7 +12,9 @@
         "buildPipeline",
         "frontendRoutes"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        "playwright.config.ts"
+      ],
       "outputPaths": [
         "src/styles/tokens.css",
         "src/styles/motion-tokens.css",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M1-T1：接入8个核心品牌变量及既有路径真实冒烟
沿用分支 task/M1-T1、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：c05fc8a5fb6198a932bfc715de2ea8141001fd67da51a5392672405a08673733
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 仅将背景、前景、强调色、边界宽度、圆角、基础字号、正文行高、焦点颜色8个核心token接入现有首页，不建立新页面或新业务控件
构建/启动真实standalone，从header产品链接进入产品页，computed style逐一等于11节取值
目录沿SSR loadCatalog(listPublishedModels)，冒烟另作真实HTTP GET /api/models兼容校验，不给产品页增加重复fetch。2) 真实首页WebVitals触发POST /api/rum并核204和脱敏日志，CI起同一服务运行此浏览器冒烟。3) 本地已审文档随本PR进入主干
后续任务从该落地基线建分支。
有效范围：
.github/workflows/ci.yml
AGENTS.md
CLAUDE.md
docs/PackJoyU-开发文档/
e2e/brand-smoke.spec.ts
eslint.config.mjs
next.config.ts
package.json
playwright.config.ts
prod-env-check.ts
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
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/instrumentation.ts
src/lib/navigation/routes.ts
src/styles/motion-tokens.css
src/styles/tokens.css
tsconfig.json
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M1-T1:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
