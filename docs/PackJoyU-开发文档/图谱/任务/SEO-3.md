---
type: task
id: SEO-3
status: hold
module: M7
origin: issue-ledger-20261024
---

# SEO-3　solutions 与六个行业页去掉 noindex 并进入 sitemap

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#427
- 审查：由 PR 上 bot 审查替代
- 登记状态：暂不派

暂不派。等文案和图片定稿。

## 输入 / 产出

- **输入**：已定稿的 solutions 文案和图片。
- **产出**：可索引的 solutions 列表页和六个行业页，以及对应 sitemap 条目。
- **有效路径**：`src/lib/seo/sitemapEntries.ts`、`src/lib/seo/indexnow.ts`、`tests/solutions-industry.test.ts`

## 验收标准

等文案和图片定稿后再派。一个 PR 做完，不拆开。去掉 solutions 列表和六个行业页的 noindex，把它们加入 sitemap，并让 indexnow 的 solution 条目可以随发布状态走。单测：sitemap 正好多出每个语言 1 个列表页加 6 个详情页；未知 slug 不出现；factory 和 cases 仍是 noindex 且不在 sitemap。各页 canonical 和 hreflang 不变。tsc、lint、test、build 通过。

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
