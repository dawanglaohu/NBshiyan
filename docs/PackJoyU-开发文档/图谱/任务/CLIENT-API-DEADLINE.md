---
type: task
id: CLIENT-API-DEADLINE
status: done
module: M1
origin: issue-ledger-20261024
---

# CLIENT-API-DEADLINE　deadline 必须打断卡住的正文读取

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M1]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#471
- 合并提交：`02b57ac52fe8a6c4d1e87d28aa62e080bb1e0ba8`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。否掉了只依赖 fetch abort，也否掉了只 cancel 不竞速。

## 输入 / 产出

- **输入**：客户端请求在响应头到达后继续读正文。
- **产出**：deadline 和用户取消都能打断挂起的正文读取。
- **有效路径**：`src/lib/client/api.ts`、`tests/client-api-foundation.http.test.ts`

## 验收标准

已由 PR #471 于 2026-10-25 合入 main。合并提交 02b57ac52fe8a6c4d1e87d28aa62e080bb1e0ba8。deadline 必须打断卡住的正文读取。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/client/api.ts:217` — `readOrAbort`：正文读取和 attempt 的 AbortSignal 竞速，abort 时 `reader.cancel()` 并拒绝。原因：响应头到达后，fetch 的 signal 有时不会让挂起的 `reader.read()` 失败，deadline 因此到点仍不返回。
- `src/lib/client/api.ts:246` — `readCapped` 接收这个 signal；已 abort 时先取消 body 再抛。超限、空 body、解析失败的原路径保留。
- `src/lib/client/api.ts:382` — `requestApi` 把 `attempt.signal` 传入 `readCapped`，所以 deadline 和用户取消走同一条中断。
- `tests/client-api-foundation.http.test.ts:1281` — 新测试。服务器写完 403 头和半截正文后挂住；外层流不再把后续读取交给传输层的 abort。断言 14s–22s 内结束、一次请求、403、`stop`、不重放、`retryAfterMs === 31000`。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
- 否掉了「只依赖 fetch abort」和「只 cancel 不竞速」。踩坑：本机 22.17.0 上真实 fetch 的 abort 是稳的，旧用例修前 20/20 通过，复现必须让正文流自己不响应 abort；CI 的 Node 是 22.23.3，旧用例在那里会超时。
<!-- notes:end -->
