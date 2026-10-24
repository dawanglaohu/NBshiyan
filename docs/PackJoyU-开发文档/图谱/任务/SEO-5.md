---
type: task
id: SEO-5
status: todo
module: M7
origin: issue-ledger-20261024
---

# SEO-5　404 页只留一个 robots meta

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#429
- 审查：由 PR 上 bot 审查替代
- 登记状态：待派

## 输入 / 产出

- **输入**：本地化 404 页现有的 robots metadata。
- **产出**：404 响应里恰好一个 robots meta。
- **有效路径**：`src/app/[locale]/not-found.tsx`

## 验收标准

404 页只输出一个 robots meta，内容是 noindex, follow。如果去不掉 Next 自动加的那个，就保留它、去掉页面自己的，并在 PR 正文说明。e2e 或单测断言恰好 1 个 meta name=robots，状态码仍是 404，标题不变。

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
