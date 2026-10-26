---
type: task
id: FE-404-TITLE
status: done
module: M7
origin: issue-ledger-20261024
---

# FE-404-TITLE　404 页标题进 head

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：待开 issue
- PR：#461
- 合并提交：`cc63de7cc401987a636f3aa8abf954c1aa02459a`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

已由 PR #461 于 2026-10-25 合入 main。合并提交 cc63de7cc401987a636f3aa8abf954c1aa02459a。没有单独的 GitHub issue。来源是前端、SEO、UX。UX 只复核 (b) 渲染后 document.title。注册点是 handoff.wiring frontendRoutes 的 src/app/。

## 输入 / 产出

- **输入**：404 页的标题已经出现在原始 HTML 里。线上若只验「原始 HTML 里有 404 标题」，这条已经通过。
- **产出**：404 标题出现在原始 HTML 的 head 结束之前，并且 Chrome 渲染后 document.title 是这个标题。
- **有效路径**：`src/app/`、`src/app/[locale]/not-found.tsx`、`src/app/[locale]/locale-unavailable/not-found.tsx`、`src/components/NotFoundTitle.tsx`、`tests/not-found-meta.test.ts`、`e2e/not-found-robots.spec.ts`、`e2e/seo.spec.ts`

## 验收标准

已由 PR #461 于 2026-10-25 合入 main。合并提交 cc63de7cc401987a636f3aa8abf954c1aa02459a。GitHub 上没有单独 issue。实施需前端、SEO、UX 审。UX 只复核 (b) 渲染后 document.title 这一条，用户在标签页、历史和书签里看到的就是它。不得把 Googlebot 加进 htmlLimitedBots。那一项影响全站，另议。本任务的有效路径不含 next.config.ts。验收必须同时满足两条，只过一条不算通过。（a）原始 HTML 里 404 标题出现在 </head> 之前，用 Chrome UA 和 Googlebot UA 各测一次的原始 HTML 断言。（b）渲染后 document.title 是 404 标题。（a）和（b）都必须各自覆盖两类 404：一类是普通未知路径，例如 /en/xxx，现在渲染后会变成首页标题，正是要修的问题；一类是未上线语言 /de，现在是对的。两类都测才能防止回退，只测 /de 等于没验。不能只验「原始 HTML 里有 404 标题」。线上已经满足，等于没验收。这些断言加在 e2e/not-found-robots.spec.ts。（a）的 </head> 前位置断言和（b）的 toHaveTitle 断言都写在这个文件。404 原始 HTML 标题断言现在就在这里。不只列 e2e/seo.spec.ts。不改其他路由的 metadata 输出。与 SEO-5 同改 src/app/[locale]/not-found.tsx。SEO-5 已由 PR #456 合入 main，合并提交 466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd。实施时基于已包含这次合并的 main。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/app/` — handoff.wiring 的 frontendRoutes 注册目录。PR #461 改了这个目录下的 404 页
- `src/app/[locale]/not-found.tsx:17` — `generateMetadata` 只用 `NotFound.meta.title`，不写 robots
- `src/app/[locale]/not-found.tsx:53` — 使用共用的 `NotFoundTitle`
- `src/app/[locale]/locale-unavailable/not-found.tsx:17` — 未上线语言的英文 404 metadata
- `src/app/[locale]/locale-unavailable/not-found.tsx:24` — `NotFoundTitle locale="en"`
- `src/components/NotFoundTitle.tsx:9` — 按语言取 404 标题，新增语言时要同步
- `src/components/NotFoundTitle.tsx:23` — `useLayoutEffect` 写回标题，观察 head，最多 25×200ms
- `src/components/NotFoundTitle.tsx:42` — 卸载时 `disconnect` 并 `clearInterval`
- `e2e/not-found-robots.spec.ts:23` — 原始 HTML 恰好一个 404 `<title>`，并保留原文包含断言
- `e2e/not-found-robots.spec.ts:96` — 改掉 `document.title` 后 1 秒内写回
- `e2e/not-found-robots.spec.ts:105` — 软导航、后退、前进
- `tests/not-found-meta.test.ts:18` — 仍要求 `title: t('meta.title')`
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
404 响应是 `__next_error__` 文档。Chrome UA 下 metadata 在 `</head>` 之后，内容是 404 标题。组件不另写 title 元素，渲染后 head 里只有这一条。

水合会把 `document.title` 改成首页标题。`useLayoutEffect` 在绘制前写回，只观察 `document.head`。观察 `document.body` 会被首页画布的持续变更打满。卸载时断开观察并停掉轮询，所以客户端导航离开本页后不再写标题。

未上线语言的标题固定英文。页面不声明 robots。原始 HTML 里 robots 仍是一条 `noindex`。`/de` 渲染后 DOM 里框架可能再插一条 `noindex`，原有断言保持不变。

fix1：改为 'use client' 标题组件，修复软导航后标题被锁；(a) 定为不做
<!-- notes:end -->
