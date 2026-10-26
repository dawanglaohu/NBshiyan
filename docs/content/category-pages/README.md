# Category page copy drafts（24 页：12 品类 × EN/RU）

> Refs #99 · 为打开 `CATEGORY_PAGES_LIVE` 做准备 · 只在本地，未推送 · 俄语全部待 Ryan 校对（ё、CTA «Запросить расчёт»）

## 结构（每页相同）
1. 头部注释：内部 key、本页 URL、hreflang 对应页
2. `# H1`
3. `## Intro` / `## Вступление`
4. 使用场景 · 材料与选项 · 定制与印刷
5. 从询盘到交付（5 步，不含任何天数）
6. MOQ / 打样周期 / 生产周期 / 贸易条款 —— 全部 `{{待Ryan确认}}`
7. FAQ：链接到本页 `#faq`，内容来自 `docs/content/landing-faq.md`（seo/landing-faq）
8. 相关品类内链（用 `categoryMeta.ts` 的 slug）
9. CTA：Request a quote / Запросить расчёт

来源：#188 落地页（`seo-188/docs/content/*.md`）的规格表、`src/lib/seo/categoryMeta.ts`、`docs/seo-category-meta.md`、landing-faq。#188 里没确认的说法（清单见 `docs/content/ryan-fact-sheet.md` 附录）全部未沿用或改成占位符。

## 前端渲染规则（必须遵守）
- **任何含 `{{` 的块（段落、列表项、表格行、整节）都不能渲染。** 一节里全部条目都被过滤掉时，整节不显示（例如 MOQ 一节目前会整节隐藏）。
- 生产构建如果页面输出里出现 `{{`，测试必须失败（`pnpm seo:audit` 已检查 `{{`）。
- `gift-cards` 页顶部的 F16 说明是贺卡已定，提示只给 Ryan 看，不渲染；这个品类保持隐藏。

## 字数与占位符（字数不含 HTML 注释）
| 文件 | 字数 | `{{待Ryan确认}}` 数 |
|---|---|---|
| `christmas-merchandise.en.md` | 249 | 6 |
| `christmas-merchandise.ru.md` | 228 | 6 |
| `color-boxes.en.md` | 256 | 5 |
| `color-boxes.ru.md` | 232 | 5 |
| `color-printing.en.md` | 240 | 5 |
| `color-printing.ru.md` | 217 | 5 |
| `corrugated-boxes.en.md` | 257 | 5 |
| `corrugated-boxes.ru.md` | 238 | 5 |
| `eco-paper-cups.en.md` | 238 | 6 |
| `eco-paper-cups.ru.md` | 213 | 6 |
| `gift-boxes.en.md` | 254 | 5 |
| `gift-boxes.ru.md` | 232 | 5 |
| `gift-cards.en.md` | 267 | 8 |
| `gift-cards.ru.md` | 242 | 8 |
| `offset-printing.en.md` | 238 | 7 |
| `offset-printing.ru.md` | 214 | 7 |
| `paper-cups.en.md` | 244 | 6 |
| `paper-cups.ru.md` | 223 | 6 |
| `party-supplies.en.md` | 248 | 6 |
| `party-supplies.ru.md` | 234 | 6 |
| `pulp-molding.en.md` | 261 | 6 |
| `pulp-molding.ru.md` | 237 | 6 |
| `wine-boxes.en.md` | 249 | 5 |
| `wine-boxes.ru.md` | 237 | 5 |
| **合计** | 5748 | 140 |

## 待 Ryan 确认
- 每个品类的 MOQ、打样/生产周期、贸易条款、可选工艺清单
- paper-cups / eco-paper-cups 的涂层材料、可回收/可降解说法（F22）；pulp-molding 的纤维来源
- offset-printing 的设备和幅面（#188 里写的设备品牌未确认，见 fact sheet Q10）
- party-supplies 涂层；christmas 的季节下单截止日
- gift-cards：F16 —— 贺卡已定。塑料卡和刷边是否提供
