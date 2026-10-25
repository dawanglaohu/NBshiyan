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
- GitHub：待开 issue
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

已由 PR #457 于 2026-10-25 合入 main。合并提交 926a34b7041e51ad25d9425a62b1b06e7dbdd680。本登记不重做。runReset 在读密码、连库、签发令牌之前要求 stdinIsTTY。失败码 stdin_not_tty 映射到退出码 2。入口传 process.stdin.isTTY。readStdinLine 已删除。admin-create 的行为未改。没有单独的 GitHub issue。合入后需要重新构建并部署镜像，只重启旧容器不会带上这次行为。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
_落地前回填：`路径:行号` — 作用。_
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
_落地前回填实现选择、失败教训与维护约束。_
<!-- notes:end -->
