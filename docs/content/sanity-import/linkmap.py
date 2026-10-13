#!/usr/bin/env python3
"""Generate docs/content/internal-links.{json,md} (Refs #99). Anchors vary per source page."""
import json, pathlib, re, sys
HERE = pathlib.Path(__file__).resolve().parent
# Usage: linkmap.py [content_dir] [--out DIR] [--meta categoryMeta.ts]  (defaults: docs/content, src/lib/seo/categoryMeta.ts)
# Exits non-zero if the meta file is missing/unreadable or an EN slug still contains 'compost' (retired eco-paper-cups slug).
_args = sys.argv[1:]
OUT_DIR = None
_meta = None
if '--meta' in _args:
    i = _args.index('--meta'); _meta = _args[i + 1]; del _args[i:i + 2]
if '--out' in _args:
    i = _args.index('--out'); OUT_DIR = pathlib.Path(_args[i + 1]); del _args[i:i + 2]
CONTENT = pathlib.Path(_args[0]) if _args else HERE.parent
# --meta defaults to the app's canonical src/lib/seo/categoryMeta.ts (same file categorySlugs.ts and build.py use).
META_PATH = pathlib.Path(_meta) if _meta else HERE.parents[2] / 'src/lib/seo/categoryMeta.ts'
try:
    META = META_PATH.read_text(encoding='utf-8')
except (OSError, UnicodeDecodeError) as e:
    sys.exit(f'error: cannot read category meta {META_PATH}: {e}')
# Retired slug guard: the old EN eco-paper-cups slug (never live, #218 F15/F17) contained 'compost'; a stale meta must not map links.
# Matching the stem 'compost' covers the retired slug and any other 'compost…' EN slug.
_en_slugs = re.findall(r"en: \{ slug: '([^']*)'", META)
if not _en_slugs:
    sys.exit(f'error: no category slugs found in {META_PATH}')
_retired = [x for x in _en_slugs if 'compost' in x]
if _retired:
    sys.exit(f"error: {META_PATH} has retired/unconfirmed EN slug(s) {_retired}; sync categoryMeta.ts with seo/yo-unification (eco-paper-cups)")
def slugs(k):
    b = META.split(f"key: '{k}'")[1].split('{ key:')[0]; en, ru = b.split('ru: {')
    return {'en': re.search(r"slug: '([^']*)'", en).group(1), 'ru': re.search(r"slug: '([^']*)'", ru).group(1)}
# 3 anchor variants per category per locale (natural phrasing, not exact-match only)
A = {
 'corrugated-boxes': {'en': ['custom corrugated boxes', 'branded shipping boxes', 'corrugated mailer boxes'], 'ru': ['гофрокороба на заказ', 'почтовые коробки с логотипом', 'транспортная упаковка из гофрокартона']},
 'color-boxes': {'en': ['custom printed boxes', 'full-color retail boxes', 'printed product packaging'], 'ru': ['картонные коробки с печатью', 'коробки с логотипом', 'упаковка для косметики и розницы']},
 'gift-boxes': {'en': ['custom gift boxes', 'rigid magnetic gift boxes', 'premium gift packaging'], 'ru': ['подарочные коробки на заказ', 'жёсткие коробки с магнитом', 'премиальная подарочная упаковка']},
 'pulp-molding': {'en': ['molded pulp packaging', 'custom pulp inserts', 'molded fiber trays'], 'ru': ['упаковка из формованной целлюлозы', 'ложементы из целлюлозы', 'лотки из целлюлозы']},
 'paper-cups': {'en': ['custom paper cups', 'branded coffee cups', 'printed paper cups with your logo'], 'ru': ['бумажные стаканы с логотипом', 'стаканы для кофе с печатью', 'фирменные бумажные стаканы']},
 'party-supplies': {'en': ['custom party supplies', 'printed party tableware', 'private-label party products'], 'ru': ['бумажная посуда для праздника', 'праздничная посуда с печатью', 'товары для праздника под вашей маркой']},
 'wine-boxes': {'en': ['custom wine boxes', 'wine and spirits gift boxes', 'luxury bottle packaging'], 'ru': ['коробки для вина на заказ', 'подарочная упаковка для алкоголя', 'коробки для бутылок с логотипом']},
 'color-printing': {'en': ['packaging printing services', 'full-color packaging printing', 'CMYK and Pantone printing'], 'ru': ['печать упаковки', 'полноцветная печать на картоне', 'печать пантонами']},
 'offset-printing': {'en': ['offset printing services', 'high-volume offset printing', 'catalog and box printing'], 'ru': ['офсетная печать упаковки', 'офсетная печать тиражом', 'печать каталогов и коробок']},
 'eco-paper-cups': {'en': ['eco-friendly paper cups', 'eco-friendly coffee cups', 'eco paper cups with your logo'], 'ru': ['экологичные стаканы', 'эко стаканы с логотипом', 'экологичные бумажные стаканы']},
 'gift-cards': {'en': ['custom gift cards', 'printed gift vouchers', 'gift card holders and envelopes'], 'ru': ['печать подарочных карт', 'подарочные сертификаты на заказ', 'упаковка для подарочных карт']},
 'christmas-merchandise': {'en': ['custom Christmas packaging', 'holiday gift boxes', 'advent calendars and seasonal packaging'], 'ru': ['новогодняя упаковка на заказ', 'новогодние подарочные коробки', 'адвент-календари на заказ']},
}
REL = {  # category -> related categories (from #188), 3 each
 'corrugated-boxes': ['color-boxes', 'pulp-molding', 'offset-printing'], 'color-boxes': ['gift-boxes', 'color-printing', 'offset-printing'],
 'gift-boxes': ['wine-boxes', 'christmas-merchandise', 'color-boxes'], 'pulp-molding': ['corrugated-boxes', 'eco-paper-cups', 'gift-boxes'],
 'paper-cups': ['eco-paper-cups', 'party-supplies', 'color-boxes'], 'party-supplies': ['paper-cups', 'christmas-merchandise', 'color-printing'],
 'wine-boxes': ['gift-boxes', 'christmas-merchandise', 'pulp-molding'], 'color-printing': ['offset-printing', 'color-boxes', 'gift-cards'],
 'offset-printing': ['color-printing', 'color-boxes', 'gift-cards'], 'eco-paper-cups': ['paper-cups', 'pulp-molding', 'party-supplies'],
 'gift-cards': ['color-printing', 'gift-boxes', 'offset-printing'], 'christmas-merchandise': ['gift-boxes', 'wine-boxes', 'party-supplies'],
}
ART = {
 'custom-mailer-boxes-ecommerce-buyers-guide': {'slug': {'en': 'custom-mailer-boxes-ecommerce-buyers-guide', 'ru': 'pochtovye-korobki-s-logotipom-dlya-internet-magazina'},
   'cats': ['corrugated-boxes', 'color-boxes', 'pulp-molding'],
   'anchor': {'en': ['our buyer\'s guide to custom mailer boxes', 'how to choose e-commerce mailer boxes', 'mailer box sizing and printing guide'],
              'ru': ['как заказать почтовые коробки для интернет-магазина', 'гид по коробкам для маркетплейсов', 'как выбрать коробку для интернет-магазина']}},
 'corporate-gift-packaging-planning-guide': {'slug': {'en': 'corporate-gift-packaging-planning-guide', 'ru': 'korporativnye-podarki-upakovka-s-logotipom'},
   'cats': ['gift-boxes', 'christmas-merchandise', 'wine-boxes'],
   'anchor': {'en': ['corporate gift packaging planning guide', 'how to plan corporate gift boxes', 'timeline for corporate gift packaging'],
              'ru': ['как спланировать упаковку для корпоративных подарков', 'упаковка корпоративных подарков к Новому году', 'гид по корпоративной подарочной упаковке']}},
}
# Only articles that build.py will import get links: a file for that locale/slug must exist in articles/ and must not
# say 'import: false'. Missing or held-back articles drop out here (both directions) and come back on the next run.
def importable():
    ok = set()
    for f in sorted((CONTENT / 'articles').glob('*.md')):
        m = re.match(r'^---\n(.*?)\n---\n', f.read_text(), re.S)
        fm = dict(re.findall(r'^(\w+): "?(.*?)"?$', m.group(1), re.M)) if m else {}
        if fm.get('import') != 'false': ok.add((fm.get('locale', 'en'), fm.get('slug')))
    return ok
LIVE = importable()
cat_url = lambda k, l: f'/{l}/products/{slugs(k)[l]}'
art_url = lambda a, l: f'/{l}/articles/{ART[a]["slug"][l]}'
links = []
use = {}  # rotate anchors per target so repeats are spread
def anchor(pool, tid, l):
    i = use.get((tid, l), 0); use[(tid, l)] = i + 1; return pool[i % len(pool)]
for l in ('en', 'ru'):
    for k, rel in REL.items():
        for t in rel:
            links.append({'locale': l, 'kind': 'category→category', 'from': cat_url(k, l), 'to': cat_url(t, l), 'anchor': anchor(A[t][l], t, l)})
    for a, v in ART.items():
        if (l, v['slug'][l]) not in LIVE: continue
        for k in v['cats']:
            links.append({'locale': l, 'kind': 'article→category', 'from': art_url(a, l), 'to': cat_url(k, l), 'anchor': anchor(A[k][l], k, l)})
            links.append({'locale': l, 'kind': 'category→article', 'from': cat_url(k, l), 'to': art_url(a, l), 'anchor': anchor(v['anchor'][l], a, l)})
for x in links: assert re.match(r'^/(en|ru)/', x['to']) and x['to'].startswith(f"/{x['locale']}/")
out = OUT_DIR or HERE.parent
(out / 'internal-links.json').write_text(json.dumps({'version': 1, 'note': 'Refs #99. Relative paths only (/en/ or /ru/). Same-locale links only.', 'links': links}, ensure_ascii=False, indent=2) + '\n')
md = ['# 内链地图（Refs #99）\n', '由 `docs/content/sanity-import/linkmap.py` 生成，机器可读版本见 `internal-links.json`。只在同一种语言内部互链，路径都是相对路径。',
      '锚文本每个目标页准备 3 种说法轮流用，避免同一个精确匹配词重复出现。俄语锚文本：⚠️ 需要 Ryan 校对。\n',
      '只给会被导入的文章生成链接：`articles/` 里没有对应语言的文件、或 front matter 写了 `import: false` 的文章，两个方向的链接都不生成；文章可以导入后重新运行本脚本，链接会自动回来。\n',
      '品类 → 品类的链接会作为"相关产品"一节加在落地页正文末尾；文章 → 品类的链接已经写在文章正文里，导入时会转成链接标记，不再另加一节。\n']
for l, title in (('en', 'English'), ('ru', 'Русский ⚠️ 需要 Ryan 校对')):
    md += [f'\n## {title}\n', '| 类型 | 来源 | 目标 | 锚文本 |', '|---|---|---|---|']
    md += [f"| {x['kind']} | `{x['from']}` | `{x['to']}` | {x['anchor']} |" for x in links if x['locale'] == l]
(out / 'internal-links.md').write_text('\n'.join(md) + '\n')
print(len(links), 'links')
