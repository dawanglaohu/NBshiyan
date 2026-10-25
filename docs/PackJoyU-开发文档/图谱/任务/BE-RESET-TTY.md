---
type: task
id: BE-RESET-TTY
status: done
module: M3
origin: issue-ledger-20261024
---

# BE-RESET-TTY　管理员重置文档改为带终端执行

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M3]]
- 前置依赖：无
- GitHub：#431
- PR：#455
- 合并提交：`e12d00e7e384316854e4e04584a57dfcf4108a53`
- 审查：全栈审查
- 登记状态：已落地

已由 PR #455 于 2026-10-25 合入 main。合并提交 e12d00e7e384316854e4e04584a57dfcf4108a53。issue #431 已关闭。stdin 也必须是终端的跟进是 BE-RESET-STDIN-TTY（PR #457）。

## 输入 / 产出

- **输入**：三份部署文档里的 admin-create 和 reset 示例。
- **产出**：示例都带交互终端，并写明没有终端时的行为。
- **有效路径**：`launch-runbook.md`、`docs/launch-infra.md`、`deploy/README.md`、`tests/launch-runbook.test.ts`

## 验收标准

只改文档和已有文档测试，不改两个 admin 脚本。deploy/README.md、launch-runbook.md、docs/launch-infra.md 里所有 admin-create 和 admin-reset-initial-password 示例都是 docker compose exec -it，或 $DC exec -it，或 run --rm -it。三份都说明：reset 没有终端时退出 2 且什么都不改，从标准输入喂密码的旧用法已失效；admin-create 没有终端时会建号，但不签发、不显示绑定链接。三份都写明绑定链接只私下发给账号本人。launch-runbook.md 有 reset 一节，或明确链到 deploy/README.md 的对应小节。文档测试仍通过。示例只用占位符，不写真实邮箱、域名、主机名或密钥。会改 deploy/README.md，走全栈审查。

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
