# 文档补丁 M2-T3-model-accessibility-test-path

任务：M2-T3
原分支：task/M2-T3
原 PR：510
依据：M2-T3 新增的 tests/m2-t3-model-accessibility.test.ts 是漏传 zoomId/zoomDelta 静默失效的唯一守卫，141 个契约均未登记该路径，按 AGENTS.md 由审查方补齐 supportPaths；只补这一条路径

## 差异与复验范围

- M2-T3：definition、effectivePaths
- M2-T5：上游契约变化或本次审查目标
- M2-T6：上游契约变化或本次审查目标
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

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -429,7 +429,9 @@
       "wiring": [
         "frontendRoutes"
       ],
-      "supportPaths": [],
+      "supportPaths": [
+        "tests/m2-t3-model-accessibility.test.ts"
+      ],
       "outputPaths": [
         "src/components/three/",
         "src/lib/three/",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M2-T3：接通模型键盘触屏与复位控件
沿用分支 task/M2-T3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：6e95012a627d50f859cceb011f5250fb0110d71d43802eefdffd14543abae596
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) Tab逐个到达命名控件且焦点可见，方向/缩放/复位与鼠标功能相同
Escape退出并回来源控件，不锁Tab、不自动跳产品链接（E-101）。2) 分别测试模型单指拖动、双指min/max内缩放、文字区页面滚动，所有操作只在模型区接管且不提交询盘
逐个测点击目标≥44 CSS px（E-102）。3) 任意旋转/缩放后复位等于该产品初始相机/边界
1440/1920及窄屏完整模型可见、名称/关键控件符合11节字号且规格/询盘仍可见，不通过删内容消除裁切（E-104）。
有效范围：
e2e/model-accessibility.spec.ts
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
src/components/three/
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/navigation/routes.ts
src/lib/three/
tests/m2-t3-model-accessibility.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M2-T3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
