---
type: task
id: SEO-5
status: done
module: M7
origin: issue-ledger-20261024
---

# SEO-5　404 页只留一个 robots meta

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M7]]
- 前置依赖：无
- GitHub：#429
- PR：#456
- 合并提交：`466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

已由 PR #456 于 2026-10-24（PT）合入 main。合并提交 466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd。issue #429 已关闭，state_reason 为 completed。关闭事件没有 commit_id。fix2（069412f0）已在这次合并里：/de 用例断言原始 HTML 的 robots 条数和标题，locale-unavailable 的 not-found 注释写明不输出 canonical 和 hreflang。这两项不是待办。

## 输入 / 产出

- **输入**：本地化 404 页现有的 robots metadata。
- **产出**：404 原始 HTML 里只有 1 条 robots，且为 noindex。未发布语言页渲染后可以再有一条，每条都是 noindex。
- **有效路径**：`src/app/[locale]/not-found.tsx`、`src/app/[locale]/locale-unavailable/not-found.tsx`、`src/app/[locale]/products/[slug]/page.tsx`、`e2e/not-found-robots.spec.ts`、`tests/not-found-meta.test.ts`、`tests/middleware-locale-gate.test.ts`

## 验收标准

与 PR #456 一致。404 页原始 HTML 里只有 1 条 robots，且为 noindex。/de 这类未发布语言页，Next 在渲染后 DOM 里会再补一条；只要每条都是 noindex，不含独立的 index 或 follow，就算通过。状态码仍是 404。标题仍来自 NotFound.meta.title。不把 robots 字段加回本文件，以免再多一条 meta。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/app/[locale]/not-found.tsx:13` — 注释写明不要在本文件写 robots。notFound() 已经插入唯一的 noindex meta，这里再写会多出一条。
- `src/app/[locale]/not-found.tsx:17` — generateMetadata 只返回 NotFound.meta.title 和 description: null。
- `src/app/[locale]/locale-unavailable/not-found.tsx:13` — 注释写明 robots 由 Next notFound() 注入，不自行声明，不输出 canonical 和 hreflang。
- `src/app/[locale]/locale-unavailable/not-found.tsx:17` — 未发布语言 404 的 generateMetadata 不再声明 robots。
- `src/app/[locale]/products/[slug]/page.tsx:28` — 未命中品类时返回空 metadata，不自带 robots。
- `e2e/not-found-robots.spec.ts:18` — 已发布语言 404 的 robots meta 条数为 1，内容为 noindex。
- `e2e/not-found-robots.spec.ts:31` — /de 的原始 HTML 恰好 1 条 robots，且为 noindex。
- `e2e/not-found-robots.spec.ts:39` — 渲染后 DOM 里每条 robots 都含 noindex，且不含独立的 index 或 follow。
- `tests/not-found-meta.test.ts:20` — 断言本地化 404 源码不再出现 robots 字段。
- `tests/not-found-meta.test.ts:29` — 断言品类 404 与未发布语言 404 也不声明 robots。
- `tests/middleware-locale-gate.test.ts:92` — 断言 locale-unavailable 页面源码不再匹配 robots 字段。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- 原始 HTML 只留 Next notFound() 插入的那一条 robots，内容是 noindex。本文件再写 robots 字段会多出一条 meta。
- /de 这类未发布语言页，渲染后 DOM 里 Next 会再补一条。通过条件是每条都是 noindex，且不含独立的 index 或 follow。
- fix2 `069412f0` 已在合并提交里。/de 用例断言原始 HTML 的 robots 条数和标题，以及 locale-unavailable 注释写明不输出 canonical 和 hreflang。这两项不是待办。
- 未知品类页不再自己返回 `robots: { index: false }`，避免和 notFound() 的 meta 叠成两条。
- 合入日按 PT 记为 2026-10-24。该合并提交的提交者时间是 2026-10-25 10:05 +0800。
- PR #456，合并提交 `466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd`。`git show --stat` 是 6 个文件。issue #429 已关闭，state_reason 为 completed。关闭事件没有 commit_id。
<!-- notes:end -->
