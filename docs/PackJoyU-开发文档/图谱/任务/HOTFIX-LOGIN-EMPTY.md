---
type: task
id: HOTFIX-LOGIN-EMPTY
status: done
module: M3
origin: issue-ledger-20261024
---

# HOTFIX-LOGIN-EMPTY　默认登录页空框不再挡住登录

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#486
- 合并提交：`e8d7f7afd569ba16d07bf3b043eeb77add8b67d0`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。PR 回填草稿没有行号。自定义登录页不在这次范围内。

## 输入 / 产出

- **输入**：默认登录页没有填写的可选框。
- **产出**：空白的 mode、rememberDevice、recoveryCode、totp 不再让严格契约失败。空邮箱和未知字段仍拒绝。
- **有效路径**：`src/auth.ts`、`tests/hotfix-login-empty.test.ts`、`e2e/hotfix-login-empty.spec.ts`

## 验收标准

已由 PR #486 于 2026-10-26 合入 main。合并提交 e8d7f7afd569ba16d07bf3b043eeb77add8b67d0。默认登录页只填 email、password、totp 时可以通过契约。空邮箱和未知字段仍拒绝。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/auth.ts:22` — 空白可选字段是 mode、rememberDevice、recoveryCode、totp
- `src/auth.ts:35` — `parseLogin` 只删除这四个字段的空值
- `tests/hotfix-login-empty.test.ts:27` — 只填 email、password、totp 时按 password 模式通过
- `tests/hotfix-login-empty.test.ts:91` — 空白邮箱仍被契约拒绝
- `tests/hotfix-login-empty.test.ts:101` — 未知字段仍被严格契约拒绝
- `e2e/hotfix-login-empty.spec.ts:9` — 默认登录页只填 email、password、totp
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
默认登录页没填的可选框会提交成空字符串。`parseLogin` 删掉空白的 mode、rememberDevice、recoveryCode 和 totp，再交给严格契约。空邮箱和未知字段仍拒绝。自定义登录页不在这次范围内。
<!-- notes:end -->
