---
type: task
id: GIFT-CARDS-RENAME
status: done
module: M7
origin: issue-ledger-20261024
---

# GIFT-CARDS-RENAME　礼品卡品类 slug 与 SEO 元数据改为贺卡

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#465
- 合并提交：`7ceff069b4c381c55b7e01fe428fea90d34de865`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。PR 回填草稿写的是「无」。

## 输入 / 产出

- **输入**：礼品卡品类现有的 slug、SEO 元数据和俄文显示名。
- **产出**：对外名称改为贺卡，slug 与元数据一起改。
- **有效路径**：`design/og-src/render-og-categories.mjs`、`messages/ru.json`、`src/data/og-versions.json`、`src/data/products.ts`、`src/lib/seo/categoryMeta.ts`、`tests/gift-cards-seo.test.ts`

## 验收标准

已由 PR #465 于 2026-10-25 合入 main。合并提交 7ceff069b4c381c55b7e01fe428fea90d34de865。礼品卡品类 slug 与 SEO 元数据改为贺卡。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/seo/categoryMeta.ts` — PR #465 回填草稿为「无」，这里不编行号
- `src/data/products.ts` — 礼品卡 slug 与 SEO 元数据改为贺卡
- `tests/gift-cards-seo.test.ts` — 覆盖这次改名
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
PR #465 的回填草稿只有「无」。合并提交 7ceff069b4c381c55b7e01fe428fea90d34de865。
<!-- notes:end -->
