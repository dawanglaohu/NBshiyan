# Arabic (MSA, Gulf/MENA B2B) UI strings — independent native-level review (launch gate)

Reviewer: independent of drafter · 2026-10-17 · `messages/ar.json` vs `messages/en.json` (383 strings) · glossary §8

## Verdict: **PASS with fixes**

Go-live is approved once `review/ar.reviewed.json` replaces `messages/ar.json`. The patched copy is kept outside `messages/` so tests aren't affected. RTL frontend work (below) is a separate launch prerequisite, not a translation issue.

Translation defects: blocker 0 · major 3 · minor 12. Plus 12 keys changed to apply the PM wine/spirits decision (option b); these aren't counted as defects.

## Checks performed
- All 383 strings read side by side against en.
- Keys, order, ICU placeholders and `<link>`/`<accent>` tags are identical to en in the patched file.
- Register: consistent MSA. Generic masculine singular imperative (أخبرنا، اطلب، اختر) is used throughout. PackJoyU is treated as feminine (توفّر، تعالج، تجمع), consistently.
- Number–noun agreement is correct (180 يومًا، 48 ساعة، ساعتين، سنتين، 12 شهرًا، زجاجتين). `{max}`/`{n}` use label constructions. `{s}` was wrong (fixed).
- Idafa/definiteness: «لقطاع {industryGen}» and «حلول التغليف لقطاع {industry}» take the head noun without ال, and every industryGen value is definite: منتجات التجزئة (definite idafa), التجارة الإلكترونية والشحن، المقاهي ومحلات القهوة، الحفلات والفعاليات، الهدايا وهدايا الشركات، الزجاجات الفاخرة (new).
- Gender agreement: Views مغلقة/مفتوحة agree with العلبة.
- Punctuation: Arabic «،» and «؟», «» quotes, Western digits. No Arabic-Indic digits. No ASCII comma, question mark or straight quotes inside Arabic text.
- UI length: buttons and labels are fine. meta titles ≤60.
- Content rules: no FSC/ISO/FDA, eco, food-grade, free, MOQ, lead-time or capacity numbers beyond en (privacy retention durations mirror en). Gift Cards = «بطاقات تهنئة». Samples are OK. Factory wording is OK («علب صنعناها»).

## Issues (translation)
| # | key | current | proposed | reason | severity |
|---|---|---|---|---|---|
| 1 | `Privacy.sections.company.text[0]` | مراقب البيانات: {{待Ryan确认}} | المتحكم في البيانات: {{待Ryan确认}} | «مراقب البيانات» = data monitor/supervisor; the established legal term for GDPR 'data controller' (and UAE/KSA PDPL) is «المتحكم في البيانات». It's a legal page, so the wrong term matters. | major |
| 2 | `Inquiry.retryIn` | حاول مرة أخرى بعد {s} ثانية | حاول مرة أخرى ({s} ث) | «بعد {s} ثانية» is only grammatical for s ≥ 11. For 3–10 it must be «ثوانٍ», for 2 «ثانيتين», for 1 «ثانية واحدة», and this is a live countdown, so the wrong form shows. Per glossary §8, use a label construction (ث = standard timer abbreviation), or ICU plural (zero/one/two/few/many/other) if the frontend prefers. | major |
| 3 | `Products.specs.christmas-merchandise[2]` | اطلب قبل سبتمبر لموسم الربع الرابع | اطلب بحلول سبتمبر لموسم الربع الرابع | «قبل سبتمبر» = before September, i.e. by end of August, which moves the deadline a month earlier than en 'by September'. «بحلول» is the faithful rendering. The claim itself is still pending Ryan. | major |
| 4 | `Contact.intro` | ثلاث خطوات قصيرة. بيانات التواصل فقط مطلوبة — اختر «غير متأكد» لأي شيء لم تحدده بعد. | ثلاث خطوات قصيرة. بيانات التواصل هي الحقول الإلزامية الوحيدة — اختر «غير متأكد» لأي شيء لم تحدده بعد. | «بيانات التواصل فقط مطلوبة» is calqued word order and reads oddly in MSA. | minor |
| 5 | `Home.ctaBandTitle` | هل لديك مشروع في ذهنك؟ | هل لديك مشروع تخطط له؟ | «مشروع في ذهنك» is a calque of 'in mind'. «تخطط له» is the natural B2B phrasing. | minor |
| 6 | `Factory.cta` | هل لديك مشروع في ذهنك؟ أخبرنا عنه. | هل لديك مشروع تخطط له؟ أخبرنا عنه. | Same calque as above. | minor |
| 7 | `Cases.cta` | هل لديك مشروع في ذهنك؟ أخبرنا عنه. | هل لديك مشروع تخطط له؟ أخبرنا عنه. | Same calque as above. | minor |
| 8 | `Products.tapToRotate` | انقر للتدوير | المس للتدوير | «انقر» = click (mouse). For a touch-only hint, «المس» (or «اضغط») is correct. It also distinguishes the hint from dragToRotate. | minor |
| 9 | `Quote.added` | في عرض السعر ✓ | أُضيف إلى عرض السعر ✓ | «في عرض السعر ✓» is a verbless fragment. «أُضيف» is the standard Arabic UI state label. | minor |
| 10 | `Quote.continue` | متابعة إلى الطلب | المتابعة لإرسال الطلب | «متابعة إلى الطلب» is unidiomatic; the next step is filling in and sending the request. | minor |
| 11 | `Inquiry.qty.50k` | أكثر من 50,000 | 50,000 فأكثر | en '50,000+' includes 50,000. «أكثر من 50,000» excludes it, and «فأكثر» is the idiomatic inclusive form. | minor |
| 12 | `Solutions.industries.color-boxes.title` | تغليف منتجات التجزئة | تغليف لمنتجات التجزئة | Consistency: all other industry titles use «تغليف لـ…»; this one was a bare idafa. | minor |
| 13 | `Inquiry.logo.hint` | PNG أو JPEG أو WebP، حتى 2 MB. | الصيغ المقبولة: PNG أو JPEG أو WebP، بحد أقصى 2 MB. | Bidi: the string begins with a Latin run, so any context that picks direction from the first strong character (dir=auto, aria, tooltips) renders it LTR with the «،» and period misplaced. Leading Arabic fixes the base direction. «حتى» is also ambiguous ('until'); «بحد أقصى» is clearer. | minor |
| 14 | `Contact.ogImageAlt` | PackJoyU: اطلب عرض سعر للتغليف المخصص | اطلب عرض سعر للتغليف المخصص \| PackJoyU | Bidi: the alt starts with Latin «PackJoyU:», and OG/alt contexts carry no dir attribute, so the colon jumps and the line reads LTR. Brand moved to the end, matching the title pattern. | minor |
| 15 | `Privacy.ogImageAlt` | PackJoyU: سياسة الخصوصية | سياسة الخصوصية \| PackJoyU | Same bidi issue as Contact.ogImageAlt. | minor |

## Wine/spirits → neutral «علب للزجاجات الفاخرة» (PM decision, option b — ar only)

Every mention of wine/alcohol was removed from ar body text, headings, meta and alt text. Other languages are unchanged. Key names (`wine-boxes`) are unchanged, since they're code identifiers.

| # | key | before | after | note |
|---|---|---|---|---|
| 1 | `Meta.description` | توفّر PackJoyU علب الكرتون المموج وعلب الهدايا والنبيذ وقوالب اللب الورقي والأكواب الورقية والتغليف المطبوع حسب الطلب للعلامات التجارية في أمريكا الشمالية وأوروبا وأستراليا. | توفّر PackJoyU علب الكرتون المموج وعلب الهدايا وعلب الزجاجات الفاخرة وقوالب اللب الورقي والأكواب الورقية والتغليف المطبوع حسب الطلب للعلامات التجارية في أمريكا الشمالية وأوروبا وأستراليا. | — |
| 2 | `Home.premiumTitle` | علب هدايا ونبيذ فاخرة | علب فاخرة للهدايا والزجاجات | — |
| 3 | `Products.names.wine-boxes` | علب النبيذ | علب للزجاجات الفاخرة | — |
| 4 | `Products.metaDescription` | استكشف 12 فئة من التغليف المخصص بتقنية ثلاثية الأبعاد: علب الكرتون المموج، وعلب الهدايا والنبيذ، وقوالب اللب الورقي، والأكواب الورقية، والطباعة. اطلب عرض سعر من PackJoyU. | استكشف 12 فئة من التغليف المخصص بتقنية ثلاثية الأبعاد: علب الكرتون المموج، وعلب الهدايا والزجاجات الفاخرة، وقوالب اللب الورقي، والأكواب الورقية، والطباعة. اطلب عرض سعر من PackJoyU. | — |
| 5 | `Products.desc.wine-boxes` | علب حسب الطلب للنبيذ والمشروبات الروحية لزجاجة واحدة أو أكثر، بتشطيبات فاخرة وحشوات داخلية. | علب حسب الطلب للزجاجات الفاخرة، لزجاجة واحدة أو أكثر، بتشطيبات راقية وحشوات داخلية. | «راقية» avoids repeating «فاخرة». |
| 6 | `Products.ogImageAlt` | PackJoyU: منتجاتنا بتقنية ثلاثية الأبعاد: علب كرتون مموج وعلب هدايا ونبيذ حسب الطلب | منتجاتنا بتقنية ثلاثية الأبعاد: علب كرتون مموج وعلب هدايا وعلب للزجاجات الفاخرة حسب الطلب \| PackJoyU | brand moved to the end (same bidi issue as Contact.ogImageAlt). |
| 7 | `Solutions.premium.eyebrow` | علب النبيذ والهدايا | علب الهدايا والزجاجات الفاخرة | — |
| 8 | `Solutions.premium.lead` | علب صلبة للنبيذ والهدايا مصممة حول زجاجتك أو منتجك، بالتشطيب وتجربة الفتح اللذين تختارهما. | علب صلبة للهدايا والزجاجات الفاخرة مصممة حول زجاجتك أو منتجك، بالتشطيب وتجربة الفتح اللذين تختارهما. | — |
| 9 | `Solutions.premium.imageAlt.wine` | علبة نبيذ حسب الطلب | علبة حسب الطلب للزجاجات الفاخرة | The image asset itself must not show wine; UX/frontend should check. |
| 10 | `Solutions.industries.wine-boxes.name` | النبيذ والمشروبات الروحية | الزجاجات الفاخرة | definite, so it's valid after «قطاع» in idafa. |
| 11 | `Solutions.industries.wine-boxes.title` | تغليف للنبيذ والمشروبات الروحية | تغليف للزجاجات الفاخرة | — |
| 12 | `Solutions.industries.wine-boxes.industryGen` | النبيذ والمشروبات الروحية | الزجاجات الفاخرة | definite (ال), giving «لقطاع الزجاجات الفاخرة» and «حلول التغليف لقطاع الزجاجات الفاخرة». |

Grep of `review/ar.reviewed.json` for نبيذ / روحية / مشروبات روحية / كحول / خمر / شمبانيا / ويسكي / فودكا / مسكر / بيرة (whole word) found **0 matches**. A substring-only grep for «بيرة» hits «كبيرة» (large), which is a false positive.

Unchanged on purpose: `Products.specs.wine-boxes[0..2]` (bottle formats, foil/UV/magnetic, fitted inserts) were already neutral. Paper-cup «المشروبات الباردة/الساخنة» means soft/hot drinks, not alcohol.

**Follow-ups outside messages (not done here):**
- The **ar slug** for the wine-boxes category and industry page must follow the neutral wording (not `…wine…`/`نبيذ`). That's **SEO's call**.
- ar categoryMeta, category-page article, sitemap/hreflang and any ar structured data must use the same neutral wording.
- The image and 3D model assets for this category (`Solutions.premium.imageAlt.wine` image, the wine-box 3D texture) must not show wine bottles or labels on the ar site. UX/frontend should check.
- Optional for PM/SEO: Gulf demand for bottle gift boxes is largely perfume/oud and premium beverages. A future variant «علب العطور والزجاجات الفاخرة» could rank better, but it adds product scope, so it isn't applied.

## Not translation defects — pending elsewhere (same as other locales; not counted)
| key | item | owner |
|---|---|---|
| Products.specs.christmas-merchandise[2] | deadline-type claim mirroring en 'Order by September for Q4' (translation corrected to «بحلول») | PM → Ryan |
| Products.specs.paper-cups[0] | «أحجام متعددة» placeholder; en keeps 4–22 oz | Ryan |
| Products.metaDescription | «12 فئة» mirrors en '12'; categoryMeta uses 11 | PM/SEO |
| Privacy.sections.contact.text[1], company.text[0] | {{待Ryan确认}} email / data controller | Ryan |
| Nav.switchLang, Footer.otherLang | «English version»/«English» pending phase-0 dropdown | frontend/PM |
| Christmas category | limited relevance in parts of the Gulf; kept per en (PM may choose to hide on ar) | PM |

## RTL / bidi notes per placeholder (frontend)
- `<html lang="ar" dir="rtl">` on the ar route; logical CSS; mirror arrows and chevrons, but not logos, 3D controls or media icons.
- `{name}` (Products.alt starts with it) and `{category}`: wrap in `<bdi>`. Values are Arabic today, but any Latin value flips the line.
- `{n}`/`{total}` (stepOf), `{max}` (Quote.full, overLimit), `{s}` (retryIn, inside parentheses): numerals are weak, so they render correctly in an RTL container. Wrap in `<bdi>` if the container may lack `dir`.
- `{industry}`/`{industryGen}`: Arabic definite values, no risk. Never concatenate «لـ» + value in code (لـ + ال → للـ).
- Strings starting with Latin tokens that still need an RTL container: Products.specs.color-boxes[1], color-printing[0] («CMYK + …»). Email input, `name@company.com` and `pj-consent` should be `dir="ltr"`. «410 Gone», «4096 × 4096 px» and «1.5–2.5 mm» are fine inside RTL.
- `{{待Ryan确认}}` will be replaced before launch. If the email is Latin, wrap it in `<bdi>`.

## Notes (no change)
- Product names mix definite (علب الهدايا، الأكواب الورقية) and indefinite (علب ملونة مطبوعة، بطاقات تهنئة) forms. Both are acceptable as card labels and in «خصّص {category} مرة أخرى». Unify later if SEO wants.
- «من العيّنة إلى الإنتاج بالجملة» follows the glossary. It's natural.
