# 文档补丁 m3-t22-ci-support

任务：M3-T22
原分支：task/M3-T22
原 PR：None
依据：Chief授权：#538合入main后补CI支持路径 .github/workflows/ci.yml；含A3计数与主段显示名，不改断言/预算/验收

## 差异与复验范围

- M3-T22：definition、effectivePaths
- M7-T10：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -3690,7 +3690,8 @@
       ],
       "supportPaths": [
         "e2e/admin-legacy-unassigned-gate.spec.ts",
-        "tests/admin-legacy-unassigned-style.test.ts"
+        "tests/admin-legacy-unassigned-style.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "stage": "integration",
       "wiring": [],
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T22：迁移未归类邮件样式并保持关闭门禁
沿用分支 task/M3-T22、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：9318c939fa95b9f23968a42304f55b58087c8ddc5fd5ca333695feb5266fed0f
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 保留UNASSIGNED_MAIL_LIVE=false和MAIL_ATTACHMENTS_LIVE=false
真实ADMIN登录点击现有询盘导航，侧栏没有未归类邮件入口
直达/admin/mail/unassigned仍404，网络记录无/mail/unassigned、assign-lookup、assign、ignore或附件请求。不新增后端、不开gate、不以mock数据宣称运营收件闭环。
2) UnassignedInbox/UnassignedNav及其mail.css专属选择器沿11节同源值替换独立色板/8/12/999px圆角/1px边界，保留现有切分类/选择/归类/忽略/撤销/过期说明回调及禁止附件入口
组件层状态断言注明组件证据，不能冒称真实API完成。
3) 在真实服务1920×1080、1440×900、390×844记录原询盘导航到受门禁拒绝页面的GIF和零请求断言
关闭组件没有渲染时D1–D6/overflow/computed style明确记gate-off/not-rendered，不能填通过。共享MailParts/MailThread可见样式复用T21实际服务密度/GIF，组件层验证各状态的2px边界/0圆角/单强调色和44px目标，不开启隐藏界面造证据。必读07/11/12、锁定minimalist-flat。（E-107）
有效范围：
.github/workflows/ci.yml
e2e/admin-legacy-unassigned-gate.spec.ts
src/app/admin/mail.css
src/components/admin/mail/UnassignedInbox.tsx
src/components/admin/mail/UnassignedNav.tsx
tests/admin-legacy-unassigned-style.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T22:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
