# 文档补丁 M3-T21-MODEL-RUN-AUTH-20261106

任务：M3-T21
原分支：task/M3-T21
原 PR：532
依据：将已裁七槽真实Auth.js池的模型ADMIN和EDITOR消费者登记到M3-T21必要支持范围，不改T23验收或GUI

## 差异与复验范围

- M3-T21：definition、effectivePaths
- M3-T22：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -3631,7 +3631,8 @@
         "e2e/admin-org-settings.spec.ts",
         "e2e/admin-shell-activity.spec.ts",
         "e2e/brand-smoke.spec.ts",
-        "tests/e2e-run-auth.test.ts"
+        "tests/e2e-run-auth.test.ts",
+        "e2e/admin-legacy-model-visual.spec.ts"
       ],
       "stage": "integration",
       "wiring": [],
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T21：迁移原询盘列表、详情与往来邮件视觉
沿用分支 task/M3-T21、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：8038bb4adf7a5413bdebe72d07ef30d90e61227e7723702fc01522d2e3d24ece
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 真实ADMIN/SALES登录后点后台“询盘”→/admin/inquiries，搜索/日期/状态/负责人/分页均发送既有GET /api/admin/inquiries及GET /api/admin/users
点击真实行编号进入/admin/inquiries/[id]，GET对应详情/history保持原scope，返回列表与筛选仍有效。真实POST /api/inquiries先建合成询盘，不用数据库插入冒充业务链。
2) 详情保留状态PATCH、负责人分配、POST notes、既有回复路径及匿名化只读限制
在隔离PG/SMTP中从可见控件核原method/body和持久结果，SALES不能读取他人询盘。既有邮件开启且后端mail/config允许时MailThread沿GET/POST /api/admin/inquiries/[id]/mail、status/retry显示真实状态
关闭时不发信且原回退可见，不改变gate。
3) 把InquiryDetail的内联conic-gradient、anonymized.tsx的4/999px圆角/1px边界及InquiryHistory/StatusBadge/DateRange/InquiryNotFound的旧视觉改为11节同源组件/样式。已匿名化正文/邮箱不重新显示、状态/历史/结果文字不因去色或删环图而消失
保留数值与标签。必读07/11/12，消费唯一minimalist-flat和M1视觉组件，不重搜或改slug。实际服务真实登录，在1920×1080、1440×900、390×844记录真实操作GIF、computed style（2px黑边、0圆角、无阴影/渐变、强调色#b45700）、D1–D6/overflow
density7/gutter16/gap16/pad16，work铺满/form左对齐，44px触屏目标，loading/empty/error/success/disabled/focus逐态可判。权限和业务动作、旧API/邮件gate均保持。（E-106）
有效范围：
.github/workflows/ci.yml
e2e/admin-about-images.spec.ts
e2e/admin-legacy-inquiries-visual.spec.ts
e2e/admin-legacy-model-visual.spec.ts
e2e/admin-org-settings.spec.ts
e2e/admin-shell-activity.spec.ts
e2e/brand-smoke.spec.ts
e2e/global-setup.ts
e2e/run-auth.ts
e2e/shared-admin.ts
src/app/admin/admin.css
src/app/admin/mail.css
src/components/admin/DateRange.tsx
src/components/admin/InquiryDetail.tsx
src/components/admin/InquiryHistory.tsx
src/components/admin/InquiryList.tsx
src/components/admin/InquiryNotFound.tsx
src/components/admin/StatusBadge.tsx
src/components/admin/anonymized.tsx
src/components/admin/mail/MailParts.tsx
src/components/admin/mail/MailThread.tsx
tests/admin-anonymized-ui.test.ts
tests/admin-legacy-inquiries-style.test.ts
tests/e2e-run-auth.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T21:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
