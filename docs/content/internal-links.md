# 内链地图（Refs #99）

由 `docs/content/sanity-import/linkmap.py` 生成，机器可读版本见 `internal-links.json`。只在同一种语言内部互链，路径都是相对路径。
锚文本每个目标页准备 3 种说法轮流用，避免同一个精确匹配词重复出现。俄语锚文本：⚠️ 需要 Ryan 校对。

品类 → 品类的链接会作为"相关产品"一节加在落地页正文末尾；文章 → 品类的链接已经写在文章正文里，导入时会转成链接标记，不再另加一节。


## English

| 类型 | 来源 | 目标 | 锚文本 |
|---|---|---|---|
| category→category | `/en/products/custom-corrugated-boxes` | `/en/products/custom-printed-boxes` | custom printed boxes |
| category→category | `/en/products/custom-corrugated-boxes` | `/en/products/molded-pulp-packaging` | molded pulp packaging |
| category→category | `/en/products/custom-corrugated-boxes` | `/en/products/offset-printing-services` | offset printing services |
| category→category | `/en/products/custom-printed-boxes` | `/en/products/custom-gift-boxes` | custom gift boxes |
| category→category | `/en/products/custom-printed-boxes` | `/en/products/custom-color-printing` | packaging printing services |
| category→category | `/en/products/custom-printed-boxes` | `/en/products/offset-printing-services` | high-volume offset printing |
| category→category | `/en/products/custom-gift-boxes` | `/en/products/custom-wine-boxes` | custom wine boxes |
| category→category | `/en/products/custom-gift-boxes` | `/en/products/custom-christmas-packaging` | custom Christmas packaging |
| category→category | `/en/products/custom-gift-boxes` | `/en/products/custom-printed-boxes` | full-color retail boxes |
| category→category | `/en/products/molded-pulp-packaging` | `/en/products/custom-corrugated-boxes` | custom corrugated boxes |
| category→category | `/en/products/molded-pulp-packaging` | `/en/products/eco-paper-cups` | eco-friendly paper cups |
| category→category | `/en/products/molded-pulp-packaging` | `/en/products/custom-gift-boxes` | rigid magnetic gift boxes |
| category→category | `/en/products/custom-paper-cups` | `/en/products/eco-paper-cups` | plastic-free coffee cups |
| category→category | `/en/products/custom-paper-cups` | `/en/products/custom-party-supplies` | custom party supplies |
| category→category | `/en/products/custom-paper-cups` | `/en/products/custom-printed-boxes` | printed product packaging |
| category→category | `/en/products/custom-party-supplies` | `/en/products/custom-paper-cups` | custom paper cups |
| category→category | `/en/products/custom-party-supplies` | `/en/products/custom-christmas-packaging` | holiday gift boxes |
| category→category | `/en/products/custom-party-supplies` | `/en/products/custom-color-printing` | full-color packaging printing |
| category→category | `/en/products/custom-wine-boxes` | `/en/products/custom-gift-boxes` | premium gift packaging |
| category→category | `/en/products/custom-wine-boxes` | `/en/products/custom-christmas-packaging` | advent calendars and seasonal packaging |
| category→category | `/en/products/custom-wine-boxes` | `/en/products/molded-pulp-packaging` | plastic-free pulp inserts |
| category→category | `/en/products/custom-color-printing` | `/en/products/offset-printing-services` | catalog and box printing |
| category→category | `/en/products/custom-color-printing` | `/en/products/custom-printed-boxes` | custom printed boxes |
| category→category | `/en/products/custom-color-printing` | `/en/products/custom-gift-cards` | custom gift cards |
| category→category | `/en/products/offset-printing-services` | `/en/products/custom-color-printing` | CMYK and Pantone printing |
| category→category | `/en/products/offset-printing-services` | `/en/products/custom-printed-boxes` | full-color retail boxes |
| category→category | `/en/products/offset-printing-services` | `/en/products/custom-gift-cards` | printed gift vouchers |
| category→category | `/en/products/eco-paper-cups` | `/en/products/custom-paper-cups` | branded coffee cups |
| category→category | `/en/products/eco-paper-cups` | `/en/products/molded-pulp-packaging` | molded fiber trays |
| category→category | `/en/products/eco-paper-cups` | `/en/products/custom-party-supplies` | printed party tableware |
| category→category | `/en/products/custom-gift-cards` | `/en/products/custom-color-printing` | packaging printing services |
| category→category | `/en/products/custom-gift-cards` | `/en/products/custom-gift-boxes` | custom gift boxes |
| category→category | `/en/products/custom-gift-cards` | `/en/products/offset-printing-services` | offset printing services |
| category→category | `/en/products/custom-christmas-packaging` | `/en/products/custom-gift-boxes` | rigid magnetic gift boxes |
| category→category | `/en/products/custom-christmas-packaging` | `/en/products/custom-wine-boxes` | wine and spirits gift boxes |
| category→category | `/en/products/custom-christmas-packaging` | `/en/products/custom-party-supplies` | private-label party products |
| article→category | `/en/articles/custom-mailer-boxes-ecommerce-buyers-guide` | `/en/products/custom-corrugated-boxes` | branded shipping boxes |
| category→article | `/en/products/custom-corrugated-boxes` | `/en/articles/custom-mailer-boxes-ecommerce-buyers-guide` | our buyer's guide to custom mailer boxes |
| article→category | `/en/articles/custom-mailer-boxes-ecommerce-buyers-guide` | `/en/products/custom-printed-boxes` | printed product packaging |
| category→article | `/en/products/custom-printed-boxes` | `/en/articles/custom-mailer-boxes-ecommerce-buyers-guide` | how to choose e-commerce mailer boxes |
| article→category | `/en/articles/custom-mailer-boxes-ecommerce-buyers-guide` | `/en/products/molded-pulp-packaging` | molded pulp packaging |
| category→article | `/en/products/molded-pulp-packaging` | `/en/articles/custom-mailer-boxes-ecommerce-buyers-guide` | mailer box sizing and printing guide |
| article→category | `/en/articles/corporate-gift-packaging-planning-guide` | `/en/products/custom-gift-boxes` | premium gift packaging |
| category→article | `/en/products/custom-gift-boxes` | `/en/articles/corporate-gift-packaging-planning-guide` | corporate gift packaging planning guide |
| article→category | `/en/articles/corporate-gift-packaging-planning-guide` | `/en/products/custom-christmas-packaging` | custom Christmas packaging |
| category→article | `/en/products/custom-christmas-packaging` | `/en/articles/corporate-gift-packaging-planning-guide` | how to plan corporate gift boxes |
| article→category | `/en/articles/corporate-gift-packaging-planning-guide` | `/en/products/custom-wine-boxes` | luxury bottle packaging |
| category→article | `/en/products/custom-wine-boxes` | `/en/articles/corporate-gift-packaging-planning-guide` | timeline for corporate gift packaging |

## Русский ⚠️ 需要 Ryan 校对

| 类型 | 来源 | 目标 | 锚文本 |
|---|---|---|---|
| category→category | `/ru/products/gofrokorobki` | `/ru/products/tsvetnye-korobki` | картонные коробки с печатью |
| category→category | `/ru/products/gofrokorobki` | `/ru/products/izdeliya-iz-tsellyulozy` | упаковка из формованной целлюлозы |
| category→category | `/ru/products/gofrokorobki` | `/ru/products/ofsetnaya-pechat` | офсетная печать упаковки |
| category→category | `/ru/products/tsvetnye-korobki` | `/ru/products/podarochnye-korobki` | подарочные коробки на заказ |
| category→category | `/ru/products/tsvetnye-korobki` | `/ru/products/tsvetnaya-pechat` | печать упаковки |
| category→category | `/ru/products/tsvetnye-korobki` | `/ru/products/ofsetnaya-pechat` | офсетная печать тиражом |
| category→category | `/ru/products/podarochnye-korobki` | `/ru/products/upakovka-dlya-vina` | коробки для вина на заказ |
| category→category | `/ru/products/podarochnye-korobki` | `/ru/products/novogodnyaya-upakovka` | новогодняя упаковка на заказ |
| category→category | `/ru/products/podarochnye-korobki` | `/ru/products/tsvetnye-korobki` | коробки с логотипом |
| category→category | `/ru/products/izdeliya-iz-tsellyulozy` | `/ru/products/gofrokorobki` | гофрокороба на заказ |
| category→category | `/ru/products/izdeliya-iz-tsellyulozy` | `/ru/products/ekologichnye-stakany` | экологичные стаканы |
| category→category | `/ru/products/izdeliya-iz-tsellyulozy` | `/ru/products/podarochnye-korobki` | жёсткие коробки с магнитом |
| category→category | `/ru/products/bumazhnye-stakany` | `/ru/products/ekologichnye-stakany` | эко стаканы без пластика |
| category→category | `/ru/products/bumazhnye-stakany` | `/ru/products/tovary-dlya-prazdnikov` | бумажная посуда для праздника |
| category→category | `/ru/products/bumazhnye-stakany` | `/ru/products/tsvetnye-korobki` | упаковка для косметики и розницы |
| category→category | `/ru/products/tovary-dlya-prazdnikov` | `/ru/products/bumazhnye-stakany` | бумажные стаканы с логотипом |
| category→category | `/ru/products/tovary-dlya-prazdnikov` | `/ru/products/novogodnyaya-upakovka` | новогодние подарочные коробки |
| category→category | `/ru/products/tovary-dlya-prazdnikov` | `/ru/products/tsvetnaya-pechat` | полноцветная печать на картоне |
| category→category | `/ru/products/upakovka-dlya-vina` | `/ru/products/podarochnye-korobki` | премиальная подарочная упаковка |
| category→category | `/ru/products/upakovka-dlya-vina` | `/ru/products/novogodnyaya-upakovka` | адвент-календари на заказ |
| category→category | `/ru/products/upakovka-dlya-vina` | `/ru/products/izdeliya-iz-tsellyulozy` | ложементы без пластика |
| category→category | `/ru/products/tsvetnaya-pechat` | `/ru/products/ofsetnaya-pechat` | печать каталогов и коробок |
| category→category | `/ru/products/tsvetnaya-pechat` | `/ru/products/tsvetnye-korobki` | картонные коробки с печатью |
| category→category | `/ru/products/tsvetnaya-pechat` | `/ru/products/podarochnye-karty` | печать подарочных карт |
| category→category | `/ru/products/ofsetnaya-pechat` | `/ru/products/tsvetnaya-pechat` | печать пантонами |
| category→category | `/ru/products/ofsetnaya-pechat` | `/ru/products/tsvetnye-korobki` | коробки с логотипом |
| category→category | `/ru/products/ofsetnaya-pechat` | `/ru/products/podarochnye-karty` | подарочные сертификаты на заказ |
| category→category | `/ru/products/ekologichnye-stakany` | `/ru/products/bumazhnye-stakany` | стаканы для кофе с печатью |
| category→category | `/ru/products/ekologichnye-stakany` | `/ru/products/izdeliya-iz-tsellyulozy` | лотки из целлюлозы |
| category→category | `/ru/products/ekologichnye-stakany` | `/ru/products/tovary-dlya-prazdnikov` | праздничная посуда с печатью |
| category→category | `/ru/products/podarochnye-karty` | `/ru/products/tsvetnaya-pechat` | печать упаковки |
| category→category | `/ru/products/podarochnye-karty` | `/ru/products/podarochnye-korobki` | подарочные коробки на заказ |
| category→category | `/ru/products/podarochnye-karty` | `/ru/products/ofsetnaya-pechat` | офсетная печать упаковки |
| category→category | `/ru/products/novogodnyaya-upakovka` | `/ru/products/podarochnye-korobki` | жёсткие коробки с магнитом |
| category→category | `/ru/products/novogodnyaya-upakovka` | `/ru/products/upakovka-dlya-vina` | подарочная упаковка для алкоголя |
| category→category | `/ru/products/novogodnyaya-upakovka` | `/ru/products/tovary-dlya-prazdnikov` | товары для праздника под вашей маркой |
| article→category | `/ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina` | `/ru/products/gofrokorobki` | почтовые коробки с логотипом |
| category→article | `/ru/products/gofrokorobki` | `/ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina` | как заказать почтовые коробки для интернет-магазина |
| article→category | `/ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina` | `/ru/products/tsvetnye-korobki` | упаковка для косметики и розницы |
| category→article | `/ru/products/tsvetnye-korobki` | `/ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina` | гид по коробкам для маркетплейсов |
| article→category | `/ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina` | `/ru/products/izdeliya-iz-tsellyulozy` | упаковка из формованной целлюлозы |
| category→article | `/ru/products/izdeliya-iz-tsellyulozy` | `/ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina` | как выбрать коробку для интернет-магазина |
| article→category | `/ru/articles/korporativnye-podarki-upakovka-s-logotipom` | `/ru/products/podarochnye-korobki` | премиальная подарочная упаковка |
| category→article | `/ru/products/podarochnye-korobki` | `/ru/articles/korporativnye-podarki-upakovka-s-logotipom` | как спланировать упаковку для корпоративных подарков |
| article→category | `/ru/articles/korporativnye-podarki-upakovka-s-logotipom` | `/ru/products/novogodnyaya-upakovka` | новогодняя упаковка на заказ |
| category→article | `/ru/products/novogodnyaya-upakovka` | `/ru/articles/korporativnye-podarki-upakovka-s-logotipom` | упаковка корпоративных подарков к Новому году |
| article→category | `/ru/articles/korporativnye-podarki-upakovka-s-logotipom` | `/ru/products/upakovka-dlya-vina` | коробки для бутылок с логотипом |
| category→article | `/ru/products/upakovka-dlya-vina` | `/ru/articles/korporativnye-podarki-upakovka-s-logotipom` | гид по корпоративной подарочной упаковке |
