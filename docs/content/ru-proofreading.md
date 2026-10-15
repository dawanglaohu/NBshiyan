# Русская вычитка / 俄语校对包（Refs #99）

> 汇总所有等待 Ryan 校对的俄语文本，来源：main、#188、#201、#205、#215、#217、#222。由脚本从各分支提取（2026-10-13 更新：已包含 #222 和 #188/#201/#205 的术语统一），原文件不变；校对意见写在最后一列，确认后由 SEO bot 回写到对应文件。
> 规则：不编造任何数字、认证、评分或价格；**TBD** 原样保留。字符数按 Unicode 字符计（含空格）。
> CSV 版本：`ru-proofreading.csv`（同样的 ID，可以在表格里填）。

## 条目数量

| 分组 | 条目数 |
|---|---|
| 1. 品类落地页 / Category pages（#188） | 414 |
| 2. Metadata（title ≤60 / description ≤160） | 52 |
| 3. Alt text（含 3.1 #220 品类分享图 12 条） | 15 |
| 4. 内链锚文本 / Internal-link anchors（#205） | 48 |
| 5. 站内 SEO 相关界面文案 / SEO-facing UI copy（messages/ru.json） | 39 |
| 6. 落地页设计稿 / Landing design（#217，design/landing/） | 85 |
| 7. /s/<id> 503 与兜底页 / Shortlink 503 & fallback（#215） | 3 |
| 8. 文章 / Articles（#205） | 2 篇，20 个小节（清单）；标题和描述在第 2 组 |

合计 656 条表格条目 + 文章小节清单。

## ⚠️ 重点存疑 / Flagged items（请先看这些）

| # | 条目 ID | 问题 | 原因 |
|---|---|---|---|
| F1 ✅ 已处理 | UI-Home.adv.* (`2 млн+`, `FSC · ISO 9001`, `5–7 дней`, `100%`) | **未经确认的事实** | **已处理（#222）**：按产品经理决定，英俄 4 个数字的 value 已清空，首页只渲染有数值的卡片，全部为空时整个区块不显示，页面上不出现 TBD。数字本身已列入 Ryan 待确认事实清单，确认后填回即可恢复。本表不再列出这 4 个空值。 |
| F2 | MSG-Contact.metaDescription、UI-Home.ctaBandText 等「в течение 24 часов」「напрямую с завода」 | 承诺需确认 | 24 小时回复和「工厂直供」是业务承诺，需 Ryan 确认能做到。 |
| F3 ✅ 已处理 | ART-*-seotitle | 标题超长 | **已处理（#205）**：两篇文章新增 front matter `seo_title`（47 和 50 字符），用于 `<title>` 和 Sanity `seo.title`，`build.py` 已重新生成导入文件；H1（`ART-*-title`，71/80 字符）保持不变。⚠️ 新标题待 Ryan 校对。 |
| F4 ✅ 已处理 | гофрокороб / гофрокоробка / гофрокороба | 术语不统一 | **已处理**：统一为 #188 Yandex 关键词的写法 **гофрокороба**（复数），单数 гофрокороб、属格 гофрокоробов。改动：`Products.names`、`Products.metaDescription`、`Products.desc`（#222），`Meta.description`（#201）。slug `gofrokorobki` 不变；#188 关键词清单里的搜索词变体（如「гофрокоробка с логотипом купить」）原样保留。⚠️ 待 Ryan 校对。 |
| F5 ✅ 已处理 | UI-Products.names.christmas-merchandise | 与 Yandex 关键词不一致、本地化 | **已处理（#222）**：「Рождественская продукция」→「**Новогодняя упаковка**」，与 #188 关键词「новогодняя упаковка на заказ」一致。⚠️ 待 Ryan 校对。 |
| F6 | UI-Products.names.gift-cards「Подарочные карты」/ M-gift-cards-* | 歧义 | 俄语「подарочная карта」通常指预付礼品卡（储值卡），我们卖的是印刷贺卡/卡片。请确认是否改成「открытки」「печать подарочных сертификатов」之类。 |
| F7 ✅ 已处理（расчёт） | е / ё 混用 | 拼写不统一 | **已处理**：「расчёт」及其变格统一用 ё（#188 落地页、#205 文章和导入文件、`categoryMeta.ts`（#222））。其他词（жесткие/жёсткие、истёк 等）未改，仍请 Ryan 决定。#217 设计稿里的「Запросить расчет / Расчет / расчете」需由设计师跟进。 |
| F8 ✅ 已处理 | CTA：「Запросить цену」vs「Запросить расчет」vs「Запросить расчёт стоимости」 | 用语不统一 | **已处理**：按钮和 CTA 统一为「**Запросить расчёт**」：`Nav.quote`、`Home.ctaQuote`（#222），`Contact.title`、`DesignExpired.quote`（#201），#188 落地页 CTA。#201 的 Contact metaTitle「Запросить расчёт стоимости упаковки на заказ」是 SEO 标题，保持较长形式。⚠️ 待 Ryan 校对。 |
| F9 ✅ 已处理 | M-pulp-molding-desc | 拼写 | **已处理（#222）**：「Эко упаковка」→「**Экоупаковка**」。 |
| F10 | M-*-title「… оптом」/「на заказ оптом」 | 关键词堆砌感 | 例如「Новогодняя упаковка на заказ оптом」「Подарочные коробки на заказ оптом」，两个商业词连用，读起来像为 SEO 硬拼，请看是否自然。 |
| F11 | Products.alt「{name}: упаковка на заказ от PackJoyU」 | 格一致 | `{name}` 插入的是复数名词（Гофрокороба 等），后面是单数「упаковка」，读起来可以接受，但请确认。 |
| F12 | ALT-Meta.ogImageAlt / heroLabel | 与图片内容核对 | alt 写的是「коробки, бумажные стаканы и печать」/「Коробки и бумажный стакан」，需等 #208 的分享图定稿后对照画面确认。 |
| F14 | S215-text vs D217 503 文案 | 两处 503 文案不一致 | #215 页面：「Временно недоступно, пожалуйста, попробуйте позже.」（标题和正文重复同一句）；#217 设计稿：「Сейчас не удается загрузить сохраненный дизайн. Попробуйте еще раз через минуту — ваш дизайн сохранен.」。请定一版；另外「ваш дизайн сохранен」是功能承诺，需确认 503 时数据确实没丢。 |
| F15 | D217 FAQ「Доставляете ли вы в Россию? Да…」 | 业务表述 | 和待定的俄罗斯配送/地址表述相关（见下方 TBD），定稿前不要上线。D217 示例数值（`1 000 шт.`、`50 USD`、`15–25 days`）仅是格式示例，不是真实数据。 |
| F13 | C-*（落地页正文） | 偏直译 | 落地页俄语正文与英文逐句对应（本表能逐行配对就是因为结构完全平行），有些句子是英文句式，例如「упаковку которых хочется сохранить」。请重点看每页导语段（每页第 2 条）。 |
| F14 | 全站 | ✅ 产品经理决定：全站统一使用 ё | 已有文本中的 е/ё（如 расчет/расчёт、жесткие/жёсткие）将按此统一；本包新增的 #220 alt 已用 ё。请 Ryan 校对时一并留意。 |
| F15 | ALT-OG-ekologichnye-stakany | 「Биоразлагаемые」改为「Экологичные」 | 「биоразлагаемый/компостируемый」属于需要认证支撑的声明。**需要 Ryan 提供认证**（证书名称/编号/链接）后才能恢复该说法。H1、meta（`categoryMeta.ts`、`docs/seo-category-meta.md`）、`messages/ru.json` 和内链锚文本已同步改为「Экологичные」（seo/yo-unification、#188、#205）。英文见 F17。 |
| F16 | ALT-OG-podarochnye-karty / 英文 slug `custom-gift-cards` | gift cards 的含义（俄英都有） | 「подарочные карты」在俄语里通常指储值礼品卡（подарочный сертификат）；如果产品是贺卡/祝福卡，应改为「открытки」。英文 slug `custom-gift-cards` 同样有歧义：英文搜索里 "gift cards" 多指储值卡，贺卡应为 `custom-greeting-cards`。影响 alt、H1、slug（英俄）和 meta，请 Ryan 确认；未上线，改 slug 不需要 301。 |
| F17 | 英文 eco-paper-cups（`M-eco-paper-cups-*`、#188 落地页、`messages/en.json`、#220 英文 alt） | 「Compostable」改为「Eco-friendly」 | 与 F15 相同：compostable / biodegradable 需要证书支撑。Ryan 提供认证（证书名称/编号/链接）前，英文统一用 Eco-friendly；英文 slug 也由 `compostable-paper-cups` 改为 `eco-paper-cups`（从未上线，不需要 301）。 |
| F18 | eco-paper-cups 卖点「FSC-certified board」/「Картон с сертификатом FSC」（`messages/en.json`、`messages/ru.json` 的 eco-paper-cups 列表） | 已隐藏（seo/yo-unification `b61a363`） | FSC 认证属于需要出处的声明，目前没有证书依据。**需要 Ryan 提供 FSC 证书**（持证主体、证书编号 FSC-C……、范围、有效期、可公开验证的链接）后才能恢复。设计稿里的 Compostable 由 UX 改，3D 贴图由产品经理转 3D。俄语原文待 Ryan 校对。 |
| F19 | 「24 小时内回复」/「в течение 24 часов」（`messages/*.json` 的 `ctaBandText`、联系表单 `reply`、`contactText`，以及 /contact meta description） | 已隐藏，统一改为「a packaging specialist will reply by email」/「специалист по упаковке ответит вам по email」（seo/yo-unification `db5fd13`、`7a21bcf`、ef26703） | 回复时限是对客户的承诺，未经确认。**需要 Ryan 确认**实际可承诺的回复时间。后端的询盘/样品确认邮件模板里也有「will reply within {{replyTime}}」（`CONTACT_REPLY_TIME` 未设置时默认 24 小时，英俄都有），由后端在 #171 线上处理。俄语原文待 Ryan 校对。 |
| F20 | `categoryMeta.ts` 描述（corrugated-boxes、paper-cups、eco-paper-cups，英俄）和 `messages/*.json` party-supplies 卖点 | 已隐藏/改为中性说法（seo/yo-unification `7a21bcf`） | 「Factory-direct export」/「Прямые поставки с фабрики」「Оптом с фабрики」、「Food-safe inks」/「Пищевые краски」「безопасные краски」、「water-based or PLA lining」/「водной или PLA основой」都没有确认依据。**需要 Ryan 确认**是否工厂直供出口、油墨是否有食品安全认证（标准/报告）、杯子内衬实际材料，确认后再恢复。另有 `tests/unconfirmed-claims.test.ts` 防止这些说法回流。俄语原文待 Ryan 校对。 |
| F21 | 「Samples are free of charge」/ 样品免费（后端询盘/样品确认邮件模板，#171 线；网站文案目前没有） | 网站侧由 `tests/unconfirmed-claims.test.ts` 拦截；如需说明费用，统一用「Any costs will be confirmed by email before dispatch」/「Все расходы мы согласуем с вами по email до отправки」（俄语待 Ryan 校对） | 样品是否免费未经确认。**需要 Ryan 确认**样品与运费政策。邮件模板由后端在 #171 合入后单独 PR 处理。 |
| F22 | 「Water-based, plastic-free coating」/「Водное покрытие без пластика」（eco-paper-cups 卖点）；同类：eco-paper-cups 简介「water-based coatings / покрытие на водной основе」、pulp-molding「plastic-free / без пластика / вместо пластика」；设计稿里的「FDA-compliant」「Plastic-free inserts replacing EPS foam」 | 网站侧改为「Coating options confirmed per order」/「Варианты покрытия уточняем под заказ」，pulp-molding 去掉 plastic-free 说法（俄语待 Ryan 校对）；`tests/unconfirmed-claims.test.ts` 拦截 plastic-free/без пластика、water-based/водное покрытие、FDA、EPS/泡沫替代说法 | 涂层材料、无塑、FDA 合规、替代 EPS 均未经确认。**需要 Ryan 确认**涂层类型和相关证明文件后再恢复。 |

说明：F1、F3、F4、F5、F7（расчёт）、F8、F9 已按产品经理决定处理（标 ✅），改动后的俄语仍待 Ryan 校对。F2 仍是待确认的业务承诺（24 小时回复、工厂直供），本轮未改。其余是语言判断，需要母语者决定。

## 🔴 Ryan 需要提供的业务信息（TBD）

| 项目 | 状态 | 用在哪里 |
|---|---|---|
| 最小起订量 MOQ（每个品类） | **TBD** | 12 个落地页规格表「Минимальный тираж」 |
| 打样周期 / 生产周期（每个品类） | **TBD** | 落地页「Срок изготовления образца / Срок производства」、文章「Сроки」小节 |
| 认证（名称、证书号、链接） | **TBD** | 首页 `FSC · ISO 9001`（见 F1）、落地页、/api/specs |
| 贸易条款（FOB/CIF/DDP 等） | **TBD** | 落地页「условия поставки — в расчете」、/api/specs `tradeTerms` |
| 俄罗斯清关条款（谁清关、文件、EAC 等） | **TBD** | industries.md 文章 5、文章「Доставка」小节 |
| 俄罗斯配送范围与真实地址的表述 | **TBD** | Yandex 地区设为俄罗斯的前提（产品经理已列入待决） |
| 首页数字：产能、认证、打样天数、环保比例 | **待确认，已隐藏（#222）** | 见 F1 |

## 1. 品类落地页 / Category pages（#188）

每个品类：先 meta 以外的正文（H1、导语、卖点、规格、流程、CTA、FAQ），再 Yandex 关键词和俄语文章选题。行业关键词（IND-*）在最后。

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| C-eco-paper-cups-01 | `docs/content/eco-paper-cups.md` | #188 | ### H1: Eco-Friendly Paper Cups | ### H1: Экологичные стаканы с логотипом ⚠️F15/F17 |  |  |
| C-eco-paper-cups-02 | `docs/content/eco-paper-cups.md` | #188 | PackJoyU offers paper cups custom printed with your logo. These cups are designed for cafes, chains and brands. Exact compostability claims depend on the lining, inks and the certification held for each product — we confirm documentation before you use any claim on your packaging. | PackJoyU предлагает бумажные стаканы с печатью вашего логотипа. Они подходят кофейням, сетям и брендам. Заявления о компостируемости зависят от покрытия, красок и сертификатов на конкретный продукт — мы подтверждаем документы до того, как вы используете такие формулировки на упаковке. |  |  |
| C-eco-paper-cups-03 | `docs/content/eco-paper-cups.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-eco-paper-cups-04 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-05 | `docs/content/eco-paper-cups.md` | #188 | - **Branded and greener** — Full-wrap logo printing. | - **Бренд и экология** — Печать логотипа по всей поверхности. |  |  |
| C-eco-paper-cups-06 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-07 | `docs/content/eco-paper-cups.md` | #188 | - **Honest claims** — Certification documents verified per product before marketing use. | - **Честные формулировки** — Сертификаты проверяются до использования в маркетинге. |  |  |
| C-eco-paper-cups-08 | `docs/content/eco-paper-cups.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-eco-paper-cups-09 | `docs/content/eco-paper-cups.md` | #188 | Lining \| On request | Покрытие \| По запросу |  |  |
| C-eco-paper-cups-10 | `docs/content/eco-paper-cups.md` | #188 | Types \| Single / double wall | Виды \| Однослойные / двухслойные |  |  |
| C-eco-paper-cups-11 | `docs/content/eco-paper-cups.md` | #188 | Sizes \| On request | Объемы \| По запросу |  |  |
| C-eco-paper-cups-12 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-13 | `docs/content/eco-paper-cups.md` | #188 | Accessories \| On request | Аксессуары \| По запросу |  |  |
| C-eco-paper-cups-14 | `docs/content/eco-paper-cups.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-eco-paper-cups-15 | `docs/content/eco-paper-cups.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-eco-paper-cups-16 | `docs/content/eco-paper-cups.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-eco-paper-cups-17 | `docs/content/eco-paper-cups.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-eco-paper-cups-18 | `docs/content/eco-paper-cups.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-eco-paper-cups-19 | `docs/content/eco-paper-cups.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-eco-paper-cups-20 | `docs/content/eco-paper-cups.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-eco-paper-cups-21 | `docs/content/eco-paper-cups.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-eco-paper-cups-22 | `docs/content/eco-paper-cups.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-eco-paper-cups-23 | `docs/content/eco-paper-cups.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-eco-paper-cups-24 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-25 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-26 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-27 | `docs/content/eco-paper-cups.md` | #188 | | |  |  |
| C-eco-paper-cups-28 | `docs/content/eco-paper-cups.md` | #188 | - **Q: Can I print "compostable" on my cups?** | - **В: Можно ли написать «компостируемый» на стакане?** |  |  |
| C-eco-paper-cups-29 | `docs/content/eco-paper-cups.md` | #188 | A: Only with valid certification for that exact product; we will provide documents if available. | О: Только при наличии сертификата на конкретный продукт. |  |  |
| C-eco-paper-cups-kw-Транзакционные | `docs/content/eco-paper-cups.md` | #188 |  | **Транзакционные (主页面)**: биоразлагаемые стаканы, эко стаканы без пластика, компостируемые стаканы оптом, экологичные бумажные стаканы с логотипом |  |  |
| C-eco-paper-cups-kw-Коммерческие | `docs/content/eco-paper-cups.md` | #188 |  | **Коммерческие (主页面 + 小节)**: стаканы с PLA покрытием, экоупаковка для кофейни, бумажные стаканы без полиэтилена |  |  |
| C-eco-paper-cups-kw-Информационные | `docs/content/eco-paper-cups.md` | #188 |  | **Информационные (博客文章)**: чем PLA отличается от ПЭ, перерабатываются ли бумажные стаканы |  |  |
| C-eco-paper-cups-outline-1 | `docs/content/eco-paper-cups.md` | #188 |  | Экостаканы для кофейни: какие бывают и что писать на упаковке |  |  |
| C-eco-paper-cups-outline-2 | `docs/content/eco-paper-cups.md` | #188 |  | H2s: Покрытия; сертификаты; формулировки |  |  |
| C-custom-christmas-packaging-01 | `docs/content/custom-christmas-packaging.md` | #188 | ### H1: Custom Christmas Packaging | ### H1: Новогодняя упаковка на заказ |  |  |
| C-custom-christmas-packaging-02 | `docs/content/custom-christmas-packaging.md` | #188 | PackJoyU produces custom Christmas and holiday packaging for retailers, confectionery, cosmetics and corporate gifting: gift boxes, advent calendars, seasonal sleeves, bags and themed printed products. Holiday packaging is time-critical, so we help you plan structure, artwork and production early to arrive on shelf before the season starts. | PackJoyU производит новогоднюю и праздничную упаковку на заказ для розницы, кондитерских, косметических брендов и корпоративных подарков: подарочные коробки, адвент-календари, сезонные футляры, пакеты и тематическую полиграфию. Новогодняя упаковка — это жесткие сроки, поэтому мы помогаем заранее спланировать конструкцию, дизайн и производство, чтобы продукция была на полке до начала сезона. |  |  |
| C-custom-christmas-packaging-03 | `docs/content/custom-christmas-packaging.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-christmas-packaging-04 | `docs/content/custom-christmas-packaging.md` | #188 | - **Seasonal range** — Gift boxes, advent calendars, sleeves, bags, tags. | - **Сезонный ассортимент** — Подарочные коробки, адвент-календари, футляры, пакеты, бирки. |  |  |
| C-custom-christmas-packaging-05 | `docs/content/custom-christmas-packaging.md` | #188 | - **On-time planning** — Production schedule planned back from your in-store date. | - **Планирование сроков** — График производства от даты поступления в магазин. |  |  |
| C-custom-christmas-packaging-06 | `docs/content/custom-christmas-packaging.md` | #188 | - **Festive finishes** — Gold/silver foil, glitter, embossing, windows. | - **Праздничная отделка** — Золотая/серебряная фольга, глиттер, конгрев, окна. |  |  |
| C-custom-christmas-packaging-07 | `docs/content/custom-christmas-packaging.md` | #188 | - **Corporate gifting** — Branded sets for client and employee gifts. | - **Корпоративные подарки** — Брендированные наборы для клиентов и сотрудников. |  |  |
| C-custom-christmas-packaging-08 | `docs/content/custom-christmas-packaging.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-christmas-packaging-09 | `docs/content/custom-christmas-packaging.md` | #188 | Products \| Christmas gift boxes, advent calendars, sleeves, paper bags, tags, ornaments packaging | Продукция \| Новогодние коробки, адвент-календари, футляры, пакеты, бирки, упаковка для игрушек |  |  |
| C-custom-christmas-packaging-10 | `docs/content/custom-christmas-packaging.md` | #188 | Material \| Rigid board, folding carton, corrugated, kraft | Материал \| Переплетный картон, картон, гофрокартон, крафт |  |  |
| C-custom-christmas-packaging-11 | `docs/content/custom-christmas-packaging.md` | #188 | Printing \| Offset CMYK/Pantone, metallic inks | Печать \| Офсет CMYK/Pantone, металлизированные краски |  |  |
| C-custom-christmas-packaging-12 | `docs/content/custom-christmas-packaging.md` | #188 | Finishes \| Foil, glitter, embossing, window, ribbon | Отделка \| Фольга, глиттер, конгрев, окно, лента |  |  |
| C-custom-christmas-packaging-13 | `docs/content/custom-christmas-packaging.md` | #188 | Order deadline \| On request | Срок заказа \| По запросу |  |  |
| C-custom-christmas-packaging-14 | `docs/content/custom-christmas-packaging.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-christmas-packaging-15 | `docs/content/custom-christmas-packaging.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-christmas-packaging-16 | `docs/content/custom-christmas-packaging.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-christmas-packaging-17 | `docs/content/custom-christmas-packaging.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-christmas-packaging-18 | `docs/content/custom-christmas-packaging.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-christmas-packaging-19 | `docs/content/custom-christmas-packaging.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-christmas-packaging-20 | `docs/content/custom-christmas-packaging.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-christmas-packaging-21 | `docs/content/custom-christmas-packaging.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-christmas-packaging-22 | `docs/content/custom-christmas-packaging.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-christmas-packaging-23 | `docs/content/custom-christmas-packaging.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-christmas-packaging-24 | `docs/content/custom-christmas-packaging.md` | #188 | - **Q: When should I order Christmas packaging?** | - **В: Когда заказывать новогоднюю упаковку?** |  |  |
| C-custom-christmas-packaging-25 | `docs/content/custom-christmas-packaging.md` | #188 | A: As early as possible; the latest safe order date including shipping is on request. | О: Как можно раньше; крайнюю дату с учетом доставки — по запросу. |  |  |
| C-custom-christmas-packaging-26 | `docs/content/custom-christmas-packaging.md` | #188 | - **Q: Do you make advent calendars?** | - **В: Делаете ли адвент-календари?** |  |  |
| C-custom-christmas-packaging-27 | `docs/content/custom-christmas-packaging.md` | #188 | A: Yes, custom advent calendars with compartments. | О: Да, на заказ с ячейками. |  |  |
| C-custom-christmas-packaging-28 | `docs/content/custom-christmas-packaging.md` | #188 | - **Q: Can you make corporate New Year gift sets?** | - **В: Делаете ли корпоративные новогодние наборы?** |  |  |
| C-custom-christmas-packaging-29 | `docs/content/custom-christmas-packaging.md` | #188 | A: Yes, branded gift boxes with inserts. | О: Да, брендированные коробки с ложементами. |  |  |
| C-custom-christmas-packaging-kw-Транзакционные | `docs/content/custom-christmas-packaging.md` | #188 |  | **Транзакционные (主页面)**: новогодняя упаковка на заказ, новогодние подарочные коробки оптом, адвент календарь на заказ, упаковка для новогодних подарков |  |  |
| C-custom-christmas-packaging-kw-Коммерческие | `docs/content/custom-christmas-packaging.md` | #188 |  | **Коммерческие (主页面 + 小节)**: новогодние коробки с логотипом, корпоративные новогодние подарки упаковка, упаковка для сладких подарков, новогодние пакеты с печатью |  |  |
| C-custom-christmas-packaging-kw-Информационные | `docs/content/custom-christmas-packaging.md` | #188 |  | **Информационные (博客文章)**: когда заказывать новогоднюю упаковку, идеи новогодней упаковки |  |  |
| C-custom-christmas-packaging-outline-1 | `docs/content/custom-christmas-packaging.md` | #188 |  | Новогодняя упаковка: как успеть к сезону |  |  |
| C-custom-christmas-packaging-outline-2 | `docs/content/custom-christmas-packaging.md` | #188 |  | H2s: График; выбор упаковки; логистика в РФ |  |  |
| C-custom-color-printing-01 | `docs/content/custom-color-printing.md` | #188 | ### H1: Packaging Printing Services | ### H1: Печать упаковки на заказ |  |  |
| C-custom-color-printing-02 | `docs/content/custom-color-printing.md` | #188 | PackJoyU offers full-color printing for packaging, labels, inserts and printed paper products. We print CMYK and Pantone spot colors on paper and board with careful color management and proofing, so your brand colors stay consistent across boxes, labels and marketing materials — and across repeat orders. | PackJoyU выполняет полноцветную печать упаковки, этикеток, вкладышей и бумажной продукции. Печатаем CMYK и пантонами на бумаге и картоне с контролем цвета и цветопробой, чтобы фирменные цвета совпадали на коробках, этикетках и маркетинговых материалах — и от тиража к тиражу. |  |  |
| C-custom-color-printing-03 | `docs/content/custom-color-printing.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-color-printing-04 | `docs/content/custom-color-printing.md` | #188 | - **Accurate color** — CMYK + Pantone with proofing before production. | - **Точный цвет** — CMYK и пантоны с цветопробой до тиража. |  |  |
| C-custom-color-printing-05 | `docs/content/custom-color-printing.md` | #188 | - **One supplier** — Boxes, labels, inserts and leaflets matched in color. | - **Один поставщик** — Коробки, этикетки, вкладыши и листовки в одном цвете. |  |  |
| C-custom-color-printing-06 | `docs/content/custom-color-printing.md` | #188 | - **Finishing** — Coating, lamination, foil, die-cutting. | - **Постпечатная обработка** — Лак, ламинация, фольга, высечка. |  |  |
| C-custom-color-printing-07 | `docs/content/custom-color-printing.md` | #188 | - **Export support** — Packing and documentation for international shipment. | - **Экспорт** — Упаковка и документы для международных поставок. |  |  |
| C-custom-color-printing-08 | `docs/content/custom-color-printing.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-color-printing-09 | `docs/content/custom-color-printing.md` | #188 | Products \| Packaging, labels, inserts, leaflets, hang tags | Продукция \| Упаковка, этикетки, вкладыши, листовки, бирки |  |  |
| C-custom-color-printing-10 | `docs/content/custom-color-printing.md` | #188 | Substrates \| Coated/uncoated paper, paperboard, kraft | Материалы \| Мелованная/немелованная бумага, картон, крафт |  |  |
| C-custom-color-printing-11 | `docs/content/custom-color-printing.md` | #188 | Colors \| CMYK, Pantone spot; white ink on kraft on request | Цвета \| CMYK, пантоны; белила по крафту — по запросу |  |  |
| C-custom-color-printing-12 | `docs/content/custom-color-printing.md` | #188 | Proofing \| Digital proof; physical/press proof on request | Пробы \| Цифровая; физическая/печатная — по запросу |  |  |
| C-custom-color-printing-13 | `docs/content/custom-color-printing.md` | #188 | Finishes \| Varnish, lamination, foil, embossing, die-cut | Отделка \| Лак, ламинация, фольга, конгрев, высечка |  |  |
| C-custom-color-printing-14 | `docs/content/custom-color-printing.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-color-printing-15 | `docs/content/custom-color-printing.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-color-printing-16 | `docs/content/custom-color-printing.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-color-printing-17 | `docs/content/custom-color-printing.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-color-printing-18 | `docs/content/custom-color-printing.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-color-printing-19 | `docs/content/custom-color-printing.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-color-printing-20 | `docs/content/custom-color-printing.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-color-printing-21 | `docs/content/custom-color-printing.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-color-printing-22 | `docs/content/custom-color-printing.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-color-printing-23 | `docs/content/custom-color-printing.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-color-printing-24 | `docs/content/custom-color-printing.md` | #188 | - **Q: Which file formats do you accept?** | - **В: Какие форматы файлов принимаете?** |  |  |
| C-custom-color-printing-25 | `docs/content/custom-color-printing.md` | #188 | A: Print-ready PDF / AI with outlined fonts and bleed; requirements on request. | О: PDF/AI для печати, шрифты в кривых, вылеты; требования — по запросу. |  |  |
| C-custom-color-printing-26 | `docs/content/custom-color-printing.md` | #188 | - **Q: How do you ensure color consistency?** | - **В: Как обеспечивается стабильность цвета?** |  |  |
| C-custom-color-printing-27 | `docs/content/custom-color-printing.md` | #188 | A: Pantone references and proof approval before the run. | О: Пантонные эталоны и утверждение пробы до тиража. |  |  |
| C-custom-color-printing-28 | `docs/content/custom-color-printing.md` | #188 | - **Q: Can you print labels and boxes together?** | - **В: Можно ли напечатать этикетки и коробки вместе?** |  |  |
| C-custom-color-printing-29 | `docs/content/custom-color-printing.md` | #188 | A: Yes, in one order for matching color. | О: Да, в одном заказе для совпадения цвета. |  |  |
| C-custom-color-printing-kw-Транзакционные | `docs/content/custom-color-printing.md` | #188 |  | **Транзакционные (主页面)**: печать упаковки, полноцветная печать на картоне, печать этикеток на заказ, типография упаковка |  |  |
| C-custom-color-printing-kw-Коммерческие | `docs/content/custom-color-printing.md` | #188 |  | **Коммерческие (主页面 + 小节)**: печать вкладышей, печать пантонами, печать на крафт картоне, печать бирок |  |  |
| C-custom-color-printing-kw-Информационные | `docs/content/custom-color-printing.md` | #188 |  | **Информационные (博客文章)**: CMYK или Pantone, как подготовить файл к печати, что такое цветопроба |  |  |
| C-custom-color-printing-outline-1 | `docs/content/custom-color-printing.md` | #188 |  | Как добиться точного фирменного цвета в печати |  |  |
| C-custom-color-printing-outline-2 | `docs/content/custom-color-printing.md` | #188 |  | H2s: Пантоны; пробы; материалы; контроль |  |  |
| C-custom-corrugated-boxes-01 | `docs/content/custom-corrugated-boxes.md` | #188 | ### H1: Custom Corrugated Boxes | ### H1: Гофрокороба на заказ |  |  |
| C-custom-corrugated-boxes-02 | `docs/content/custom-corrugated-boxes.md` | #188 | PackJoyU manufactures custom corrugated boxes for shipping, e-commerce and retail: mailer boxes, regular slotted cartons and display boxes made to your exact dimensions. We print your logo and artwork directly on the board, so your packaging protects the product in transit and still looks like your brand when it arrives. We work with importers, distributors and brands who need consistent quality across repeat orders. | PackJoyU производит гофрокороба на заказ для доставки, интернет-торговли и розницы: почтовые коробки, четырехклапанные короба и демонстрационную упаковку точно под ваши размеры. Мы наносим логотип и дизайн прямо на гофрокартон, поэтому коробка защищает товар при перевозке и при этом работает на узнаваемость бренда. Мы поставляем продукцию импортерам, дистрибьюторам и брендам, которым важно стабильное качество от партии к партии. |  |  |
| C-custom-corrugated-boxes-03 | `docs/content/custom-corrugated-boxes.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-corrugated-boxes-04 | `docs/content/custom-corrugated-boxes.md` | #188 | - **Made to your size** — Every box is cut to your product dimensions, reducing void fill and shipping volume. | - **Точно по размеру** — Каждая коробка изготавливается под габариты товара — меньше наполнителя и объема при доставке. |  |  |
| C-custom-corrugated-boxes-05 | `docs/content/custom-corrugated-boxes.md` | #188 | - **Branded unboxing** — Flexo or digital printing inside and outside, from one-color logos to full artwork. | - **Фирменная распаковка** — Флексо- или цифровая печать снаружи и внутри: от логотипа в один цвет до полноцветного дизайна. |  |  |
| C-custom-corrugated-boxes-06 | `docs/content/custom-corrugated-boxes.md` | #188 | - **Built for transit** — Board grade and flute selected for your product weight and shipping route. | - **Прочность при перевозке** — Марку картона и профиль гофры подбираем под вес товара и маршрут доставки. |  |  |
| C-custom-corrugated-boxes-07 | `docs/content/custom-corrugated-boxes.md` | #188 | - **One supplier** — From structural design to export packing and documentation. | - **Один поставщик** — От конструкции коробки до экспортной упаковки и документов. |  |  |
| C-custom-corrugated-boxes-08 | `docs/content/custom-corrugated-boxes.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-corrugated-boxes-09 | `docs/content/custom-corrugated-boxes.md` | #188 | Styles \| Mailer (tuck-front) boxes, regular slotted cartons (RSC), die-cut boxes, display/shelf-ready boxes | Конструкции \| Почтовые коробки (самосборные), четырехклапанные короба, высечные коробки, шоу-боксы |  |  |
| C-custom-corrugated-boxes-10 | `docs/content/custom-corrugated-boxes.md` | #188 | Material \| Kraft or white corrugated board; flute and wall (single / double) to be confirmed per product | Материал \| Бурый или белый гофрокартон; профиль гофры и количество слоев — по продукту |  |  |
| C-custom-corrugated-boxes-11 | `docs/content/custom-corrugated-boxes.md` | #188 | Printing \| Flexographic, digital or litho-laminated (offset print on liner) | Печать \| Флексопечать, цифровая печать или кашировка офсетным листом |  |  |
| C-custom-corrugated-boxes-12 | `docs/content/custom-corrugated-boxes.md` | #188 | Finishes \| Matte/gloss varnish, lamination, inside printing, tear strips, inserts | Отделка \| Матовый/глянцевый лак, ламинация, печать внутри, отрывная лента, ложементы |  |  |
| C-custom-corrugated-boxes-13 | `docs/content/custom-corrugated-boxes.md` | #188 | Sizes \| Custom — send product dimensions or a sample | Размеры \| Любые — пришлите габариты товара или образец |  |  |
| C-custom-corrugated-boxes-14 | `docs/content/custom-corrugated-boxes.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-corrugated-boxes-15 | `docs/content/custom-corrugated-boxes.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-corrugated-boxes-16 | `docs/content/custom-corrugated-boxes.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-corrugated-boxes-17 | `docs/content/custom-corrugated-boxes.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-corrugated-boxes-18 | `docs/content/custom-corrugated-boxes.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-corrugated-boxes-19 | `docs/content/custom-corrugated-boxes.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-corrugated-boxes-20 | `docs/content/custom-corrugated-boxes.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-corrugated-boxes-21 | `docs/content/custom-corrugated-boxes.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-corrugated-boxes-22 | `docs/content/custom-corrugated-boxes.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-corrugated-boxes-23 | `docs/content/custom-corrugated-boxes.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-corrugated-boxes-24 | `docs/content/custom-corrugated-boxes.md` | #188 | - **Q: Can you design the box structure for my product?** | - **В: Можете ли вы разработать конструкцию коробки?** |  |  |
| C-custom-corrugated-boxes-25 | `docs/content/custom-corrugated-boxes.md` | #188 | A: Yes. Send your product dimensions and weight, and our team will propose a structure and dieline for approval. | О: Да. Пришлите размеры и вес товара — мы предложим конструкцию и развертку на согласование. |  |  |
| C-custom-corrugated-boxes-26 | `docs/content/custom-corrugated-boxes.md` | #188 | - **Q: Can you print inside the box?** | - **В: Возможна ли печать внутри коробки?** |  |  |
| C-custom-corrugated-boxes-27 | `docs/content/custom-corrugated-boxes.md` | #188 | A: Yes, inside printing is available for mailer boxes. Cost and lead time impact: on request. | О: Да, для почтовых коробок доступна печать внутри. Влияние на цену и сроки — по запросу. |  |  |
| C-custom-corrugated-boxes-28 | `docs/content/custom-corrugated-boxes.md` | #188 | - **Q: Do you ship to my country?** | - **В: Доставляете ли вы в Россию?** |  |  |
| C-custom-corrugated-boxes-29 | `docs/content/custom-corrugated-boxes.md` | #188 | A: We export worldwide. Shipping terms (e.g. FOB/CIF) are confirmed per quote. | О: Да, мы экспортируем продукцию, условия поставки уточняются в расчёте. |  |  |
| C-custom-corrugated-boxes-kw-Транзакционные | `docs/content/custom-corrugated-boxes.md` | #188 |  | **Транзакционные (主页面)**: гофрокороба на заказ, производство гофрокоробов, гофрокороб оптом, гофрокоробка с логотипом купить |  |  |
| C-custom-corrugated-boxes-kw-Коммерческие | `docs/content/custom-corrugated-boxes.md` | #188 |  | **Коммерческие (主页面 + 小节)**: почтовые коробки с логотипом, самосборные коробки на заказ, коробки для маркетплейсов, транспортная упаковка |  |  |
| C-custom-corrugated-boxes-kw-Информационные | `docs/content/custom-corrugated-boxes.md` | #188 |  | **Информационные (博客文章)**: марки гофрокартона, профиль гофры виды, как выбрать размер коробки для Wildberries |  |  |
| C-custom-corrugated-boxes-outline-1 | `docs/content/custom-corrugated-boxes.md` | #188 |  | Как подготовить гофрокороба для маркетплейсов (Wildberries, Ozon) |  |  |
| C-custom-corrugated-boxes-outline-2 | `docs/content/custom-corrugated-boxes.md` | #188 |  | H2s: Требования площадок к упаковке; размеры; маркировка; прочность; чек-лист заказа |  |  |
| C-custom-gift-boxes-01 | `docs/content/custom-gift-boxes.md` | #188 | ### H1: Custom Gift Boxes | ### H1: Подарочные коробки на заказ |  |  |
| C-custom-gift-boxes-02 | `docs/content/custom-gift-boxes.md` | #188 | PackJoyU makes rigid gift boxes for brands that want packaging customers keep: magnetic-closure boxes, lid-and-base sets, drawer boxes and book-style cases with custom inserts. Each box is wrapped in specialty paper and finished with foil stamping, embossing or other details matched to your brand. We support corporate gifting, luxury retail, cosmetics, jewelry and seasonal collections. | PackJoyU производит жесткие подарочные коробки для брендов, упаковку которых хочется сохранить: коробки на магните, крышка-дно, выдвижные коробки и коробки-книжки с ложементами. Каждая коробка оклеивается дизайнерской бумагой и дополняется тиснением фольгой, конгревом и другими деталями в стиле бренда. Подходит для корпоративных подарков, премиальной розницы, косметики, ювелирных изделий и сезонных коллекций. |  |  |
| C-custom-gift-boxes-03 | `docs/content/custom-gift-boxes.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-gift-boxes-04 | `docs/content/custom-gift-boxes.md` | #188 | - **Premium rigid construction** — Greyboard core wrapped in printed or specialty paper. | - **Жесткая премиальная конструкция** — Основа из переплетного картона, оклеенная печатной или дизайнерской бумагой. |  |  |
| C-custom-gift-boxes-05 | `docs/content/custom-gift-boxes.md` | #188 | - **Custom inserts** — EVA, foam, paperboard or molded pulp inserts that hold each item. | - **Ложементы на заказ** — Ложементы из EVA, поролона, картона или формованной целлюлозы под каждый предмет. |  |  |
| C-custom-gift-boxes-06 | `docs/content/custom-gift-boxes.md` | #188 | - **Brand details** — Foil, embossing, ribbons, magnetic closures, printed interiors. | - **Детали бренда** — Фольга, конгрев, ленты, магнитные замки, печать внутри. |  |  |
| C-custom-gift-boxes-07 | `docs/content/custom-gift-boxes.md` | #188 | - **Dark-and-gold collection** — Option to match the PackJoyU premium black/gold style for luxury lines. | - **Премиальная черно-золотая линия** — Возможность оформления в премиальном стиле для люксовых коллекций. |  |  |
| C-custom-gift-boxes-08 | `docs/content/custom-gift-boxes.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-gift-boxes-09 | `docs/content/custom-gift-boxes.md` | #188 | Styles \| Magnetic closure, lid & base, drawer/sliding, book-style, collapsible (flat-pack) | Конструкции \| На магните, крышка-дно, выдвижная, коробка-книжка, складная (поставляется в плоском виде) |  |  |
| C-custom-gift-boxes-10 | `docs/content/custom-gift-boxes.md` | #188 | Material \| Greyboard core (thickness TBD per size) + art paper, specialty or textured paper | Материал \| Переплетный картон (толщина — по размеру) + мелованная, дизайнерская или фактурная бумага |  |  |
| C-custom-gift-boxes-11 | `docs/content/custom-gift-boxes.md` | #188 | Printing \| Offset CMYK/Pantone on wrapping paper | Печать \| Офсет CMYK/Pantone на оклеечной бумаге |  |  |
| C-custom-gift-boxes-12 | `docs/content/custom-gift-boxes.md` | #188 | Finishes \| Foil, embossing/debossing, spot UV, lamination, ribbon pull, magnets | Отделка \| Фольга, конгрев/блинтовое тиснение, выборочный лак, ламинация, лента, магниты |  |  |
| C-custom-gift-boxes-13 | `docs/content/custom-gift-boxes.md` | #188 | Inserts \| EVA, foam, paperboard, molded pulp, satin lining | Ложементы \| EVA, поролон, картон, формованная целлюлоза, атлас |  |  |
| C-custom-gift-boxes-14 | `docs/content/custom-gift-boxes.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-gift-boxes-15 | `docs/content/custom-gift-boxes.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-gift-boxes-16 | `docs/content/custom-gift-boxes.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-gift-boxes-17 | `docs/content/custom-gift-boxes.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-gift-boxes-18 | `docs/content/custom-gift-boxes.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-gift-boxes-19 | `docs/content/custom-gift-boxes.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-gift-boxes-20 | `docs/content/custom-gift-boxes.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-gift-boxes-21 | `docs/content/custom-gift-boxes.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-gift-boxes-22 | `docs/content/custom-gift-boxes.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-gift-boxes-23 | `docs/content/custom-gift-boxes.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-gift-boxes-24 | `docs/content/custom-gift-boxes.md` | #188 | - **Q: Can gift boxes ship flat to save freight?** | - **В: Можно ли отправлять коробки в плоском виде?** |  |  |
| C-custom-gift-boxes-25 | `docs/content/custom-gift-boxes.md` | #188 | A: Collapsible rigid styles ship flat; standard rigid boxes ship assembled. We advise per order. | О: Складные жесткие коробки едут в плоском виде, стандартные — в собранном. Подскажем под заказ. |  |  |
| C-custom-gift-boxes-26 | `docs/content/custom-gift-boxes.md` | #188 | - **Q: Can you make inserts for multiple items?** | - **В: Делаете ли ложементы под несколько предметов?** |  |  |
| C-custom-gift-boxes-27 | `docs/content/custom-gift-boxes.md` | #188 | A: Yes, inserts are cut to your products. Send samples or dimensions. | О: Да, ложемент вырезается под ваши изделия. Пришлите образцы или размеры. |  |  |
| C-custom-gift-boxes-28 | `docs/content/custom-gift-boxes.md` | #188 | - **Q: Do you offer corporate gift box sets?** | - **В: Делаете ли корпоративные подарочные наборы?** |  |  |
| C-custom-gift-boxes-29 | `docs/content/custom-gift-boxes.md` | #188 | A: Yes, we produce branded sets for corporate gifting programs. | О: Да, производим брендированные наборы для корпоративных подарков. |  |  |
| C-custom-gift-boxes-kw-Транзакционные | `docs/content/custom-gift-boxes.md` | #188 |  | **Транзакционные (主页面)**: подарочные коробки на заказ, подарочные коробки оптом, жесткие коробки с магнитом, производство подарочной упаковки |  |  |
| C-custom-gift-boxes-kw-Коммерческие | `docs/content/custom-gift-boxes.md` | #188 |  | **Коммерческие (主页面 + 小节)**: коробки с ложементом, корпоративные подарочные наборы, коробка книжка на заказ, премиальная упаковка с логотипом |  |  |
| C-custom-gift-boxes-kw-Информационные | `docs/content/custom-gift-boxes.md` | #188 |  | **Информационные (博客文章)**: виды подарочных коробок, ложемент из EVA или картона, как выбрать подарочную упаковку |  |  |
| C-custom-gift-boxes-outline-1 | `docs/content/custom-gift-boxes.md` | #188 |  | Корпоративные подарки к Новому году: как заказать упаковку вовремя |  |  |
| C-custom-gift-boxes-outline-2 | `docs/content/custom-gift-boxes.md` | #188 |  | H2s: Сроки; выбор конструкции; ложементы; логистика |  |  |
| C-custom-gift-cards-01 | `docs/content/custom-gift-cards.md` | #188 | ### H1: Custom Gift Cards | ### H1: Печать подарочных карт на заказ |  |  |
| C-custom-gift-cards-02 | `docs/content/custom-gift-cards.md` | #188 | PackJoyU prints custom paper gift cards, vouchers and certificates, together with matching card holders, envelopes and display packaging. Premium finishes such as foil stamping, spot UV and embossing give each card a retail-quality look, and coordinated packaging turns a simple card into a presentable gift. | PackJoyU печатает подарочные карты, ваучеры и сертификаты на бумажной основе вместе с держателями, конвертами и упаковкой для выкладки. Премиальная отделка — тиснение фольгой, выборочный лак и конгрев — придает каждой карте розничное качество, а упаковка в едином стиле превращает карту в полноценный подарок. |  |  |
| C-custom-gift-cards-03 | `docs/content/custom-gift-cards.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-gift-cards-04 | `docs/content/custom-gift-cards.md` | #188 | - **Premium look** — Foil, spot UV, embossing, special papers. | - **Премиальный вид** — Фольга, выборочный лак, конгрев, дизайнерская бумага. |  |  |
| C-custom-gift-cards-05 | `docs/content/custom-gift-cards.md` | #188 | - **Complete set** — Cards, holders, envelopes and boxes in one design. | - **Полный комплект** — Карты, держатели, конверты и коробки в одном дизайне. |  |  |
| C-custom-gift-cards-06 | `docs/content/custom-gift-cards.md` | #188 | - **Personalization** — Variable numbering/barcodes on request. | - **Персонализация** — Нумерация/штрихкоды — по запросу. |  |  |
| C-custom-gift-cards-07 | `docs/content/custom-gift-cards.md` | #188 | - **Retail-ready** — Hang-tab holders and display packs. | - **Для розницы** — Держатели с европодвесом и упаковка для выкладки. |  |  |
| C-custom-gift-cards-08 | `docs/content/custom-gift-cards.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-gift-cards-09 | `docs/content/custom-gift-cards.md` | #188 | Products \| Gift cards, vouchers, certificates, card holders, envelopes, gift card boxes | Продукция \| Подарочные карты, ваучеры, сертификаты, держатели, конверты, коробки |  |  |
| C-custom-gift-cards-10 | `docs/content/custom-gift-cards.md` | #188 | Material \| Paperboard / special papers | Материал \| Картон / дизайнерская бумага |  |  |
| C-custom-gift-cards-11 | `docs/content/custom-gift-cards.md` | #188 | Printing \| Offset CMYK/Pantone | Печать \| Офсет CMYK/Pantone |  |  |
| C-custom-gift-cards-12 | `docs/content/custom-gift-cards.md` | #188 | Finishes \| Foil, spot UV, embossing, edge painting on request | Отделка \| Фольга, выборочный лак, конгрев, окраска торца — по запросу |  |  |
| C-custom-gift-cards-13 | `docs/content/custom-gift-cards.md` | #188 | Variable data \| Numbering, barcode/QR — on request | Переменные данные \| Нумерация, штрихкод/QR — по запросу |  |  |
| C-custom-gift-cards-14 | `docs/content/custom-gift-cards.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-gift-cards-15 | `docs/content/custom-gift-cards.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-gift-cards-16 | `docs/content/custom-gift-cards.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-gift-cards-17 | `docs/content/custom-gift-cards.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-gift-cards-18 | `docs/content/custom-gift-cards.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-gift-cards-19 | `docs/content/custom-gift-cards.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-gift-cards-20 | `docs/content/custom-gift-cards.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-gift-cards-21 | `docs/content/custom-gift-cards.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-gift-cards-22 | `docs/content/custom-gift-cards.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-gift-cards-23 | `docs/content/custom-gift-cards.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-gift-cards-24 | `docs/content/custom-gift-cards.md` | #188 | - **Q: Can each card have a unique number or barcode?** | - **В: Можно ли уникальный номер или штрихкод на каждой карте?** |  |  |
| C-custom-gift-cards-25 | `docs/content/custom-gift-cards.md` | #188 | A: Variable data printing capability: on request. | О: Возможность печати переменных данных — по запросу. |  |  |
| C-custom-gift-cards-26 | `docs/content/custom-gift-cards.md` | #188 | - **Q: Do you make packaging for gift cards?** | - **В: Делаете ли упаковку для карт?** |  |  |
| C-custom-gift-cards-27 | `docs/content/custom-gift-cards.md` | #188 | A: Yes, holders, envelopes and boxes. | О: Да, держатели, конверты и коробки. |  |  |
| C-custom-gift-cards-28 | `docs/content/custom-gift-cards.md` | #188 | - **Q: Can you print plastic cards?** | - **В: Печатаете пластиковые карты?** |  |  |
| C-custom-gift-cards-29 | `docs/content/custom-gift-cards.md` | #188 | A: On request. | О: По запросу. |  |  |
| C-custom-gift-cards-kw-Транзакционные | `docs/content/custom-gift-cards.md` | #188 |  | **Транзакционные (主页面)**: печать подарочных карт, подарочные сертификаты на заказ, упаковка для подарочных карт, конверты для сертификатов |  |  |
| C-custom-gift-cards-kw-Коммерческие | `docs/content/custom-gift-cards.md` | #188 |  | **Коммерческие (主页面 + 小节)**: печать ваучеров, держатель для подарочной карты, подарочный сертификат с логотипом |  |  |
| C-custom-gift-cards-kw-Информационные | `docs/content/custom-gift-cards.md` | #188 |  | **Информационные (博客文章)**: как оформить подарочный сертификат, бумажные или пластиковые карты |  |  |
| C-custom-gift-cards-outline-1 | `docs/content/custom-gift-cards.md` | #188 |  | Подарочные сертификаты для бизнеса: печать и упаковка |  |  |
| C-custom-gift-cards-outline-2 | `docs/content/custom-gift-cards.md` | #188 |  | H2s: Варианты; отделка; сроки |  |  |
| C-custom-paper-cups-01 | `docs/content/custom-paper-cups.md` | #188 | ### H1: Custom Paper Cups | ### H1: Бумажные стаканы с логотипом |  |  |
| C-custom-paper-cups-02 | `docs/content/custom-paper-cups.md` | #188 | PackJoyU manufactures custom printed paper cups for coffee shops, restaurant chains, events and brands. Choose single wall, double wall or ripple wall cups in a range of sizes, printed with your logo and artwork, with matching lids and sleeves available. Your cup becomes a moving advertisement every time a customer walks out the door. | PackJoyU производит бумажные стаканы с печатью для кофеен, ресторанных сетей, мероприятий и брендов. Выбирайте однослойные, двухслойные или гофрированные стаканы разных объемов с вашим логотипом; в комплекте доступны крышки и манжеты. Ваш стакан становится рекламой каждый раз, когда гость выходит из кофейни. |  |  |
| C-custom-paper-cups-03 | `docs/content/custom-paper-cups.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-paper-cups-04 | `docs/content/custom-paper-cups.md` | #188 | - **Your brand in every hand** — Full-wrap printing of logo and artwork. | - **Ваш бренд в каждой руке** — Печать логотипа и дизайна по всей поверхности. |  |  |
| C-custom-paper-cups-05 | `docs/content/custom-paper-cups.md` | #188 | - **Hot and cold** — Single, double and ripple wall for heat insulation; cold cup options. | - **Горячие и холодные напитки** — Однослойные, двухслойные и гофрированные стаканы; варианты для холодных напитков. |  |  |
| C-custom-paper-cups-06 | `docs/content/custom-paper-cups.md` | #188 | - **Matching accessories** — Lids, sleeves and carriers to complete the set. | - **Аксессуары в комплекте** — Крышки, манжеты и подставки. |  |  |
| C-custom-paper-cups-07 | `docs/content/custom-paper-cups.md` | #188 | | |  |  |
| C-custom-paper-cups-08 | `docs/content/custom-paper-cups.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-paper-cups-09 | `docs/content/custom-paper-cups.md` | #188 | Types \| Single wall, double wall, ripple wall, cold cups | Виды \| Однослойные, двухслойные, гофрированные, для холодных напитков |  |  |
| C-custom-paper-cups-10 | `docs/content/custom-paper-cups.md` | #188 | Sizes \| On request | Объемы \| По запросу |  |  |
| C-custom-paper-cups-11 | `docs/content/custom-paper-cups.md` | #188 | Lining \| PE lining; other options on request | Покрытие \| ПЭ; другие варианты — по запросу |  |  |
| C-custom-paper-cups-12 | `docs/content/custom-paper-cups.md` | #188 | Printing \| Flexo or offset, full-wrap | Печать \| Флексо или офсет по всей поверхности |  |  |
| C-custom-paper-cups-13 | `docs/content/custom-paper-cups.md` | #188 | Accessories \| PS/PP lids, sleeves, carriers | Аксессуары \| Крышки PS/PP, манжеты, подставки |  |  |
| C-custom-paper-cups-14 | `docs/content/custom-paper-cups.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-paper-cups-15 | `docs/content/custom-paper-cups.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-paper-cups-16 | `docs/content/custom-paper-cups.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-paper-cups-17 | `docs/content/custom-paper-cups.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-paper-cups-18 | `docs/content/custom-paper-cups.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-paper-cups-19 | `docs/content/custom-paper-cups.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-paper-cups-20 | `docs/content/custom-paper-cups.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-paper-cups-21 | `docs/content/custom-paper-cups.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-paper-cups-22 | `docs/content/custom-paper-cups.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-paper-cups-23 | `docs/content/custom-paper-cups.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-paper-cups-24 | `docs/content/custom-paper-cups.md` | #188 | - **Q: What sizes are available?** | - **В: Какие объемы доступны?** |  |  |
| C-custom-paper-cups-25 | `docs/content/custom-paper-cups.md` | #188 | A: Common coffee cup sizes; exact range on request. | О: Стандартные объемы для кофе; точный ряд — по запросу. |  |  |
| C-custom-paper-cups-26 | `docs/content/custom-paper-cups.md` | #188 | - **Q: Can you match lids to the cup?** | - **В: Подойдут ли крышки к стакану?** |  |  |
| C-custom-paper-cups-27 | `docs/content/custom-paper-cups.md` | #188 | A: Yes, matching lids are available for each rim size. | О: Да, для каждого диаметра есть подходящие крышки. |  |  |
| C-custom-paper-cups-28 | `docs/content/custom-paper-cups.md` | #188 | | |  |  |
| C-custom-paper-cups-29 | `docs/content/custom-paper-cups.md` | #188 | | |  |  |
| C-custom-paper-cups-kw-Транзакционные | `docs/content/custom-paper-cups.md` | #188 |  | **Транзакционные (主页面)**: бумажные стаканы с логотипом, бумажные стаканчики оптом, стаканы для кофе с печатью, производство бумажных стаканов |  |  |
| C-custom-paper-cups-kw-Коммерческие | `docs/content/custom-paper-cups.md` | #188 |  | **Коммерческие (主页面 + 小节)**: двухслойные стаканы с логотипом, стаканы для кофейни, крышки для бумажных стаканов, фирменные стаканы для кофе |  |  |
| C-custom-paper-cups-kw-Информационные | `docs/content/custom-paper-cups.md` | #188 |  | **Информационные (博客文章)**: однослойный или двухслойный стакан, объемы стаканов для кофе, как сделать стаканы с логотипом |  |  |
| C-custom-paper-cups-outline-1 | `docs/content/custom-paper-cups.md` | #188 |  | Стаканы с логотипом для кофейни: что важно знать |  |  |
| C-custom-paper-cups-outline-2 | `docs/content/custom-paper-cups.md` | #188 |  | H2s: Объемы; печать; крышки; заказ и сроки |  |  |
| C-custom-party-supplies-01 | `docs/content/custom-party-supplies.md` | #188 | ### H1: Custom Party Supplies | ### H1: Бумажная посуда для праздника оптом |  |  |
| C-custom-party-supplies-02 | `docs/content/custom-party-supplies.md` | #188 | PackJoyU produces custom printed paper party supplies for retailers, party brands and event companies: plates, cups, napkins, banners and decorations in coordinated designs. We print your own collections or private-label themes for birthdays, weddings and seasonal holidays, packed retail-ready for store shelves or online marketplaces. | PackJoyU производит бумажную праздничную продукцию с печатью для розничных сетей, брендов товаров для праздника и ивент-агентств: тарелки, стаканы, салфетки, гирлянды и декор в едином дизайне. Печатаем ваши коллекции или тематические серии под собственной торговой маркой для дней рождения, свадеб и сезонных праздников с упаковкой, готовой для полки или маркетплейса. |  |  |
| C-custom-party-supplies-03 | `docs/content/custom-party-supplies.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-party-supplies-04 | `docs/content/custom-party-supplies.md` | #188 | - **Coordinated collections** — Plates, cups, napkins and decor in one design. | - **Единые коллекции** — Тарелки, стаканы, салфетки и декор в одном дизайне. |  |  |
| C-custom-party-supplies-05 | `docs/content/custom-party-supplies.md` | #188 | - **Private label** — Your brand on the product and the retail pack. | - **Собственная торговая марка** — Ваш бренд на изделии и упаковке. |  |  |
| C-custom-party-supplies-06 | `docs/content/custom-party-supplies.md` | #188 | - **Retail-ready packing** — Shrink, header cards or boxes for shelves and marketplaces. | - **Готово для полки** — Термоусадка, хедеры или коробки для магазинов и маркетплейсов. |  |  |
| C-custom-party-supplies-07 | `docs/content/custom-party-supplies.md` | #188 | - **Seasonal themes** — Plan birthday, wedding and holiday lines in one order. | - **Сезонные серии** — Дни рождения, свадьбы и праздники в одном заказе. |  |  |
| C-custom-party-supplies-08 | `docs/content/custom-party-supplies.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-party-supplies-09 | `docs/content/custom-party-supplies.md` | #188 | Products \| Paper plates, cups, napkins, banners, cake toppers, party bags | Изделия \| Бумажные тарелки, стаканы, салфетки, гирлянды, топперы, пакеты |  |  |
| C-custom-party-supplies-10 | `docs/content/custom-party-supplies.md` | #188 | Material \| Paperboard, tissue paper; coating options on request | Материал \| Картон, тишью; покрытия — по запросу |  |  |
| C-custom-party-supplies-11 | `docs/content/custom-party-supplies.md` | #188 | Printing \| Offset / flexo, Pantone matching | Печать \| Офсет / флексо, пантоны |  |  |
| C-custom-party-supplies-12 | `docs/content/custom-party-supplies.md` | #188 | Finishes \| Foil accents, die-cut shapes | Отделка \| Фольга, фигурная высечка |  |  |
| C-custom-party-supplies-13 | `docs/content/custom-party-supplies.md` | #188 | Packing \| Shrink-wrap, header card, retail box | Упаковка \| Термоусадка, хедер, коробка |  |  |
| C-custom-party-supplies-14 | `docs/content/custom-party-supplies.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-party-supplies-15 | `docs/content/custom-party-supplies.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-party-supplies-16 | `docs/content/custom-party-supplies.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-party-supplies-17 | `docs/content/custom-party-supplies.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-party-supplies-18 | `docs/content/custom-party-supplies.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-party-supplies-19 | `docs/content/custom-party-supplies.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-party-supplies-20 | `docs/content/custom-party-supplies.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-party-supplies-21 | `docs/content/custom-party-supplies.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-party-supplies-22 | `docs/content/custom-party-supplies.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-party-supplies-23 | `docs/content/custom-party-supplies.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-party-supplies-24 | `docs/content/custom-party-supplies.md` | #188 | - **Q: Can you produce a full themed collection?** | - **В: Можно ли сделать коллекцию в одном стиле?** |  |  |
| C-custom-party-supplies-25 | `docs/content/custom-party-supplies.md` | #188 | A: Yes, we coordinate designs across product types. | О: Да, согласуем дизайн для всех видов изделий. |  |  |
| C-custom-party-supplies-26 | `docs/content/custom-party-supplies.md` | #188 | - **Q: Do you offer private-label packing?** | - **В: Упаковка под вашей маркой?** |  |  |
| C-custom-party-supplies-27 | `docs/content/custom-party-supplies.md` | #188 | A: Yes, with your barcode and brand on the pack. | О: Да, со штрихкодом и брендом на упаковке. |  |  |
| C-custom-party-supplies-28 | `docs/content/custom-party-supplies.md` | #188 | | |  |  |
| C-custom-party-supplies-29 | `docs/content/custom-party-supplies.md` | #188 | | |  |  |
| C-custom-party-supplies-kw-Транзакционные | `docs/content/custom-party-supplies.md` | #188 |  | **Транзакционные (主页面)**: бумажная посуда для праздника оптом, одноразовая посуда с печатью, товары для праздника оптом, праздничные тарелки и стаканы |  |  |
| C-custom-party-supplies-kw-Коммерческие | `docs/content/custom-party-supplies.md` | #188 |  | **Коммерческие (主页面 + 小节)**: салфетки с печатью на заказ, посуда для дня рождения, бумажный декор для праздника, товары для праздника под СТМ |  |  |
| C-custom-party-supplies-kw-Информационные | `docs/content/custom-party-supplies.md` | #188 |  | **Информационные (博客文章)**: экологичная одноразовая посуда, как продавать товары для праздника на маркетплейсе |  |  |
| C-custom-party-supplies-outline-1 | `docs/content/custom-party-supplies.md` | #188 |  | Товары для праздника под собственной маркой: с чего начать |  |  |
| C-custom-party-supplies-outline-2 | `docs/content/custom-party-supplies.md` | #188 |  | H2s: Ассортимент; дизайн; упаковка; маркетплейсы |  |  |
| C-custom-printed-boxes-01 | `docs/content/custom-printed-boxes.md` | #188 | ### H1: Custom Printed Boxes | ### H1: Картонные коробки с печатью на заказ |  |  |
| C-custom-printed-boxes-02 | `docs/content/custom-printed-boxes.md` | #188 | PackJoyU produces full-color printed paperboard boxes for cosmetics, electronics, food, supplements and retail products. From tuck-end folding cartons to boxes with windows and inserts, each design is printed with accurate brand colors and finished with foil, embossing or coating to stand out on the shelf. We manufacture to your dielines or develop a new structure with you. | PackJoyU производит картонные коробки с полноцветной печатью для косметики, электроники, продуктов питания, БАДов и розничных товаров. От складных коробок с клапанами до упаковки с окном и ложементом — каждый макет печатается с точной передачей фирменных цветов и дополняется тиснением фольгой, конгревом или ламинацией, чтобы товар выделялся на полке. Изготавливаем по вашей развертке или разрабатываем конструкцию вместе с вами. |  |  |
| C-custom-printed-boxes-03 | `docs/content/custom-printed-boxes.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-printed-boxes-04 | `docs/content/custom-printed-boxes.md` | #188 | - **Shelf impact** — Offset CMYK + Pantone printing for vivid, consistent brand color. | - **Заметность на полке** — Офсетная печать CMYK и Pantone — яркий и стабильный фирменный цвет. |  |  |
| C-custom-printed-boxes-05 | `docs/content/custom-printed-boxes.md` | #188 | - **Premium finishes** — Hot foil, embossing/debossing, spot UV, soft-touch or gloss lamination. | - **Премиальная отделка** — Тиснение фольгой, конгрев, выборочный УФ-лак, soft-touch или глянцевая ламинация. |  |  |
| C-custom-printed-boxes-06 | `docs/content/custom-printed-boxes.md` | #188 | - **Structures for any product** — Tuck-end, auto-bottom, sleeve, window and hanger-tab boxes. | - **Конструкция под любой товар** — Коробки с клапанами, с автодном, футляры-слайдеры, с окном и европодвесом. |  |  |
| C-custom-printed-boxes-07 | `docs/content/custom-printed-boxes.md` | #188 | - **Proof before production** — Digital and physical proofs so you approve color and fit first. | - **Проба до тиража** — Цифровая и физическая проба — вы утверждаете цвет и посадку заранее. |  |  |
| C-custom-printed-boxes-08 | `docs/content/custom-printed-boxes.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-printed-boxes-09 | `docs/content/custom-printed-boxes.md` | #188 | Styles \| Straight/reverse tuck-end, auto-lock bottom, sleeve, window, hanger tab | Конструкции \| Коробки с клапанами, с автодном, футляры, с окном, с европодвесом |  |  |
| C-custom-printed-boxes-10 | `docs/content/custom-printed-boxes.md` | #188 | Material \| White or kraft paperboard (e.g. SBS, C1S, grey-back); grammage per product | Материал \| Белый или крафт-картон (хром-эрзац, целлюлозный картон); плотность — по продукту |  |  |
| C-custom-printed-boxes-11 | `docs/content/custom-printed-boxes.md` | #188 | Printing \| Offset CMYK, Pantone spot colors | Печать \| Офсет CMYK, пантоны |  |  |
| C-custom-printed-boxes-12 | `docs/content/custom-printed-boxes.md` | #188 | Finishes \| Foil stamping, embossing, spot UV, matte/gloss/soft-touch lamination, window patching | Отделка \| Тиснение фольгой, конгрев, выборочный лак, матовая/глянцевая/soft-touch ламинация, окно |  |  |
| C-custom-printed-boxes-13 | `docs/content/custom-printed-boxes.md` | #188 | Sizes \| Custom | Размеры \| Любые |  |  |
| C-custom-printed-boxes-14 | `docs/content/custom-printed-boxes.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-printed-boxes-15 | `docs/content/custom-printed-boxes.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-printed-boxes-16 | `docs/content/custom-printed-boxes.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-printed-boxes-17 | `docs/content/custom-printed-boxes.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-printed-boxes-18 | `docs/content/custom-printed-boxes.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-printed-boxes-19 | `docs/content/custom-printed-boxes.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-printed-boxes-20 | `docs/content/custom-printed-boxes.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-printed-boxes-21 | `docs/content/custom-printed-boxes.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-printed-boxes-22 | `docs/content/custom-printed-boxes.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-printed-boxes-23 | `docs/content/custom-printed-boxes.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-printed-boxes-24 | `docs/content/custom-printed-boxes.md` | #188 | - **Q: Can you match our Pantone colors?** | - **В: Можете ли вы попасть в наши пантоны?** |  |  |
| C-custom-printed-boxes-25 | `docs/content/custom-printed-boxes.md` | #188 | A: Yes, we print Pantone spot colors and provide proofs for approval. | О: Да, мы печатаем пантонными красками и предоставляем пробу на утверждение. |  |  |
| C-custom-printed-boxes-26 | `docs/content/custom-printed-boxes.md` | #188 | - **Q: Do you provide dielines?** | - **В: Вы предоставляете развертку (штамп)?** |  |  |
| C-custom-printed-boxes-27 | `docs/content/custom-printed-boxes.md` | #188 | A: Yes, we can supply a dieline for your product size so your designer can place artwork. | О: Да, подготовим развертку под размер товара для вашего дизайнера. |  |  |
| C-custom-printed-boxes-28 | `docs/content/custom-printed-boxes.md` | #188 | - **Q: Can I get a physical sample first?** | - **В: Можно ли сначала получить образец?** |  |  |
| C-custom-printed-boxes-29 | `docs/content/custom-printed-boxes.md` | #188 | A: Yes. Sample cost and lead time: on request. | О: Да. Стоимость и сроки образца — по запросу. |  |  |
| C-custom-printed-boxes-kw-Транзакционные | `docs/content/custom-printed-boxes.md` | #188 |  | **Транзакционные (主页面)**: картонные коробки с печатью, коробки с логотипом на заказ, производство картонной упаковки, упаковка для косметики оптом |  |  |
| C-custom-printed-boxes-kw-Коммерческие | `docs/content/custom-printed-boxes.md` | #188 |  | **Коммерческие (主页面 + 小节)**: коробки для косметики на заказ, коробки с окном, упаковка для БАДов, подарочная картонная упаковка |  |  |
| C-custom-printed-boxes-kw-Информационные | `docs/content/custom-printed-boxes.md` | #188 |  | **Информационные (博客文章)**: что такое развертка коробки, виды ламинации, как подготовить макет коробки |  |  |
| C-custom-printed-boxes-outline-1 | `docs/content/custom-printed-boxes.md` | #188 |  | Как подготовить макет для печати коробки |  |  |
| C-custom-printed-boxes-outline-2 | `docs/content/custom-printed-boxes.md` | #188 |  | H2s: Развертка; вылеты; CMYK vs Pantone; шрифты; типичные ошибки |  |  |
| C-custom-wine-boxes-01 | `docs/content/custom-wine-boxes.md` | #188 | ### H1: Custom Wine Boxes | ### H1: Коробки для вина на заказ |  |  |
| C-custom-wine-boxes-02 | `docs/content/custom-wine-boxes.md` | #188 | PackJoyU manufactures luxury wine and spirits boxes for wineries, distilleries, importers and gift brands. We make single-bottle and multi-bottle boxes with magnetic closures, fitted inserts and premium finishes such as foil stamping and embossed logos, so every bottle arrives protected and gift-ready. Our dark-and-gold premium style is designed for exactly this category. | PackJoyU производит премиальные коробки для вина и крепких напитков для виноделен, производителей, импортеров и подарочных брендов. Изготавливаем коробки на одну и несколько бутылок с магнитными замками, ложементами и премиальной отделкой — тиснением фольгой и конгревом логотипа, чтобы каждая бутылка была защищена и готова к подарку. Наш премиальный черно-золотой стиль создан именно для этой категории. |  |  |
| C-custom-wine-boxes-03 | `docs/content/custom-wine-boxes.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-custom-wine-boxes-04 | `docs/content/custom-wine-boxes.md` | #188 | - **Bottle protection** — Fitted inserts hold bottles and glasses securely. | - **Защита бутылки** — Ложемент надежно фиксирует бутылки и бокалы. |  |  |
| C-custom-wine-boxes-05 | `docs/content/custom-wine-boxes.md` | #188 | - **Luxury presentation** — Rigid construction, specialty papers, foil and embossing. | - **Премиальный вид** — Жесткая конструкция, дизайнерская бумага, фольга и конгрев. |  |  |
| C-custom-wine-boxes-06 | `docs/content/custom-wine-boxes.md` | #188 | - **Single or multi-bottle** — 1, 2, 3 or 6-bottle formats and gift sets with accessories. | - **На одну или несколько бутылок** — Форматы на 1, 2, 3 или 6 бутылок и наборы с аксессуарами. |  |  |
| C-custom-wine-boxes-07 | `docs/content/custom-wine-boxes.md` | #188 | - **Gift-ready** — Ribbon pulls, magnetic lids, window options. | - **Готово к подарку** — Ленты, магнитные крышки, окна. |  |  |
| C-custom-wine-boxes-08 | `docs/content/custom-wine-boxes.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-custom-wine-boxes-09 | `docs/content/custom-wine-boxes.md` | #188 | Styles \| Magnetic flap, lid & base, book-style, tube, corrugated wine shipper | Конструкции \| С магнитным клапаном, крышка-дно, коробка-книжка, тубус, гофро для доставки |  |  |
| C-custom-wine-boxes-10 | `docs/content/custom-wine-boxes.md` | #188 | Capacity \| 1 / 2 / 3 / 6 bottles; gift sets with glasses/accessories | Вместимость \| 1 / 2 / 3 / 6 бутылок; наборы с бокалами |  |  |
| C-custom-wine-boxes-11 | `docs/content/custom-wine-boxes.md` | #188 | Material \| Rigid greyboard + specialty paper; corrugated for shipping | Материал \| Переплетный картон + дизайнерская бумага; гофрокартон для доставки |  |  |
| C-custom-wine-boxes-12 | `docs/content/custom-wine-boxes.md` | #188 | Finishes \| Foil, embossing, spot UV, soft-touch, ribbon | Отделка \| Фольга, конгрев, выборочный лак, soft-touch, лента |  |  |
| C-custom-wine-boxes-13 | `docs/content/custom-wine-boxes.md` | #188 | Inserts \| EVA, paperboard, molded pulp, satin | Ложементы \| EVA, картон, формованная целлюлоза, атлас |  |  |
| C-custom-wine-boxes-14 | `docs/content/custom-wine-boxes.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-custom-wine-boxes-15 | `docs/content/custom-wine-boxes.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-custom-wine-boxes-16 | `docs/content/custom-wine-boxes.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-custom-wine-boxes-17 | `docs/content/custom-wine-boxes.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-custom-wine-boxes-18 | `docs/content/custom-wine-boxes.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-custom-wine-boxes-19 | `docs/content/custom-wine-boxes.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-custom-wine-boxes-20 | `docs/content/custom-wine-boxes.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-custom-wine-boxes-21 | `docs/content/custom-wine-boxes.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-custom-wine-boxes-22 | `docs/content/custom-wine-boxes.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-custom-wine-boxes-23 | `docs/content/custom-wine-boxes.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-custom-wine-boxes-24 | `docs/content/custom-wine-boxes.md` | #188 | - **Q: Can you fit non-standard bottle shapes?** | - **В: Подойдет ли для бутылки нестандартной формы?** |  |  |
| C-custom-wine-boxes-25 | `docs/content/custom-wine-boxes.md` | #188 | A: Yes, send bottle dimensions or a sample for a custom insert. | О: Да, пришлите размеры или образец бутылки для ложемента. |  |  |
| C-custom-wine-boxes-26 | `docs/content/custom-wine-boxes.md` | #188 | - **Q: Do you make shipping-safe wine boxes?** | - **В: Есть ли коробки для пересылки вина?** |  |  |
| C-custom-wine-boxes-27 | `docs/content/custom-wine-boxes.md` | #188 | A: Corrugated and pulp-insert shippers are available; transit testing on request. | О: Есть гофро- и целлюлозные варианты; испытания при перевозке — по запросу. |  |  |
| C-custom-wine-boxes-28 | `docs/content/custom-wine-boxes.md` | #188 | - **Q: Can boxes include glasses or accessories?** | - **В: Можно ли добавить бокалы или аксессуары?** |  |  |
| C-custom-wine-boxes-29 | `docs/content/custom-wine-boxes.md` | #188 | A: Yes, gift sets with multi-cavity inserts. | О: Да, наборы с многоместным ложементом. |  |  |
| C-custom-wine-boxes-kw-Транзакционные | `docs/content/custom-wine-boxes.md` | #188 |  | **Транзакционные (主页面)**: коробки для вина на заказ, подарочная упаковка для вина, коробка для бутылки с логотипом, упаковка для алкоголя оптом |  |  |
| C-custom-wine-boxes-kw-Коммерческие | `docs/content/custom-wine-boxes.md` | #188 |  | **Коммерческие (主页面 + 小节)**: коробка для виски на заказ, подарочный набор вина в коробке, коробка на 2 бутылки, коробка для коньяка с ложементом |  |  |
| C-custom-wine-boxes-kw-Информационные | `docs/content/custom-wine-boxes.md` | #188 |  | **Информационные (博客文章)**: размеры коробки для бутылки вина, как упаковать вино в подарок |  |  |
| C-custom-wine-boxes-outline-1 | `docs/content/custom-wine-boxes.md` | #188 |  | Подарочная упаковка для вина и крепкого алкоголя |  |  |
| C-custom-wine-boxes-outline-2 | `docs/content/custom-wine-boxes.md` | #188 |  | H2s: Виды коробок; ложементы; отделка; сезон |  |  |
| IND-upakovka-dlya-produktov | `docs/content/industries.md` | #188 | food packaging manufacturer, custom food boxes, coffee shop packaging, bakery boxes custom | упаковка для пищевых продуктов, упаковка для кофейни, коробки для кондитерских изделий |  |  |
| IND-upakovka-dlya-alkogolya | `docs/content/industries.md` | #188 | wine and spirits packaging, liquor gift box manufacturer, distillery packaging | упаковка для алкоголя, подарочная упаковка для вина, коробки для виски |  |  |
| IND-upakovka-dlya-marketpleysov | `docs/content/industries.md` | #188 | ecommerce packaging boxes, custom mailer boxes, subscription box packaging | упаковка для маркетплейсов, коробки для Wildberries, упаковка для Ozon |  |  |
| IND-prazdnichnaya-upakovka | `docs/content/industries.md` | #188 | holiday packaging, christmas packaging wholesale, seasonal gift boxes | новогодняя упаковка оптом, праздничная упаковка, корпоративные подарки упаковка |  |  |
| IND-art5 | `docs/content/industries.md` | #188 |  | Как заказать упаковку из Китая: пошаговое руководство: поставщик, образцы, контроль качества, логистика и таможня. |  |  |
| IND-art6 | `docs/content/industries.md` | #188 |  | Упаковка для маркетплейсов: требования и решения：требования WB/Ozon, гофрокороба, маркировка. |  |  |
| C-molded-pulp-packaging-01 | `docs/content/molded-pulp-packaging.md` | #188 | ### H1: Molded Pulp Packaging | ### H1: Упаковка из формованной целлюлозы |  |  |
| C-molded-pulp-packaging-02 | `docs/content/molded-pulp-packaging.md` | #188 | PackJoyU produces custom molded pulp packaging from bagasse (sugarcane fiber) and recycled paper fiber: protective inserts, trays, clamshells and premium smooth-finish boxes. Molded pulp is shaped precisely to your product. | PackJoyU производит упаковку из формованной целлюлозы на основе багассы (волокна сахарного тростника) и вторичного бумажного волокна: защитные ложементы, лотки, контейнеры и премиальные коробки с гладкой поверхностью. Формованная целлюлоза точно повторяет форму вашего товара. |  |  |
| C-molded-pulp-packaging-03 | `docs/content/molded-pulp-packaging.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-molded-pulp-packaging-04 | `docs/content/molded-pulp-packaging.md` | #188 | | |  |  |
| C-molded-pulp-packaging-05 | `docs/content/molded-pulp-packaging.md` | #188 | - **Precision fit** — Custom molds shaped to your product for protection. | - **Точная посадка** — Пресс-форма под ваш товар для надежной защиты. |  |  |
| C-molded-pulp-packaging-06 | `docs/content/molded-pulp-packaging.md` | #188 | - **Smooth premium option** — Dry-pressed (thermoformed) pulp for a refined look. | - **Премиальная гладкая поверхность** — Термоформованная целлюлоза для аккуратного внешнего вида. |  |  |
| C-molded-pulp-packaging-07 | `docs/content/molded-pulp-packaging.md` | #188 | - **Pairs with printed boxes** — Combine inserts with our corrugated or gift boxes. | - **В комплекте с коробкой** — Сочетайте ложементы с нашими гофро- или подарочными коробками. |  |  |
| C-molded-pulp-packaging-08 | `docs/content/molded-pulp-packaging.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-molded-pulp-packaging-09 | `docs/content/molded-pulp-packaging.md` | #188 | Types \| Protective inserts, trays, clamshells, cup carriers, premium boxes | Виды \| Защитные ложементы, лотки, контейнеры, держатели для стаканов, премиальные коробки |  |  |
| C-molded-pulp-packaging-10 | `docs/content/molded-pulp-packaging.md` | #188 | Material \| Bagasse, bamboo or recycled paper pulp | Материал \| Багасса, бамбук или вторичная бумажная масса |  |  |
| C-molded-pulp-packaging-11 | `docs/content/molded-pulp-packaging.md` | #188 | Process \| Wet-press (smooth) or dry-press (standard) molding | Технология \| Мокрое прессование (гладкая) или сухое (стандартная) |  |  |
| C-molded-pulp-packaging-12 | `docs/content/molded-pulp-packaging.md` | #188 | Options \| Natural, bleached or dyed color; embossed logo | Опции \| Натуральный, отбеленный или окрашенный цвет; рельефный логотип |  |  |
| C-molded-pulp-packaging-13 | `docs/content/molded-pulp-packaging.md` | #188 | Tooling \| Custom mold required — tooling cost and time on request | Оснастка \| Нужна пресс-форма — стоимость и сроки по запросу |  |  |
| C-molded-pulp-packaging-14 | `docs/content/molded-pulp-packaging.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-molded-pulp-packaging-15 | `docs/content/molded-pulp-packaging.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-molded-pulp-packaging-16 | `docs/content/molded-pulp-packaging.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-molded-pulp-packaging-17 | `docs/content/molded-pulp-packaging.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-molded-pulp-packaging-18 | `docs/content/molded-pulp-packaging.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-molded-pulp-packaging-19 | `docs/content/molded-pulp-packaging.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-molded-pulp-packaging-20 | `docs/content/molded-pulp-packaging.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-molded-pulp-packaging-21 | `docs/content/molded-pulp-packaging.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-molded-pulp-packaging-22 | `docs/content/molded-pulp-packaging.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-molded-pulp-packaging-23 | `docs/content/molded-pulp-packaging.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-molded-pulp-packaging-24 | `docs/content/molded-pulp-packaging.md` | #188 | - **Q: Is molded pulp compostable?** | |  |  |
| C-molded-pulp-packaging-25 | `docs/content/molded-pulp-packaging.md` | #188 | | |  |  |
| C-molded-pulp-packaging-26 | `docs/content/molded-pulp-packaging.md` | #188 | - **Q: Do I need a custom mold?** | - **В: Нужна ли отдельная пресс-форма?** |  |  |
| C-molded-pulp-packaging-27 | `docs/content/molded-pulp-packaging.md` | #188 | A: Yes for a custom shape. Tooling cost and lead time: on request. | О: Да, для индивидуальной формы. Стоимость и сроки оснастки — по запросу. |  |  |
| C-molded-pulp-packaging-28 | `docs/content/molded-pulp-packaging.md` | #188 | - **Q: Can you emboss our logo?** | - **В: Можно ли нанести логотип?** |  |  |
| C-molded-pulp-packaging-29 | `docs/content/molded-pulp-packaging.md` | #188 | A: Yes, a logo can be molded into the surface. | О: Да, логотип формуется рельефом на поверхности. |  |  |
| C-molded-pulp-packaging-kw-Транзакционные | `docs/content/molded-pulp-packaging.md` | #188 |  | **Транзакционные (主页面)**: упаковка из формованной целлюлозы, лотки из целлюлозы оптом, производство изделий из целлюлозы, эко упаковка из сахарного тростника |  |  |
| C-molded-pulp-packaging-kw-Коммерческие | `docs/content/molded-pulp-packaging.md` | #188 |  | **Коммерческие (主页面 + 小节)**: ложемент из целлюлозы, упаковка без пластика, экологичная упаковка для бизнеса, упаковка из багассы |  |  |
| C-molded-pulp-packaging-kw-Информационные | `docs/content/molded-pulp-packaging.md` | #188 |  | **Информационные (博客文章)**: что такое формованная целлюлоза, замена пенопласта в упаковке, экоупаковка плюсы и минусы |  |  |
| C-molded-pulp-packaging-outline-1 | `docs/content/molded-pulp-packaging.md` | #188 |  | |  |  |
| C-molded-pulp-packaging-outline-2 | `docs/content/molded-pulp-packaging.md` | #188 |  | H2s: Материалы; ограничения; как заказать ложементы |  |  |
| C-offset-printing-services-01 | `docs/content/offset-printing-services.md` | #188 | ### H1: Offset Printing Services | ### H1: Офсетная печать упаковки |  |  |
| C-offset-printing-services-02 | `docs/content/offset-printing-services.md` | #188 | PackJoyU provides high-volume offset printing for boxes, catalogs, brochures, labels and other printed materials. Offset printing delivers sharp detail and consistent color across large runs, with finishing available — lamination, foil, die-cutting and binding. | PackJoyU выполняет офсетную печать больших тиражей: коробки, каталоги, буклеты, этикетки и другая полиграфия. Офсет обеспечивает четкую детализацию и стабильный цвет на больших тиражах; доступна постпечатная обработка — ламинация, фольга, высечка и переплет. |  |  |
| C-offset-printing-services-03 | `docs/content/offset-printing-services.md` | #188 | #### Why PackJoyU | #### Почему PackJoyU |  |  |
| C-offset-printing-services-04 | `docs/content/offset-printing-services.md` | #188 | - **Efficient at volume** — Lower unit cost on larger runs. | - **Выгодно на тиражах** — Ниже цена за единицу на больших тиражах. |  |  |
| C-offset-printing-services-05 | `docs/content/offset-printing-services.md` | #188 | - **Sharp, consistent** — Fine detail and stable color sheet to sheet. | - **Четко и стабильно** — Мелкие детали и стабильный цвет от листа к листу. |  |  |
| C-offset-printing-services-06 | `docs/content/offset-printing-services.md` | #188 | - **Finishing and binding** — Lamination, foil, die-cut, saddle-stitch, perfect binding. | - **Постпечать и переплет** — Ламинация, фольга, высечка, скрепка, КБС. |  |  |
| C-offset-printing-services-07 | `docs/content/offset-printing-services.md` | #188 | | |  |  |
| C-offset-printing-services-08 | `docs/content/offset-printing-services.md` | #188 | #### Specifications & options | #### Характеристики и опции |  |  |
| C-offset-printing-services-09 | `docs/content/offset-printing-services.md` | #188 | Products \| Folding cartons, catalogs, brochures, booklets, labels, posters | Продукция \| Складные коробки, каталоги, буклеты, брошюры, этикетки, плакаты |  |  |
| C-offset-printing-services-10 | `docs/content/offset-printing-services.md` | #188 | Press \| Sheet-fed offset (press sizes on request) | Оборудование \| Листовой офсет (форматы — по запросу) |  |  |
| C-offset-printing-services-11 | `docs/content/offset-printing-services.md` | #188 | Colors \| CMYK + Pantone spot | Цвета \| CMYK + пантоны |  |  |
| C-offset-printing-services-12 | `docs/content/offset-printing-services.md` | #188 | Finishing \| Lamination, foil, spot UV, die-cut, folding, gluing | Обработка \| Ламинация, фольга, выборочный лак, высечка, фальцовка, склейка |  |  |
| C-offset-printing-services-13 | `docs/content/offset-printing-services.md` | #188 | Binding \| Saddle stitch, perfect binding, wire-o — on request | Переплет \| Скрепка, КБС, пружина — по запросу |  |  |
| C-offset-printing-services-14 | `docs/content/offset-printing-services.md` | #188 | MOQ \| On request | Минимальный тираж \| По запросу |  |  |
| C-offset-printing-services-15 | `docs/content/offset-printing-services.md` | #188 | Sample lead time \| On request | Срок изготовления образца \| По запросу |  |  |
| C-offset-printing-services-16 | `docs/content/offset-printing-services.md` | #188 | Production lead time \| On request | Срок производства \| По запросу |  |  |
| C-offset-printing-services-17 | `docs/content/offset-printing-services.md` | #188 | #### How it works | #### Как мы работаем |  |  |
| C-offset-printing-services-18 | `docs/content/offset-printing-services.md` | #188 | 1. **Send your brief** — product size, quantity, artwork or reference. | 1. **Отправьте задачу** — размеры товара, тираж, макет или референс. |  |  |
| C-offset-printing-services-19 | `docs/content/offset-printing-services.md` | #188 | 2. **Quote & structure** — we propose material, structure and dieline. | 2. **Расчёт и конструкция** — предложим материал, конструкцию и развертку. |  |  |
| C-offset-printing-services-20 | `docs/content/offset-printing-services.md` | #188 | 3. **Proof & sample** — digital proof, then physical sample (lead time on request). | 3. **Проба и образец** — цифровая проба, затем физический образец (срок — по запросу). |  |  |
| C-offset-printing-services-21 | `docs/content/offset-printing-services.md` | #188 | 4. **Production & QC** — mass production with inspection before packing. | 4. **Производство и контроль** — тираж с проверкой качества перед упаковкой. |  |  |
| C-offset-printing-services-22 | `docs/content/offset-printing-services.md` | #188 | 5. **Export shipping** — export packing and documents; terms confirmed per quote. | 5. **Экспортная доставка** — упаковка и документы; условия поставки — в расчёте. |  |  |
| C-offset-printing-services-23 | `docs/content/offset-printing-services.md` | #188 | **CTA:** Request a quote →（链接到询价表单，预填品类） | **CTA:** Запросить расчёт → |  |  |
| C-offset-printing-services-24 | `docs/content/offset-printing-services.md` | #188 | - **Q: When is offset better than digital?** | - **В: Когда офсет выгоднее цифры?** |  |  |
| C-offset-printing-services-25 | `docs/content/offset-printing-services.md` | #188 | A: Typically for larger runs and strict color; break-even quantity on request. | О: Обычно на больших тиражах и при строгих требованиях к цвету; расчёт — по запросу. |  |  |
| C-offset-printing-services-26 | `docs/content/offset-printing-services.md` | #188 | - **Q: Can you print catalogs in Russian?** | - **В: Печатаете каталоги на русском?** |  |  |
| C-offset-printing-services-27 | `docs/content/offset-printing-services.md` | #188 | A: Yes, we print from your supplied files in any language. | О: Да, печатаем по вашим файлам на любом языке. |  |  |
| C-offset-printing-services-28 | `docs/content/offset-printing-services.md` | #188 | - **Q: Do you check files before printing?** | - **В: Проверяете файлы перед печатью?** |  |  |
| C-offset-printing-services-29 | `docs/content/offset-printing-services.md` | #188 | A: Yes, prepress check and proof before the run. | О: Да, препресс-проверка и проба до тиража. |  |  |
| C-offset-printing-services-kw-Транзакционные | `docs/content/offset-printing-services.md` | #188 |  | **Транзакционные (主页面)**: офсетная печать упаковки, офсетная печать коробок, печать каталогов, типография офсетная печать |  |  |
| C-offset-printing-services-kw-Коммерческие | `docs/content/offset-printing-services.md` | #188 |  | **Коммерческие (主页面 + 小节)**: печать буклетов тиражом, печать брошюр, печать этикеток офсет, полиграфия из Китая |  |  |
| C-offset-printing-services-kw-Информационные | `docs/content/offset-printing-services.md` | #188 |  | **Информационные (博客文章)**: офсетная или цифровая печать, как работает офсетная печать |  |  |
| C-offset-printing-services-outline-1 | `docs/content/offset-printing-services.md` | #188 |  | Офсетная печать в Китае: как заказать каталог или упаковку |  |  |
| C-offset-printing-services-outline-2 | `docs/content/offset-printing-services.md` | #188 |  | H2s: Подготовка; пробы; логистика |  |  |

## 2. Metadata（title ≤60 / description ≤160）

来源：`categoryMeta.ts`（main）、`messages/ru.json`（#201 分支，相对 main 有改动的标 #201）、文章 front matter（#205）。

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| M-corrugated-boxes-title | `src/lib/seo/categoryMeta.ts` | main | Custom Corrugated Boxes Manufacturer \| PackJoyU | Гофрокороба на заказ — производство \| PackJoyU | 46/60 |  |
| M-corrugated-boxes-desc | `src/lib/seo/categoryMeta.ts` | #222 | Custom corrugated shipping and mailer boxes made to your size, with flexo or digital printing and your logo. Request a quote today. | Производство гофрокоробов на заказ: почтовые и транспортные коробки любых размеров с печатью и логотипом. Запросите расчёт. | 123/160 |  |
| M-corrugated-boxes-kw | `src/lib/seo/categoryMeta.ts` | main | гофрокороба на заказ | гофрокороба на заказ |  |  |
| M-color-boxes-title | `src/lib/seo/categoryMeta.ts` | main | Custom Printed Boxes Manufacturer & Supplier \| PackJoyU | Картонные коробки с печатью на заказ \| PackJoyU | 47/60 |  |
| M-color-boxes-desc | `src/lib/seo/categoryMeta.ts` | #222 | Full-color printed paperboard boxes for cosmetics, electronics and retail. Custom sizes, foil, embossing and matte or gloss coating. Request a quote today. | Картонные коробки с полноцветной печатью и логотипом для косметики, электроники и розницы. Любые размеры, тиснение и ламинация. Запросите расчёт. | 145/160 |  |
| M-color-boxes-kw | `src/lib/seo/categoryMeta.ts` | main | картонные коробки с печатью | картонные коробки с печатью |  |  |
| M-gift-boxes-title | `src/lib/seo/categoryMeta.ts` | main | Custom Gift Boxes Manufacturer & Supplier \| PackJoyU | Подарочные коробки на заказ оптом \| PackJoyU | 44/60 |  |
| M-gift-boxes-desc | `src/lib/seo/categoryMeta.ts` | #222 | Rigid gift boxes with magnetic lids, drawers and custom inserts. Premium wrapping paper, foil stamping and embossing for your brand. Request a quote today. | Жесткие подарочные коробки на заказ: с магнитом, выдвижные, с ложементом. Дизайнерская бумага, тиснение фольгой и логотип бренда. Запросите расчёт. | 147/160 |  |
| M-gift-boxes-kw | `src/lib/seo/categoryMeta.ts` | main | подарочные коробки на заказ | подарочные коробки на заказ |  |  |
| M-pulp-molding-title | `src/lib/seo/categoryMeta.ts` | main | Molded Pulp Packaging Manufacturer \| PackJoyU | Упаковка из формованной целлюлозы \| PackJoyU | 44/60 |  |
| M-pulp-molding-desc | `src/lib/seo/categoryMeta.ts` | #222 | Molded pulp trays, inserts and boxes, custom shaped. Request a quote today. | Лотки, ложементы и коробки из формованной целлюлозы любой формы под ваш продукт. Запросите расчёт. | 98/160 |  |
| M-pulp-molding-kw | `src/lib/seo/categoryMeta.ts` | main | упаковка из формованной целлюлозы | упаковка из формованной целлюлозы |  |  |
| M-paper-cups-title | `src/lib/seo/categoryMeta.ts` | main | Custom Paper Cups Manufacturer & Supplier \| PackJoyU | Бумажные стаканы с логотипом оптом \| PackJoyU | 45/60 |  |
| M-paper-cups-desc | `src/lib/seo/categoryMeta.ts` | #222 | Custom printed paper coffee cups with your logo in single and double wall, with matching lids for cafes and brands. Get a quote. | Бумажные стаканы для кофе с логотипом: однослойные и двухслойные, разные объемы и крышки в комплекте. Запросите расчёт. | 119/160 |  |
| M-paper-cups-kw | `src/lib/seo/categoryMeta.ts` | main | бумажные стаканы с логотипом | бумажные стаканы с логотипом |  |  |
| M-party-supplies-title | `src/lib/seo/categoryMeta.ts` | main | Custom Party Supplies Manufacturer \| PackJoyU | Бумажная посуда для праздника оптом \| PackJoyU | 46/60 |  |
| M-party-supplies-desc | `src/lib/seo/categoryMeta.ts` | #222 | Custom printed paper party supplies: plates, cups, napkins and decorations in your designs. Wholesale production for retailers and brands. Request a quote. | Одноразовая бумажная посуда с печатью для праздников: тарелки, стаканы, салфетки и декор по вашему дизайну. Оптом для сетей и брендов. Запросите расчёт. | 152/160 |  |
| M-party-supplies-kw | `src/lib/seo/categoryMeta.ts` | main | бумажная посуда для праздника оптом | бумажная посуда для праздника оптом |  |  |
| M-wine-boxes-title | `src/lib/seo/categoryMeta.ts` | main | Custom Wine Boxes Manufacturer & Supplier \| PackJoyU | Коробки для вина на заказ с логотипом \| PackJoyU | 48/60 |  |
| M-wine-boxes-desc | `src/lib/seo/categoryMeta.ts` | #222 | Luxury wine and spirits boxes for single or multiple bottles, with magnetic closures, inserts, foil and embossed logos. Gift-ready packaging. Get a quote. | Подарочные коробки для вина и крепких напитков на заказ: на одну или несколько бутылок, с магнитом, ложементом и тиснением логотипа. Запросите расчёт. | 150/160 |  |
| M-wine-boxes-kw | `src/lib/seo/categoryMeta.ts` | main | коробки для вина на заказ | коробки для вина на заказ |  |  |
| M-color-printing-title | `src/lib/seo/categoryMeta.ts` | main | Packaging Printing Services Manufacturer \| PackJoyU | Печать упаковки на заказ — полноцвет \| PackJoyU | 47/60 |  |
| M-color-printing-desc | `src/lib/seo/categoryMeta.ts` | #222 | Full-color CMYK and Pantone printing for packaging, labels and inserts on paper and board. Accurate color matching and fast proofs. Request a quote. | Полноцветная печать упаковки, этикеток и вкладышей на бумаге и картоне. Точная цветопередача CMYK и Pantone, быстрые пробы для брендов. Запросите расчёт. | 153/160 |  |
| M-color-printing-kw | `src/lib/seo/categoryMeta.ts` | main | печать упаковки | печать упаковки |  |  |
| M-offset-printing-title | `src/lib/seo/categoryMeta.ts` | main | Offset Printing Services Manufacturer \| PackJoyU | Офсетная печать упаковки на заказ \| PackJoyU | 44/60 |  |
| M-offset-printing-desc | `src/lib/seo/categoryMeta.ts` | #222 | High-volume offset printing for boxes, catalogs, brochures and labels. Sharp detail, consistent color. Request a quote. | Офсетная печать коробок, каталогов, буклетов и этикеток большими тиражами. Четкая детализация, стабильный цвет. Запросите расчёт. | 129/160 |  |
| M-offset-printing-kw | `src/lib/seo/categoryMeta.ts` | main | офсетная печать упаковки | офсетная печать упаковки |  |  |
| M-eco-paper-cups-title | `src/lib/seo/categoryMeta.ts` | seo/yo-unification | Eco-Friendly Paper Cups Manufacturer \| PackJoyU | Экологичные стаканы с логотипом \| PackJoyU ⚠️F15/F17 | 42/60 |  |
| M-eco-paper-cups-desc | `src/lib/seo/categoryMeta.ts` | seo/yo-unification | Eco-friendly paper cups custom printed with your logo, for cafes and coffee chains. Request a quote today. | Экологичные бумажные стаканы с печатью вашего логотипа. Для кофеен, ресторанов и сетей. Запросите расчёт. | 105/160 |  |
| M-eco-paper-cups-kw | `src/lib/seo/categoryMeta.ts` | seo/yo-unification | eco-friendly paper cups | экологичные стаканы |  |  |
| M-gift-cards-title | `src/lib/seo/categoryMeta.ts` | main | Custom Gift Cards Printing & Supplier \| PackJoyU | Печать подарочных карт на заказ \| PackJoyU | 42/60 |  |
| M-gift-cards-desc | `src/lib/seo/categoryMeta.ts` | #222 | Custom printed gift cards, vouchers and card holders with foil, spot UV and embossing. Matching envelopes and packaging for retail brands. Request a quote. | Печать подарочных карт и сертификатов на заказ: фольга, выборочный лак и тиснение. Конверты и упаковка для карт в едином стиле бренда. Запросите расчёт. | 152/160 |  |
| M-gift-cards-kw | `src/lib/seo/categoryMeta.ts` | main | печать подарочных карт | печать подарочных карт |  |  |
| M-christmas-merchandise-title | `src/lib/seo/categoryMeta.ts` | main | Custom Christmas Packaging Manufacturer \| PackJoyU | Новогодняя упаковка на заказ оптом \| PackJoyU | 45/60 |  |
| M-christmas-merchandise-desc | `src/lib/seo/categoryMeta.ts` | #222 | Custom Christmas gift boxes, advent calendars and seasonal packaging printed with your brand. Plan early for on-time holiday delivery. Request a quote. | Новогодние подарочные коробки, адвент календари и сезонная упаковка на заказ с логотипом. Закажите заранее, чтобы успеть к Новому году. Запросите расчёт. | 153/160 |  |
| M-christmas-merchandise-kw | `src/lib/seo/categoryMeta.ts` | main | новогодняя упаковка на заказ | новогодняя упаковка на заказ |  |  |
| MSG-Meta.title | `messages/ru.json` | #201 | Custom Packaging Manufacturer: Boxes & Cups \| PackJoyU | Производитель упаковки: коробки, стаканы, печать \| PackJoyU | 59/60 |  |
| MSG-Meta.description | `messages/ru.json` | #201 | PackJoyU manufactures custom corrugated boxes, gift and wine boxes, molded pulp, eco paper cups and printed packaging for brands in North America, Europe and Australia. | PackJoyU производит гофрокороба, подарочные и винные коробки, изделия из целлюлозы, эко-стаканы и печатную упаковку на заказ. | 125/160 |  |
| MSG-Products.metaTitle | `messages/ru.json` | main | Custom Packaging Products in 3D: Boxes, Cups & Printing \| PackJoyU | Упаковка на заказ в 3D: коробки, стаканы, печать \| PackJoyU | 59/60 |  |
| MSG-Products.metaDescription | `messages/ru.json` | #222 | Explore 12 custom packaging categories in 3D: corrugated boxes, gift and wine boxes, molded pulp, paper cups and printing. Request a quote from PackJoyU. | 12 видов упаковки на заказ в 3D: гофрокороба, подарочные и винные коробки, формованная целлюлоза, бумажные стаканы и печать. Запросите расчёт у PackJoyU. | 153/160 |  |
| MSG-Contact.metaTitle | `messages/ru.json` | #201 | Request a Custom Packaging Quote \| PackJoyU Manufacturer | Запросить расчёт стоимости упаковки на заказ \| PackJoyU | 55/60 |  |
| MSG-Contact.metaDescription | `messages/ru.json` | #201 | Tell us about your custom boxes, paper cups or printing project and get a quote from PackJoyU. | Расскажите о проекте: коробки, бумажные стаканы или печать на заказ. PackJoyU подготовит расчёт. | 96/160 |  |
| MSG-Privacy.metaTitle | `messages/ru.json` | main | Privacy policy (draft) \| PackJoyU | Политика конфиденциальности (черновик) \| PackJoyU | 49/60 |  |
| MSG-Privacy.metaDescription | `messages/ru.json` | #201 | How PackJoyU collects, uses and protects personal data from quote requests, sample orders, chat and cookies, and how to exercise your privacy rights. | Как PackJoyU собирает, использует и защищает персональные данные из запросов цены, заявок на образцы, чата и cookie, и как воспользоваться своими правами. | 154/160 |  |
| MSG-DesignExpired.metaTitle | `messages/ru.json` | main | Design expired \| PackJoyU | Срок действия дизайна истёк \| PackJoyU | 38/60 |  |
| MSG-DesignShared.metaTitle | `messages/ru.json` | #201 | Custom Packaging Design \| PackJoyU | Дизайн упаковки на заказ \| PackJoyU | 35/60 |  |
| ART-korporativnye-podarki-upakovka-s-logotipom-title | `docs/content/articles/korporativnye-podarki-upakovka-s-logotipom.md` | #205 | (EN article corporate-gift-packaging-planning-guide) H1 | Упаковка для корпоративных подарков с логотипом: как спланировать заказ |  |  |
| ART-korporativnye-podarki-upakovka-s-logotipom-seotitle | `docs/content/articles/korporativnye-podarki-upakovka-s-logotipom.md` | #205 | (EN article corporate-gift-packaging-planning-guide) SEO title / Sanity seo.title | Упаковка для корпоративных подарков с логотипом | 47/60 |  |
| ART-korporativnye-podarki-upakovka-s-logotipom-desc | `docs/content/articles/korporativnye-podarki-upakovka-s-logotipom.md` | #205 |  | Как спланировать упаковку для корпоративных подарков: виды подарочных коробок, ложементы, нанесение логотипа, сроки к Новому году и доставка. | 141/160 |  |
| ART-pochtovye-korobki-s-logotipom-dlya-internet-magazina-title | `docs/content/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina.md` | #205 | (EN article custom-mailer-boxes-ecommerce-buyers-guide) H1 | Почтовые коробки с логотипом для интернет-магазина и маркетплейсов: как заказать |  |  |
| ART-pochtovye-korobki-s-logotipom-dlya-internet-magazina-seotitle | `docs/content/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina.md` | #205 | (EN article custom-mailer-boxes-ecommerce-buyers-guide) SEO title / Sanity seo.title | Почтовые коробки с логотипом для интернет-магазина | 50/60 |  |
| ART-pochtovye-korobki-s-logotipom-dlya-internet-magazina-desc | `docs/content/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina.md` | #205 |  | Как заказать почтовые коробки с логотипом для интернет-магазина и маркетплейсов: конструкции, гофрокартон, печать, размеры и этапы заказа на производстве. | 154/160 |  |

## 3. Alt text

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| ALT-Meta.ogImageAlt | `messages/ru.json` | #201 | PackJoyU custom packaging: boxes, paper cups and printing | Упаковка на заказ PackJoyU: коробки, бумажные стаканы и печать |  |  |
| ALT-Home.heroLabel | `messages/ru.json` | main | Stack of custom PackJoyU boxes and a paper cup | Коробки и бумажный стакан PackJoyU |  |  |
| ALT-Products.alt | `messages/ru.json` | main | {name}: custom packaging by PackJoyU | {name}: упаковка на заказ от PackJoyU |  |  |

### 3.1 品类分享图 alt / Category share-image alt（#220，`public/og/category-<slug>-ru.jpg`）

设计师 #220 **定稿表**（已替换此前的临时稿）：只描述画面，不带品牌名 / H1 前缀（标题已在 og:title），全部用 ё。英文列是设计师的英文 alt 定稿（对应英文分享图 `/og/category-<en-slug>-en.jpg`）。**英俄两列都待 Ryan 确认。**

| ID | 文件 | PR | English（对照） | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| ALT-OG-gofrokorobki | `public/og/category-gofrokorobki-ru.jpg` ✔ | #220 · final (designer) | corrugated shipping box with printed logo and handling symbols (`/og/category-custom-corrugated-boxes-en.jpg`) | гофрокороб с печатью логотипа и манипуляционных знаков | 54 |  |
| ALT-OG-tsvetnye-korobki | `public/og/category-tsvetnye-korobki-ru.jpg` ✔ | #220 · final (designer) | red printed paperboard box (`/og/category-custom-printed-boxes-en.jpg`) | красная картонная коробка с печатью | 35 |  |
| ALT-OG-podarochnye-korobki | `public/og/category-podarochnye-korobki-ru.jpg` ✔ | #220 · final (designer) | black rigid gift box with gold ribbon and logo on the lid (`/og/category-custom-gift-boxes-en.jpg`) | чёрная жёсткая подарочная коробка с золотой лентой и логотипом на крышке | 72 |  |
| ALT-OG-izdeliya-iz-tsellyulozy | `public/og/category-izdeliya-iz-tsellyulozy-ru.jpg` ✔ | #220 · final (designer) | molded pulp tray (`/og/category-molded-pulp-packaging-en.jpg`) | лоток из формованной целлюлозы | 30 |  |
| ALT-OG-bumazhnye-stakany | `public/og/category-bumazhnye-stakany-ru.jpg` ✔ | #220 · final (designer) | paper cup with a red band (`/og/category-custom-paper-cups-en.jpg`) | бумажный стакан с красной полосой | 33 |  |
| ALT-OG-tovary-dlya-prazdnikov | `public/og/category-tovary-dlya-prazdnikov-ru.jpg` ✔ | #220 · final (designer) | paper plate and party hat (`/og/category-custom-party-supplies-en.jpg`) | бумажная тарелка и праздничный колпак | 37 |  |
| ALT-OG-upakovka-dlya-vina | `public/og/category-upakovka-dlya-vina-ru.jpg` ✔ | #220 · final (designer) | tall dark wine box with a gold band (`/og/category-custom-wine-boxes-en.jpg`) | высокая тёмная коробка для вина с золотой полосой | 49 |  |
| ALT-OG-tsvetnaya-pechat | `public/og/category-tsvetnaya-pechat-ru.jpg` ✔ | #220 · final (designer) | full-color (CMYK) print sample (`/og/category-custom-color-printing-en.jpg`) | образец полноцветной печати (CMYK) | 34 |  |
| ALT-OG-ofsetnaya-pechat | `public/og/category-ofsetnaya-pechat-ru.jpg` ✔ | #220 · final (designer) | stack of printed sheets (`/og/category-offset-printing-services-en.jpg`) | стопка отпечатанных листов | 26 |  |
| ALT-OG-ekologichnye-stakany | `public/og/category-ekologichnye-stakany-ru.jpg` ✔ | #220 · final (designer) | paper cup with green band and leaf print (`/og/category-eco-paper-cups-en.jpg`) | бумажный стакан с зелёной полосой и изображением листа | 54 |  |
| ALT-OG-podarochnye-karty | `public/og/category-podarochnye-karty-ru.jpg` ✔ | #220 · final (designer) | printed gift cards (`/og/category-custom-gift-cards-en.jpg`) | напечатанные подарочные карты ⚠️F16（карты / открытки — ждёт Ryan） | 29 |  |
| ALT-OG-novogodnyaya-upakovka | `public/og/category-novogodnyaya-upakovka-ru.jpg` ✔ | #220 · final (designer) | red Christmas gift box with green ribbon (`/og/category-custom-christmas-packaging-en.jpg`) | красная новогодняя коробка с зелёной лентой | 43 |  |

## 4. 内链锚文本 / Internal-link anchors（#205）

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| A-01 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/gofrokorobki → /ru/products/tsvetnye-korobki | картонные коробки с печатью |  |  |
| A-02 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/gofrokorobki → /ru/products/izdeliya-iz-tsellyulozy | упаковка из формованной целлюлозы |  |  |
| A-03 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/gofrokorobki → /ru/products/ofsetnaya-pechat | офсетная печать упаковки |  |  |
| A-04 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tsvetnye-korobki → /ru/products/podarochnye-korobki | подарочные коробки на заказ |  |  |
| A-05 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tsvetnye-korobki → /ru/products/tsvetnaya-pechat | печать упаковки |  |  |
| A-06 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tsvetnye-korobki → /ru/products/ofsetnaya-pechat | офсетная печать тиражом |  |  |
| A-07 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/podarochnye-korobki → /ru/products/upakovka-dlya-vina | коробки для вина на заказ |  |  |
| A-08 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/podarochnye-korobki → /ru/products/novogodnyaya-upakovka | новогодняя упаковка на заказ |  |  |
| A-09 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/podarochnye-korobki → /ru/products/tsvetnye-korobki | коробки с логотипом |  |  |
| A-10 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/izdeliya-iz-tsellyulozy → /ru/products/gofrokorobki | гофрокороба на заказ |  |  |
| A-11 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/izdeliya-iz-tsellyulozy → /ru/products/ekologichnye-stakany | экологичные стаканы |  |  |
| A-12 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/izdeliya-iz-tsellyulozy → /ru/products/podarochnye-korobki | жесткие коробки с магнитом |  |  |
| A-13 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/bumazhnye-stakany → /ru/products/ekologichnye-stakany | экологичные стаканы |  |  |
| A-14 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/bumazhnye-stakany → /ru/products/tovary-dlya-prazdnikov | бумажная посуда для праздника |  |  |
| A-15 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/bumazhnye-stakany → /ru/products/tsvetnye-korobki | упаковка для косметики и розницы |  |  |
| A-16 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tovary-dlya-prazdnikov → /ru/products/bumazhnye-stakany | бумажные стаканы с логотипом |  |  |
| A-17 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tovary-dlya-prazdnikov → /ru/products/novogodnyaya-upakovka | новогодние подарочные коробки |  |  |
| A-18 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tovary-dlya-prazdnikov → /ru/products/tsvetnaya-pechat | полноцветная печать на картоне |  |  |
| A-19 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/upakovka-dlya-vina → /ru/products/podarochnye-korobki | премиальная подарочная упаковка |  |  |
| A-20 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/upakovka-dlya-vina → /ru/products/novogodnyaya-upakovka | адвент-календари на заказ |  |  |
| A-21 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/upakovka-dlya-vina → /ru/products/izdeliya-iz-tsellyulozy | ложементы из целлюлозы |  |  |
| A-22 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tsvetnaya-pechat → /ru/products/ofsetnaya-pechat | печать каталогов и коробок |  |  |
| A-23 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tsvetnaya-pechat → /ru/products/tsvetnye-korobki | картонные коробки с печатью |  |  |
| A-24 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/tsvetnaya-pechat → /ru/products/podarochnye-karty | печать подарочных карт |  |  |
| A-25 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/ofsetnaya-pechat → /ru/products/tsvetnaya-pechat | печать пантонами |  |  |
| A-26 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/ofsetnaya-pechat → /ru/products/tsvetnye-korobki | коробки с логотипом |  |  |
| A-27 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/ofsetnaya-pechat → /ru/products/podarochnye-karty | подарочные сертификаты на заказ |  |  |
| A-28 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/ekologichnye-stakany → /ru/products/bumazhnye-stakany | стаканы для кофе с печатью |  |  |
| A-29 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/ekologichnye-stakany → /ru/products/izdeliya-iz-tsellyulozy | лотки из целлюлозы |  |  |
| A-30 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/ekologichnye-stakany → /ru/products/tovary-dlya-prazdnikov | праздничная посуда с печатью |  |  |
| A-31 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/podarochnye-karty → /ru/products/tsvetnaya-pechat | печать упаковки |  |  |
| A-32 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/podarochnye-karty → /ru/products/podarochnye-korobki | подарочные коробки на заказ |  |  |
| A-33 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/podarochnye-karty → /ru/products/ofsetnaya-pechat | офсетная печать упаковки |  |  |
| A-34 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/novogodnyaya-upakovka → /ru/products/podarochnye-korobki | жесткие коробки с магнитом |  |  |
| A-35 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/novogodnyaya-upakovka → /ru/products/upakovka-dlya-vina | подарочная упаковка для алкоголя |  |  |
| A-36 | `docs/content/internal-links.json` | #205 | category→category: /ru/products/novogodnyaya-upakovka → /ru/products/tovary-dlya-prazdnikov | товары для праздника под вашей маркой |  |  |
| A-37 | `docs/content/internal-links.json` | #205 | article→category: /ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina → /ru/products/gofrokorobki | почтовые коробки с логотипом |  |  |
| A-38 | `docs/content/internal-links.json` | #205 | category→article: /ru/products/gofrokorobki → /ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina | как заказать почтовые коробки для интернет-магазина |  |  |
| A-39 | `docs/content/internal-links.json` | #205 | article→category: /ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina → /ru/products/tsvetnye-korobki | упаковка для косметики и розницы |  |  |
| A-40 | `docs/content/internal-links.json` | #205 | category→article: /ru/products/tsvetnye-korobki → /ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina | гид по коробкам для маркетплейсов |  |  |
| A-41 | `docs/content/internal-links.json` | #205 | article→category: /ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina → /ru/products/izdeliya-iz-tsellyulozy | упаковка из формованной целлюлозы |  |  |
| A-42 | `docs/content/internal-links.json` | #205 | category→article: /ru/products/izdeliya-iz-tsellyulozy → /ru/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina | как выбрать коробку для интернет-магазина |  |  |
| A-43 | `docs/content/internal-links.json` | #205 | article→category: /ru/articles/korporativnye-podarki-upakovka-s-logotipom → /ru/products/podarochnye-korobki | премиальная подарочная упаковка |  |  |
| A-44 | `docs/content/internal-links.json` | #205 | category→article: /ru/products/podarochnye-korobki → /ru/articles/korporativnye-podarki-upakovka-s-logotipom | как спланировать упаковку для корпоративных подарков |  |  |
| A-45 | `docs/content/internal-links.json` | #205 | article→category: /ru/articles/korporativnye-podarki-upakovka-s-logotipom → /ru/products/novogodnyaya-upakovka | новогодняя упаковка на заказ |  |  |
| A-46 | `docs/content/internal-links.json` | #205 | category→article: /ru/products/novogodnyaya-upakovka → /ru/articles/korporativnye-podarki-upakovka-s-logotipom | упаковка корпоративных подарков к Новому году |  |  |
| A-47 | `docs/content/internal-links.json` | #205 | article→category: /ru/articles/korporativnye-podarki-upakovka-s-logotipom → /ru/products/upakovka-dlya-vina | коробки для бутылок с логотипом |  |  |
| A-48 | `docs/content/internal-links.json` | #205 | category→article: /ru/products/upakovka-dlya-vina → /ru/articles/korporativnye-podarki-upakovka-s-logotipom | гид по корпоративной подарочной упаковке |  |  |

## 5. 站内 SEO 相关界面文案 / SEO-facing UI copy（messages/ru.json）

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| UI-Home.headline | `messages/ru.json` | main | Packaging that sparks joy | Упаковка, которая дарит радость |  |  |
| UI-Home.sub | `messages/ru.json` | main | Custom paper packaging and printing, from prototype to mass production — explore every product in 3D. | Бумажная упаковка и печать на заказ — от образца до серийного производства. Рассмотрите каждое изделие в 3D. |  |  |
| UI-Home.cta | `messages/ru.json` | main | Explore products in 3D | Смотреть продукцию в 3D |  |  |
| UI-Home.ctaQuote | `messages/ru.json` | #222 | Get a quote | Запросить расчёт |  |  |
| UI-Home.advTitle | `messages/ru.json` | main | Why brands choose PackJoyU | Почему бренды выбирают PackJoyU |  |  |
| UI-Home.adv.capacity.label | `messages/ru.json` | main | boxes produced per month | коробок в месяц |  |  |
| UI-Home.adv.certs.label | `messages/ru.json` | main | | |  |  |
| UI-Home.adv.sampling.label | `messages/ru.json` | main | from artwork to physical sample | от макета до готового образца |  |  |
| UI-Home.adv.eco.label | `messages/ru.json` | main | recyclable paper options | перерабатываемые варианты бумаги |  |  |
| UI-Home.entryTitle | `messages/ru.json` | main | Find your packaging | Подберите упаковку |  |  |
| UI-Home.premiumTitle | `messages/ru.json` | main | Premium gift & wine boxes | Премиальные подарочные и винные коробки |  |  |
| UI-Home.premiumText | `messages/ru.json` | main | Rigid boxes with foil stamping, magnetic closures and custom inserts — made to be unboxed on camera. | Жёсткие коробки с тиснением фольгой, магнитным замком и ложементами — их хочется распаковывать на камеру. |  |  |
| UI-Home.ctaBandTitle | `messages/ru.json` | main | Have a project in mind? | Есть проект? |  |  |
| UI-Home.ctaBandText | `messages/ru.json` | main | Tell us what you need. | Расскажите, что вам нужно. |  |  |
| UI-Products.title | `messages/ru.json` | main | Our products in 3D | Наша продукция в 3D |  |  |
| UI-Products.names.corrugated-boxes | `messages/ru.json` | #222 | Corrugated Boxes | Гофрокороба |  |  |
| UI-Products.names.color-boxes | `messages/ru.json` | main | Color Boxes | Цветные коробки |  |  |
| UI-Products.names.gift-boxes | `messages/ru.json` | main | Gift Boxes | Подарочные коробки |  |  |
| UI-Products.names.pulp-molding | `messages/ru.json` | main | Molded Pulp | Изделия из формованной целлюлозы |  |  |
| UI-Products.names.paper-cups | `messages/ru.json` | main | Paper Cups | Бумажные стаканы |  |  |
| UI-Products.names.party-supplies | `messages/ru.json` | main | Party Supplies | Товары для праздников |  |  |
| UI-Products.names.wine-boxes | `messages/ru.json` | main | Wine Boxes | Коробки для вина |  |  |
| UI-Products.names.color-printing | `messages/ru.json` | main | Color Printing | Цветная печать |  |  |
| UI-Products.names.offset-printing | `messages/ru.json` | main | Offset Printing | Офсетная печать |  |  |
| UI-Products.names.eco-paper-cups | `messages/ru.json` | main | Eco-Friendly Paper Cups | Экологичные бумажные стаканы |  |  |
| UI-Products.names.gift-cards | `messages/ru.json` | main | Gift Cards | Подарочные карты |  |  |
| UI-Products.names.christmas-merchandise | `messages/ru.json` | #222 | Christmas Merchandise | Новогодняя упаковка |  |  |
| UI-Products.desc.corrugated-boxes | `messages/ru.json` | #222 | Custom corrugated shipping and mailer boxes in single and double wall, printed with your brand. | Гофрокороба и почтовые коробки на заказ, однослойный и двухслойный гофрокартон, печать логотипа. |  |  |
| UI-Products.desc.color-boxes | `messages/ru.json` | main | Full-color printed folding cartons and retail product boxes for cosmetics, food and electronics. | Картонные коробки с полноцветной печатью для косметики, продуктов и электроники. |  |  |
| UI-Products.desc.gift-boxes | `messages/ru.json` | main | Rigid and magnetic custom gift boxes with foil stamping, embossing and fitted inserts. | Жесткие и магнитные подарочные коробки на заказ с тиснением фольгой и ложементами. |  |  |
| UI-Products.desc.pulp-molding | `messages/ru.json` | main | Molded pulp trays and inserts. | Лотки и вкладыши из формованной целлюлозы. |  |  |
| UI-Products.desc.paper-cups | `messages/ru.json` | main | Custom printed paper cups for coffee, tea and cold drinks, in single and double wall. | Бумажные стаканы с логотипом для кофе, чая и холодных напитков. |  |  |
| UI-Products.desc.party-supplies | `messages/ru.json` | main | Printed paper party tableware: plates, cups, napkins and decorations for events and retail. | Бумажная праздничная посуда с печатью: тарелки, стаканы, салфетки и декор. |  |  |
| UI-Products.desc.wine-boxes | `messages/ru.json` | main | Custom wine and spirits boxes for one or more bottles, with premium finishes and inserts. | Коробки для вина и крепких напитков на одну или несколько бутылок, премиальная отделка. |  |  |
| UI-Products.desc.color-printing | `messages/ru.json` | main | CMYK and spot-color printing for packaging, labels and marketing materials. | Полноцветная печать и печать пантонами для упаковки, этикеток и полиграфии. |  |  |
| UI-Products.desc.offset-printing | `messages/ru.json` | main | Offset printing for boxes, catalogs and brochures with consistent color at volume. | Офсетная печать коробок, каталогов и буклетов со стабильной цветопередачей. |  |  |
| UI-Products.desc.eco-paper-cups | `messages/ru.json` | main | Eco-friendly paper cups. | Экологичные бумажные стаканы. |  |  |
| UI-Products.desc.gift-cards | `messages/ru.json` | main | Custom printed gift cards, greeting cards and card packaging for retail and promotions. | Подарочные и поздравительные карты с печатью и упаковка для них. |  |  |
| UI-Products.desc.christmas-merchandise | `messages/ru.json` | main | Christmas gift boxes, tubes, advent calendars and seasonal packaging made to order. | Новогодние подарочные коробки, тубусы, адвент-календари и сезонная упаковка на заказ. |  |  |

## 6. 落地页设计稿 / Landing design（#217，design/landing/）

设计稿里的示例俄语（字段标签、按钮、503 文案、示例落地页正文）。English 列为空的条目，英文对照在同一 HTML 文件的 `en` 对象里；示例正文与 #188 落地页对应。

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| D217-001 | `design/landing/category-landing.html:134` | #217 |  | Продукция |  |  |
| D217-002 | `design/landing/category-landing.html:134` | #217 |  | 3D-конструктор |  |  |
| D217-003 | `design/landing/category-landing.html:134` | #217 |  | Статьи |  |  |
| D217-004 | `design/landing/category-landing.html:134` | #217 |  | Контакты |  |  |
| D217-005-home | `design/landing/category-landing.html:134` | #217 |  | Главная |  |  |
| D217-006-products | `design/landing/category-landing.html:134` | #217 |  | Продукция |  |  |
| D217-007-quote | `design/landing/category-landing.html:134` | #217 |  | Запросить расчет |  |  |
| D217-008-custom | `design/landing/category-landing.html:134` | #217 |  | Собрать в 3D |  |  |
| D217-009-rotate | `design/landing/category-landing.html:134` | #217 |  | Потяните, чтобы повернуть |  |  |
| D217-010-open | `design/landing/category-landing.html:134` | #217 |  | Открыть коробку |  |  |
| D217-011-why | `design/landing/category-landing.html:135` | #217 |  | Почему PackJoyU |  |  |
| D217-012-specs | `design/landing/category-landing.html:135` | #217 |  | Характеристики и опции |  |  |
| D217-013-key | `design/landing/category-landing.html:135` | #217 |  | Основные параметры |  |  |
| D217-014-options | `design/landing/category-landing.html:135` | #217 |  | Опции |  |  |
| D217-015-certs | `design/landing/category-landing.html:135` | #217 |  | Сертификаты |  |  |
| D217-016-how | `design/landing/category-landing.html:135` | #217 |  | Как мы работаем |  |  |
| D217-017-faq | `design/landing/category-landing.html:135` | #217 |  | Частые вопросы |  |  |
| D217-018-related | `design/landing/category-landing.html:135` | #217 |  | Похожие товары |  |  |
| D217-019-reading | `design/landing/category-landing.html:135` | #217 |  | Полезные статьи |  |  |
| D217-020-size | `design/landing/category-landing.html:136` | #217 |  | Размеры |  |  |
| D217-021-material | `design/landing/category-landing.html:136` | #217 |  | Материал |  |  |
| D217-022-moq | `design/landing/category-landing.html:136` | #217 |  | Минимальный тираж |  |  |
| D217-023-sample | `design/landing/category-landing.html:136` | #217 |  | Стоимость образца |  |  |
| D217-024-lead | `design/landing/category-landing.html:136` | #217 |  | Срок производства |  |  |
| D217-025-terms | `design/landing/category-landing.html:136` | #217 |  | Условия поставки |  |  |
| D217-026-free | `design/landing/category-landing.html:136` | #217 |  | |  |  |
| D217-027-days | `design/landing/category-landing.html:136` | #217 |  | дн. |  |  |
| D217-028-pcs | `design/landing/category-landing.html:136` | #217 |  | шт. |  |  |
| D217-029-ctaT | `design/landing/category-landing.html:137` | #217 |  | Рассчитаем стоимость вашей упаковки |  |  |
| D217-030-ctaP | `design/landing/category-landing.html:137` | #217 |  | Пришлите размеры, тираж и макет. |  |  |
| D217-031-newtab | `design/landing/category-landing.html:137` | #217 |  | (откроется в новой вкладке) |  |  |
| D217-032 | `design/landing/category-landing.html:137` | #217 |  | Конфиденциальность |  |  |
| D217-033 | `design/landing/category-landing.html:137` | #217 |  | Настройки cookie |  |  |
| D217-034 | `design/landing/category-landing.html:137` | #217 |  | Контакты |  |  |
| D217-035-h1 | `design/landing/category-landing.html:146` | #217 |  | Гофрокороба на заказ |  |  |
| D217-036-lead | `design/landing/category-landing.html:146` | #217 |  | PackJoyU производит гофрокороба на заказ для доставки, интернет-торговли и розницы: почтовые коробки, четырехклапанные короба и демонстрационную упаковку точно под ваши размеры. Мы наносим логотип и дизайн прямо на гофрокартон, поэтому коробка защищает товар при перевозке и при этом работает на узнаваемость бренда. |  |  |
| D217-037 | `design/landing/category-landing.html:147` | #217 |  | Точно по размеру |  |  |
| D217-038 | `design/landing/category-landing.html:147` | #217 |  | Каждая коробка изготавливается под габариты товара — меньше наполнителя и объема при доставке. |  |  |
| D217-039 | `design/landing/category-landing.html:147` | #217 |  | Фирменная распаковка |  |  |
| D217-040 | `design/landing/category-landing.html:147` | #217 |  | Флексо- или цифровая печать снаружи и внутри: от логотипа в один цвет до полноцветного дизайна. |  |  |
| D217-041 | `design/landing/category-landing.html:147` | #217 |  | Прочность при перевозке |  |  |
| D217-042 | `design/landing/category-landing.html:147` | #217 |  | Марку картона и профиль гофры подбираем под вес товара и маршрут доставки. |  |  |
| D217-043 | `design/landing/category-landing.html:147` | #217 |  | |  |  |
| D217-044 | `design/landing/category-landing.html:147` | #217 |  | Один поставщик — от конструкции коробки до экспортной упаковки и документов. |  |  |
| D217-045 | `design/landing/category-landing.html:148` | #217 |  | Конструкции |  |  |
| D217-046 | `design/landing/category-landing.html:148` | #217 |  | Почтовые коробки (самосборные), четырехклапанные короба, высечные коробки, шоу-боксы |  |  |
| D217-047 | `design/landing/category-landing.html:148` | #217 |  | Материал |  |  |
| D217-048 | `design/landing/category-landing.html:148` | #217 |  | Бурый или белый гофрокартон; профиль гофры и количество слоев — по продукту |  |  |
| D217-049 | `design/landing/category-landing.html:148` | #217 |  | Печать |  |  |
| D217-050 | `design/landing/category-landing.html:148` | #217 |  | Флексопечать, цифровая печать или кашировка офсетным листом |  |  |
| D217-051 | `design/landing/category-landing.html:148` | #217 |  | Отделка |  |  |
| D217-052 | `design/landing/category-landing.html:148` | #217 |  | Матовый/глянцевый лак, ламинация, печать внутри, отрывная лента, ложементы |  |  |
| D217-053 | `design/landing/category-landing.html:148` | #217 |  | Размеры |  |  |
| D217-054 | `design/landing/category-landing.html:148` | #217 |  | Любые — пришлите габариты товара или образец |  |  |
| D217-055 | `design/landing/category-landing.html:149` | #217 |  | Отправьте задачу |  |  |
| D217-056 | `design/landing/category-landing.html:149` | #217 |  | размеры товара, тираж, макет или референс. |  |  |
| D217-057 | `design/landing/category-landing.html:149` | #217 |  | Расчет и конструкция |  |  |
| D217-058 | `design/landing/category-landing.html:149` | #217 |  | предложим материал, конструкцию и развертку. |  |  |
| D217-059 | `design/landing/category-landing.html:149` | #217 |  | Проба и образец |  |  |
| D217-060 | `design/landing/category-landing.html:149` | #217 |  | цифровая проба, затем физический образец. |  |  |
| D217-061 | `design/landing/category-landing.html:149` | #217 |  | Производство и контроль |  |  |
| D217-062 | `design/landing/category-landing.html:149` | #217 |  | тираж с проверкой качества перед упаковкой. |  |  |
| D217-063 | `design/landing/category-landing.html:149` | #217 |  | Экспортная доставка |  |  |
| D217-064 | `design/landing/category-landing.html:149` | #217 |  | упаковка и документы; условия поставки — в расчете. |  |  |
| D217-065 | `design/landing/category-landing.html:150` | #217 |  | Можете ли вы разработать конструкцию коробки? |  |  |
| D217-066 | `design/landing/category-landing.html:150` | #217 |  | Да. Пришлите размеры и вес товара — мы предложим конструкцию и развертку на согласование. |  |  |
| D217-067 | `design/landing/category-landing.html:150` | #217 |  | Доставляете ли вы в Россию? |  |  |
| D217-068 | `design/landing/category-landing.html:150` | #217 |  | Да, мы экспортируем продукцию, условия поставки уточняются в расчете. |  |  |
| D217-069 | `design/landing/category-landing.html:151` | #217 |  | картонные коробки с печатью |  |  |
| D217-070 | `design/landing/category-landing.html:151` | #217 |  | упаковка из формованной целлюлозы |  |  |
| D217-071 | `design/landing/category-landing.html:151` | #217 |  | офсетная печать упаковки |  |  |
| D217-072 | `design/landing/category-landing.html:152` | #217 |  | как заказать почтовые коробки для интернет-магазина |  |  |
| D217-073-c | `design/landing/category-landing.html:207` | #217 |  | 503 · ВРЕМЕННО НЕДОСТУПНО |  |  |
| D217-074-h | `design/landing/category-landing.html:207` | #217 |  | Временно недоступно |  |  |
| D217-075-p | `design/landing/category-landing.html:207` | #217 |  | Сейчас не удается загрузить сохраненный дизайн. Попробуйте еще раз через минуту — ваш дизайн сохранен. |  |  |
| D217-076-r | `design/landing/category-landing.html:207` | #217 |  | Попробовать снова |  |  |
| D217-077-h2 | `design/landing/category-landing.html:207` | #217 |  | Смотреть продукцию |  |  |
| D217-078-readme | `design/landing/README.md` | #217 | Size range | Размеры |  |  |
| D217-079-readme | `design/landing/README.md` | #217 | Material | Материал |  |  |
| D217-080-readme | `design/landing/README.md` | #217 | Minimum order | Минимальный тираж |  |  |
| D217-081-readme | `design/landing/README.md` | #217 |  | Стоимость образца |  |  |
| D217-082-readme | `design/landing/README.md` | #217 | Lead time | Срок производства |  |  |
| D217-083-readme | `design/landing/README.md` | #217 | Trade terms | Условия поставки |  |  |
| D217-084-readme | `design/landing/README.md` | #217 | Certificates | Сертификаты |  |  |
| D217-085-readme | `design/landing/README.md` | #217 | Temporarily unavailable | Временно недоступно |  |  |

## 7. /s/<id> 503 与兜底页 / Shortlink 503 & fallback（#215）

| ID | 来源 | PR | English | Русский | 字符数 | Ryan: OK / correction |
|---|---|---|---|---|---|---|
| S215-title | `src/app/[locale]/s/unavailable/notice.tsx` | #215 | Temporarily unavailable | Временно недоступно |  |  |
| S215-text | `src/app/[locale]/s/unavailable/notice.tsx` | #215 | Temporarily unavailable, please try again later. | Временно недоступно, пожалуйста, попробуйте позже. |  |  |
| S215-meta | `src/app/[locale]/s/unavailable/notice.tsx` | #215 | Temporarily unavailable \| PackJoyU | Временно недоступно \| PackJoyU | 30/60 |  |

## 8. 文章 / Articles（#205）

正文较长，请直接在文件里读，按小节打勾。英文对应版本在 #196（俄语是本地化改写，不是逐句翻译）。标题和描述见第 2 组 `ART-*`。

### Упаковка для корпоративных подарков с логотипом: как спланировать заказ
- 文件：`docs/content/articles/korporativnye-podarki-upakovka-s-logotipom.md`（#205），英文版：`corporate-gift-packaging-planning-guide`（#196）
- [ ] 标题 / H1 和 SEO 标题 `seo_title`（≤60，见 F3）
- [ ] 导语段
- [ ] ## Начните с технического задания（7 段/列表行）
- [ ] ## Какую подарочную коробку выбрать（6 段/列表行）
- [ ] ## Ложементы: чтобы всё держалось на месте（6 段/列表行）
- [ ] ## Брендирование и отделка（8 段/列表行）
- [ ] ## Сроки: как успеть к Новому году（8 段/列表行）
- [ ] ## Доставка подарков（1 段/列表行）
- [ ] ## Экологичность（1 段/列表行）
- [ ] ## Что спросить у производителя（6 段/列表行）
- [ ] ## Из чего складывается бюджет（1 段/列表行）
- [ ] ## Итог（2 段/列表行）
- [ ] 所有 TBD 保留，未写具体天数/价格
- Ryan 备注：

### Почтовые коробки с логотипом для интернет-магазина и маркетплейсов: как заказать
- 文件：`docs/content/articles/pochtovye-korobki-s-logotipom-dlya-internet-magazina.md`（#205），英文版：`custom-mailer-boxes-ecommerce-buyers-guide`（#196）
- [ ] 标题 / H1 和 SEO 标题 `seo_title`（≤60，见 F3）
- [ ] 导语段
- [ ] ## Зачем бренду коробки с логотипом（2 段/列表行）
- [ ] ## Какую конструкцию выбрать（6 段/列表行）
- [ ] ## Гофрокартон: прочность при доставке（6 段/列表行）
- [ ] ## Варианты печати（5 段/列表行）
- [ ] ## Как определить размер（2 段/列表行）
- [ ] ## Экология без громких заявлений（1 段/列表行）
- [ ] ## Этапы заказа（6 段/列表行）
- [ ] ## Что спросить у производителя（6 段/列表行）
- [ ] ## Из чего складывается цена（1 段/列表行）
- [ ] ## Итог（2 段/列表行）
- [ ] 所有 TBD 保留，未写具体天数/价格
- Ryan 备注：

## 9. Sanity 导入（#205）

`docs/content/sanity-import/import.ndjson` 里的俄语（title、excerpt、body、seo）全部由上面的 #188 落地页、`categoryMeta.ts` 和文章生成，不单独校对。上面确认后重新运行 `build.py` 即可，`seo.noindex` 全部保持 true，直到 Ryan 逐个放开。
