# 文档补丁 m3-t5-ci-support-path

任务：M3-T5
原分支：task/M3-T5
原 PR：None
依据：M3-T5 实施前置：把 .github/workflows/ci.yml 列入 supportPaths（公共 CI 支持路径）。本补丁只补有效范围，不改 CI 内容，不预置尚不存在的新测试。

## 差异与复验范围

- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T20：上游契约变化或本次审查目标
- M3-T25：上游契约变化或本次审查目标
- M3-T5：definition、effectivePaths
- M3-T8：上游契约变化或本次审查目标
- M3-T9：上游契约变化或本次审查目标
- M7-T10：上游契约变化或本次审查目标
- M7-T2：上游契约变化或本次审查目标
- M7-T5：上游契约变化或本次审查目标
- M7-T6：上游契约变化或本次审查目标
- M7-T8：上游契约变化或本次审查目标
- M7-T9：上游契约变化或本次审查目标

### _run/task-contracts.json

````diff
--- before/_run/task-contracts.json
+++ after/_run/task-contracts.json
@@ -912,7 +912,8 @@
         "src/lib/server/admin/audit.ts",
         "src/lib/server/composition.ts",
         "tests/admin-recovery-confirm.db.test.ts",
-        "tests/admin-recovery-reentry.http.test.ts"
+        "tests/admin-recovery-reentry.http.test.ts",
+        ".github/workflows/ci.yml"
       ],
       "outputPaths": [
         "src/lib/server/admin/recovery-enrollment.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T5：接通受限重入绑定与最终一次确认
沿用分支 task/M3-T5、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：7d62e9ddcd24229afd0cd95f7e276e499464c516940077fd69d884e4351e62de
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实受限handler→recovery-enrollment服务
首次加密pendingSecret，原窗口重入返回同URI/原expiresAt，不旋转/续时
错误/过期/重复confirm及两次并发confirm均核当前token/sv/secret/step，最多一次提交，失败前旧有效方式可用（E-08、E-14）。2) 真实confirm新未用TOTP后在同一事务发布secret和新恢复码hash、递增sv/撤旧设备/旧恢复凭据、消费session并清cookie，恢复码只返一次
SERVER_OWNER预授权hash才同步改密，HTTP只收totp
结果未知不重放，下一时间步真实普通登录核实，旧因素/旧设备拒绝（E-15）。
3) 新增断言复用T19已签发受限cookie的前置，不重做签发流程：POST /api/auth-admin/recovery/enroll body={}返回200，JSON的otpauthUri为非空字符串、expiresAt为UTC时间
同cookie再次POST {}仍200且两字段逐字相等、数据库pending密文及pendingUntil不变。在原expiresAt等号发enroll得到401/error=recovery_expired，不改旧secret/password。错totp的confirm返回401且无completed=true或recoveryCodes
5次错码后同受限凭据不再200。有效新totp的confirm返回200、completed=true、recoveryCodes为非空字符串数组，Set-Cookie将同一受限cookie清除，数据库completedAt非空且sv只因该次最终确认增加1。把成功前保存的同cookie复制到两个并发confirm请求，恰好一个200
另一个401且无recoveryCodes，再重复仍401、sv及恢复码hash不再变化。成功后GET /api/admin/account使用旧设备cookie为401
等待下一未用时间步用新验证器走Credentials可取得后台cookie，旧验证器码不取得会话。confirm body加password/newPassword/passwordHash任一字段为400/error=invalid
只有SERVER_OWNER预授权hash的既有测试账号在成功后用其预授权新密码登录，其他来源密码hash前后相等。
有效范围：
.github/workflows/ci.yml
src/app/api/admin/account/
src/app/api/admin/chat/
src/app/api/admin/cron/mail-queue/route.ts
src/app/api/admin/cron/operations/route.ts
src/app/api/admin/settings/analytics/route.ts
src/app/api/admin/stats/route.ts
src/app/api/admin/users/
src/app/api/analytics/
src/app/api/auth-admin/
src/app/api/auth-admin/recovery/confirm/route.ts
src/app/api/auth-admin/recovery/enroll/route.ts
src/app/api/auth/
src/app/api/chat/
src/app/api/internal/ops-report/route.ts
src/auth.ts
src/lib/server/admin/audit.ts
src/lib/server/admin/recovery-enrollment.ts
src/lib/server/admin/recovery-repo.ts
src/lib/server/composition.ts
src/lib/server/db.ts
tests/admin-recovery-confirm.db.test.ts
tests/admin-recovery-reentry.http.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T5:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
