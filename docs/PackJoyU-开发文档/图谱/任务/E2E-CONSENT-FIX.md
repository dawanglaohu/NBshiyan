---
type: task
id: E2E-CONSENT-FIX
status: done
module: M5
origin: issue-ledger-20261024
---

# E2E-CONSENT-FIX　分析同意导航去重用例在 Node 侧读取回执

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M5]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#489
- 合并提交：`6c2833ba90be585286d4faf13c4864611d422b21`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。只改 e2e。非 POST 或已经记下的请求走 fallback。

## 输入 / 产出

- **输入**：导航去重用例在文档跳转之后向浏览器取响应体。
- **产出**：同一用例改为在 Node 侧用 route.fetch 读取回执。产品代码不改。
- **有效路径**：`e2e/analytics-consent.spec.ts`

## 验收标准

已由 PR #489 于 2026-10-26 合入 main。合并提交 6c2833ba90be585286d4faf13c4864611d422b21。acceptedIds 仍须包含 pageView.eventId，重放后 duplicateIds 仍须包含该 eventId，同一 navigationId 的存储条数仍须为 1。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `e2e/analytics-consent.spec.ts:224` — 点击前注册 route，截取 POST `/api/analytics/events`；非 POST 或已记录的请求 fallback
- `e2e/analytics-consent.spec.ts:231` — `route.fetch` 后只记录 ok 回执和原始 postData，再原样 fulfill
- `e2e/analytics-consent.spec.ts:249` — 20 秒内等到回执
- `e2e/analytics-consent.spec.ts:254` — 断言前 unroute，避免影响后续导航
- `e2e/analytics-consent.spec.ts:259` — `acceptedIds` 仍须包含 page view 的 eventId
- `e2e/analytics-consent.spec.ts:271` — 重放使用记下的 postData，`duplicateIds` 仍须包含该 eventId
- `e2e/analytics-consent.spec.ts:272` — 同一 navigationId 的存储条数仍须为 1
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
导航去重用例在 Node 侧从 `route.fetch()` 读取回执，不在文档跳转之后向浏览器取响应体。上面三条断言没有放宽。产品代码没有改。
<!-- notes:end -->
