---
type: task
id: GIFT-CARD-ASSETS
status: done
module: M2
origin: issue-ledger-20261024
---

# GIFT-CARD-ASSETS　贺卡 D 方案模型、海报与两张 OG 图

> 来自 `04-执行/遗留issue-20261024.md`。不进入 19 节原批次。状态以该登记为准。

- 所属模块：[[M2]]
- 前置依赖：无
- GitHub：没有单独的 GitHub issue
- PR：#469
- 合并提交：`f91c02857e1a0a7b30a8d281bc48a10cefffe0e1`
- 审查：由 PR 上 bot 审查替代
- 登记状态：已落地

没有单独的 GitHub issue。模型文件名带新 hash，因为 /models 缓存一年。

## 输入 / 产出

- **输入**：贺卡品类现用的模型、海报和两张 OG 图。
- **产出**：换成 D 方案的新模型、新海报，并覆盖两张 OG 图。后台中文标签改为贺卡。
- **有效路径**：`design/og-src/render-og-categories.mjs`、`public/images/posters/custom-greeting-cards.6c079f1d.webp`、`public/models/gift-card.e5bf7ec9.glb`、`public/models/gift-card.e5bf7ec9.lod0.glb`、`public/og/category-custom-greeting-cards-en.jpg`、`public/og/category-otkrytki-na-zakaz-ru.jpg`、`src/components/admin/format.ts`、`src/data/og-versions.json`、`src/data/products.ts`

## 验收标准

已由 PR #469 于 2026-10-25 合入 main。合并提交 f91c02857e1a0a7b30a8d281bc48a10cefffe0e1。贺卡素材换成 D 方案。本登记不重做。

## 必须处理的边界

无

## 代码位置

<!-- code:begin -->
- `public/models/gift-card.e5bf7ec9.glb` — 新主模型，28888 字节，sha1 `db6cade40f1a6b79ff1d36af30369256e5df2a7b`。内部引用同名 lod0，所以不改名。
- `public/models/gift-card.e5bf7ec9.lod0.glb` — 配套 lod0，110956 字节，sha1 `647e131135ce0b5e9afac109a85b193f080632ff`。
- `public/images/posters/custom-greeting-cards.6c079f1d.webp` — 新海报，3592 字节，q76，sha1 `6c079f1df82d5b6b889f1c94e9c83f71a3559f06`。
- `public/og/category-custom-greeting-cards-en.jpg` — 原名覆盖，sha256 前 8 位 `53f9549f`。
- `public/og/category-otkrytki-na-zakaz-ru.jpg` — 原名覆盖，sha256 前 8 位 `37df38dd`。
- `src/data/products.ts:16` — `gift-cards` 的 model / poster 改为上面的新路径。`posterAlt` 和其他行不动。
- `design/og-src/render-og-categories.mjs:22-26` — `POSTER` 把 `gift-cards` 指到 `custom-greeting-cards`，否则渲染脚本还会去找已删除的 `custom-gift-cards.*.webp`。
- `src/data/og-versions.json:6` — `53f9549f`。
- `src/data/og-versions.json:18` — `37df38dd`。
- `src/components/admin/format.ts:13` — 后台中文标签改为「贺卡」。
<!-- code:end -->

## 实施沉淀

<!-- notes:begin -->
贺卡素材换成 D 方案。模型 `e5bf7ec9`，海报 `6c079f1d`（q76），OG `53f9549f` / `37df38dd`，后台标签「礼品卡」改为「贺卡」。
选择：`/models/*` 是一年 immutable 缓存，新模型必须用新 hash 文件名。每个海报 stem 只能有一张，所以作废的 `e818a461` 不入库。其余 20 张 OG 图不在本 PR 重渲。历史 provenance `docs/brand-content/source/dot-v3/provenance/products.ts:16` 和 `docs/PackJoyU-开发文档/_run/batches/batch-3-20261022.evidence.json:1306` 里的旧路径保留。
否掉：同名覆盖旧 glb / 旧海报；把 `custom-greeting-cards.e818a461.webp` 放进仓库；重渲其他 OG；改内部 key、slug、categoryMeta、posterAlt 和文案；改校对表里的 `custom-gift-cards.md` 引用。
坑：git 把两个 glb 识别成 rename，核对过工作区字节和 sha1 仍是新文件。本机 `core.autocrlf=true` 让 `tests/m4-t15-copy.test.ts:36` 对 `messages/*.json` 的 `
` 检查失败，blob 本身是 LF，本提交没碰这两个文件。
<!-- notes:end -->
