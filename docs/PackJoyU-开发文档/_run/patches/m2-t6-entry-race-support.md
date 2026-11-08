# 文档补丁 m2-t6-entry-race-support

任务：M2-T6
原分支：task/M2-T6
原 PR：540
依据：Chief授权：#540入口竞态修复支持路径 e2e/admin-legacy-model-visual.spec.ts 登记进 M2-T6 supportPaths；不改M3-T23验收/状态、不改已审测试

## 差异与复验范围

- M2-T5：上游契约变化或本次审查目标
- M2-T6：definition、effectivePaths
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
@@ -547,6 +547,7 @@
       "supportPaths": [
         "e2e/poster-carrier.spec.ts",
         "e2e/poster-carrier/",
+        "e2e/admin-legacy-model-visual.spec.ts",
         ".github/workflows/ci.yml"
       ],
       "outputPaths": [
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M2-T6：接通真实模型失败与海报回退
沿用分支 task/M2-T6、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：a542c5911cbfc4a9df871ec719855c65ea021762b5d198e3a4dddb2e8b4abc16
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 分别注入GLB下载失败、WebGL不支持、context lost和仅poster/FoldBox，显示对应产品海报及可点击重试/询盘
不无限重试、不把其他产品图片充当回退。2) 重试建立新的实际加载尝试，卸载取消旧监听/加载回调
纯展示状态只上报加载结果回调，不在本任务创建分析成功事件，统计完整集成由M2-T7完成。
有效范围：
.github/workflows/ci.yml
e2e/admin-legacy-model-visual.spec.ts
e2e/model-fallback.spec.ts
e2e/poster-carrier.spec.ts
e2e/poster-carrier/
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
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M2-T6:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
