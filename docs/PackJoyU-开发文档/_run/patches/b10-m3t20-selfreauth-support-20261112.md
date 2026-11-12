# 文档补丁 b10-m3t20-selfreauth-support-20261112

任务：M3-T20
原分支：task/M3-T20
原 PR：558
依据：SELF_REAUTH enroll/confirm recovery endpoints need declared support paths for M3-T20 repair

## 差异与复验范围

- M3-T11：上游契约变化或本次审查目标
- M3-T12：上游契约变化或本次审查目标
- M3-T13：上游契约变化或本次审查目标
- M3-T20：definition、effectivePaths
- M3-T25：上游契约变化或本次审查目标
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
@@ -1659,7 +1659,10 @@
       "supportPaths": [
         "src/lib/server/admin/recovery-repo.ts",
         "src/lib/server/composition.ts",
-        "tests/admin-self-rebind.http.test.ts"
+        "tests/admin-self-rebind.http.test.ts",
+        "src/lib/server/admin/recovery-enrollment.ts",
+        "tests/admin-enroll-hardening-347-348.test.ts",
+        "tests/admin-enroll-token-347.test.ts"
       ],
       "outputPaths": [
         "src/app/api/admin/account/2fa/reset/route.ts",
````

新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。

## 原任务续做

# 继续原任务 M3-T20：将本人换验证器接入受限重绑
沿用分支 task/M3-T20、现有工作树和原 PR；不要创建新任务或重新初始化分支。
任务契约版本：785e543d1cad6c285d0234b8f697bf7c60cdafe62c9483093354b35a174d47f7
读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。
修正后的验收：
1) 调用方/接线点：真实2fa/reset→当前设备+TOTP_RESET grant事务消费→SELF_REAUTH受限cookie及enrollLink
兼容currentPassword+totp同强度且recoveryCode拒绝，原因素在最终confirm前不清除，受限cookie后台请求401（E-14）。2) 未提供现密码且仅无密码session/TOTP时签grant或直接reset均拒绝且绑定不变
取得合法本人grant后受限enroll/confirm完成新绑定并留审计，忘密仅能另走OS-owner预授权，不经HTTP自设密码（E-75）。
有效范围：
src/app/api/admin/account/
src/app/api/admin/account/2fa/reset/route.ts
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
src/lib/server/admin/recovery-enrollment.ts
src/lib/server/admin/recovery-repo.ts
src/lib/server/admin/self-rebind.ts
src/lib/server/composition.ts
src/lib/server/db.ts
tests/admin-enroll-hardening-347-348.test.ts
tests/admin-enroll-token-347.test.ts
tests/admin-self-rebind.http.test.ts
保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。
## 自行裁决：交 Jev，不交用户
实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。
把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。
运行 python "docs/PackJoyU-开发文档/_run/typesafe_ask.py" --log "docs/PackJoyU-开发文档/_run/judgments.jsonl" --label "M3-T20:resume" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。
仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。
adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。
回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。
