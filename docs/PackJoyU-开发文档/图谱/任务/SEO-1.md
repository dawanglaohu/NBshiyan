---
type: task
id: SEO-1
status: done
module: M7
origin: issue-ledger-20261024
---

# SEO-1　/about 进入 sitemap 并带 1600 图

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#425
- PR：#445
- 合并提交：`55a5a7111c81d3938b0528c5567b3b50c878f0d7`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

已由 PR #445 于 2026-10-24 合入 main。合并提交 55a5a7111c81d3938b0528c5567b3b50c878f0d7。issue #425 已关闭。

## 输入 / 产出

- **输入**：已发布语言的关于页内容与图片清单。
- **产出**：sitemap 中的关于页条目和 image 条目。
- **有效路径**：`src/app/sitemap.ts`、`src/lib/seo/sitemapEntries.ts`、`src/lib/server/site-settings.ts`、`tests/sitemap.test.ts`

## 验收标准

每个已发布语言的关于页进入 sitemap。条件和页面一致：getAboutContent(locale) 非 null 才输出；开关关闭、语言未发布或内容不完整时不输出。hreflang 只列确实发布的语言。x-default 统一用 aboutLanguages()：只发布一种语言时不输出 x-default，两种及以上并包含 en 时才指向 en。每张图一条 image，URL 用 AboutImage.src.lg，即长边文件名以 -1600.webp 结尾，不列 src.sm。图片 URL 用 SITE_URL 拼成绝对地址。保持现有 revalidate，读取失败时不输出关于页，其他条目照常。lastModified 用 AboutContent.updatedAt。单测覆盖开关关闭、只发布 en、三张图、getAboutContent 抛错。pnpm build 的路由类型表前后一致，并写进 PR 正文。tsc、lint、test、build 通过。上线后由 SEO 只读验收。不改 robots.txt，不改关于页本身，不新增依赖。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/app/sitemap.ts` — PR #445 的描述没有「回填草稿」，不编行号
- `src/lib/seo/sitemapEntries.ts` — PR #445 的描述没有「回填草稿」，不编行号
- `src/lib/server/site-settings.ts` — PR #445 的描述没有「回填草稿」，不编行号
- `tests/sitemap.test.ts` — PR #445 的描述没有「回填草稿」，不编行号
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
PR #445 的描述没有「回填草稿」。合并提交 `55a5a7111c81d3938b0528c5567b3b50c878f0d7`。代码位置不编行号。
<!-- notes:end -->
