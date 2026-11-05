# 文档补丁 M3-T4-legacy-reset-tests

任务：M3-T4
原分支：task/M3-T4
原 PR：None
依据：M3-T4 验收标准1/E-13 否定旧无验证直重置旁路，定点适配 #347 旧行为断言测试与 UsersAdmin 最小调用，补登 supportPaths

## 差异与复验范围

- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T18：上游契约变化或本次审查目标
- M3-T19：上游契约变化或本次审查目标
- M3-T20：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T4：definition、effectivePaths
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
@@ -854,7 +854,12 @@
         "src/lib/server/admin/recovery-repo.ts",
         "src/lib/server/admin/audit.ts",
         "src/lib/server/composition.ts",
-        "tests/admin-recovery-authorizations.http.test.ts"
+        "src/components/admin/users/UsersAdmin.tsx",
+        "tests/admin-recovery-authorizations.http.test.ts",
+        "tests/admin-reset-2fa-unlock-347.test.ts",
+        "tests/admin-enroll-token-347.test.ts",
+        "tests/admin-enroll-hardening-347-348.test.ts",
+        "tests/admin-enroll-347-fe.test.ts"
       ],
       "outputPaths": [
         "src/lib/server/admin/recovery-authorizations.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T4：签发管理员目标恢复permit
沿用分支 task/M3-T4、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：5fb965004691814a5cf4a6ebe9ca9747690cbf9cb6cd4dbae120583faf33777d
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实ADMIN handler→recovery-authorizations
当前密码+新TOTP取得绑定他人的RECOVERY_AUTHORIZE grant后签15min permit，target不可自己
旧无body直接reset、仅session、访客邮件请求、SALES/EDITOR均拒绝且目标因素不变（E-13）。2) permit随机256bit、仅存hash/一次响应，授权核销/target/source/reason审计同事务，重复同grant不再签发
日志无permit明文，响应丢失不自动签第二份
普通passwordless会话不能借此省略现密码（E-73、E-75）。
有效范围：
prisma/schema.prisma
src/app/api/admin/account/
src/app/api/admin/account/recovery-authorizations/route.ts
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
src/components/admin/users/UsersAdmin.tsx
src/lib/server/admin/audit.ts
src/lib/server/admin/recovery-authorizations.ts
src/lib/server/admin/recovery-repo.ts
src/lib/server/composition.ts
src/lib/server/db.ts
tests/admin-enroll-347-fe.test.ts
tests/admin-enroll-hardening-347-348.test.ts
tests/admin-enroll-token-347.test.ts
tests/admin-recovery-authorizations.http.test.ts
tests/admin-reset-2fa-unlock-347.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T4:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
