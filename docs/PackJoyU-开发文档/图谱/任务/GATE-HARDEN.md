---
type: task
id: GATE-HARDEN
status: merging
module: M7
origin: issue-ledger-20261024
---

# GATE-HARDEN　安全审查 gate 防止 workflow 绕过

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#438
- PR：#438
- 审查：全栈审查
- 登记状态：待合入

待合入。后续范围见 GATE-HARDEN-2。

## 输入 / 产出

- **输入**：打开中的 PR #438。
- **产出**：合入 main 后的 pull_request_target gate、replay 和 rerun。
- **有效路径**：`.github/workflows/security-review.yml`、`.github/workflows/security-review-replay.yml`、`.github/workflows/security-review-rerun.yml`

## 验收标准

PR #438 仍开着，等仓库管理员合入。当前 head 是 de79bfdca6002fc54fd89dc1ce120324526f1fcc。本登记不实施、不合并。gate 与 rerun 不 checkout、不安装依赖、不构建、不执行 PR head 里的代码。新增路径规则覆盖 src/app/admin、src/app/media、src/components/admin、src/components/seo/JsonLd.tsx、src/lib/site-settings。需要全栈审查者批准后，再由有旁路权限的管理员合并。合入前默认分支上还不会出现这份 gate 检查。

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
