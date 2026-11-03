# 文档补丁 M3-T3-required-ci-bootstrap-support

任务：M3-T3
原分支：task/M3-T3
原 PR：503
依据：补列一次性新鲜本人授权验收所需 CI 执行入口、设备活动 HTTP 测试初始化及无数据库 bootstrap 回归路径；不修改任务验收、安全边界或静态返工 ID

## 差异与复验范围

- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T16：上游契约变化或本次审查目标
- M3-T17：上游契约变化或本次审查目标
- M3-T18：上游契约变化或本次审查目标
- M3-T19：上游契约变化或本次审查目标
- M3-T20：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T3：definition、effectivePaths
- M3-T4：上游契约变化或本次审查目标
- M3-T5：上游契约变化或本次审查目标
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标
- R5-T59021355：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -801,7 +801,10 @@
         "prisma/schema.prisma",
         "src/lib/server/composition.ts",
         "tests/admin-action-grant.db.test.ts",
-        "tests/admin-reauth.http.test.ts"
+        "tests/admin-reauth.http.test.ts",
+        ".github/workflows/ci.yml",
+        "tests/admin-session-activity.http.test.ts",
+        "tests/admin-session-activity-bootstrap.test.ts"
       ],
       "outputPaths": [
         "src/lib/server/admin/action-grant.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T3：签发一次性新鲜本人授权
沿用分支 task/M3-T3、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：8239d7e82e6efdac5fa2d76115a788f4af34f25d4076fc036036030e636edd24
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实POST reauth→当前设备守卫→现密码和未用TOTP→256bit单次token响应/hash入库
同时登录/另一敏感请求已消费该step时不再发grant（E-72）。2) 用测试消费者在同一数据库事务核purpose/target/user/sid/sv/expiresAt/usedAt，重复或跨用途/跨设备/5min等号/设备撤销均不消费成功
真实reauth读取当前权限，ADMIN才可为他人RECOVERY_AUTHORIZE（E-73、E-74）。3) 对仍可无密码登录但忘现密码的真实账号，仅session或TOTP请求reauth返回401且grant数不变，随后普通totp登录仍可用
受限恢复不签普通grant（E-75）。
有效范围：
.github/workflows/ci.yml
prisma/schema.prisma
src/app/api/admin/account/
src/app/api/admin/account/reauth/route.ts
src/app/api/admin/chat/
src/app/api/admin/cron/mail-queue/route.ts
src/app/api/admin/cron/operations/route.ts
src/app/api/admin/settings/analytics/route.ts
src/app/api/admin/stats/route.ts
src/app/api/admin/users/
src/app/api/analytics/
src/app/api/auth-admin/
src/app/api/auth/
src/app/api/chat/
src/app/api/internal/ops-report/route.ts
src/auth.ts
src/lib/server/admin/action-grant.ts
src/lib/server/composition.ts
src/lib/server/db.ts
tests/admin-action-grant.db.test.ts
tests/admin-reauth.http.test.ts
tests/admin-session-activity-bootstrap.test.ts
tests/admin-session-activity.http.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T3:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
