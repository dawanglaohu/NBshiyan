#!/usr/bin/env python3
"""PM decision 1 (2026-10-17): drop 'fast proofs' and 'on-time holiday delivery' in en/ru sources."""
import sys
EN_CP = ('Accurate color matching and fast proofs.', 'Accurate color matching and proofs before the run.')
RU_CP = ('Точная цветопередача CMYK и Pantone, быстрые пробы для брендов.', 'Точная цветопередача CMYK и Pantone, цветопроба до тиража.')
EN_XM = ('Plan early for on-time holiday delivery.', 'Plan your season early.')
RU_XM = ('Закажите заранее, чтобы успеть к Новому году.', 'Спланируйте сезон заранее.')
RU_ADV = ('адвент календари и сезонная упаковка', 'адвент-календари и сезонная упаковка')
F = {
 'src/lib/seo/categoryMeta.ts': [EN_CP, RU_CP, EN_XM, RU_XM, RU_ADV],
 'docs/content/custom-color-printing.md': [EN_CP, RU_CP],
 'docs/content/custom-christmas-packaging.md': [EN_XM, RU_XM, RU_ADV,
   ('- **On-time planning** — Production schedule planned back from your in-store date.', '- **Season planning** — We plan the production schedule with you around your in-store date.'),
   ('Recommended latest order date for on-time holiday delivery: confirmed with your quote', 'Recommended latest order date for the season: confirmed with your quote')],
 'docs/seo-category-meta.md': [EN_CP, RU_CP, EN_XM, RU_XM, RU_ADV],
 'docs/content/articles/corporate-gift-packaging-planning-guide.md': [
   ('the latest safe order date for on-time holiday delivery is TBD', 'the recommended latest order date for the season is TBD')],
}
for p, pairs in F.items():
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        if a not in s: sys.exit(f'{p}: not found: {a}')
        s = s.replace(a, b)
    open(p, 'w', encoding='utf-8').write(s)
print('ok')
