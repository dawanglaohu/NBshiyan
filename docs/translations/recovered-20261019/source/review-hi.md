# Hindi UI strings — independent native-level review (launch gate)

Reviewer: independent of drafter · 2026-10-17 · files: `messages/hi.json` vs `messages/en.json` (383 strings) · glossary §7

## Verdict: **PASS with fixes**

Go-live is approved once the fixes below are applied, i.e. ship `messages/hi.reviewed.json` (rename to `hi.json`; don't leave `*.reviewed.json` in `messages/`, because tests glob that folder).

Severity counts: blocker 0 · major 0 · minor 12 (+ linked edits listed without a separate severity)

## Checks performed
- All 383 strings read side by side against en.
- Keys and order are identical to en. ICU placeholders and `<tag>`s are identical in the original and reviewed files. en has no ICU plural/select; `{n}`/`{max}` contexts are always >1, so the plural is fine.
- Content rules: no FSC/ISO/FDA, eco/recyclable/biodegradable, food-grade, free, 24h promise, MOQ or lead-time numbers beyond en (the privacy 24h/48h retention facts mirror en). Gift Cards = greeting cards. Factory/manufacturer wording is within the rules. `tests/unconfirmed-claims.test.ts` passes for the original and reviewed files (vitest, 15/15).

- Register: formal आप throughout. Gender/number agreement and postpositions are checked. `{industryGen}` before के लिए is oblique (पार्टियों और इवेंट्स; invariant loanwords unchanged), and `Solutions.detail.metaTitle` uses direct `{industry}` after a colon. Nukta (फ़/ज़/ख़-optional) and chandrabindu (पाएँ, हटाएँ) are used correctly. Loanwords match Indian B2B usage. Button lengths are OK.

## Issues
| # | key | current | proposed | reason | severity |
|---|---|---|---|---|---|
| 1 | `Solutions.industries.color-boxes.name` | रिटेल उत्पाद | रिटेल प्रोडक्ट्स | शब्दावली में असंगति: पूरी साइट में प्रोडक्ट/प्रोडक्ट्स (ग्लॉसरी), सिर्फ़ यहाँ उत्पाद। हिंदी B2B साइटों पर 'रिटेल प्रोडक्ट्स' आम है। | minor |
| 2 | `Solutions.industries.color-boxes.title` | रिटेल उत्पादों के लिए पैकेजिंग | रिटेल प्रोडक्ट्स के लिए पैकेजिंग | linked to the row above | (linked) |
| 3 | `Solutions.industries.color-boxes.industryGen` | रिटेल उत्पादों | रिटेल प्रोडक्ट्स | उसी बदलाव का oblique रूप; अंग्रेज़ी plural loanword 'प्रोडक्ट्स' के लिए से पहले अपरिवर्तित रहता है (जैसे 'किन प्रोडक्ट्स में')। ग्लॉसरी §7 का उदाहरण भी अपडेट करें। | minor |
| 4 | `Solutions.industries.party-supplies.name` | पार्टी और इवेंट्स | पार्टियाँ और इवेंट्स | 'पार्टी और इवेंट्स' में वचन असंगत (एकवचन + बहुवचन)। industryGen 'पार्टियों और इवेंट्स' का direct रूप 'पार्टियाँ और इवेंट्स' है। | minor |
| 5 | `Solutions.meta.description` | आपकी इंडस्ट्री के लिए कस्टम बॉक्स, कप और इन्सर्ट, स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार। कोटेशन के लिए अपने प्रोडक्ट के बारे में बताइए। | आपकी इंडस्ट्री के लिए कस्टम बॉक्स, कप और इन्सर्ट, जिनके स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार तय होते हैं। कोटेशन के लिए अपने प्रोडक्ट के बारे में बताइए। | 'स्पेसिफ़िकेशन … के अनुसार।' क्रियाहीन अधूरा वाक्यांश है, अंग्रेज़ी 'with specs matched…' का शब्दशः अनुवाद। संबंधवाचक उपवाक्य से स्वाभाविक बनता है। | minor |
| 6 | `Solutions.lead` | कस्टम बॉक्स, कप और इन्सर्ट, स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार। | कस्टम बॉक्स, कप और इन्सर्ट, जिनके स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार तय होते हैं। | वही (क्रियाहीन वाक्यांश)। | minor |
| 7 | `Solutions.detail.lead` | {industryGen} के लिए कस्टम पैकेजिंग, स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार। | {industryGen} के लिए कस्टम पैकेजिंग, जिसके स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार तय होते हैं। | वही; पैकेजिंग (एकवचन) → 'जिसके'। | minor |
| 8 | `Solutions.detail.metaDescription` | {industryGen} के लिए कस्टम पैकेजिंग, स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार। कोटेशन के लिए अपने प्रोडक्ट के बारे में बताइए। | {industryGen} के लिए कस्टम पैकेजिंग, जिसके स्पेसिफ़िकेशन आपके प्रोडक्ट की शिपिंग और बिक्री के तरीके के अनुसार तय होते हैं। कोटेशन के लिए अपने प्रोडक्ट के बारे में बताइए। | वही। | minor |
| 9 | `Products.desc.corrugated-boxes` | सिंगल और डबल वॉल में कस्टम कोरुगेटेड शिपिंग और मेलर बॉक्स, आपके ब्रांड के साथ प्रिंटेड। | सिंगल और डबल वॉल में कस्टम कोरुगेटेड शिपिंग और मेलर बॉक्स, जिन पर आपका ब्रांड प्रिंट किया जाता है। | 'आपके ब्रांड के साथ प्रिंटेड' का अर्थ अस्पष्ट/अटपटा ('ब्रांड के साथ' = ब्रांड के साथ मिलकर)। अर्थ है: बॉक्स पर आपका ब्रांड छपा हो। | minor |
| 10 | `Quote.added` | सूची में है ✓ | सूची में जोड़ा गया ✓ | 'सूची में है ✓' बटन स्टेट के लिए अटपटा; हिंदी UI में 'जोड़ा गया' मानक है। | minor |
| 11 | `Quote.continue` | अनुरोध पर आगे बढ़ें | अनुरोध भरें | 'अनुरोध पर आगे बढ़ें' अस्वाभाविक ('अनुरोध के ऊपर आगे बढ़ें')। अगला चरण फ़ॉर्म भरना है; छोटा बटन लेबल। | minor |
| 12 | `Cases.eyebrow` | केस वॉल | हमारे प्रोजेक्ट | 'केस वॉल' भारतीय खरीदार के लिए अर्थहीन लिप्यंतरण है (en में भी आंतरिक शब्द)। es/de/fr की तरह 'हमारे प्रोजेक्ट'। | minor |
| 13 | `Privacy.sections.retention.items.logos` | जो लोगो किसी इन्क्वायरी से नहीं जुड़े हैं, वे आम तौर पर अपलोड के 48 घंटे के अंदर डिलीट हो जाते हैं (24 घंटे बाद वे डिलीट होने योग्य हो जाते हैं और क्लीनअप रोज़ चलता है), सिवाय उन लोगो के जो किसी अनएक्सपायर्ड सेव्ड डिज़ाइन में अभी भी उपयोग हो रहे हैं। | जो लोगो किसी इन्क्वायरी से नहीं जुड़े हैं, वे आम तौर पर अपलोड के 48 घंटे के अंदर डिलीट हो जाते हैं (24 घंटे बाद वे डिलीट होने योग्य हो जाते हैं और क्लीनअप रोज़ चलता है), सिवाय उन लोगो के जो अभी भी किसी ऐसे सेव किए गए डिज़ाइन में उपयोग हो रहे हैं जिसकी अवधि खत्म नहीं हुई है। | 'अनएक्सपायर्ड सेव्ड डिज़ाइन' भारी अंग्रेज़ी-मिश्रित, प्राइवेसी टेक्स्ट में समझना कठिन। | minor |

## Not translation defects — content items pending outside this review (same in en; not counted)
| key | item | owner |
|---|---|---|
| Products.specs.christmas-merchandise[2] | “Q4 के लिए सितंबर तक ऑर्डर करें” = deadline-type claim mirroring en "Order by September for Q4" | PM → Ryan |
| Products.specs.paper-cups[0] | “कई साइज़” placeholder while en keeps "4–22 oz" (PM decision) | Ryan |
| Products.metaDescription | “12 कस्टम पैकेजिंग कैटेगरी” mirrors en "12"; the categoryMeta work uses 11 (eco-paper-cups merged). Translation correct vs en; en number needs a PM/SEO decision | PM/SEO |
| Privacy.sections.contact.text[1], company.text[0] | {{待Ryan确认}} email / data controller — must be filled in all locales before launch | Ryan |
| Nav.switchLang, Footer.otherLang | "English version"/"English" pending phase-0 multi-locale dropdown | frontend/PM |

## Notes (no change made)
- “पक्का नहीं” for “Not sure” is natural and matches Contact.intro’s quoted label; keep them in sync if either changes.
- खत्म without nukta (rateLimit, adminSessions, logos) is common modern spelling and acceptable; ख़त्म is optional.
- (L × W × H) is kept: it's standard in Indian B2B packaging forms.
- Glossary §7 example `रिटेल उत्पादों` should be updated to `रिटेल प्रोडक्ट्स` to match fix #1–3.
