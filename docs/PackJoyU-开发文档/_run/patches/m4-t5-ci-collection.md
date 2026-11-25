# 文档补丁 m4-t5-ci-collection

任务：M4-T5
原分支：task/M4-T5
原 PR：571
依据：PR #571 的 CI 实收 250/main 219；M4-T5 新增两份 E2E，必须允许在现有 A3 分区（含实跑计数）接入，保留逐例、互斥和完备断言。

## 差异与复验范围

- M2-T8：上游契约变化或本次审查目标
- M4-T13：上游契约变化或本次审查目标
- M4-T14：上游契约变化或本次审查目标
- M4-T5：definition、effectivePaths
- M4-T6：上游契约变化或本次审查目标
- M4-T9：上游契约变化或本次审查目标
- M7-T1：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -1926,6 +1926,7 @@
         "eventKinds"
       ],
       "supportPaths": [
+        ".github/workflows/ci.yml",
         "src/components/inquiry/InquiryWizard.tsx",
         "src/lib/navigation/routes.ts",
         "messages/en.json",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T5：接通访客聊天打开与消息编辑器
沿用分支 task/M4-T5、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：5ecfdc39582cf909209fdf624b8c386011c082939f523ecee6b3f86f231d696b
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 入口：主页Request a quote→/[locale]/contact→Contact a person（contact-human-chat）
点开才POST /api/chat/session
Send message（chat-send）调用POST /api/chat/conversations或对应messages，数据源还含GET /api/chat/conversations/[id]
实际点击断言id/seq/receivedAt，成功前不显示received（E-31）。2) 服务可达但无人值守显示Offline message，无在线灯，保存成功文案Received, awaiting human handling且无即时答复承诺
email空/省略可发、非法/超长错误保留消息，关闭未发送草稿不持久化（E-17、E-36、E-38、E-39）。3) 首次cookie401/404或关闭线程时停止旧提交并显示Start a new conversation按钮，不自动把旧草稿发新会话
拒分析照常咨询且网络无第三方脚本（E-40、E-85）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700
后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。
4) 当前导航首次新咨询收件成功且当时有效同意后，POST /api/analytics/events发kind=chat_start、原navigationId、随机eventId/occurredAt及可选已发布productSlug/净化path
同次成功回调/响应重试复用eventId且只计一次。回复、失败、仅开窗口、拒绝/撤回及后补同意不补发历史
事件不含email/body/会话或消息ID/cookie凭据。真实聊天→事件→聚合chatStarts有端到端断言，必要聊天不依赖分析同意（E-40、E-47）。
有效范围：
.github/workflows/ci.yml
e2e/chat-start-analytics.spec.ts
e2e/chat-visitor-composer.spec.ts
messages/en.json
messages/ru.json
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
src/components/chat/ChatContainer.tsx
src/components/chat/Composer.tsx
src/components/chat/ContactChatEntry.tsx
src/components/chat/MessageList.tsx
src/components/inquiry/InquiryWizard.tsx
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/client/chat.ts
src/lib/contracts/analytics.ts
src/lib/contracts/chat.ts
src/lib/navigation/routes.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T5:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
