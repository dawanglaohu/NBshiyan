---
type: task
id: CATALOG-MERGE
status: done
module: M2
origin: issue-ledger-20261024
---

# CATALOG-MERGE　按品类合并 3D 目录

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M2]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#470
- 合并提交：`4d0c18288b499dfbf090432a11bc7e3516eff4fa`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。否掉了 category 不合法就退回 productSlug，也否掉了按绝对存储域名放行。

## 输入 / 产出

- **输入**：3D 目录和品类元数据是两套列表。
- **产出**：按品类合并成一套卡片，分析白名单与可见 key 对齐。
- **有效路径**：`src/app/[locale]/products/page.tsx`、`src/lib/catalog/catalog.ts`、`src/lib/contracts/analytics.ts`、`src/lib/server/analytics/event-repo.ts`、`src/lib/server/analytics/ingest.ts`、`tests/catalog-merge.test.ts`、`tests/catalog.test.ts`

## 验收标准

已由 PR #470 于 2026-10-25 合入 main。合并提交 4d0c18288b499dfbf090432a11bc7e3516eff4fa。按品类合并 3D 目录。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/catalog/catalog.ts:37` — `isListedCatalogKey`。3D 页和分析白名单共用。否掉了「category 不合法就退回 productSlug」，两边会对不齐。
- `src/lib/catalog/catalog.ts:56` — `catalogAssetUrl`。只留站内路径。否掉了按绝对存储域名放行：仓库里的公开地址已经是 `/api/models/` 和 `/media/`。
- `src/lib/catalog/catalog.ts:82` — `catalogPosterAlt`。库海报退回 `Products.alt`，en/ru 都带品类名。否掉了留空 alt，也否掉了把旧海报的专用 alt 套到新图上。
- `src/lib/catalog/catalog.ts:110` — `decorateCatalogProducts`。页面和测试共用文案与 alt。
- `src/lib/catalog/catalog.ts:133` — `catalogItemList`。ItemList 只收合并后的卡片，链接是页面锚点，不给未知 key 生成 `/products/<slug>`。
- `src/lib/catalog/catalog.ts:144` — `withPublishedReady`。不把上架状态写进公开 JSON。
- `src/lib/catalog/catalog.ts:157` — `cardFrom`。同 key 沿用动效和落地页；没有 fallback 且 URL 不合格则整卡丢掉。
- `src/lib/catalog/catalog.ts:188` — `mergeCatalog`。原位替换，categoryMeta 额外 key 接在最后。
- `src/lib/catalog/catalog.ts:220` — `loadCatalog`。有合并结果就返回合并列表；没有才回退整表。读失败只打错误名。
- `src/lib/catalog/catalog.ts:236` — `acceptedCatalogSlugs`。和可见 key 对齐的判定，测试用来锁集合相等。
- `src/app/[locale]/products/page.tsx:28` — 3D 页改走合并和装饰，不再自己拼 alt。
- `src/lib/server/analytics/event-repo.ts:41` — `publishedSlugs` 按 `category` + published + READY + `isListedCatalogKey` 查询。
- `src/lib/server/analytics/ingest.ts:111` — 注释与新白名单一致。行为仍是内部 key 先放行，其余交给 `publishedSlugs`。
- `src/lib/contracts/analytics.ts:26` — 契约注释改为接受 categoryMeta 里的已发布 category。
- `tests/catalog-merge.test.ts` — 规格 1–9。`tests/catalog.test.ts` — 旧夹具补上 published/READY，未知 category 改为断言整表仍在。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
坑：node 测试渲染带 JSX 的客户端组件时，tsx 按经典 JSX 编译，要先把 `React` 挂到 `globalThis`。`QuoteProvider` 在没有 next-intl 运行环境时会打 `ENVIRONMENT_FALLBACK`，渲染结果仍然可用，没有为消掉这行日志去改询价组件。
<!-- notes:end -->
