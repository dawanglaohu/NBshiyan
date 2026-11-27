# 文档补丁 m4-t9-composer-e2e-sync

任务：M4-T9
原分支：task/M4-T9
原 PR：575
依据：GitHub CI A3 主段 260/261 通过，仅 e2e/chat-visitor-composer.spec.ts:195 因 M4-T9 后台 3s 轮询与手动点击刷新重叠触发 Chromium CDP Network.getResponseBody 缓冲区回收而失败；按 Jev 裁决（jev-1.14.0 pick=A high 0.94）纳入该支持路径并用 route.fetch 在 Node 侧捕获真实同步载荷。

## 差异与复验范围

- M2-T8：上游契约变化或本次审查目标
- M4-T13：上游契约变化或本次审查目标
- M4-T14：上游契约变化或本次审查目标
- M4-T6：上游契约变化或本次审查目标
- M4-T9：definition、effectivePaths
- M7-T1：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T4：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -2129,6 +2129,7 @@
         "messages/ru.json",
         "e2e/chat-polling-network.spec.ts",
         "e2e/chat-start-analytics.spec.ts",
+        "e2e/chat-visitor-composer.spec.ts",
         ".github/workflows/ci.yml",
         "tests/chat-polling-retry.test.ts",
         "tests/stats-route.test.ts"
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M4-T9：集成聊天轮询、断网重试与失权停止
沿用分支 task/M4-T9、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：baf92ef761f4e88beebe1292ced924c7929202402a68ef9711f27c803244de77
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 入口：/contact联系人工→chat窗口
数据源GET /api/chat/conversations/[id]、POST messages/read
可见正常3s、hidden零轮询、恢复即补页，单在途，慢网失败退避1/2/4/8/16/30s
乱序/跨页插入每ID恰一次、seq不退、read仅实际可见最大完整seq（E-76、E-77）。2) 实际服务成功存消息后截断响应，UI待确认保留原UUID/body/email，点chat-retry重发原payload返回原receipt
运营实际GET只有一消息/出箱一条
未落库断网草稿仅标签页内存、刷新不承诺恢复（E-18、E-37、E-38）。3) cookie过期/撤销及运营角色撤权后下一poll和send均服务器拒绝且无正文/无写
改threadId/seq/email不能越权，UI停止定时器和旧发送、保留当前草稿并显示明确新咨询，不自动换UUID或跨线程重发（E-78、E-85）。 按11节唯一minimalist-flat，在实际服务1920×1080、1440×900、390×844记录GIF与computed style：2px黑边、0圆角、无阴影、强调色#b45700
后台逐页以work/form/card、density7/gutter16/gap16/pad16运行D1–D6和overflow探针。label与键盘焦点可达，触屏控件点击框至少44px。
有效范围：
.github/workflows/ci.yml
e2e/chat-polling-network.spec.ts
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
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/i18n/navigation.ts
src/i18n/routing.ts
src/lib/client/chat-poller.ts
src/lib/client/chat-retry.ts
src/lib/client/chat.ts
src/lib/navigation/routes.ts
tests/chat-polling-retry.test.ts
tests/stats-route.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M4-T9:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
