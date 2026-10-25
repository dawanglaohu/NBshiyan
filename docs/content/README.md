# 品类落地页内容（Fixes #99）

供 Sanity 导入的 12 个品类落地页文案草稿。元信息以 `src/lib/seo/categoryMeta.ts` 为准。

## 规则
- 每个文件：Meta、EN 文案、RU 文案（⚠️ 需要 Ryan 校对）、FAQ 草稿（暂不加 FAQPage schema）、EN/RU 关键词按意图分组（无搜索量）、内链建议、2–3 篇文章大纲。
- **TBD** = 需 Ryan/工厂提供真实数据（MOQ、交期、尺寸范围、认证等）。不得编造数字、认证、评分、价格。
- FAQ 内容确认、与页面可见内容一致后，再输出 FAQPage JSON-LD。

## 索引

| 品类 | 内部 key | EN slug | RU slug | 文件 |
|---|---|---|---|---|
| 瓦楞纸箱 | `corrugated-boxes` | `custom-corrugated-boxes` | `gofrokorobki` | [custom-corrugated-boxes.md](./custom-corrugated-boxes.md) |
| 彩盒 | `color-boxes` | `custom-printed-boxes` | `tsvetnye-korobki` | [custom-printed-boxes.md](./custom-printed-boxes.md) |
| 礼盒 | `gift-boxes` | `custom-gift-boxes` | `podarochnye-korobki` | [custom-gift-boxes.md](./custom-gift-boxes.md) |
| 纸浆模塑 | `pulp-molding` | `molded-pulp-packaging` | `izdeliya-iz-tsellyulozy` | [molded-pulp-packaging.md](./molded-pulp-packaging.md) |
| 纸杯 | `paper-cups` | `custom-paper-cups` | `bumazhnye-stakany` | [custom-paper-cups.md](./custom-paper-cups.md) |
| 派对用品 | `party-supplies` | `custom-party-supplies` | `tovary-dlya-prazdnikov` | [custom-party-supplies.md](./custom-party-supplies.md) |
| 酒盒 | `wine-boxes` | `custom-wine-boxes` | `upakovka-dlya-vina` | [custom-wine-boxes.md](./custom-wine-boxes.md) |
| 彩色印刷 | `color-printing` | `custom-color-printing` | `tsvetnaya-pechat` | [custom-color-printing.md](./custom-color-printing.md) |
| 胶印 | `offset-printing` | `offset-printing-services` | `ofsetnaya-pechat` | [offset-printing-services.md](./offset-printing-services.md) |
| 环保纸杯 | `eco-paper-cups` | `eco-paper-cups` | `ekologichnye-stakany` | [eco-paper-cups.md](./eco-paper-cups.md) |
| 礼品卡 | `gift-cards` | `custom-greeting-cards` | `otkrytki-na-zakaz` | [custom-greeting-cards.md](./custom-greeting-cards.md) |
| 圣诞周边 | `christmas-merchandise` | `custom-christmas-packaging` | `novogodnyaya-upakovka` | [custom-christmas-packaging.md](./custom-christmas-packaging.md) |

另见 [industries.md](./industries.md)：行业方案页关键词（食品、酒类、电商、节日）与跨品类文章选题。

## 需要 Ryan 提供 / 确认
1. 全部俄语内容校对。
2. 每个品类的 MOQ、打样周期、量产交期、尺寸/容量范围。
3. 已持有的认证（食品接触、FSC、可堆肥等）——没有文件前不写进页面。
4. 是否提供塑料礼品卡、可变数据印刷、纸杯具体尺寸范围、胶印机幅面。
5. 贸易条款（FOB/CIF 等）和是否支持俄罗斯清关。

## 文章草稿

以下 4 个选题各有 EN/RU 草稿，均为 `status: draft`、`import: false`。事实占位、俄语校对和发布前链接验收完成前，不导入 Sanity。源文件存在不表示对应网页已上线。

| 选题 | EN | RU |
| --- | --- | --- |
| 节日包装排期 | [Holiday packaging timeline](./articles/holiday-packaging-timeline.md) | [Когда заказывать новогоднюю упаковку](./articles/kogda-zakazyvat-novogodnyuyu-upakovku.md) |
| CMYK / Pantone | [CMYK vs Pantone](./articles/cmyk-vs-pantone-packaging.md) | [CMYK или Pantone](./articles/cmyk-ili-pantone.md) |
| 折叠纸盒结构 | [Folding carton styles](./articles/folding-carton-styles.md) | [Виды картонных коробок](./articles/vidy-kartonnykh-korobok.md) |
| 纸杯容量与杯壁 | [Paper cup sizes and wall types](./articles/paper-cup-sizes-wall-types.md) | [Объёмы бумажных стаканов](./articles/obyomy-bumazhnykh-stakanov.md) |

事实收集见 [Ryan 问卷](./ryan-fact-sheet.md)与[占位映射](./placeholder-map.md)。文章发布顺序仍以[内容计划](./content-plan.md)为准。
