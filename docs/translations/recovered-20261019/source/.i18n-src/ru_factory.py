#!/usr/bin/env python3
"""RU: restore own-factory wording (confirmed directly by Ryan, 2026-10-17) + gift-cards → «открытки». Every replacement must hit."""
import glob, json, re, sys
def sub(path, pairs, count_min=1):
    s = open(path, encoding='utf-8').read(); o = s
    for a, b in pairs:
        n = s.count(a)
        if n < count_min: sys.exit(f'{path}: not found: {a[:70]}')
        s = s.replace(a, b)
    if s != o: open(path, 'w', encoding='utf-8').write(s)
    return s != o
pages = sorted(glob.glob('docs/content/category-pages/*.ru.md'))
STEP4_OLD = '4. **Тираж и проверка качества** — после утверждения образца организуем выпуск и контроль партии.'
STEP4_NEW = '4. **Производство и контроль качества** — после утверждения образца запускаем тираж на нашей фабрике и проверяем партию.'
INTRO = {
 'christmas-merchandise': ('PackJoyU поставляет новогоднюю упаковку', 'PackJoyU производит новогоднюю упаковку'),
 'color-boxes': ('PackJoyU поставляет картонные коробки', 'PackJoyU производит картонные коробки'),
 'color-printing': ('PackJoyU организует цветную печать', 'PackJoyU выполняет цветную печать'),
 'corrugated-boxes': ('PackJoyU поставляет гофрокороба', 'PackJoyU производит гофрокороба'),
 'gift-boxes': ('PackJoyU поставляет жёсткие подарочные коробки', 'PackJoyU производит жёсткие подарочные коробки'),
 'offset-printing': ('PackJoyU организует офсетную печать', 'PackJoyU выполняет офсетную печать'),
 'paper-cups': ('PackJoyU поставляет бумажные стаканы', 'PackJoyU производит бумажные стаканы'),
 'party-supplies': ('PackJoyU поставляет бумажную посуду', 'PackJoyU производит бумажную посуду'),
 'pulp-molding': ('PackJoyU поставляет лотки', 'PackJoyU производит лотки'),
 'wine-boxes': ('PackJoyU поставляет коробки для вина', 'PackJoyU производит коробки для вина'),
}
for p in pages:
    key = p.split('/')[-1][:-6]
    pairs = [(STEP4_OLD, STEP4_NEW)]
    if key in INTRO: pairs.append(INTRO[key])
    sub(p, pairs)
# gift-cards page: открытки
gc = 'docs/content/category-pages/gift-cards.ru.md'
s = open(gc, encoding='utf-8').read()
print('--- gift-cards.ru.md before (lines with карт):'); [print(l[:200]) for l in s.splitlines() if re.search(r'карт|F16', l)]
