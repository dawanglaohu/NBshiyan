# 上线后两个月内容计划（8 篇文章）

> Refs #99 · 只是计划，不含正文。周次按“正式上线后第 N 周”计算，上线日期待定。
> 规则：不编数据。搜索量一律未填（接入 Google Keyword Planner / Yandex Wordstat 后补）；文中需要的事实一律写 `{{待Ryan确认}}`。
> 关键词来源：#188 各落地页的 Keywords 小节（`seo/issue-99-category-content`）。标“候选”的词不在 #188 清单里，发布前要用 Wordstat / Keyword Planner 核实。
> 俄语标题和关键词：⚠️ 待 Ryan 校对。
> 品类页路径用 `src/lib/seo/categoryMeta.ts` 的 slug：EN `/en/products/<en slug>`，RU `/ru/products/<ru slug>`。

## 已有文章（#205，不要重复）

| # | EN slug | RU slug | RU 主关键词 | 落地页 |
|---|---|---|---|---|
| A | `custom-mailer-boxes-ecommerce-buyers-guide` | `pochtovye-korobki-s-logotipom-dlya-internet-magazina` | почтовые коробки с логотипом | corrugated-boxes（`/ru/products/gofrokorobki`） |
| B | `corporate-gift-packaging-planning-guide` | `korporativnye-podarki-upakovka-s-logotipom` | упаковка для корпоративных подарков | gift-boxes（`/ru/products/podarochnye-korobki`） |

**怎么避免和 A、B 抢同一批搜索（关键词蚕食）：**
1. 新文章的主关键词都不用 A、B 的主关键词和次关键词（почтовые коробки с логотипом、самосборные коробки、упаковка для маркетплейсов、корпоративные новогодние подарки、коробки с ложементом、жёсткие коробки с магнитом 等），也不用它们的英文对应词。
2. 和 A、B 有交集的主题（第 1、5、8 篇）明确换角度：A、B 是“怎么下单”的采购指南，新文章是单一问题的解释（选哪种结构、怎么准备文件、季节排期），并在正文里链接到 A、B，而不是重复写同一节。
3. 每个品类页只指定一篇主文章作为“延伸阅读”，A、B 原有的品类 → 文章链接保持不变（`internal-links.json`）。
4. 发布后看 Search Console / Yandex.Webmaster：同一个查询如果新旧文章交替出现，就合并或调整标题（见文末“发布后检查”）。

## 总览

| 周 | # | 主题 | 主品类页 | 和已有文章的关系 |
|---|---|---|---|---|
| 1 | 1 | 节日包装排期 | christmas-merchandise | 和 B 的“Сроки”一节相邻：本篇面向零售/品牌季节商品，不讲企业礼品 |
| 2 | 2 | CMYK 还是 Pantone | color-printing | 无 |
| 3 | 3 | 折叠纸盒结构 | color-boxes | 无 |
| 4 | 4 | 纸杯容量和单双层 | paper-cups | 无 |
| 5 | 5 | 硬质礼盒结构 | gift-boxes | 和 B 相邻：本篇讲结构类型，不讲企业礼品流程 |
| 6 | 6 | 纸浆模塑湿压 / 干压 | pulp-molding | 无 |
| 7 | 7 | 胶印还是数码印刷 | offset-printing | 无 |
| 8 | 8 | 印刷文件和刀版准备 | color-printing、color-boxes | 和 A 的“Как определить размер”相邻：本篇只讲文件准备 |

第 1 篇排在第一周，是因为它和季节有关；如果上线时已经过了 Ryan 给出的最晚下单日期（`{{待Ryan确认}}`），就改到明年季前发布，第 2–8 篇依次前移。

---

## 第 1 篇（第 1 周）节日包装排期

- **工作标题**：EN *Holiday Packaging Timeline: Plan Backwards from Your Launch* · RU *Новогодняя упаковка: когда заказывать, чтобы успеть к сезону*
- **关键词**
  - EN 主：when to order holiday packaging；次：custom christmas packaging timeline（候选）、advent calendar packaging ideas
  - RU 主：когда заказывать новогоднюю упаковку；次：идеи новогодней упаковки、адвент календарь на заказ
- **搜索意图**：信息型（排期规划），带商业意图
- **目标品类页**：christmas-merchandise（`/en/products/custom-christmas-packaging`、`/ru/products/novogodnyaya-upakovka`）
- **内链**
  - 出：→ christmas-merchandise；→ gift-boxes；→ 第 8 篇（文件准备）；→ B（企业礼品，一句带过）
  - 入：christmas-merchandise 页“延伸阅读”；B 的“Сроки”一节加一句链接
- **不和 B 重叠**：不用“корпоративные подарки”作关键词；企业礼品只链接到 B。
- **需要的事实**：最晚下单日期 `{{待Ryan确认}}`（fact sheet Q12）；设计、打样、生产、运输各阶段时长 `{{待Ryan确认}}`（Q2、Q3）；起订量 `{{待Ryan确认}}`（Q1）；发往俄罗斯的方式和清关 `{{待Ryan确认}}`（Q23）

## 第 2 篇（第 2 周）CMYK 还是 Pantone

- **工作标题**：EN *CMYK vs Pantone for Packaging: How to Choose* · RU *CMYK или Pantone: как выбрать для печати упаковки*
- **关键词**
  - EN 主：cmyk vs pantone；次：pantone printing packaging、color proof types
  - RU 主：CMYK или Pantone；次：печать пантонами、что такое цветопроба
- **搜索意图**：信息型（技术选择）
- **目标品类页**：color-printing（`/en/products/custom-color-printing`、`/ru/products/tsvetnaya-pechat`）；次要 offset-printing
- **内链**
  - 出：→ color-printing；→ offset-printing；→ 第 7 篇；→ 第 8 篇
  - 入：color-printing 页“延伸阅读”；第 7、8 篇
- **需要的事实**：可做的打样/色样类型 `{{待Ryan确认}}`；专色的额外费用如何报价 `{{待Ryan确认}}`；色差标准和验收方法 `{{待Ryan确认}}`

## 第 3 篇（第 3 周）折叠纸盒结构

- **工作标题**：EN *Folding Carton Styles Explained: Tuck End, Auto Bottom, Sleeve and Window* · RU *Виды картонных коробок: какую конструкцию выбрать*
- **关键词**
  - EN 主：tuck end vs auto bottom box；次：window boxes custom、custom cosmetic boxes
  - RU 主：виды картонных коробок（候选）；次：коробки с окном、коробки для косметики на заказ
- **搜索意图**：信息型 → 商业调查
- **目标品类页**：color-boxes（`/en/products/custom-printed-boxes`、`/ru/products/tsvetnye-korobki`）
- **内链**
  - 出：→ color-boxes；→ 第 8 篇；→ A（只在“运输用外箱”一句里链接）
  - 入：color-boxes 页“延伸阅读”；第 8 篇
- **不和 A 重叠**：A 讲瓦楞邮寄箱，本篇只讲卡纸折叠盒。
- **需要的事实**：可做的结构清单 `{{待Ryan确认}}`；可选纸板 `{{待Ryan确认}}`；起订量 `{{待Ryan确认}}`（Q1）

## 第 4 篇（第 4 周）纸杯容量和单双层

- **工作标题**：EN *Paper Cup Sizes and Wall Types: A Guide for Coffee Shops* · RU *Объёмы бумажных стаканов и однослойный или двухслойный: гид для кофейни*
- **关键词**
  - EN 主：paper cup sizes oz chart；次：single vs double wall cup、paper cups with lids
  - RU 主：объёмы стаканов для кофе；次：однослойный или двухслойный стакан、крышки для бумажных стаканов
- **搜索意图**：信息型（选型）
- **目标品类页**：paper-cups（`/en/products/custom-paper-cups`、`/ru/products/bumazhnye-stakany`）；次要 eco-paper-cups（只链接，不写环保说法）
- **内链**
  - 出：→ paper-cups；→ eco-paper-cups；→ party-supplies
  - 入：paper-cups 页“延伸阅读”
- **需要的事实**：可做的容量和口径 `{{待Ryan确认}}`；配套杯盖和杯套 `{{待Ryan确认}}`；内壁涂层 `{{待Ryan确认}}`（Q6）；油墨和食品接触文件 `{{待Ryan确认}}`（Q18）。涂层和环保相关内容在 Ryan 确认前一律不写。

## 第 5 篇（第 5 周）硬质礼盒结构

- **工作标题**：EN *Rigid Gift Box Styles: Magnetic, Lid and Base, Drawer or Book?* · RU *Виды подарочных коробок: магнитная, крышка-дно, выдвижная или книжка*
- **关键词**
  - EN 主：rigid vs folding box；次：collapsible rigid box、drawer gift box custom
  - RU 主：виды подарочных коробок；次：как выбрать подарочную упаковку、коробка книжка на заказ
- **搜索意图**：信息型 → 商业调查
- **目标品类页**：gift-boxes（`/en/products/custom-gift-boxes`、`/ru/products/podarochnye-korobki`）；次要 wine-boxes
- **内链**
  - 出：→ gift-boxes；→ wine-boxes；→ pulp-molding；→ B（企业礼品）
  - 入：gift-boxes 页“延伸阅读”（B 已有的链接保留）；第 1 篇
- **不和 B 重叠**：不用“жёсткие коробки с магнитом”“коробки с ложементом”作主关键词（这两个是 B 的次关键词）；内托只简单介绍，详细内容链接到 B 的「Ложементы」一节。
- **需要的事实**：可做的结构 `{{待Ryan确认}}`；灰板厚度 `{{待Ryan确认}}`；可折叠硬盒是否能做 `{{待Ryan确认}}`；起订量和交期 `{{待Ryan确认}}`（Q1–Q3）

## 第 6 篇（第 6 周）纸浆模塑湿压 / 干压

- **工作标题**：EN *Wet-Press vs Dry-Press Molded Pulp: Finish, Tolerance and Uses* · RU *Формованная целлюлоза: мокрое и сухое прессование — в чём разница*
- **关键词**
  - EN 主：wet press vs dry press molded pulp；次：custom molded pulp inserts、molded fiber packaging
  - RU 主：что такое формованная целлюлоза；次：ложемент из целлюлозы、упаковка из багассы
- **搜索意图**：信息型（工艺选择）
- **目标品类页**：pulp-molding（`/en/products/molded-pulp-packaging`、`/ru/products/izdeliya-iz-tsellyulozy`）
- **内链**
  - 出：→ pulp-molding；→ gift-boxes；→ corrugated-boxes
  - 入：pulp-molding 页“延伸阅读”；第 5 篇
- **刻意不选的题目**：#188 大纲里和其他内托材料对比、以及“换掉塑料”的选题，都要用到没确认的环保说法，等 Ryan 回答 fact sheet Q7、Q22 后再考虑。
- **需要的事实**：纤维来源 `{{待Ryan确认}}`（Q8）；能做哪种压制工艺 `{{待Ryan确认}}`；模具费和开模时间 `{{待Ryan确认}}`；公差 `{{待Ryan确认}}`

## 第 7 篇（第 7 周）胶印还是数码印刷

- **工作标题**：EN *Offset vs Digital Printing: How to Decide for Packaging and Catalogs* · RU *Офсетная или цифровая печать: что выбрать для упаковки и каталогов*
- **关键词**
  - EN 主：offset vs digital printing；次：how offset printing works、booklet printing wholesale
  - RU 主：офсетная или цифровая печать；次：как работает офсетная печать、печать каталогов
- **搜索意图**：信息型 → 商业调查
- **目标品类页**：offset-printing（`/en/products/offset-printing-services`、`/ru/products/ofsetnaya-pechat`）；次要 color-printing
- **内链**
  - 出：→ offset-printing；→ color-printing；→ 第 2 篇
  - 入：offset-printing 页“延伸阅读”；第 2 篇
- **需要的事实**：是否做数码印刷 `{{待Ryan确认}}`；印刷设备 `{{待Ryan确认}}`（Q10，设备品牌不写）；幅面 `{{待Ryan确认}}`（Q11）；两种方式各自的起订量 `{{待Ryan确认}}`（Q1）

## 第 8 篇（第 8 周）印刷文件和刀版准备

- **工作标题**：EN *Print File and Dieline Checklist for Custom Boxes* · RU *Как подготовить макет коробки к печати: развёртка, вылеты, шрифты*
- **关键词**
  - EN 主：how to prepare print files；次：what is a dieline、soft touch vs matte lamination
  - RU 主：как подготовить макет коробки；次：что такое развёртка коробки、как подготовить файл к печати
- **搜索意图**：信息型（操作指南）
- **目标品类页**：color-printing（`/en/products/custom-color-printing`、`/ru/products/tsvetnaya-pechat`）、color-boxes（`/en/products/custom-printed-boxes`、`/ru/products/tsvetnye-korobki`）
- **内链**
  - 出：→ color-printing；→ color-boxes；→ 第 2 篇；→ 第 3 篇；→ A（邮寄箱尺寸一节）
  - 入：第 1、2、3 篇；color-boxes 页
- **不和 A 重叠**：A 讲邮寄箱怎么选尺寸、怎么下单；本篇只讲文件格式、出血、字体、刀版图层，尺寸问题链接到 A。
- **需要的事实**：接受的文件格式 `{{待Ryan确认}}`；出血和安全区要求 `{{待Ryan确认}}`；刀版由谁提供 `{{待Ryan确认}}`；打样确认流程 `{{待Ryan确认}}`

---

## 备选（第 9 周以后）

- wine-boxes：酒盒尺寸和内托选择（EN *wine box sizes*、RU *размеры коробки для бутылки вина*）
- gift-cards：等 fact sheet Q13（产品到底是储值卡还是贺卡）有答案后再定题
- party-supplies：自有品牌派对用品（EN *private-label party supplies*、RU *товары для праздника под собственной маркой*）

## 发布流程和检查

1. 每篇先写英文，再写俄语（俄语待 Ryan 校对），按 #205 的 front matter 格式放在 `docs/content/articles/`。
2. 发布前：`{{待Ryan确认}}` 没填的段落不发布；守卫测试和 ё-lint 必须通过；`linkmap.py` 加入新文章的内链后，再跑 `build.py`，并通过逐字节比对测试。
3. 发布后（每周一次）：在 Search Console / Yandex.Webmaster 看新文章和 A、B、品类页有没有抢同一个查询；有的话调整标题或合并。
