---
type: task
id: BE-RESET-STDIN-TTY
status: done
module: M3
origin: issue-ledger-20261024
---

# BE-RESET-STDIN-TTY　reset 脚本要求标准输入也是终端

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：[[BE-RESET-TTY]]
- GitHub：没有单独的 GitHub issue
- PR：#457
- 合并提交：`926a34b7041e51ad25d9425a62b1b06e7dbdd680`
- 审查：全栈审查
- 登记状态：已落地

#455 的 P3 跟进。审查留下的 firstLine 再导出见 POST-LAUNCH-P3。

## 输入 / 产出

- **输入**：PR #455 合入后，stdout 是终端而 stdin 被重定向时，reset 仍会从标准输入读密码。
- **产出**：记账。stdin 不是终端时退出 2，不读密码，不改数据，不签发令牌。
- **有效路径**：`scripts/admin-reset-initial-password.mjs`、`scripts/admin-reset-initial-password-lib.mjs`、`scripts/admin-reset-initial-password-lib.d.mts`、`tests/admin-reset-initial-password.test.ts`、`tests/admin-reset-initial-password.db.test.ts`、`tests/launch-runbook.test.ts`、`tests/reset-rate-limit-ca.test.ts`、`deploy/README.md`、`docs/launch-infra.md`、`launch-runbook.md`、`docs/API.md`

## 验收标准

已由 PR #457 于 2026-10-24 合入 main。合并提交 926a34b7041e51ad25d9425a62b1b06e7dbdd680。本登记不重做。runReset 在读密码、连库、签发令牌之前要求 stdinIsTTY。失败码 stdin_not_tty 映射到退出码 2。入口传 process.stdin.isTTY。readStdinLine 已删除。admin-create 的行为未改。没有单独的 GitHub issue。合入后需要重新构建并部署镜像，只重启旧容器不会带上这次行为。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `scripts/admin-reset-initial-password-lib.mjs:550` — runReset 在读密码之前要求 stdinIsTTY 为 true，否则返回 stdin_not_tty。
- `scripts/admin-reset-initial-password-lib.mjs:82` — stdin_not_tty 的退出码是 2。
- `scripts/admin-reset-initial-password-lib.mjs:35` — 仍再导出 firstLine。去掉它见 POST-LAUNCH-P3。
- `scripts/admin-reset-initial-password-lib.d.mts:55` — 类型上声明可选的 stdinIsTTY。
- `scripts/admin-reset-initial-password.mjs:63` — 入口传入 process.stdin.isTTY。
- `scripts/admin-reset-initial-password.mjs:44` — readPassword 再挡一次非终端 stdin。
- `tests/admin-reset-initial-password.test.ts:614` — 断言入口传的是 process.stdin.isTTY。
- `tests/admin-reset-initial-password.db.test.ts:81` — 数据库测试调用 runReset 时传入 stdinIsTTY。
- `tests/reset-rate-limit-ca.test.ts:120` — CA 测试调用 runReset 时传入 stdinIsTTY。
- `tests/launch-runbook.test.ts:51` — 文档测试要求写明 stdin 或 stdout 不是终端时退出 2。
- `deploy/README.md:185` — 写明 stdin 和 stdout 都必须是终端。
- `docs/launch-infra.md:278` — 写明 stdin 或 stdout 不是终端时退出 2。
- `launch-runbook.md:155` — 写明 stdin 或 stdout 不是终端时退出 2。
- `docs/API.md:91` — 写明 stdin 和 stdout 都必须是终端，否则退出 2、什么都不改。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- PR #457，合并提交 `926a34b7041e51ad25d9425a62b1b06e7dbdd680`。没有单独的 GitHub issue。`git show --stat` 是 11 个文件：两个脚本、`admin-reset-initial-password-lib.d.mts`、四份文档和四个测试。admin-create 不在这次合并里。
- runReset 在读密码、连库、签发令牌之前要求 stdin 是终端。失败码 stdin_not_tty 映射到退出码 2。readStdinLine 已从这支脚本删除。
- 合入日按 PT 记为 2026-10-24。该合并提交的提交者时间是 2026-10-25 09:19 +0800。
- 合入后需要重新构建并部署镜像。只重启旧容器不会带上这次行为。`firstLine` 的再导出还在，见 POST-LAUNCH-P3。
<!-- notes:end -->
