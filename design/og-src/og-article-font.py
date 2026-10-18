# Article OG fonts (src/app/[locale]/articles/[slug]/og): static Manrope 800/600 instances, subset to Latin + Latin-1/Ext-A + Cyrillic + typographic
# punctuation (« » „ “ ” – — … №), plus the 800 advance-width table used by src/lib/seo/og/articleOgLayout.ts to wrap the title.
# Satori (next/og) can't use variable fonts or woff2, so these TTFs are committed. Licence: SIL OFL 1.1 (src/assets/og-fonts/OFL.txt).
# Run from repo root: python3 design/og-src/og-article-font.py <path to Manrope-VariableFont_wght.ttf>
import json, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset
V = sys.argv[1]
U = list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x400, 0x460)) + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x201E, 0x2022, 0x2026, 0x2116, 0x20BD, 0x2122]
for w, name in [(800, 'ExtraBold'), (600, 'SemiBold')]:
    out = f'src/assets/og-fonts/Manrope-{name}.ttf'
    instancer.instantiateVariableFont(TTFont(V), {'wght': w}).save(out)
    o = subset.Options(); o.layout_features = ['kern', 'liga', 'calt', 'locl']; o.name_IDs = ['*']; o.notdef_outline = True; o.hinting = False
    f = TTFont(out); s = subset.Subsetter(o); s.populate(unicodes=U); s.subset(f); f.save(out)
f = TTFont('src/assets/og-fonts/Manrope-ExtraBold.ttf')
hm = f['hmtx'].metrics
json.dump({'unitsPerEm': f['head'].unitsPerEm, 'widths': {str(cp): hm[g][0] for cp, g in sorted(f.getBestCmap().items())}},
          open('src/lib/seo/og/manrope-800-widths.json', 'w'), separators=(',', ':'))
