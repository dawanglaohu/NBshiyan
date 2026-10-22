# 文档补丁 M3-T1-security-repair

任务：M3-T1
原分支：task/M3-T1
原 PR：408
依据：安全复核修正当前设备优先级和按已提交会话版本撤销；合法account路由与共用guard、相关回归夹具为必要支持路径，不改变验收标准

## 差异与复验范围

- M2-T7：上游契约变化或本次审查目标
- M2-T8：上游契约变化或本次审查目标
- M3-T1：definition、effectivePaths
- M3-T10：上游契约变化或本次审查目标
- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
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
- M4-T2：上游契约变化或本次审查目标
- M4-T3：上游契约变化或本次审查目标
- M4-T4：上游契约变化或本次审查目标
- M4-T5：上游契约变化或本次审查目标
- M4-T6：上游契约变化或本次审查目标
- M4-T7：上游契约变化或本次审查目标
- M4-T9：上游契约变化或本次审查目标
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
@@ -685,7 +685,18 @@
         "src/types/next-auth.d.ts",
         "src/app/api/admin/account/route.ts",
         "tests/admin-device-session.db.test.ts",
-        "tests/admin-device-guard.http.test.ts"
+        "tests/admin-device-guard.http.test.ts",
+        "src/lib/server/admin/account.ts",
+        "src/app/api/auth/[...nextauth]/route.ts",
+        "src/app/api/admin/account/password/route.ts",
+        "src/app/api/admin/account/2fa/reset/route.ts",
+        "src/app/api/admin/users/[id]/route.ts",
+        "src/app/api/admin/users/[id]/reset-2fa/route.ts",
+        "tests/fixtures/auth-stub.ts",
+        "tests/mail-routes.test.ts",
+        "tests/spec-form.test.ts",
+        ".github/workflows/ci.yml",
+        "e2e/admin-device-session.spec.ts"
       ],
       "outputPaths": [
         "src/auth.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T1：将真实Auth.js会话绑定当前设备与权限
沿用分支 task/M3-T1、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：40d74414c7f01fde589d3c5357ea89ccd7b5cc1851d116beca329c632b57e959
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实Credentials→src/auth.ts→设备服务
真HTTP登录创建归当前user/sv的sid，GET /api/admin/account与Auth.js session/SSR均核User存在、disabled、lockedUntil、totpEnabled、role、sv、sid归属/revokedAt/期限
旧无sid JWT、数据库不可校验均拒绝，角色只取当前库值（E-70）。2) 普通初始有效期2h，记住7d闲置且签发后30d绝对
到期等号即拒绝
普通Auth.js signOut服务端撤sid后清cookie，复制的旧cookie访问GET account返回401，跨请求不得授权缓存（E-01、E-02、E-03、E-69）。
3) GET account包含10节完整AccountDTO和当前设备期限，未开启账号passwordlessEnabled=false
专用PG核真实响应requestCount一次、受控5xx增加errorCount，计数故障不改变原业务结果。
有效范围：
.github/workflows/ci.yml
e2e/admin-device-session.spec.ts
prisma/schema.prisma
src/app/api/admin/account/
src/app/api/admin/account/2fa/reset/route.ts
src/app/api/admin/account/password/route.ts
src/app/api/admin/account/route.ts
src/app/api/admin/chat/
src/app/api/admin/cron/mail-queue/route.ts
src/app/api/admin/cron/operations/route.ts
src/app/api/admin/settings/analytics/route.ts
src/app/api/admin/stats/route.ts
src/app/api/admin/users/
src/app/api/admin/users/[id]/reset-2fa/route.ts
src/app/api/admin/users/[id]/route.ts
src/app/api/analytics/
src/app/api/auth-admin/
src/app/api/auth/
src/app/api/auth/[...nextauth]/route.ts
src/app/api/chat/
src/app/api/internal/ops-report/route.ts
src/auth.ts
src/lib/server/admin/account.ts
src/lib/server/admin/accounts.ts
src/lib/server/admin/device-repo.ts
src/lib/server/admin/device-session.ts
src/lib/server/admin/guard.ts
src/lib/server/admin/layout-gate.ts
src/lib/server/admin/login.ts
src/lib/server/admin/page-access.ts
src/lib/server/composition.ts
src/lib/server/db.ts
src/types/next-auth.d.ts
tests/admin-device-guard.http.test.ts
tests/admin-device-session.db.test.ts
tests/fixtures/auth-stub.ts
tests/mail-routes.test.ts
tests/spec-form.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T1:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
