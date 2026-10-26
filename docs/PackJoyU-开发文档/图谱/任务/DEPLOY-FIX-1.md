---
type: task
id: DEPLOY-FIX-1
status: done
module: M1
origin: issue-ledger-20261024
---

# DEPLOY-FIX-1　首页海报移出 docs

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M1]]
- 前置依赖：无
- GitHub：#421
- PR：#421
- 合并提交：`40b2eb5c52361ac57390530c7347498e3b2e07b1`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

## 输入 / 产出

- **输入**：已合并的生产镜像资源修复。
- **产出**：记账。首页海报已从 docs 移到 public。
- **有效路径**：`src/lib/home/brandMedia.ts`、`src/app/[locale]/page.tsx`、`public/brand/packjoyu-industrial-city-v3-loop-poster.png`

## 验收标准

已由 PR #421 于 2026-10-24 合入 main。合并提交 40b2eb5c52361ac57390530c7347498e3b2e07b1。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/lib/home/brandMedia.ts` — PR #421 的描述没有「回填草稿」，不编行号
- `src/app/[locale]/page.tsx` — PR #421 的描述没有「回填草稿」，不编行号
- `public/brand/packjoyu-industrial-city-v3-loop-poster.png` — PR #421 的描述没有「回填草稿」，不编行号
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
PR #421 的描述没有「回填草稿」。合并提交 `40b2eb5c52361ac57390530c7347498e3b2e07b1`。代码位置不编行号。
<!-- notes:end -->
