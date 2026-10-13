> [!WARNING]
> **⚠️ 示例数据，严禁上线**：本目录设计稿中的所有规格数值（MOQ、尺寸、交期、样品费、材质、证书等）均为示例数据，仅用于展示版式，**绝不能写进代码或上线**。线上规格只能从后端 `/api/specs` 获取，没有值的字段不显示。
>
> **⚠️ EXAMPLE DATA — MUST NEVER GO LIVE**: All spec values in these mock-ups (MOQ, dimensions, lead time, sample fee, material, certificates, etc.) are placeholder examples for layout only and **must never be hard-coded or shipped**. Live specs come **only** from the backend `/api/specs`; fields without a value are not shown.

# Category landing `/[locale]/products/<slug>` + 503 (Refs #209)

Open `category-landing.html` (add `#d-en`, `#m-ru`, … to see one frame). PNG renders: `d-en`, `d-ru`, `d-wine-b` (theme B), `m-en`, `m-ru` (390), `m360-ru` (360, no specs), `e503` (EN/RU, desktop + mobile).
Spec values in the frames are **placeholders for layout only** (shape = `/api/specs`). Don't ship them.

## Page structure (one H1; order per #209 §1)
| # | Block | Tag / level | Source | Rules |
|---|---|---|---|---|
| 0 | Breadcrumb | `<nav aria-label="Breadcrumb">`, last item `aria-current="page"` | categoryMeta | Must match BreadcrumbList JSON-LD. Items ≥44px tall |
| 1 | Hero | **`<h1>`** = #188 H1 (no brand name), lead `<p>` | #188 | **No fade-in or reveal** on H1/hero. Poster is `next/image priority` with width/height. 3D viewer (r3f) mounts on top of the poster on the client; "Open box" only on boxes with the `open` clip |
| 2 | Why PackJoyU | `<h2>` + 4× `<h3>` | #188 | `.reveal` allowed (below the fold) |
| 3 | Specifications & options | `<h2>`; "Key specs" `<h3>` + `<dl>`; "Certificates" `<h3>` + `<ul>`; "Options" `<h3>` + `<table>` (`th scope=row`) | `/api/specs` + #188 options rows | See the field table below. Never an image |
| 4 | How it works | `<h2>` + `<ol>` with `<h3>` per step | #188 | Remove "(lead time TBD)" text |
| 5 | FAQ | `<h2>` + `<details><summary>` | #188 draft | **Not rendered until Ryan finalizes.** Drop any answer that contains TBD. Answers stay in the HTML when collapsed (`<details>`, not display:none) |
| 6 | Related products | `<h2>` + `<ul>` of `<a>` | internal-links.json `category→category` | Copy `anchor` exactly, same-locale relative href, no nofollow |
| 7 | Further reading | `<h2>` + `<a>` | `category→article` | Hide the section when the article isn't published |
| 8 | Inquiry CTA band | `<h2>` (visually a band) + primary button | — | Link to inquiry with the category prefilled. A second CTA sits in the hero; mobile also gets a sticky bottom CTA |

## Key specs — `/api/specs` fields (missing field → no row; all missing → no "Key specs" block)
| Field | Label EN / RU | Display |
|---|---|---|
| `size {min,max,unit}` | Size range / Размеры | `100–600 mm`, RU `мм` |
| `material` | Material / Материал | locale text |
| `moq {value,unit}` | Minimum order / Минимальный тираж | `Intl.NumberFormat` (`ru-RU` → `1 000 шт.`) |
| `sampleFee {amount,currency}` / `{free:true}` | Sample fee / Стоимость образца | `50 USD` / Free · Бесплатно |
| `leadTime {min,max,unit}` | Lead time / Срок производства | `15–25 days` / `дн.` |
| `tradeTerms` | Trade terms / Условия поставки | locale text |
| `certifications[{name,certNo?,url?}]` | Certificates / Сертификаты | Card: name + "Cert. no." line. With `url` (https only): `target="_blank" rel="noopener noreferrer"`, external-link icon, and visually-hidden "(opens in a new tab)". Empty array → no Certificates block |
- The **Options** table (#188 copy rows: styles, printing, finishes…) always shows; TBD rows (MOQ/lead time in the copy) are removed. A structured value from `/api/specs` replaces its TBD row.
- With no spec data and no certs, the section is just H2 + Options (frame `m360-ru`). If Options is empty too, drop the whole section including its H2.
- Desktop: Key specs and certs on the left, Options on the right. Mobile: stacked. At 360 the Options table turns into stacked th/td.

## Theme
- Theme C (default). **Theme B `.theme-premium`** for `gift-boxes` and `wine-boxes`: bg #121214, gold #D4AF6A button with **#121214 text** (#148), hover lighter.
- Coral #FF5A36 primary stays as-is until #147 is decided. Text links use `--accent-text` #C2381A on light backgrounds, gold on B.
- Focus: global #120 ring `outline:2px solid var(--focus-ring); outline-offset:3px` (shown on the wine frame's primary button).

## Motion / SEO
- Animate only transform and opacity (`motion-tokens.css`). Reveal only below the fold via `.reveal-ready .reveal`. Content is never display:none. Card hover is `translateY(-2px)`. FAQ uses a rotating "+".
- All visible text is in the server HTML (`curl` check). The 3D canvas is decorative enhancement: the viewer has `role=img` + `aria-label`.

## Mobile
- Tap targets ≥44px (buttons 52px). The sticky CTA bar sits at the bottom. The FAB and page bottom padding respect `--fab-clearance` / `--consent-h` (same as #202). The sticky bar goes above the consent bar when it's shown: `bottom: var(--consent-h)`.
- RU H1 uses `overflow-wrap:anywhere; hyphens:auto` so it doesn't scroll sideways at 360 (#194 lesson).

## 503 (`/s/<id>` DB down)
- Theme C. `<h1>` Temporarily unavailable / Временно недоступно. Body text plus **Try again** (reloads) and **Browse products** → `/{locale}/products`.
- noindex + `no-store` + `Retry-After`. No error details shown. No SEO content.
