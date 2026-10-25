---
type: task
id: SEO-2
status: done
module: M7
origin: issue-ledger-20261024
---

# SEO-2　静态 /og jpg 的缓存头

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#426
- PR：#450
- 合并提交：`6161329671e6e03e47f387643c3772633e2ce673`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

已由 PR #450 于 2026-10-24 合入 main。合并提交 6161329671e6e03e47f387643c3772633e2ce673。issue #426 已关闭。

## 输入 / 产出

- **输入**：public/og 下的静态 jpg。
- **产出**：headers() 里只作用于这些静态 jpg 的 Cache-Control。
- **有效路径**：`next.config.ts`

## 验收标准

在 next.config.ts 的 headers() 给静态 /og jpg 设置 Cache-Control 为 public, max-age=86400, stale-while-revalidate=604800。不加 immutable，不加 s-maxage。只作用于 public/og 下的静态 jpg。动态的文章 og 和关于页 og 保持原样，匹配规则写清楚。换图后的清缓存写进 PR 的部署说明，由运维按 URL 处理。单测或 e2e 断言 /og/home-en.jpg 的头等于这一串，文章 og 的头保持原样。tsc、lint、test、build 通过。上线后 SEO 用只读响应头验收。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `next.config.ts:31` — 静态 jpg 的匹配是 `/og/:file*.jpg`。
- `next.config.ts:32` — Cache-Control 为 `public, max-age=86400, stale-while-revalidate=604800`。
- `next.config.ts:46` — headers() 把这条头加到上述匹配。
- `tests/og-static-cache.test.ts:58` — 断言这串头，并且不含 immutable 和 s-maxage。
- `tests/og-static-cache.test.ts:62` — `/og/home-en.jpg` 命中。文章 og 和关于页 og 不走这条规则。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- PR #450，合并提交 `6161329671e6e03e47f387643c3772633e2ce673`。`git show --stat` 只有 `next.config.ts` 和 `tests/og-static-cache.test.ts`。
- 文件名没有内容哈希，所以不加 immutable，也不加 s-maxage。浏览器缓存 1 天，过期后 7 天内可以先用旧图。
- 匹配只覆盖 `/og/` 下以 `.jpg` 结尾的路径。`/[locale]/articles/[slug]/og` 和 `/[locale]/about/og` 仍由各自 route 写头。
- 静态 `/og` 未命中时仍会被这条 1 天头盖住。404 改为 no-store 的验收见 POST-LAUNCH-P3。
<!-- notes:end -->
