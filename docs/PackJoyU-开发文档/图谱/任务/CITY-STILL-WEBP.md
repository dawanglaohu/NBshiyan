---
type: task
id: CITY-STILL-WEBP
status: done
module: M1
origin: issue-ledger-20261024
---

# CITY-STILL-WEBP　首页城市场景静帧改用响应式 WebP

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M1]]
- 前置依赖：无
- GitHub：待开 issue
- PR：#448
- 合并提交：`369c2e90a2ea92096896e0126f579d61bfe553ea`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。SEO-6（#444）仍是 GIF 改视频，等 3D 交付 MP4，不在本登记里重做。

## 输入 / 产出

- **输入**：首页城市场景暂停静帧原来的 PNG。
- **产出**：记账。静帧改为 1384w 与 2000w 的 WebP，srcset 按视口选择。
- **有效路径**：`src/components/layout/BrandScene.tsx`、`src/lib/home/brandMedia.ts`、`public/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp`、`public/brand/packjoyu-industrial-city-v3-loop-poster-2000.webp`、`tests/home-brand-media.test.ts`、`e2e/home-media.spec.ts`

## 验收标准

已由 PR #448 于 2026-10-24 合入 main。合并提交 369c2e90a2ea92096896e0126f579d61bfe553ea。首页城市场景暂停静帧改为 1384w 与 2000w WebP。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `src/components/layout/BrandScene.tsx` — PR #448 的描述没有「回填草稿」，不编行号
- `src/lib/home/brandMedia.ts` — PR #448 的描述没有「回填草稿」，不编行号
- `public/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp` — PR #448 的描述没有「回填草稿」，不编行号
- `public/brand/packjoyu-industrial-city-v3-loop-poster-2000.webp` — PR #448 的描述没有「回填草稿」，不编行号
- `tests/home-brand-media.test.ts` — PR #448 的描述没有「回填草稿」，不编行号
- `e2e/home-media.spec.ts` — PR #448 的描述没有「回填草稿」，不编行号
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
PR #448 的描述没有「回填草稿」。合并提交 `369c2e90a2ea92096896e0126f579d61bfe553ea`。代码位置不编行号。
<!-- notes:end -->
