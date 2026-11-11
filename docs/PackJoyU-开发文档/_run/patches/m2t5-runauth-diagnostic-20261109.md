# 文档补丁 m2t5-runauth-diagnostic-20261109

任务：M2-T5
原分支：task/M2-T5
原 PR：none
依据：M2-T5 有效范围补齐权限诊断夹具：仅追加 e2e/run-auth.ts 与 tests/e2e-run-auth.test.ts 两条 supportPaths；不改变验收要求、历史补丁/复核/progress。

## 差异与复验范围

- M2-T5：definition、effectivePaths
- M2-T8：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -507,7 +507,9 @@
       ],
       "supportPaths": [
         ".github/workflows/ci.yml",
-        "e2e/product-cards.spec.ts"
+        "e2e/product-cards.spec.ts",
+        "e2e/run-auth.ts",
+        "tests/e2e-run-auth.test.ts"
       ],
       "outputPaths": [
         "src/components/inquiry/",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M2-T5：连接产品上下文到既有询盘表单
沿用分支 task/M2-T5、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：bfc79d9ba03c92693f71c4e938823fb906354bec4fb6d34de826eff8f1ade5dd
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 点击产品卡inquire-product→/[locale]/contact，真实POST /api/inquiries携服务器认可productSlug并保存真实Inquiry编号，表单的产品/规格等于来源卡片，不改旧询盘协议。2) en/ru和390窄屏分别走该入口，提交前从模型拖动/键盘控制不产生询盘POST
名称、规格、询盘入口仍可见且能完成提交，保留一条真实路径GIF。
有效范围：
.github/workflows/ci.yml
e2e/product-cards.spec.ts
e2e/product-inquiry.spec.ts
e2e/run-auth.ts
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
src/components/inquiry/
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/components/quote/
src/components/three/ProductGallery.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/navigation/routes.ts
tests/e2e-run-auth.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M2-T5:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
