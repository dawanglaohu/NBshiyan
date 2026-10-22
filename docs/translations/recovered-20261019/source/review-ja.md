# Japanese UI strings — independent native-level review (launch gate)

Reviewer: independent of drafter · 2026-10-17 · files: `messages/ja.json` vs `messages/en.json` (383 strings) · glossary §7

## Verdict: **PASS with fixes**

Go-live is approved once the fixes below are applied, i.e. ship `messages/ja.reviewed.json` (rename to `ja.json`; don't leave `*.reviewed.json` in `messages/`, because tests glob that folder).

Severity counts: blocker 0 · major 2 · minor 13

## Checks performed
- All 383 strings read side by side against en.
- Keys and order are identical to en. ICU placeholders and `<tag>`s are identical in the original and reviewed files. en has no ICU plural/select; `{n}`/`{max}` contexts are always >1, so the plural is fine.
- Content rules: no FSC/ISO/FDA, eco/recyclable/biodegradable, food-grade, free, 24h promise, MOQ or lead-time numbers beyond en (the privacy 24h/48h retention facts mirror en). Gift Cards = greeting cards. Factory/manufacturer wording is within the rules. `tests/unconfirmed-claims.test.ts` passes for the original and reviewed files (vitest, 15/15).

- Register: です・ます is consistent and keigo is appropriate (貴社/お客様/いたします). Punctuation is 全角 「」（）：？ with no half-width ?!:() in Japanese text. Katakana loanwords are natural. Button/label lengths are fine (≤ en width). meta titles ≤60 chars.

## Issues
| # | key | current | proposed | reason | severity |
|---|---|---|---|---|---|
| 1 | `Solutions.meta.description` | 貴社の業界に合わせたオーダーメイドの箱、紙コップ、中敷き。製品の配送方法と販売方法に合わせて仕様を決めます。お見積もりは製品についてお聞かせください。 | 貴社の業界に合わせたオーダーメイドの箱、紙コップ、中敷き。製品の配送方法と販売方法に合わせて仕様を決めます。お見積もりをご希望の方は、製品についてお聞かせください。 | 「お見積もりは製品についてお聞かせください」は主述が噛み合わない非文。CTA文として不自然。 | major |
| 2 | `Solutions.detail.metaDescription` | {industryGen}向けのオーダーメイドパッケージ。製品の配送方法と販売方法に合わせて仕様を決めます。お見積もりは製品についてお聞かせください。 | {industryGen}向けのオーダーメイドパッケージ。製品の配送方法と販売方法に合わせて仕様を決めます。お見積もりをご希望の方は、製品についてお聞かせください。 | 同上（同じ非文）。 | major |
| 3 | `Inquiry.errors.retry` | 現在セキュリティチェックを完了できませんでした。入力内容は保持されています。少し時間をおいて再度お試しください。 | セキュリティチェックを完了できませんでした。入力内容は保持されています。少し時間をおいて再度お試しください。 | 「現在…できませんでした」は時制が噛み合わず機械翻訳調。 | minor |
| 4 | `Inquiry.logo.errors.server` | 現在ロゴをアップロードできませんでした。しばらくしてから再度お試しください。 | ロゴをアップロードできませんでした。しばらくしてから再度お試しください。 | 「現在…できませんでした」の時制不一致（同上）。 | minor |
| 5 | `Inquiry.products` | ご関心のある製品はどれですか？ | ご興味のある製品をお選びください | 「ご関心のある製品はどれですか？」は英語疑問文の直訳調。選択式フォームのラベルとしては指示形が自然。 | minor |
| 6 | `Inquiry.consent` | <link>プライバシーポリシー</link>に記載のとおり、本お問い合わせへの回答のためにPackJoyUが私のデータを処理することに同意します。 | <link>プライバシーポリシー</link>に記載のとおり、本お問い合わせへの回答のためにPackJoyUが個人データを処理することに同意します。 | 「私のデータ」は英語直訳調。日本語の同意文では「個人データ」が定型。 | minor |
| 7 | `Inquiry.validation.consent` | データ処理に同意する場合はチェックを入れてください。 | データ処理への同意欄にチェックを入れてください。 | 「同意する場合は」だと任意項目に読める。送信には必須の同意なので指示形に。 | minor |
| 8 | `Inquiry.email` | 会社のメールアドレス | 勤務先のメールアドレス | 「会社のメールアドレス」は口語的。B2Bフォームでは「勤務先メールアドレス」が定型。 | minor |
| 9 | `Inquiry.validation.emailRequired` | 会社のメールアドレスを入力してください。 | 勤務先のメールアドレスを入力してください。 | Inquiry.email と用語統一。 | minor |
| 10 | `Inquiry.quantity` | 1回あたりの注文数量 | 1回あたりのご注文数量 | 他の項目（ご連絡先・ご希望の時期）と敬語レベルを統一。 | minor |
| 11 | `Home.premiumText` | 箔押し、マグネット式の蓋、オーダーメイドの中敷きを備えた貼り箱。開封の瞬間まで映えるパッケージです。 | 箔押し、マグネット式の蓋、オーダーメイドの中敷きを備えた貼り箱。開封動画でも映える仕上がりです。 | 「made to be unboxed on camera」の「カメラ/動画」の意味が落ちている。「開封の瞬間まで映える」は意味が曖昧。 | minor |
| 12 | `Products.desc.corrugated-boxes` | シングル・ダブルの段ボールで作る配送箱・メーラーボックス。貴社ブランドを印刷します。 | シングル・ダブルウォールの段ボールで作る配送箱・メーラーボックス。貴社ブランドを印刷します。 | 用語統一：他所はすべて「シングル・ダブルウォール」。 | minor |
| 13 | `Products.desc.pulp-molding` | パルプモールドのトレーと中敷き。 | パルプモールドのトレー・緩衝材。 | パルプモールドの insert は日本の包装業界では「緩衝材」/「インナー」が一般的。「中敷き」は平らな敷き紙を想起させる。 | minor |
| 14 | `Factory.eyebrow` | 製造の流れ | ご注文の流れ | meta.title「ご注文の流れ」と不統一。内容も見積もり〜出荷の注文フロー（製造工程のみではない）。 | minor |
| 15 | `Cases.title` | 当社が製作した箱 | これまでに製作したパッケージ | 「当社が製作した箱」は硬く直訳調。事例ページ見出しとして自然な形に（工場表現は可のまま）。 | minor |

## Not translation defects — content items pending outside this review (same in en; not counted)
| key | item | owner |
|---|---|---|
| Products.specs.christmas-merchandise[2] | 「第4四半期分は9月までにご注文ください」 = deadline-type claim mirroring en "Order by September for Q4" | PM → Ryan |
| Products.specs.paper-cups[0] | 「複数サイズ」 placeholder while en keeps "4–22 oz" (PM decision) | Ryan |
| Products.metaDescription | 「12のカスタムパッケージカテゴリー」 mirrors en "12"; the categoryMeta work uses 11 (eco-paper-cups merged). Translation correct vs en; en number needs a PM/SEO decision | PM/SEO |
| Privacy.sections.contact.text[1], company.text[0] | {{待Ryan确认}} email / data controller — must be filled in all locales before launch | Ryan |
| Nav.switchLang, Footer.otherLang | "English version"/"English" pending phase-0 multi-locale dropdown | frontend/PM |

## Notes (no change made)
- 中敷き is used for 'insert' across gift/wine boxes. It's acceptable, but 中台/インナー is more idiomatic in the Japanese gift-box trade. Consider it a glossary option; changed only for molded pulp (緩衝材).
- 1～2か月 (〜) vs 300–400 gsm (–) are mixed range marks. Both are acceptable in their contexts (prose vs specs).
- Nav.quote/CTA お見積もり依頼 is fine as a short button.
