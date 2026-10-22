# PackJoyU 术语表 / Glossary EN · RU · ES · DE · FR · JA · HI · AR（Phase 1: es / de / fr · Phase 2 draft: ja / hi / ar）

Draft v0.3 · 2026-10-17 (gift-cards = greeting cards, Ryan; PM decisions: no "fast proofs"/"on-time holiday delivery" in any language; 4–22 oz pending Ryan; ja/hi §7). Source: `messages/en.json` + proofread `messages/ru.json` (main @b896168). Used for `messages/{es,de,fr}.json`.
Register: ES = *usted*, neutral Spain/LatAm; DE = *Sie*; FR = *vous*. Numbers: ES/DE `1.000`, `1,5 mm`; FR `1 000`, `1,5 mm`; units `g/m²`, `oz` kept.
Content rules: no eco, certification, food-grade, capacity, lead-time or MOQ figures/claims; never "custom" + "wholesale" in one title.
Own factory (update 2026-10-17, confirmed directly by Ryan on 2026-10-17): factory/manufacturer wording is allowed — ES «nuestra fábrica / fabricamos», DE «unsere Fabrik / wir fertigen», FR «notre usine / nous fabriquons»; **RU may now also say «наша фабрика / производим»** (ru.json/categoryMeta were neutralized under the old rule and can be reverted where useful). Still no capacity, floor-area, years or export-country numbers. Translations stay faithful to en.json, which still says "supplies", so only `Cases.title` uses factory wording for now.

## 1. Product categories / 品类

| EN | RU | ES | DE | FR | note |
|---|---|---|---|---|---|
| Corrugated Boxes | Гофрокороба | Cajas de cartón ondulado | Wellpappkartons | Cartons ondulés | DE alt: Versandkartons (shipping-focused). FR alt: boîtes en carton ondulé |
| Mailer box | Почтовая коробка (самосборная) | Caja postal / caja de envío | Versandkarton / Faltkarton mit Steckverschluss | Boîte postale / boîte d’expédition | |
| Shipping carton (RSC) | Четырёхклапанный короб | Caja americana | Faltkiste (FEFCO 0201) | Caisse américaine | standard trade terms |
| Color Boxes / folding cartons | Картонные коробки с печатью | Cajas impresas / estuches plegables | Bedruckte Faltschachteln | Boîtes pliantes imprimées / étuis | ES "estuche" = small retail carton |
| Gift Boxes (rigid) | Подарочные коробки (жёсткие) | Cajas de regalo (rígidas) | Geschenkboxen (feste Kartonagen) | Coffrets cadeaux (rigides) | DE trade term for rigid boxes: "feste Kartonage" |
| Magnetic closure box | Коробка на магните | Caja con cierre magnético | Magnetbox / Box mit Magnetverschluss | Coffret aimanté | |
| Lid-and-base box | Крышка–дно | Caja con tapa y base | Stülpdeckelschachtel | Boîte couvercle-fond | |
| Drawer / slide box | Выдвижная коробка / пенал | Caja tipo cajón | Schiebeschachtel | Boîte tiroir | |
| Book-style box | Коробка-книжка | Caja tipo libro | Klappbox / Buchbox | Coffret livre | |
| Molded Pulp | Формованная целлюлоза | Pulpa moldeada | Formfaserguss (Faserguss) | Pulpe moulée (fibre moulée) | ⚠️ no "eco/compostable/plastic-free" in any language |
| Insert | Ложемент | Interior / inserto / calce | Einlage / Inlay | Calage | FR "calage" = protective fit insert |
| Tray (pulp) | Лоток | Bandeja | Tray / Schale | Plateau / barquette | |
| Paper Cups | Бумажные стаканы | Vasos de papel | Pappbecher | Gobelets en carton | FR "gobelet papier" also used |
| Single / double wall cup | Одно- / двухслойный | Pared simple / doble | Einwandig / doppelwandig | Simple / double paroi | not "capa" |
| Cup sleeve | Манжета | Funda / faja para vaso | Becherhülse / Manschette | Manchon / fourreau | |
| Printed Coffee Cups (key `eco-paper-cups`) | Стаканы для кофе с печатью | Vasos de café impresos | Bedruckte Kaffeebecher | Gobelets à café imprimés | ⚠️ never ecológico / öko / écologique |
| Party Supplies | Товары для праздника | Artículos para fiestas | Partyartikel | Articles de fête | |
| Wine Boxes | Коробки для вина | Cajas para vino | Weinverpackungen | Coffrets à vin | DE "Weinkarton" can mean bag-in-box, avoid |
| Color Printing | Цветная печать | Impresión a color | Farbdruck | Impression couleur | |
| Offset Printing | Офсетная печать | Impresión offset | Offsetdruck | Impression offset | |
| Gift Cards (key `gift-cards`) = **greeting cards** | **Открытки** (RU currently «Подарочные карты» → should become «открытки», RU F6/F16) | Tarjetas de felicitación | Grußkarten | Cartes de vœux (cartes de correspondance for plain/business stationery cards) | ✅ Ryan confirmed 2026-10-17: greeting cards, not stored-value gift cards. Never tarjetas de regalo / Geschenkkarten / cartes cadeaux |
| Christmas Merchandise | Новогодняя упаковка | Embalaje navideño | Weihnachtsverpackungen | Emballages de Noël | RU localized to New Year; ES/DE/FR keep Christmas |
| Advent calendar | Адвент-календарь | Calendario de Adviento | Adventskalender | Calendrier de l’Avent | |
| Gift tube | Тубус | Tubo de regalo | Geschenkröhre / Versandhülse | Tube cadeau | |

## 2. Materials / 材料

| EN | RU | ES | DE | FR | note |
|---|---|---|---|---|---|
| Corrugated board | Гофрокартон | Cartón ondulado | Wellpappe | Carton ondulé | |
| Flute (E/B/C) | Профиль гофры | Onda / canal (E/B/C) | Welle (E-/B-/C-Welle) | Cannelure (E/B/C) | |
| Single / double wall board | Трёх- / пятислойный | Canal simple / doble | Einwellig / zweiwellig | Simple / double cannelure | |
| Paperboard | Картон | Cartoncillo / cartulina | Karton | Carton compact | form option label |
| SBS board | Целлюлозный картон (SBS) | Cartón SBS | SBS-Karton (Chromokarton) | Carton SBS | |
| Kraft paper / board | Крафт | Papel / cartón kraft | Kraftpapier / Kraftkarton | Papier / carton kraft | |
| Greyboard (rigid) | Переплётный картон | Cartón gris | Graukarton (Buchbindepappe) | Carton gris | |
| Card stock | Картон (для карт) | Cartulina | Karton | Carte / bristol | |
| EVA foam | EVA | EVA | EVA-Schaum | Mousse EVA | |
| Bagasse | Багасса | Bagazo de caña | Bagasse | Bagasse | ⚠️ not used in messages; raw material unconfirmed (#257) |
| Coating (cup) | Покрытие | Recubrimiento | Beschichtung | Revêtement | "confirmed per order" only; no PE/PLA/water-based claims |

## 3. Printing & finishing / 印刷与表面工艺

| EN | RU | ES | DE | FR | note |
|---|---|---|---|---|---|
| CMYK / full color | CMYK / полноцветная печать | CMYK / a todo color | CMYK / vierfarbig | CMJN / quadrichromie | FR always CMJN |
| Spot color (Pantone) | Пантон | Tinta directa (Pantone) | Sonderfarbe (Pantone) | Ton direct (Pantone) | |
| Flexo printing | Флексопечать | Flexografía | Flexodruck | Flexographie | |
| Digital printing | Цифровая печать | Impresión digital | Digitaldruck | Impression numérique | |
| Color proof | Цветопроба | Prueba de color | Farbproof / Andruck | Épreuve couleur / BAT | FR "BAT" = sign-off proof |
| Foil stamping | Тиснение фольгой | Estampado en caliente (foil) | Heißfolienprägung | Marquage à chaud / dorure | |
| Embossing / debossing | Конгрев / блинтовое тиснение | Relieve / bajorrelieve | Prägung / Blindprägung | Gaufrage / embossage | |
| Spot UV | Выборочный УФ-лак | Barniz UV selectivo | Partieller UV-Lack | Vernis UV sélectif | |
| Lamination (matte/gloss/soft-touch) | Ламинация | Laminado (mate/brillo/soft-touch) | Kaschierung / Folienkaschierung | Pelliculage (mat/brillant/soft-touch) | DE "Laminierung" is office-lamination; use Kaschierung |
| Die-cutting | Высечка | Troquelado | Stanzen | Découpe | |
| Dieline | Развёртка / штанцформа | Troquel (plano) | Stanzkontur | Plan de découpe | ES "troquel" = both die and dieline |
| Folding / gluing | Фальцовка / склейка | Plegado / encolado | Falzen / Kleben | Pliage / collage | |
| Assembly | Сборка | Montaje | Konfektionierung | Montage | |
| Perfect binding | КБС | Encuadernación fresada (rústica) | Klebebindung | Reliure dos carré collé | |
| Saddle stitch | Скрепка | Grapado / encuadernación a caballete | Rückendrahtheftung | Piqûre à cheval | |
| Glitter | Глиттер | Purpurina | Glitzer | Paillettes | |
| Quality control | Контроль качества | Control de calidad | Qualitätskontrolle | Contrôle qualité | |
| Get a quote (CTA) | Запросить расчёт | Solicitar presupuesto | Angebot anfordern | Demander un devis | fixed CTA in all three |
| Sample → bulk order | от образца до крупного тиража | de la muestra al pedido en volumen | vom Muster bis zur Serienbestellung | de l’échantillon à la commande en volume | samples confirmed by Ryan |

## 4. Proposed localized category slugs（提案，SEO 决定 / proposal — SEO to decide）

Not implemented; `categoryMeta.ts` and routing (`locales: ['en','ru']`) are unchanged. ASCII, no accents (ES ñ→n, DE ä→ae etc., FR é→e). Avoid "mayorista / großhandel / gros" with "a medida / individuell / sur mesure".

| key | EN (current) | ES (proposal) | DE (proposal) | FR (proposal) | note |
|---|---|---|---|---|---|
| corrugated-boxes | custom-corrugated-boxes | cajas-carton-ondulado | wellpappkartons | cartons-ondules | |
| color-boxes | custom-printed-boxes | cajas-impresas | bedruckte-faltschachteln | boites-pliantes-imprimees | |
| gift-boxes | custom-gift-boxes | cajas-de-regalo | geschenkboxen | coffrets-cadeaux | |
| pulp-molding | molded-pulp-packaging | embalaje-pulpa-moldeada | formfaserguss-verpackungen | emballages-pulpe-moulee | |
| paper-cups | custom-paper-cups | vasos-de-papel-personalizados | bedruckte-pappbecher | gobelets-carton-personnalises | |
| party-supplies | custom-party-supplies | articulos-para-fiestas | partyartikel | articles-de-fete | |
| wine-boxes | custom-wine-boxes | cajas-para-vino | weinverpackungen | coffrets-a-vin | |
| color-printing | custom-color-printing | impresion-de-embalaje | verpackungsdruck | impression-emballages | |
| offset-printing | offset-printing-services | impresion-offset | offsetdruck | impression-offset | |
| gift-cards | custom-gift-cards (EN may become custom-greeting-cards) | tarjetas-de-felicitacion | grusskarten | cartes-de-voeux | greeting cards confirmed; RU slug podarochnye-karty → suggest otkrytki |
| christmas-merchandise | custom-christmas-packaging | embalaje-navideno | weihnachtsverpackungen | emballages-de-noel | |
| eco-paper-cups (no categoryMeta entry on main) | — | vasos-cafe-impresos | bedruckte-kaffeebecher | gobelets-cafe-imprimes | only if the category gets its own page; else merge with paper-cups |

## 5. Flagged in source (en.json/ru.json) — kept for parity, Ryan to confirm

| key | EN | issue |
|---|---|---|
| Products.specs.christmas-merchandise[2] | Order by September for Q4 | ordering deadline ≈ lead-time commitment |
| Products.specs.wine-boxes[2] | Fitted inserts for safe shipping | protection promise (mild) |
| Products.specs.* numbers | 300–400 gsm, 1.5–2.5 mm, 350–600 gsm, up to 4 colors, 1/2/3 bottles | spec ranges, not MOQ/lead time; unconfirmed |
| Products.specs.paper-cups[0] | 4–22 oz, single or double wall | ⏳ **PENDING RYAN** (PM asking). Live languages EN and RU stay as on main and must match (RU «4–22 унции, одно- или двухслойные»). Unlaunched languages say "several sizes": ES «Varias capacidades», DE «Verschiedene Größen», FR «Plusieurs contenances», JA「複数サイズ」, HI «कई साइज़», AR «أحجام متعددة». `docs/content/custom-paper-cups.md` EN row "approx. 4–22 oz" untouched. If Ryan confirms the range, restore it in the unlaunched languages; if not, en+ru change together. |
| categoryMeta color-printing / christmas | ~~fast proofs~~ / ~~on-time holiday delivery~~ | ✅ fixed in EN+RU sources (PM 2026-10-17): "proofs before the run" / «цветопроба до тиража»; "Plan your season early" / «Спланируйте сезон заранее». es/de/fr already neutral. |
| Home.premiumText | made to be unboxed on camera | marketing, fine |
| Products.desc.christmas-merchandise | made to order | neutral; DE "auf Bestellung", FR "réalisés sur commande" |
| Cases.title | Boxes we've made | now translated literally (Cajas que hemos fabricado / Von uns gefertigte Boxen / Boîtes que nous avons fabriquées) per own-factory confirmation |
| Nav.switchLang / Footer.otherLang | Русская версия / Русский | en points to RU; es/de/fr set to "English version"/"English" — needs a multi-locale switcher |

## 6. Landing FAQ (es/de/fr) notes

- Files: `docs/content/landing-faq.{es,de,fr}.md` (59 Q&A each, 12 categories, ids `faq-<key>-<lang>-<n>`); category pages `*.{es,de,fr}.md` now cite them.
- `christmas-merchandise` Q5 EN "Do you deliver to Russia?" → localized as "Do you ship to my country?" (¿Envían a mi país? / Liefern Sie in mein Land? / Livrez-vous dans mon pays ?); placeholder kept. ✅ approved by PM 2026-10-17.
- `gift-cards` Q1: the EN "(gift cards vs greeting cards pending, #218 F16)" note dropped — resolved as greeting cards.
- Terms: MOQ → ES «pedido mínimo», DE «Mindestbestellmenge», FR «minimum de commande»; proof → «prueba» / «Proof» / «épreuve»; mold → «molde» / «Werkzeug» / «moule».

## 7. Japanese / Hindi (Phase 2 draft: `messages/ja.json`, `messages/hi.json`)

Register: **JA** polite です・ます, B2B (お客様 / 貴社, 〜いたします); full-width punctuation 「」：（）; numbers 1,000. **HI** Devanagari, standard modern business Hindi with the English loanwords Indian buyers use (कोटेशन, सैंपल, प्रोडक्ट, बॉक्स, ऑर्डर, प्रिंटिंग); nukta forms फ़/ज़; formal आप; numbers in Western digits (1,000, not lakh notation).

| EN | JA | HI | note |
|---|---|---|---|
| Get a quote (CTA / nav) | お見積もり依頼 | कोटेशन पाएँ | short button |
| Request a quote (page title) | お見積もり依頼 | कोटेशन का अनुरोध करें | |
| Send request | 依頼を送信 | अनुरोध भेजें | |
| Quote list | 見積もりリスト | कोटेशन सूची | |
| from sample to bulk order | サンプルから量産まで | सैंपल से बल्क ऑर्डर तक | Ryan: samples offered |
| packaging specialist | パッケージ担当者 | पैकेजिंग विशेषज्ञ | |
| Corrugated boxes | 段ボール箱 | कोरुगेटेड बॉक्स | |
| Color boxes / folding cartons | 印刷紙箱 / 折り箱 | प्रिंटेड बॉक्स / फ़ोल्डिंग कार्टन | |
| Gift boxes / rigid boxes | ギフトボックス / 貼り箱 | गिफ़्ट बॉक्स / रिजिड बॉक्स | |
| Molded pulp | パルプモールド | मोल्डेड पल्प | |
| Paper cups / single–double wall | 紙コップ / シングル・ダブルウォール | पेपर कप / सिंगल–डबल वॉल | |
| Printed Coffee Cups (`eco-paper-cups`) | 印刷入りコーヒーカップ | प्रिंटेड कॉफ़ी कप | never エコ / इको |
| Party supplies | パーティー用品 | पार्टी सप्लाइज़ | |
| Wine boxes | ワインボックス | वाइन बॉक्स | |
| Gift Cards (= greeting cards, Ryan) | グリーティングカード | ग्रीटिंग कार्ड | not ギフトカード / गिफ़्ट कार्ड (stored value) |
| Christmas merchandise | クリスマス商品 | क्रिसमस मर्चेंडाइज़ | |
| insert | 中敷き | इन्सर्ट | |
| dieline | 展開図 | डाईलाइन | |
| flute | フルート | फ़्लूट | |
| greyboard | チップボール | ग्रेबोर्ड | |
| foil stamping / embossing / spot UV | 箔押し / エンボス / 部分UV | फ़ॉइल स्टैम्पिंग / एम्बॉसिंग / स्पॉट UV | |
| lamination matte/gloss | マット／グロスラミネート | मैट/ग्लॉस लैमिनेशन | |
| Pantone / spot color | パントン / 特色 | पैनटोन / स्पॉट कलर | |
| color proof | 色校正 | कलर प्रूफ़ | |
| die-cutting | 型抜き | डाई-कटिंग | |
| QC | 検品 / 品質検査 | QC / क्वालिटी कंट्रोल | |
| MOQ | 最小ロット | MOQ (न्यूनतम ऑर्डर मात्रा) | only with {{待Ryan确认}} |
| our factory / we manufacture | 自社工場 / 製造しています | हमारी फ़ैक्टरी / हम बनाते हैं | allowed (own factory confirmed directly by Ryan); en.json says "supplies", so ja/hi follow it; only `Cases.title` = 当社が製作した箱 / हमारे बनाए बॉक्स |

**`{industryGen}` / `{industry}` grammar caveats**
- JA: no case inflection; templates use `{industryGen}向けの…` / `{industry}向け…`, so `industryGen` = `name` (bare noun, e.g. 小売製品, EC・配送).
- HI: `{industryGen}` is always followed by the postposition के लिए, so it must be the **oblique** form: plural -ों/-यों (रिटेल प्रोडक्ट्स, पार्टियों और इवेंट्स); loanword/invariant nouns stay unchanged (ई-कॉमर्स और शिपिंग, वाइन और स्पिरिट्स). New industries must supply an oblique `industryGen`. `Solutions.detail.metaTitle` uses `पैकेजिंग समाधान: {industry}` (direct-case `name` after a colon) to avoid a case clash.
- Gender agreement: verbs after PackJoyU are masculine singular (PackJoyU … करता है).

**Flagged in ja/hi (kept for parity with en):** `Products.specs.christmas-merchandise[2]` "Order by September for Q4" (第4四半期分は9月までにご注文ください / Q4 के लिए सितंबर तक ऑर्डर करें) = deadline-type claim, Ryan to confirm; `Nav.switchLang`/`Footer.otherLang` set to "English version"/"English" pending a multi-locale switcher; ja/hi are **unreviewed drafts — need native review** before launch.

## 8. Arabic (Phase 2 draft: `messages/ar.json`)

Register: Modern Standard Arabic, professional Gulf/MENA B2B tone; you = singular masculine generic (أخبرنا، اطلب), the usual convention on B2B sites. Arabic punctuation (، ؟ ؛ « »); Western digits (1,000 · 300–400 gsm · 2 MB). Latin units/brands kept as is (gsm, mm, px, MB, CMYK, UV, EVA, PackJoyU, Tawk.to, Turnstile). Numbers + counted nouns use agreement forms: 180 يومًا، 48 ساعة، ساعتين، سنتين، 12 شهرًا. Where EN puts a count in a sentence ({max} items) the AR uses a label construction («الحد الأقصى: {max}») to avoid number–noun agreement for any value.

| EN | AR | note |
|---|---|---|
| Get a quote / Request a quote (CTA, nav, title) | اطلب عرض سعر | one CTA everywhere |
| Send request | إرسال الطلب | |
| Quote list / Add to quote | قائمة عرض السعر / أضف إلى عرض السعر | |
| from sample to bulk order | من العيّنة إلى الإنتاج بالجملة | Ryan: samples offered |
| sample | عيّنة | with shadda for clarity |
| packaging specialist | متخصص التغليف | «أحد متخصصي التغليف» |
| Corrugated boxes | علب الكرتون المموج | |
| Color boxes / folding cartons | علب ملونة مطبوعة / علب كرتون قابلة للطي | |
| Gift boxes / rigid boxes | علب الهدايا / علب صلبة | |
| Molded pulp | قوالب اللب الورقي / لب ورقي مقولب | |
| Paper cups / single–double wall | الأكواب الورقية / جدار مفرد–مزدوج | |
| Printed Coffee Cups (`eco-paper-cups`) | أكواب قهوة مطبوعة | never صديقة للبيئة |
| Party supplies | مستلزمات الحفلات | |
| Wine boxes | علب للزجاجات الفاخرة | ✅ neutral per PM/reviewer; no alcohol terms (نبيذ، مشروبات روحية) anywhere in ar; industry = «الزجاجات الفاخرة» |
| Gift Cards (= greeting cards, Ryan) | بطاقات تهنئة | not بطاقات هدايا (stored value) |
| Christmas merchandise | منتجات عيد الميلاد | advent calendar = تقويم المجيء |
| insert | حشوة داخلية | |
| dieline | مخطط القص | |
| flute | تموج | |
| greyboard | كرتون رمادي | |
| foil stamping / embossing / spot UV | ختم الرقائق المعدنية / نقش بارز / طلاء UV موضعي | |
| lamination matte/gloss | تغليف حراري مطفي/لامع | |
| Pantone / spot colors | بانتون / ألوان خاصة | |
| color proof | بروفة ألوان | |
| die-cutting | القص بالقوالب | |
| QC | مراقبة الجودة | |
| MOQ | الحد الأدنى للطلب | only with {{待Ryan确认}} |
| our factory / we manufacture | مصنعنا / نصنع | allowed (own factory confirmed directly by Ryan); en.json says "supplies" (توفّر), so AR follows it; `Cases.title` = «علب صنعناها» |

**`{industryGen}` / `{industry}` (idafa, definiteness)**
- Templates put a head noun before the placeholder: «لقطاع {industryGen}», «حلول التغليف لقطاع {industry}». This is an idafa (construct) chain, so the head noun قطاع takes no ال and the **placeholder value must be definite** (starts with ال or is itself a definite idafa): التجارة الإلكترونية والشحن، المقاهي ومحلات القهوة، منتجات التجزئة. Never pass an indefinite value or a value that starts with لـ/للـ.
- `name` = `industryGen` in AR (same definite form), so filters/breadcrumbs read naturally too.
- Do not build strings by joining «لـ» + value in code: لـ + ال contracts to «للـ» (للمقاهي), which a plain join gets wrong. Keep the head noun (قطاع) in the message.
- Arabic has dual/plural agreement: any future count placeholder ({n} items) should use ICU `plural` with `zero/one/two/few/many/other`, or the label style used here.

**RTL / bidi notes for the frontend**
- Set `<html lang="ar" dir="rtl">` for the ar route; mirror layout (logical CSS properties `margin-inline-start` etc.), flip directional icons (arrows, chevrons), but not logos, the 3D viewer controls or media play icons.
- Wrap interpolated values that can be Latin or numeric in `<bdi>` (or U+2068 FSI … U+2069 PDI) when rendering: `{name}` (Products.alt starts with it, so a Latin name would flip paragraph direction unless the element has explicit `dir="rtl"`), `{category}`, `{industry}`/`{industryGen}` if any value is ever Latin, `{n}/{total}/{max}/{s}` next to «/» or «:» and parentheses.
- Titles «… | PackJoyU»: Latin brand at the end of an RTL string is fine in `<title>`; in visible UI keep `dir="rtl"` on the container. Strings mixing Latin tokens with punctuation (e.g. «PNG أو JPEG أو WebP، حتى 2 MB.», «كرتون SBS أو كرافت بوزن 300–400 gsm», «4096 × 4096 px», «name@company.com», `pj-consent`, «410 Gone») display correctly only inside an RTL base direction; email inputs and the pj-consent code should be `dir="ltr"`.
- Ranges «300–400», «1.5–2.5 mm» are kept as LTR number runs; do not convert to Arabic-Indic digits.
- Language switcher entry stays «English version»/«English» (pending multi-locale switcher).

**Flagged in ar:** ✅ wine/spirits resolved — `messages/ar.json` replaced by the independently reviewed version (bottle-box wording «علب للزجاجات الفاخرة», no alcohol terms); that file is now the source of truth (`.i18n-src/ar/` = superseded first draft, validator is check-only). Remaining: «اطلب قبل سبتمبر لموسم الربع الرابع» (Order by September for Q4) needs Ryan; paper-cups = «أحجام متعددة» (4–22 oz pending Ryan); `Meta.description` is 187 chars (>160) in the reviewed file — left for the reviewer.

## 9. No hardcoded category counts (PM 2026-10-17)

Never write the number of categories in copy ("12 categories", «12 видов»): the catalog grows. Count-free patterns used in `Products.metaDescription`:
EN "Explore our wide range of custom packaging in 3D" · RU «Широкий выбор упаковки на заказ в 3D» · ES «nuestra amplia gama de embalaje a medida» · DE «unser breites Sortiment individueller Verpackungen» · FR «notre large gamme d’emballages sur mesure» · JA「幅広いカスタムパッケージ」 · HI «कस्टम पैकेजिंग की कई कैटेगरी» · AR «تشكيلة واسعة من التغليف المخصص». Structured data (`ItemList` on /products) already derives positions from the data, no count.

