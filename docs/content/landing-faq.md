# 品类落地页 FAQ 草稿 / Landing-page FAQ drafts（12 个品类，英俄）

> Refs #99 #209 #217 · 结构照 #217 `design/landing/README.md` 第 5 区块：`<h2>` + `<details><summary>`。
> **状态：草稿。FAQ 在 Ryan 定稿前不渲染（#217）。俄语全部 ⚠️ 待 Ryan 校对（ждёт вычитки Ryan）。**

## 约定 / Conventions（前端、内容都要遵守）
1. **占位符**：所有事实（MOQ、交期、样品费、模具费、价格、证书、环保说法（可降解、可堆肥等）、工厂直供、回复时限、发货范围和俄罗斯配送）一律写字面占位符 `{{待Ryan确认}}`，不编任何数字或说法。
2. **含 `{{…}}` 的问答不渲染**：只要一条问答（问题或答案）里还有 `{{…}}`，这一条就不出现在页面上，也**不进 FAQPage JSON-LD**。
3. **生产环境测试**：生产构建如果发现任何 `{{…}}` 占位符，测试直接失败（前端在接入时加）。
4. **JSON-LD 开关**：FAQPage JSON-LD 还要受 `NEXT_PUBLIC_FAQ_JSONLD_ENABLED` 控制，默认关闭；Ryan 定稿且开关打开后才输出（#192）。
5. 一个品类只要剩下少于 2 条可渲染问答，就整块不显示（避免空 FAQ）。
6. 俄语：全站用 ё；术语 «гофрокороба»、CTA «Запросить расчёт»、品类名 «Новогодняя упаковка»。
7. 问题按真实买家搜索意图写（MOQ、交期、打样、材料、印刷、运输），不堆关键词；答案在折叠状态下也保留在 HTML 里（`<details>`）。

| key | EN slug | RU slug | 条数 |
|---|---|---|---|
| `corrugated-boxes` | `custom-corrugated-boxes` | `gofrokorobki` | 5 |
| `color-boxes` | `custom-printed-boxes` | `tsvetnye-korobki` | 5 |
| `gift-boxes` | `custom-gift-boxes` | `podarochnye-korobki` | 5 |
| `pulp-molding` | `molded-pulp-packaging` | `izdeliya-iz-tsellyulozy` | 5 |
| `paper-cups` | `custom-paper-cups` | `bumazhnye-stakany` | 5 |
| `party-supplies` | `custom-party-supplies` | `tovary-dlya-prazdnikov` | 5 |
| `wine-boxes` | `custom-wine-boxes` | `upakovka-dlya-vina` | 5 |
| `color-printing` | `custom-color-printing` | `tsvetnaya-pechat` | 5 |
| `offset-printing` | `offset-printing-services` | `ofsetnaya-pechat` | 5 |
| `eco-paper-cups` | `eco-paper-cups` | `ekologichnye-stakany` | 5 |
| `gift-cards` | `custom-greeting-cards` | `otkrytki-na-zakaz` | 4 |
| `christmas-merchandise` | `custom-christmas-packaging` | `novogodnyaya-upakovka` | 5 |

---

## `corrugated-boxes` — EN `/en/products/custom-corrugated-boxes` · RU `/ru/products/gofrokorobki`（Гофрокороба на заказ）

### EN

<details id="faq-corrugated-boxes-en-1"><summary>What is the minimum order quantity for custom corrugated boxes?</summary>

Our MOQ is {{待Ryan确认}}. Tell us your box size and quantity, and we will confirm the MOQ in your quote.

</details>

<details id="faq-corrugated-boxes-en-2"><summary>Which flute and board should I choose for shipping?</summary>

It depends on the product weight, how fragile it is, and how the box ships (parcel or pallet). Send us the product details and we will recommend a board in the quote. Available flute types: {{待Ryan确认}}.

</details>

<details id="faq-corrugated-boxes-en-3"><summary>Can you print my logo on the inside and outside of the box?</summary>

Printing options for the inside and outside are {{待Ryan确认}}. Send your artwork with the quote request and we will confirm what is possible for your box style.

</details>

<details id="faq-corrugated-boxes-en-4"><summary>How long does production take?</summary>

Sample lead time: {{待Ryan确认}}. Production lead time: {{待Ryan确认}}. The exact timeline is confirmed in your quote.

</details>

<details id="faq-corrugated-boxes-en-5"><summary>Can I get a sample before the full order?</summary>

Yes, you can approve a digital proof first, then a physical sample. Sample fee: {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-corrugated-boxes-ru-1"><summary>Какой минимальный тираж гофрокоробов на заказ?</summary>

Минимальный тираж — {{待Ryan确认}}. Укажите размер и количество коробок, и мы подтвердим тираж в расчёте.

</details>

<details id="faq-corrugated-boxes-ru-2"><summary>Какой профиль гофрокартона выбрать для доставки?</summary>

Это зависит от веса и хрупкости товара и от способа доставки (посылкой или на паллетах). Пришлите параметры товара, и мы предложим картон в расчёте. Доступные профили: {{待Ryan确认}}.

</details>

<details id="faq-corrugated-boxes-ru-3"><summary>Можно ли напечатать логотип снаружи и внутри коробки?</summary>

Варианты печати снаружи и внутри — {{待Ryan确认}}. Приложите макет к заявке, и мы подтвердим, что возможно для вашей конструкции.

</details>

<details id="faq-corrugated-boxes-ru-4"><summary>Сколько времени занимает производство?</summary>

Срок изготовления образца — {{待Ryan确认}}. Срок производства тиража — {{待Ryan确认}}. Точные сроки указываем в расчёте.

</details>

<details id="faq-corrugated-boxes-ru-5"><summary>Можно ли получить образец до заказа тиража?</summary>

Да, сначала вы согласуете цифровую пробу, затем — физический образец. Стоимость образца — {{待Ryan确认}}.

</details>


---

## `color-boxes` — EN `/en/products/custom-printed-boxes` · RU `/ru/products/tsvetnye-korobki`（Картонные коробки с печатью）

### EN

<details id="faq-color-boxes-en-1"><summary>What is the minimum order quantity for custom printed boxes?</summary>

Our MOQ is {{待Ryan确认}}. It is confirmed in your quote based on size, print and finish.

</details>

<details id="faq-color-boxes-en-2"><summary>What file format should my artwork be in?</summary>

Vector files (AI, PDF or Encapsulated PostScript) with fonts outlined work best. We send you a dieline so you can place the artwork, then a digital proof to approve before printing.

</details>

<details id="faq-color-boxes-en-3"><summary>Can you match my brand colors exactly?</summary>

Send your Pantone references or a physical color sample. Color-matching options and tolerances are {{待Ryan确认}}; we confirm them before printing.

</details>

<details id="faq-color-boxes-en-4"><summary>Which finishes are available?</summary>

Available finishes (e.g. matte or gloss lamination, foil, spot UV, embossing) are {{待Ryan确认}}. Tell us the look you want and we will suggest options in the quote.

</details>

<details id="faq-color-boxes-en-5"><summary>How long does it take from proof to delivery?</summary>

Production lead time: {{待Ryan确认}}. Shipping time depends on the destination and method: {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-color-boxes-ru-1"><summary>Какой минимальный тираж картонных коробок с печатью?</summary>

Минимальный тираж — {{待Ryan确认}}. Его подтверждаем в расчёте с учётом размера, печати и отделки.

</details>

<details id="faq-color-boxes-ru-2"><summary>В каком формате прислать макет?</summary>

Лучше всего векторные файлы (AI, PDF или Encapsulated PostScript) с переведёнными в кривые шрифтами. Мы пришлём развёртку для размещения макета, а затем цифровую пробу на согласование перед печатью.

</details>

<details id="faq-color-boxes-ru-3"><summary>Можно ли точно попасть в фирменные цвета?</summary>

Пришлите номера Pantone или физический образец цвета. Варианты подбора цвета и допуски — {{待Ryan确认}}; подтверждаем их до печати.

</details>

<details id="faq-color-boxes-ru-4"><summary>Какие виды отделки доступны?</summary>

Доступная отделка (например, матовая или глянцевая ламинация, фольга, выборочный лак, тиснение) — {{待Ryan确认}}. Опишите желаемый вид, и мы предложим варианты в расчёте.

</details>

<details id="faq-color-boxes-ru-5"><summary>Сколько времени проходит от пробы до доставки?</summary>

Срок производства — {{待Ryan确认}}. Срок доставки зависит от направления и способа: {{待Ryan确认}}.

</details>


---

## `gift-boxes` — EN `/en/products/custom-gift-boxes` · RU `/ru/products/podarochnye-korobki`（Подарочные коробки на заказ）

### EN

<details id="faq-gift-boxes-en-1"><summary>What styles of rigid gift boxes can you make?</summary>

Common styles include magnetic closure, lid and base, drawer (sleeve) and book-style boxes. Which styles we offer for your size: {{待Ryan确认}}.

</details>

<details id="faq-gift-boxes-en-2"><summary>Can you add a custom insert to hold my product?</summary>

Insert materials (e.g. EVA foam, paperboard, molded pulp) are {{待Ryan确认}}. Send product dimensions or a sample so the insert fits.

</details>

<details id="faq-gift-boxes-en-3"><summary>What is the minimum order quantity for gift boxes?</summary>

Our MOQ is {{待Ryan确认}}.

</details>

<details id="faq-gift-boxes-en-4"><summary>Can I see a sample before mass production?</summary>

Yes. Sample lead time: {{待Ryan确认}}. Sample fee: {{待Ryan确认}}.

</details>

<details id="faq-gift-boxes-en-5"><summary>How are rigid boxes protected during shipping?</summary>

Packing method for shipping: {{待Ryan确认}}. We confirm packing and shipping terms in your quote.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-gift-boxes-ru-1"><summary>Какие виды жёстких подарочных коробок вы делаете?</summary>

Распространённые варианты: с магнитным клапаном, крышка-дно, выдвижные (пенал) и коробки-книжки. Какие варианты доступны для вашего размера — {{待Ryan确认}}.

</details>

<details id="faq-gift-boxes-ru-2"><summary>Можно ли сделать ложемент под мой товар?</summary>

Материалы ложементов (например, EVA, картон, формованная целлюлоза) — {{待Ryan确认}}. Пришлите размеры товара или образец, чтобы ложемент сел точно.

</details>

<details id="faq-gift-boxes-ru-3"><summary>Какой минимальный тираж подарочных коробок?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-gift-boxes-ru-4"><summary>Можно ли увидеть образец до запуска тиража?</summary>

Да. Срок изготовления образца — {{待Ryan确认}}. Стоимость образца — {{待Ryan确认}}.

</details>

<details id="faq-gift-boxes-ru-5"><summary>Как жёсткие коробки защищают при перевозке?</summary>

Способ упаковки для отгрузки — {{待Ryan确认}}. Упаковку и условия поставки подтверждаем в расчёте.

</details>


---

## `pulp-molding` — EN `/en/products/molded-pulp-packaging` · RU `/ru/products/izdeliya-iz-tsellyulozy`（Упаковка из формованной целлюлозы）

### EN

<details id="faq-pulp-molding-en-1"><summary>What is molded pulp packaging made from?</summary>

Molded pulp is formed from paper fiber. The exact raw material for your order is {{待Ryan确认}}.

</details>

<details id="faq-pulp-molding-en-2"><summary>Do I need a custom mold, and what does it cost?</summary>

A custom tray shape usually needs a mold. Mold fee: {{待Ryan确认}}. Mold lead time: {{待Ryan确认}}.

</details>

<details id="faq-pulp-molding-en-3"><summary>Which end-of-life claims can be made for molded pulp?</summary>

Do not assume: it depends on the material and certification. Certifications: {{待Ryan确认}}. We only state such claims when documents exist.

</details>

<details id="faq-pulp-molding-en-4"><summary>Is molded pulp suitable for inserts for electronics or cosmetics?</summary>

Send your product so we can check fit and protection; suitability for your product is confirmed after sampling.

</details>

<details id="faq-pulp-molding-en-5"><summary>What is the minimum order quantity?</summary>

Our MOQ is {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-pulp-molding-ru-1"><summary>Из чего делают упаковку из формованной целлюлозы?</summary>

Формованную целлюлозу получают из бумажного волокна. Конкретное сырьё для вашего заказа — {{待Ryan确认}}.

</details>

<details id="faq-pulp-molding-ru-2"><summary>Нужна ли индивидуальная пресс-форма и сколько она стоит?</summary>

Для лотка нестандартной формы обычно нужна пресс-форма. Стоимость формы — {{待Ryan确认}}. Срок изготовления — {{待Ryan确认}}.

</details>

<details id="faq-pulp-molding-ru-3"><summary>Какие экологические заявления можно делать для формованной целлюлозы?</summary>

Не стоит предполагать заранее: это зависит от материала и сертификации. Сертификаты — {{待Ryan确认}}. Такие формулировки используем только при наличии документов.

</details>

<details id="faq-pulp-molding-ru-4"><summary>Подходит ли формованная целлюлоза для ложементов для электроники или косметики?</summary>

Пришлите товар, чтобы мы проверили посадку и защиту; пригодность подтверждаем после образца.

</details>

<details id="faq-pulp-molding-ru-5"><summary>Какой минимальный тираж?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>


---

## `paper-cups` — EN `/en/products/custom-paper-cups` · RU `/ru/products/bumazhnye-stakany`（Бумажные стаканы с логотипом）

### EN

<details id="faq-paper-cups-en-1"><summary>What sizes of custom paper cups are available?</summary>

Available sizes: {{待Ryan确认}}. Tell us the drink and volume you need and we will match a cup.

</details>

<details id="faq-paper-cups-en-2"><summary>Single wall or double wall: which do I need?</summary>

Double-wall cups keep hot drinks more comfortable to hold without a sleeve; single-wall cups suit cold drinks or are used with a sleeve. Available options: {{待Ryan确认}}.

</details>

<details id="faq-paper-cups-en-3"><summary>Which documents are available for the inks and cups?</summary>

Compliance documents: {{待Ryan确认}}. We share them before you order.

</details>

<details id="faq-paper-cups-en-4"><summary>What is the minimum order quantity for printed cups?</summary>

Our MOQ is {{待Ryan确认}}.

</details>

<details id="faq-paper-cups-en-5"><summary>Do you also supply matching lids and sleeves?</summary>

Lids and sleeves: {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-paper-cups-ru-1"><summary>Какие объёмы бумажных стаканов доступны?</summary>

Доступные объёмы — {{待Ryan确认}}. Укажите напиток и нужный объём, и мы подберём стакан.

</details>

<details id="faq-paper-cups-ru-2"><summary>Однослойный или двухслойный стакан — что выбрать?</summary>

Двухслойный стакан удобнее держать с горячим напитком без манжеты; однослойный подходит для холодных напитков или используется с манжетой. Доступные варианты — {{待Ryan确认}}.

</details>

<details id="faq-paper-cups-ru-3"><summary>Какие документы есть для красок и стаканов?</summary>

Документы о соответствии — {{待Ryan确认}}. Предоставим их до заказа.

</details>

<details id="faq-paper-cups-ru-4"><summary>Какой минимальный тираж стаканов с печатью?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-paper-cups-ru-5"><summary>Есть ли крышки и манжеты в комплект?</summary>

Крышки и манжеты — {{待Ryan确认}}.

</details>


---

## `party-supplies` — EN `/en/products/custom-party-supplies` · RU `/ru/products/tovary-dlya-prazdnikov`（Бумажная посуда для праздника）

### EN

<details id="faq-party-supplies-en-1"><summary>Which party products can you print?</summary>

Typical items are paper plates, cups, napkins and party hats. Our current product list: {{待Ryan确认}}.

</details>

<details id="faq-party-supplies-en-2"><summary>Can I order a matching set in one design?</summary>

Yes, you can send one design to apply across the items you choose. We confirm the item list and print method in the quote.

</details>

<details id="faq-party-supplies-en-3"><summary>Can you produce private-label party products for retail?</summary>

Retail packaging and private-label options: {{待Ryan确认}}. Tell us your channel (retail, e-commerce, events).

</details>

<details id="faq-party-supplies-en-4"><summary>What is the minimum order quantity?</summary>

Our MOQ is {{待Ryan确认}}.

</details>

<details id="faq-party-supplies-en-5"><summary>How early should I order for a seasonal event?</summary>

Production lead time is {{待Ryan确认}}, plus shipping time ({{待Ryan确认}}). Contact us early so proofs and samples fit your launch date.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-party-supplies-ru-1"><summary>Какие товары для праздника можно напечатать?</summary>

Обычно это бумажные тарелки, стаканы, салфетки и праздничные колпаки. Актуальный перечень — {{待Ryan确认}}.

</details>

<details id="faq-party-supplies-ru-2"><summary>Можно ли заказать набор в едином дизайне?</summary>

Да, вы присылаете один дизайн, и мы применяем его ко всем выбранным позициям. Перечень и способ печати подтверждаем в расчёте.

</details>

<details id="faq-party-supplies-ru-3"><summary>Делаете ли вы товары для праздника под собственной маркой для розницы?</summary>

Розничная упаковка под вашим брендом — с печатью логотипа и фирменного дизайна. Расскажите о канале продаж (розница, интернет-магазин, мероприятия).

</details>

<details id="faq-party-supplies-ru-4"><summary>Какой минимальный тираж?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-party-supplies-ru-5"><summary>Как заранее заказывать к сезонному празднику?</summary>

Срок производства — {{待Ryan确认}}, плюс доставка ({{待Ryan确认}}). Свяжитесь с нами заранее, чтобы пробы и образцы успели к вашей дате.

</details>


---

## `wine-boxes` — EN `/en/products/custom-wine-boxes` · RU `/ru/products/upakovka-dlya-vina`（Коробки для вина на заказ）

### EN

<details id="faq-wine-boxes-en-1"><summary>Can you make boxes for one, two or more bottles?</summary>

Box formats for one or several bottles are {{待Ryan确认}}. Send the bottle dimensions (height and diameter) for an accurate fit.

</details>

<details id="faq-wine-boxes-en-2"><summary>Which closure and insert options are available?</summary>

Options such as magnetic flaps, lid and base, and bottle inserts are {{待Ryan确认}}.

</details>

<details id="faq-wine-boxes-en-3"><summary>Can you add foil stamping or embossing for a premium look?</summary>

Finishes for wine boxes: {{待Ryan确认}}. We suggest options based on your label design.

</details>

<details id="faq-wine-boxes-en-4"><summary>What is the minimum order quantity for wine boxes?</summary>

Our MOQ is {{待Ryan确认}}.

</details>

<details id="faq-wine-boxes-en-5"><summary>How long does production take before the holiday season?</summary>

Sample lead time: {{待Ryan确认}}. Production lead time: {{待Ryan确认}}. Plan proofs and samples early for seasonal launches.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-wine-boxes-ru-1"><summary>Делаете ли вы коробки на одну, две и более бутылок?</summary>

Форматы на одну или несколько бутылок — {{待Ryan确认}}. Пришлите размеры бутылки (высоту и диаметр) для точной посадки.

</details>

<details id="faq-wine-boxes-ru-2"><summary>Какие варианты клапанов и ложементов доступны?</summary>

Варианты — магнитный клапан, крышка-дно, ложемент под бутылку — {{待Ryan确认}}.

</details>

<details id="faq-wine-boxes-ru-3"><summary>Можно ли добавить тиснение фольгой или конгрев для премиального вида?</summary>

Отделка для винных коробок — {{待Ryan确认}}. Предложим варианты под дизайн вашей этикетки.

</details>

<details id="faq-wine-boxes-ru-4"><summary>Какой минимальный тираж коробок для вина?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-wine-boxes-ru-5"><summary>Сколько занимает производство перед праздничным сезоном?</summary>

Срок изготовления образца — {{待Ryan确认}}. Срок производства — {{待Ryan确认}}. К сезонным запускам лучше начинать с пробами и образцами заранее.

</details>


---

## `color-printing` — EN `/en/products/custom-color-printing` · RU `/ru/products/tsvetnaya-pechat`（Печать упаковки на заказ）

### EN

<details id="faq-color-printing-en-1"><summary>What is the difference between CMYK and Pantone printing?</summary>

CMYK builds colors from four process inks and suits photos and gradients. Pantone (spot) inks are pre-mixed for exact brand colors. Many jobs combine both.

</details>

<details id="faq-color-printing-en-2"><summary>Will the printed color match my screen?</summary>

Screens show RGB, so printed colors can differ. We recommend approving a proof. Proof types (digital or physical): {{待Ryan确认}}.

</details>

<details id="faq-color-printing-en-3"><summary>Which materials can you print on?</summary>

Printable materials for your job: {{待Ryan确认}}.

</details>

<details id="faq-color-printing-en-4"><summary>What is the minimum print run?</summary>

Our minimum print run is {{待Ryan确认}}.

</details>

<details id="faq-color-printing-en-5"><summary>How should I prepare print-ready files?</summary>

Use CMYK or specified Pantone colors, add bleed, outline fonts and supply images at print resolution. We check every file and send a proof before printing.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-color-printing-ru-1"><summary>Чем печать CMYK отличается от печати пантонами?</summary>

CMYK собирает цвет из четырёх триадных красок и подходит для фото и градиентов. Пантоны — заранее смешанные краски для точных фирменных цветов. Часто их сочетают.

</details>

<details id="faq-color-printing-ru-2"><summary>Совпадёт ли цвет печати с экраном?</summary>

Экран показывает RGB, поэтому цвет на печати может отличаться. Рекомендуем согласовать пробу. Виды проб (цифровая или физическая) — {{待Ryan确认}}.

</details>

<details id="faq-color-printing-ru-3"><summary>На каких материалах вы печатаете?</summary>

Материалы для печати — {{待Ryan确认}}.

</details>

<details id="faq-color-printing-ru-4"><summary>Какой минимальный тираж печати?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-color-printing-ru-5"><summary>Как подготовить файлы к печати?</summary>

Используйте CMYK или указанные пантоны, добавьте вылеты, переведите шрифты в кривые и дайте изображения в печатном разрешении. Мы проверяем каждый файл и присылаем пробу перед печатью.

</details>


---

## `offset-printing` — EN `/en/products/offset-printing-services` · RU `/ru/products/ofsetnaya-pechat`（Офсетная печать упаковки）

### EN

<details id="faq-offset-printing-en-1"><summary>When is offset printing better than digital printing?</summary>

Offset is usually more cost-effective for larger runs and gives consistent color across the run; digital suits short runs and variable data. We recommend a method based on your quantity.

</details>

<details id="faq-offset-printing-en-2"><summary>What can you print with offset?</summary>

Typical items are boxes, catalogs, booklets and labels. What can be printed for your project: {{待Ryan确认}}.

</details>

<details id="faq-offset-printing-en-3"><summary>What is the minimum order quantity for offset printing?</summary>

Our MOQ is {{待Ryan确认}}.

</details>

<details id="faq-offset-printing-en-4"><summary>Which post-press finishing do you offer?</summary>

Finishing options (lamination, varnish, foil, die-cutting, binding): {{待Ryan确认}}.

</details>

<details id="faq-offset-printing-en-5"><summary>How long does an offset print job take?</summary>

Production lead time: {{待Ryan确认}}, confirmed in your quote after artwork approval.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-offset-printing-ru-1"><summary>Когда офсетная печать выгоднее цифровой?</summary>

Офсет обычно выгоднее на больших тиражах и даёт стабильный цвет по всему тиражу; цифровая печать подходит для малых тиражей и переменных данных. Метод подбираем по вашему тиражу.

</details>

<details id="faq-offset-printing-ru-2"><summary>Что можно напечатать офсетом?</summary>

Обычно это коробки, каталоги, буклеты и этикетки. Что можно напечатать для вашего проекта — {{待Ryan确认}}.

</details>

<details id="faq-offset-printing-ru-3"><summary>Какой минимальный тираж для офсетной печати?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-offset-printing-ru-4"><summary>Какую постпечатную обработку вы предлагаете?</summary>

Постпечатная обработка (ламинация, лак, фольга, высечка, переплёт) — {{待Ryan确认}}.

</details>

<details id="faq-offset-printing-ru-5"><summary>Сколько времени занимает офсетная печать?</summary>

Срок производства — {{待Ryan确认}}; подтверждаем в расчёте после согласования макета.

</details>


---

## `eco-paper-cups` — EN `/en/products/eco-paper-cups` · RU `/ru/products/ekologichnye-stakany`（Экологичные стаканы）

### EN

<details id="faq-eco-paper-cups-en-1"><summary>Which environmental claims can be made for these cups?</summary>

We make no end-of-life claims without certification. Certifications: {{待Ryan确认}}. If a certificate exists for the exact cup, we share it before you order.

</details>

<details id="faq-eco-paper-cups-en-2"><summary>Which coating options are available?</summary>

Coating options are confirmed per order. Which coatings we offer: {{待Ryan确认}}.

</details>

<details id="faq-eco-paper-cups-en-3"><summary>Can I print environmental claims on my cups?</summary>

Only with valid documentation for that exact product. Wording that needs a certificate is {{待Ryan确认}}.

</details>

<details id="faq-eco-paper-cups-en-4"><summary>Are these cups suitable for hot drinks?</summary>

Suitability for hot and cold drinks depends on the lining and wall type: {{待Ryan确认}}.

</details>

<details id="faq-eco-paper-cups-en-5"><summary>What is the minimum order quantity?</summary>

Our MOQ is {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-eco-paper-cups-ru-1"><summary>Какие экологические заявления можно делать для этих стаканов?</summary>

Мы не делаем заявлений об утилизации без сертификата. Сертификаты — {{待Ryan确认}}. Если на конкретный стакан есть сертификат, предоставим его до заказа.

</details>

<details id="faq-eco-paper-cups-ru-2"><summary>Какие варианты покрытия доступны?</summary>

Варианты покрытия уточняем под заказ. Какие покрытия доступны — {{待Ryan确认}}.

</details>

<details id="faq-eco-paper-cups-ru-3"><summary>Можно ли печатать экологические заявления на стаканах?</summary>

Только при наличии документов на конкретный продукт. Какие формулировки требуют сертификата — {{待Ryan确认}}.

</details>

<details id="faq-eco-paper-cups-ru-4"><summary>Подходят ли эти стаканы для горячих напитков?</summary>

Пригодность для горячих и холодных напитков зависит от покрытия и количества слоёв — {{待Ryan确认}}.

</details>

<details id="faq-eco-paper-cups-ru-5"><summary>Какой минимальный тираж?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>


---

## `gift-cards` — EN `/en/products/custom-greeting-cards` · RU `/ru/products/otkrytki-na-zakaz`（Печать открыток на заказ）

### EN

<details id="faq-gift-cards-en-1"><summary>Do you print paper gift cards, plastic cards or greeting cards?</summary>

Card types that can be printed: {{待Ryan确认}}. (Wording "gift cards" vs "greeting cards" is pending Ryan, see #218 F16.)

</details>

<details id="faq-gift-cards-en-2"><summary>Can each card have a unique number, barcode or QR code?</summary>

Variable data printing: {{待Ryan确认}}.

</details>

<details id="faq-gift-cards-en-3"><summary>Do you also make holders, envelopes or boxes for cards?</summary>

Card packaging options: {{待Ryan确认}}. A matching design across card and packaging can be requested in your quote.

</details>

<details id="faq-gift-cards-en-4"><summary>What is the minimum order quantity?</summary>

Our MOQ is {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-gift-cards-ru-1"><summary>Вы печатаете бумажные подарочные карты, пластиковые карты или открытки?</summary>

Виды карт — {{待Ryan确认}}. (Формулировка «подарочные карты» / «открытки» ждёт решения Ryan, см. #218 F16.)

</details>

<details id="faq-gift-cards-ru-2"><summary>Можно ли нанести на каждую карту уникальный номер, штрихкод или QR-код?</summary>

Печать переменных данных — {{待Ryan确认}}.

</details>

<details id="faq-gift-cards-ru-3"><summary>Делаете ли вы держатели, конверты или коробки для карт?</summary>

Упаковка для карт — {{待Ryan确认}}. Единый дизайн карты и упаковки можно указать в заявке на расчёт.

</details>

<details id="faq-gift-cards-ru-4"><summary>Какой минимальный тираж?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>


---

## `christmas-merchandise` — EN `/en/products/custom-christmas-packaging` · RU `/ru/products/novogodnyaya-upakovka`（Новогодняя упаковка）

### EN

<details id="faq-christmas-merchandise-en-1"><summary>When should I order custom Christmas packaging?</summary>

Production lead time is {{待Ryan确认}} and shipping time is {{待Ryan确认}}. Start proofs early so your packaging arrives before the season.

</details>

<details id="faq-christmas-merchandise-en-2"><summary>Can you make custom advent calendars?</summary>

Advent calendar formats: {{待Ryan确认}}.

</details>

<details id="faq-christmas-merchandise-en-3"><summary>Can I order gift boxes in a seasonal design for my brand?</summary>

Yes, send your seasonal artwork or brief. Box styles and finishes are confirmed in your quote.

</details>

<details id="faq-christmas-merchandise-en-4"><summary>What is the minimum order quantity?</summary>

Our MOQ is {{待Ryan确认}}.

</details>

<details id="faq-christmas-merchandise-en-5"><summary>Do you deliver to Russia?</summary>

Shipping regions and delivery to Russia: {{待Ryan确认}}.

</details>


### RU ⚠️ ждёт вычитки Ryan

<details id="faq-christmas-merchandise-ru-1"><summary>Когда заказывать новогоднюю упаковку?</summary>

Срок производства — {{待Ryan确认}}, срок доставки — {{待Ryan确认}}. Начинайте с пробами заранее, чтобы упаковка успела к сезону.

</details>

<details id="faq-christmas-merchandise-ru-2"><summary>Делаете ли вы адвент-календари на заказ?</summary>

Форматы адвент-календарей — {{待Ryan确认}}.

</details>

<details id="faq-christmas-merchandise-ru-3"><summary>Можно ли заказать подарочные коробки в праздничном дизайне с моим брендом?</summary>

Да, пришлите праздничный макет или задание. Конструкцию и отделку подтверждаем в расчёте.

</details>

<details id="faq-christmas-merchandise-ru-4"><summary>Какой минимальный тираж?</summary>

Минимальный тираж — {{待Ryan确认}}.

</details>

<details id="faq-christmas-merchandise-ru-5"><summary>Доставляете ли вы в Россию?</summary>

Регионы доставки и доставка в Россию — {{待Ryan确认}}.

</details>
