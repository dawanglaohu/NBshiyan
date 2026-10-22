#!/usr/bin/env python3
"""Generate docs/content/landing-faq.{es,de,fr}.md from .i18n-src/faq_{lang}.py.
Validates vs EN landing-faq.md: same keys/order, same Q&A count, same {{待Ryan确认}} count per item, no new claim words."""
import re, sys, importlib.util
P = '{{待Ryan确认}}'
def load(l):
    s = importlib.util.spec_from_file_location(l, f'.i18n-src/faq_{l}.py'); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m.FAQ
SLUG = {
 'es': {'corrugated-boxes':'cajas-carton-ondulado','color-boxes':'cajas-impresas','gift-boxes':'cajas-de-regalo','pulp-molding':'embalaje-pulpa-moldeada','paper-cups':'vasos-de-papel-personalizados','party-supplies':'articulos-para-fiestas','wine-boxes':'cajas-para-vino','color-printing':'impresion-de-embalaje','offset-printing':'impresion-offset','eco-paper-cups':'vasos-cafe-impresos','gift-cards':'tarjetas-de-felicitacion','christmas-merchandise':'embalaje-navideno'},
 'de': {'corrugated-boxes':'wellpappkartons','color-boxes':'bedruckte-faltschachteln','gift-boxes':'geschenkboxen','pulp-molding':'formfaserguss-verpackungen','paper-cups':'bedruckte-pappbecher','party-supplies':'partyartikel','wine-boxes':'weinverpackungen','color-printing':'verpackungsdruck','offset-printing':'offsetdruck','eco-paper-cups':'bedruckte-kaffeebecher','gift-cards':'grusskarten','christmas-merchandise':'weihnachtsverpackungen'},
 'fr': {'corrugated-boxes':'cartons-ondules','color-boxes':'boites-pliantes-imprimees','gift-boxes':'coffrets-cadeaux','pulp-molding':'emballages-pulpe-moulee','paper-cups':'gobelets-carton-personnalises','party-supplies':'articles-de-fete','wine-boxes':'coffrets-a-vin','color-printing':'impression-emballages','offset-printing':'impression-offset','eco-paper-cups':'gobelets-cafe-imprimes','gift-cards':'cartes-de-voeux','christmas-merchandise':'emballages-de-noel'},
}
NAME = {
 'es': {'corrugated-boxes':'Cajas de cartón ondulado personalizadas','color-boxes':'Cajas impresas personalizadas','gift-boxes':'Cajas de regalo personalizadas','pulp-molding':'Embalaje de pulpa moldeada','paper-cups':'Vasos de papel personalizados','party-supplies':'Artículos para fiestas personalizados','wine-boxes':'Cajas para vino personalizadas','color-printing':'Impresión de embalaje','offset-printing':'Servicios de impresión offset','eco-paper-cups':'Vasos de café impresos','gift-cards':'Tarjetas de felicitación personalizadas','christmas-merchandise':'Embalaje navideño personalizado'},
 'de': {'corrugated-boxes':'Individuelle Wellpappkartons','color-boxes':'Individuell bedruckte Faltschachteln','gift-boxes':'Individuelle Geschenkboxen','pulp-molding':'Verpackungen aus Formfaserguss','paper-cups':'Individuell bedruckte Pappbecher','party-supplies':'Individuelle Partyartikel','wine-boxes':'Individuelle Weinverpackungen','color-printing':'Verpackungsdruck','offset-printing':'Offsetdruck','eco-paper-cups':'Bedruckte Kaffeebecher','gift-cards':'Individuelle Grußkarten','christmas-merchandise':'Individuelle Weihnachtsverpackungen'},
 'fr': {'corrugated-boxes':'Cartons ondulés personnalisés','color-boxes':'Boîtes pliantes imprimées sur mesure','gift-boxes':'Coffrets cadeaux sur mesure','pulp-molding':'Emballages en pulpe moulée','paper-cups':'Gobelets en carton personnalisés','party-supplies':'Articles de fête personnalisés','wine-boxes':'Coffrets à vin sur mesure','color-printing':'Impression d’emballages','offset-printing':'Impression offset','eco-paper-cups':'Gobelets à café imprimés','gift-cards':'Cartes de vœux personnalisées','christmas-merchandise':'Emballages de Noël personnalisés'},
}
HEAD = {
 'es': ('Preguntas frecuentes de las páginas de categoría (ES)', 'BORRADOR. Traducido de `landing-faq.md` (EN), contrastado con RU. Mismas reglas: una pregunta/respuesta que contenga `{{…}}` no se muestra ni entra en el JSON-LD FAQPage; una categoría con menos de 2 preguntas mostrables no muestra el bloque. Slugs = propuesta SEO.'),
 'de': ('FAQ der Kategorieseiten (DE)', 'ENTWURF. Übersetzt aus `landing-faq.md` (EN), abgeglichen mit RU. Gleiche Regeln: Frage/Antwort mit `{{…}}` wird nicht ausgegeben und nicht ins FAQPage-JSON-LD übernommen; Kategorien mit weniger als 2 ausgebbaren Fragen zeigen den Block nicht. Slugs = SEO-Vorschlag.'),
 'fr': ('FAQ des pages catégories (FR)', 'BROUILLON. Traduit de `landing-faq.md` (EN), recoupé avec la version RU. Mêmes règles : une question/réponse contenant `{{…}}` n’est pas affichée et n’entre pas dans le JSON-LD FAQPage ; une catégorie avec moins de 2 questions affichables ne montre pas le bloc. Slugs = proposition SEO.'),
}
CLAIM = r'(?i)\bfsc\b|\biso\b|ecológic|öko|écolo|recicl|recycl|biodegr|compost|kompost|fda|alimentari|lebensmittelecht|qualité alimentaire|gratis|gratuit|kostenlos|\b\d+\s*(días|tage|jours|semanas|wochen|semaines|h)\b|24\s*h'
en = open('docs/content/landing-faq.md', encoding='utf-8').read()
EN = {}
for sec in re.split(r'\n(?=## `)', en)[1:]:
    key = re.match(r'## `([^`]+)`', sec).group(1)
    ensec = sec.split('### RU')[0]
    EN[key] = [(q, a) for q, a in re.findall(r'<details id="faq-[^"]+-en-\d+"><summary>(.*?)</summary>\n\n(.*?)\n\n</details>', ensec, re.S)]
errs = []
for l in ('es', 'de', 'fr'):
    F = load(l)
    if list(F) != list(EN): errs.append(f'{l}: keys/order differ {list(F)} vs {list(EN)}')
    t, s = HEAD[l]
    out = [f'# {t}', '', f'> {s}', '', '| key | slug | n |', '|---|---|---|']
    out += [f'| `{k}` | `{SLUG[l][k]}` | {len(F[k])} |' for k in F] + ['', '---', '']
    for k, items in F.items():
        out += [f'## `{k}` — `/{l}/products/{SLUG[l][k]}` ({NAME[l][k]})', '']
        if len(items) != len(EN.get(k, [])): errs.append(f'{l}.{k}: {len(items)} items vs EN {len(EN.get(k, []))}')
        for i, (q, a) in enumerate(items, 1):
            out += [f'<details id="faq-{k}-{l}-{i}"><summary>{q}</summary>', '', a, '', '</details>', '']
            eq, ea = EN[k][i-1]
            if (q+a).count(P) != (eq+ea).count(P): errs.append(f'{l}.{k}.{i}: placeholder {(q+a).count(P)} vs EN {(eq+ea).count(P)}')
            if (q+a).count('{') != (q+a).count(P)*2: errs.append(f'{l}.{k}.{i}: stray brace')
            m = re.search(CLAIM, q + ' ' + a)
            if m and not re.search(CLAIM, eq + ' ' + ea): errs.append(f'{l}.{k}.{i}: claim word "{m.group(0)}" not in EN')
            if re.search(r'\b(the|and|your|with)\b', q + ' ' + a): errs.append(f'{l}.{k}.{i}: EN leftover?')
        out += ['---', '']
    open(f'docs/content/landing-faq.{l}.md', 'w', encoding='utf-8').write('\n'.join(out).rstrip('-\n') + '\n')
    print(f'{l}: {sum(len(v) for v in F.values())} Q&A, {sum((q+a).count(P) for v in F.values() for q, a in v)} placeholders (EN {sum((q+a).count(P) for v in EN.values() for q, a in v)})')
if errs: print('FAIL'); print('\n'.join(errs)); sys.exit(1)
print('PASS: keys/order, Q&A count and per-item {{待Ryan确认}} parity with EN; no new claim words')
