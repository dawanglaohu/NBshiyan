---
type: task
id: MAIN-E2E-FIX
status: done
module: M5
origin: issue-ledger-20261024
---

# MAIN-E2E-FIX　修复 main 上 analytics 数据库测试的品类规则

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M5]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#475
- 合并提交：`848b0f43db72225b3994d39d2006af92e9aac893`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。放行规则仍是 3D 目录集合等于分析侧接受的 productSlug 集合。

## 输入 / 产出

- **输入**：#470 合并后，analytics 数据库测试仍用旧的品类规则。
- **产出**：测试改为只接受 categoryMeta 里已发布且 READY 的 key。
- **有效路径**：`tests/analytics-ingest.http.db.test.ts`、`tests/analytics-ingest.test.ts`、`tests/catalog-merge.test.ts`

## 验收标准

已由 PR #475 于 2026-10-25 合入 main。合并提交 848b0f43db72225b3994d39d2006af92e9aac893。本热修只改测试。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `tests/analytics-ingest.http.db.test.ts` — 不在 categoryMeta 的 READY + published key 整批 400；接受批使用 `gift-cards`；121 字符 slug 走白名单且不入库。
- `tests/analytics-ingest.test.ts` — 121 字符 slug 在调用 `publishedSlugs` 之前被拒。
- `tests/catalog-merge.test.ts` — `acceptedCatalogSlugs` 只接受 categoryKeys 里 published + READY 的库内 key。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- 放行规则仍是 3D 页集合等于分析接口接受的 productSlug 集合。本热修只改测试。
- 长度上界留在契约层。HTTP 层不再用一条不在 categoryMeta 的 120 字符库内行冒充「最长 slug 被接受」。
<!-- notes:end -->
