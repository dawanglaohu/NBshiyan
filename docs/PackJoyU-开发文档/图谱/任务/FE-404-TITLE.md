---
type: task
id: FE-404-TITLE
status: todo
module: M7
origin: issue-ledger-20261024
---

# FE-404-TITLE　404 页标题进 head

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：待开 issue
- 审查：由 PR 上 bot 审查替代
- 登记状态：待派

P3。待派，本次不实施。来源是前端、SEO、UX。UX 只复核 (b) 渲染后 document.title。

## 输入 / 产出

- **输入**：404 页的标题已经出现在原始 HTML 里。线上若只验「原始 HTML 里有 404 标题」，这条已经通过。
- **产出**：404 标题出现在原始 HTML 的 head 结束之前，并且 Chrome 渲染后 document.title 是这个标题。
- **有效路径**：`src/app/[locale]/not-found.tsx`、`src/app/[locale]/locale-unavailable/not-found.tsx`、`tests/not-found-meta.test.ts`、`e2e/not-found-robots.spec.ts`、`e2e/seo.spec.ts`

## 验收标准

未派发。P3。GitHub 上还没有对应 issue，编号写待开 issue，本登记不新开 issue。本次文档更新不实施。实施需前端、SEO、UX 审。UX 只复核 (b) 渲染后 document.title 这一条，用户在标签页、历史和书签里看到的就是它。不得把 Googlebot 加进 htmlLimitedBots。那一项影响全站，另议。本任务的有效路径不含 next.config.ts。验收必须同时满足两条，只过一条不算通过。（a）原始 HTML 里 404 标题出现在 </head> 之前，用 Chrome UA 和 Googlebot UA 各测一次的原始 HTML 断言。（b）渲染后 document.title 是 404 标题。（a）和（b）都必须各自覆盖两类 404：一类是普通未知路径，例如 /en/xxx，现在渲染后会变成首页标题，正是要修的问题；一类是未上线语言 /de，现在是对的。两类都测才能防止回退，只测 /de 等于没验。不能只验「原始 HTML 里有 404 标题」。线上已经满足，等于没验收。这些断言加在 e2e/not-found-robots.spec.ts。（a）的 </head> 前位置断言和（b）的 toHaveTitle 断言都写在这个文件。404 原始 HTML 标题断言现在就在这里。不只列 e2e/seo.spec.ts。不改其他路由的 metadata 输出。与 SEO-5 同改 src/app/[locale]/not-found.tsx。SEO-5 已由 PR #456 合入 main，合并提交 466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd。实施时基于已包含这次合并的 main。

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
