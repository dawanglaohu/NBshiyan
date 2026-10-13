# Ryan 待确认事实问卷（品类页 + 已隐藏说法）

> 用途：把 `docs/content/category-pages/*.md` 里的 142 处 `{{待Ryan确认}}` 去重合并成 15 个问题，再加 8 个影响全站、目前已隐藏说法的问题，共 **23 题**。
> Ryan 只需逐题回答；每题注明影响哪些品类和页面，SEO 按答案回填英俄两份页面。
> 规则：没回答的题，对应内容继续隐藏（含 `{{` 的块不渲染）。本文不包含任何推测的数值。俄语文案回填后仍需 Ryan 校对。
>
> 来源：`seo/category-copy` `0235510`（品类文案），`tests/unconfirmed-claims.test.ts`，ru-proofreading 事实清单 F1–F22（`/workspace/NBshiyan` `a403c8b`，`docs/content/ru-proofreading.md`）。

12 个品类（每个品类有英文 `.en.md` 和俄文 `.ru.md` 两页，共 24 页）：
corrugated-boxes、color-boxes、gift-boxes、wine-boxes、christmas-merchandise、paper-cups、eco-paper-cups、pulp-molding、party-supplies、color-printing、offset-printing、gift-cards。

## 占位统计（回答后可核对）

| 题号 | 主题 | 占位数 |
|---|---|---|
| Q1 | 起订量 | 24 |
| Q2 | 打样周期 | 24 |
| Q3 | 生产周期 | 24 |
| Q4 | 贸易条款 | 24 |
| Q5 | 每个品类可选项 | 24 |
| Q6–Q9 | 材料/涂层 | 8 |
| Q10–Q11 | 工艺设备 | 4 |
| Q12 | 季节截止 | 2 |
| Q13–Q15 | gift-cards（F16） | 6 |
| **合计** | | **142** |

---

## 一、起订量

**Q1. 每个品类的最小起订量（MOQ）是多少？**（可以按尺寸/工艺分档；单位：件/张/个）
- 影响：全部 12 个品类 × 英俄 = 24 页，规格区「Minimum order quantity / Минимальный тираж」。
- 未回答时：MOQ 一节整节隐藏。

| 品类 | MOQ |
|---|---|
| corrugated-boxes | |
| color-boxes | |
| gift-boxes | |
| wine-boxes | |
| christmas-merchandise | |
| paper-cups | |
| eco-paper-cups | |
| pulp-molding | |
| party-supplies | |
| color-printing | |
| offset-printing | |
| gift-cards | |

## 二、交期

**Q2. 每个品类的打样周期是多少（工作日/自然日）？**
- 影响：24 页，「Sample lead time / Срок изготовления образца」。

**Q3. 每个品类的大货生产周期是多少？**（从哪个节点起算：确认样品后 / 付定金后？）
- 影响：24 页，「Production lead time / Срок производства」。

| 品类 | 打样周期（Q2） | 生产周期（Q3） |
|---|---|---|
| corrugated-boxes | | |
| color-boxes | | |
| gift-boxes | | |
| wine-boxes | | |
| christmas-merchandise | | |
| paper-cups | | |
| eco-paper-cups | | |
| pulp-molding | | |
| party-supplies | | |
| color-printing | | |
| offset-printing | | |
| gift-cards | | |

## 三、贸易条款

**Q4. 支持哪些贸易条款（FOB/CIF/DDP/EXW 等）？各品类是否相同？发货港/城市写什么？**
- 影响：24 页，「Shipping terms / Условия поставки」；另影响 /api/specs `tradeTerms` 和落地页「условия поставки」（ru-proofreading TBD 表）。

## 四、每个品类的可选项

**Q5. 每个品类页「Available options for your order / Доступные опции для вашего заказа」写什么？**（例如可选尺寸范围、材质克重、内衬/插件、表面处理；只写确定能做的）
- 影响：24 页（每页 1 处，在「Materials and options」一节）。

## 五、材料 / 涂层

**Q6. paper-cups（普通纸杯）的涂层/内衬是什么材料？**（PE、水性、PLA 或其他；有无检测报告）
- 影响：paper-cups.en / .ru，「Coating」。也关系到附录里被隐藏的 PLA、water-based、food-safe 说法。

**Q7. eco-paper-cups 的涂层材料是什么？能否说可回收、可降解、可堆肥（compostable）？有何证书（名称、编号、链接）？**
- 影响：eco-paper-cups.en / .ru，「Coating and end-of-life」；以及 F15/F17：H1、meta、英文 slug 和俄语「Биоразлагаемые」是否能恢复。

**Q8. pulp-molding（纸浆模塑）的纤维来源是什么？**（甘蔗渣、回收纸、竹浆等）
- 影响：pulp-molding.en / .ru，「Fibre」。

**Q9. party-supplies 的纸板/纸张用什么涂层（或无涂层）？**
- 影响：party-supplies.en / .ru，「Materials」。

## 六、工艺设备

**Q10. 胶印用什么设备（品牌/型号/色组数）？**
- 影响：offset-printing.en / .ru，「Press equipment / Оборудование」。
- 「Heidelberg offset presses / Офсетные машины Heidelberg」已隐藏（seo/yo-unification `3e7fd98`），见附录。

**Q11. 胶印能做的幅面范围和可用纸张/材料？**
- 影响：offset-printing.en / .ru，「Formats and stocks / Форматы и материалы」。

## 七、季节截止

**Q12. 圣诞/新年季最晚下单日期是哪天（按到港或到货算）？每年固定吗？**
- 影响：christmas-merchandise.en / .ru，「Planning」。

## 八、gift-cards（F16）

**Q13. gift-cards 到底是什么产品：储值礼品卡（подарочный сертификат）还是印刷贺卡/祝福卡（открытки）？**
- 影响：gift-cards.en / .ru 的 H1、导语、英文 slug `custom-gift-cards` 和俄语 slug、meta、内链锚文本（F6/F16）。产品经理正在向 Ryan 催这一项。
- 未回答时：gift-cards 品类保持隐藏。

**Q14. 能做塑料卡吗？什么材料（PVC 等）？**
- 影响：gift-cards.en / .ru，「Materials」。

**Q15. 能做刷边（edge painting）吗？**
- 影响：gift-cards.en / .ru，「Customization and printing」。

## 九、其他待确认（不在品类页占位里，但影响全站已隐藏的说法）

**Q16. 实际能承诺的询盘回复时间？**（F2/F19）
- 影响：首页 ctaBandText、联系表单 reply / contactText、/contact meta description；后端询盘/样品确认邮件里的 `CONTACT_REPLY_TIME`（未设置时默认 24 小时）。目前统一写「a packaging specialist will reply by email」。

**Q17. 能否说「工厂直供 / 工厂直出口」？能否说「出口全球」？**（F2/F20）
- 影响：categoryMeta 描述（corrugated-boxes、paper-cups、eco-paper-cups）、联系页 meta、首页。

**Q18. 油墨是否有食品接触安全认证？标准和检测报告是什么？**（F20）
- 影响：party-supplies 卖点、paper-cups 描述；color-boxes 正文目前写「food-contact use to be confirmed」。

**Q19. 样品是否收费？运费谁付？**（F21）
- 影响：后端询盘/样品确认邮件模板（#171），网站 FAQ。

**Q20. 持有哪些认证？请提供名称、证书编号、范围、有效期、可公开验证的链接。**（FSC、ISO 9001、FDA、可堆肥/可降解认证等；F1/F15/F17/F18/F22）
- 影响：首页优势区、eco-paper-cups 卖点、#192 产品 JSON-LD 证书链接、/api/specs。

**Q21. 首页 4 个数字：产能、认证、打样天数、环保比例分别是多少？**（F1，原稿 `2 млн+`、`FSC · ISO 9001`、`5–7 дней`、`100%`，均未确认）
- 影响：首页优势区（目前整块不显示）。

**Q22. 纸浆模塑/环保产品能否说「无塑料」「可替代 EPS 泡沫」「符合 FDA」？依据是什么？**（F22）
- 影响：eco-paper-cups、pulp-molding 卖点和简介，设计稿。

**Q23. 俄罗斯：配送范围、谁负责清关、需要哪些文件（EAC 等）、对外写的地址？**（ru-proofreading TBD 表、F15 D217 FAQ）
- 影响：Yandex 地区设置、俄语文章「Доставка」小节、industries.md 文章 5、FAQ「Доставляете ли вы в Россию?」。

## 十、措辞问题（需 Ryan 拍板，不是事实）

**F21 俄语措辞**：样品费用说明英文是「Any costs will be confirmed by email before dispatch」，俄语目前用「Все расходы мы **согласуем с вами** по email до отправки」（意思是“和您商定”）。直译 confirmed 应为「**подтвердим**」（“我们会确认”）。两者含义不同：согласуем 暗示可协商，подтвердим 只表示告知确认。请 Ryan 选一个。

---

## 附录：目前已隐藏的说法

恢复任何一条，都需要先回答对应问题，再从 `tests/unconfirmed-claims.test.ts` 去掉相应规则。

| 说法（英 / 俄） | 隐藏在哪里 | 怎么处理的 | 对应问题 |
|---|---|---|---|
| 24 hours / в течение 24 часов（回复时限） | `messages/*.json` 的 ctaBandText、联系表单 reply、contactText、/contact meta（seo/yo-unification `db5fd13`、`7a21bcf`、`ef26703`） | 改成「a packaging specialist will reply by email」/「специалист по упаковке ответит вам по email」；守卫测试拦截 `24 hours/час`。后端邮件默认 24 小时，由后端在 #171 线处理 | Q16 |
| Factory-direct (export) / Прямые поставки с фабрики、Оптом с фабрики、напрямую с завода | `categoryMeta.ts`（corrugated-boxes、paper-cups、eco-paper-cups，英俄）（seo/yo-unification `7a21bcf`） | 改为中性说法；守卫测试拦截 | Q17 |
| Export worldwide | #188 落地页草稿（`seo-188/docs/content/*.md`） | 品类文案未沿用；`categoryMeta.ts` offset-printing 英文描述「in-house finishing for export」改为「finishing options for your order」（seo/yo-unification `3e7fd98`）；守卫测试拦截 for export / export worldwide / экспорт | Q17 |
| Food-safe inks / Пищевые краски、безопасные краски | `messages/*.json` party-supplies 卖点、`categoryMeta.ts`（seo/yo-unification `7a21bcf`） | 删除；守卫测试拦截 food-safe、пищевые краски | Q18 |
| Water-based or PLA lining / водной или PLA основой | `categoryMeta.ts` paper-cups / eco-paper-cups（`7a21bcf`） | 删除；守卫测试拦截 PLA、water-based、водное покрытие | Q6、Q7 |
| Free samples / Samples are free of charge / бесплатные образцы | 后端询盘/样品确认邮件模板（#171 线）；网站文案没有 | 网站侧守卫测试拦截；统一用「Any costs will be confirmed by email before dispatch」 | Q19、F21 措辞 |
| Water-based, plastic-free coating / Водное покрытие без пластика | eco-paper-cups 卖点（`messages/*.json`）及简介 | 改为「Coating options confirmed per order」/「Варианты покрытия уточняем под заказ」；守卫测试拦截 | Q7、Q22 |
| Plastic-free / без пластика / вместо пластика | pulp-molding 卖点和简介 | 删除；守卫测试拦截 | Q22 |
| FDA-compliant | 设计稿 | 设计侧移除；守卫测试拦截 `FDA` | Q20、Q22 |
| Plastic-free inserts replacing EPS foam | 设计稿 | 设计侧移除；守卫测试拦截 EPS/polystyrene/styrofoam/пенопласт/полистирол | Q22 |
| FSC-certified board / Картон с сертификатом FSC | `messages/*.json` eco-paper-cups 卖点（seo/yo-unification `b61a363`） | 删除；品类文案未沿用 | Q20 |
| FSC · ISO 9001、2 млн+、5–7 дней、100%（首页数字） | 首页优势区（#222） | value 清空，整块不显示 | Q20、Q21 |
| Compostable / Biodegradable / Биоразлагаемые | eco-paper-cups 的 H1、meta、英文 slug（`compostable-paper-cups` → `eco-paper-cups`）、`messages/*.json`、#220 alt | 改为 Eco-friendly / Экологичные | Q7、Q20 |
| Heidelberg offset presses / Офсетные машины Heidelberg | `messages/*.json` offset-printing 卖点（seo/yo-unification `3e7fd98`）；品类文案未沿用 | 改为「CMYK and Pantone offset printing」/「Офсетная печать CMYK и Pantone」；守卫测试拦截 Heidelberg/Хайдельберг/Гейдельберг | Q10 |

守卫测试 `tests/unconfirmed-claims.test.ts` 当前扫描 `messages/*.json` 和 `src/lib/seo/categoryMeta.ts`，规则：24 小时、factory-direct、food-safe、PLA、пищевые краски、free samples（英俄）、прямые поставки с фабрики、plastic-free（英俄）、water-based（英俄）、FDA、EPS/polystyrene/styrofoam/пенопласт/полистирол、Heidelberg（英俄）、for export / export worldwide / экспорт。
