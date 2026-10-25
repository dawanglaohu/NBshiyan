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
_落地前回填：`路径:行号` — 作用。_
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
_落地前回填实现选择、失败教训与维护约束。_
<!-- notes:end -->
