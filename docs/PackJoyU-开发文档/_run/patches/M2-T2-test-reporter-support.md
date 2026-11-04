# 文档补丁 M2-T2-test-reporter-support

任务：M2-T2
原分支：task/M2-T2
原 PR：504
依据：补齐 playwright.config.ts 取证 reporter 的必要支持路径；该文件已在 PR 差异中但未列入 taskPaths/supportPaths，按定点文档补丁流程纳入支持范围，不扩大验收、不改生成器或应用行为

## 差异与复验范围

- M2-T2：definition、effectivePaths
- M2-T3：上游契约变化或本次审查目标
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
@@ -390,7 +390,8 @@
       "supportPaths": [
         "tests/m2-t2-model-pointer.test.ts",
         "messages/en.json",
-        "messages/ru.json"
+        "messages/ru.json",
+        "playwright.config.ts"
       ],
       "outputPaths": [
         "src/components/three/",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M2-T2：修正模型直接拖动与滚轮焦点
沿用分支 task/M2-T2、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：5b4b8b6f682a107ddb8a34c968b3ef9f855a2d602fd60dddce535d97ddb964be
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 从产品卡模型viewport直接pointer-down捕获当前模型，hover停自转且不几何缩放
普通wheel始终页面滚动
Ctrl/Cmd+wheel仅在真实DOM焦点归属本模型视口/命名工具条且指针命中同一模型视口/工具条时缩放该相机，zoom控件点击仍可缩放
标题/说明/规格/链接与跨模型命中不缩放任一模型并保留浏览器行为，不以整张卡片或缓存焦点代替判定，不先强制激活（E-97、E-98、E-99）。2) pointercancel/blur/Escape/卸载均释放，重新操作正确目标且不残留锁页
用户暂停优先于隐藏/显示恢复
测试保留修改前失败与修改后通过（E-100）。
有效范围：
e2e/model-pointer.spec.ts
messages/en.json
messages/ru.json
playwright.config.ts
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
tests/m2-t2-model-pointer.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M2-T2:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
