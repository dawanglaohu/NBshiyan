---
type: task
id: GATE-HARDEN-2
status: todo
module: M7
origin: issue-ledger-20261024
---

# GATE-HARDEN-2　gate 合入后的路径清单后续

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：[[GATE-HARDEN]]
- GitHub：待开 issue
- 审查：全栈审查
- 登记状态：待派

## 输入 / 产出

- **输入**：已合入 main 的 GATE-HARDEN。
- **产出**：只改 gate workflow、敏感路径清单和对应测试。
- **有效路径**：`.github/workflows/security-review.yml`、`.github/workflows/security-review-replay.yml`、`.github/workflows/security-review-rerun.yml`

## 验收标准

#438 合入之后才派。只登记，不在本次文档更新里实施。只改 gate workflow、路径清单和测试，不改产品源码。走全栈审查。GitHub 上还没有单独 issue，编号写待开 issue，本登记不新开 issue。

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
