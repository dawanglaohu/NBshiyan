---
type: task
id: SEO-7
status: done
module: M7
origin: issue-ledger-20261024
---

# SEO-7　/about 的 sitemap 与页面统一规则

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#446
- PR：#445
- 合并提交：`55a5a7111c81d3938b0528c5567b3b50c878f0d7`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

已随 PR #445 于 2026-10-24 合入 main。合并提交 55a5a7111c81d3938b0528c5567b3b50c878f0d7。issue #446 已关闭。没有单独的实施 PR。

## 输入 / 产出

- **输入**：#445 里关于页进 sitemap 的实现，以及页面已有的 load()、visibleImages()、aboutLanguages()。
- **产出**：sitemap 与关于页共用同一套可见性、图片和 x-default 规则。
- **有效路径**：`src/app/[locale]/about/page.tsx`、`src/app/sitemap.ts`、`src/lib/seo/about.ts`、`src/lib/about/model.ts`、`tests/about-seo.test.ts`

## 验收标准

把关于页的 load()（isPublishedLocale、isAboutVisible、getAboutContent）抽成共用函数，页面和 sitemap 都调用它。sitemap 的关于页图片先用和页面同一个 visibleImages() 过滤，去掉缺 alt、尺寸不合规的图，按 imagesMax 截断，再取 src.lg（-1600）。x-default 调用 aboutLanguages()：只发布一种语言时不输出 x-default；两种及以上并且包含 en 时，x-default 指向 en。页面沿用这套口径。单测：没填 alt 的图和超出 imagesMax 的图都不在 sitemap 的 images 里。只发布 en 时 alternates 只有 en，没有 x-default；发布 en 和 ru 时有 x-default，指向 /en/about。开关关闭时 sitemap 里没有 /about。sitemap 仍然是静态页，缓存 1 小时。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/app/[locale]/about/page.tsx` — PR #445 的描述没有「回填草稿」，不编行号
- `src/app/sitemap.ts` — PR #445 的描述没有「回填草稿」，不编行号
- `src/lib/seo/about.ts` — PR #445 的描述没有「回填草稿」，不编行号
- `src/lib/about/model.ts` — PR #445 的描述没有「回填草稿」，不编行号
- `tests/about-seo.test.ts` — PR #445 的描述没有「回填草稿」，不编行号
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
PR #445 的描述没有「回填草稿」。合并提交 `55a5a7111c81d3938b0528c5567b3b50c878f0d7`。代码位置不编行号。
<!-- notes:end -->
