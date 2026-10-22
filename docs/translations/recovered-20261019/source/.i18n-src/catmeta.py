#!/usr/bin/env python3
"""Proposal: es/de/fr title/description for src/lib/seo/categoryMeta.ts. Checks title<=60, description<=160, no custom+wholesale in titles."""
import re, sys
M = {
 'corrugated-boxes': dict(
  es=('cajas-carton-ondulado','cajas de cartón ondulado personalizadas','Cajas de cartón ondulado a medida | PackJoyU','Cajas de cartón ondulado para envío y cajas postales a su medida, con impresión flexográfica o digital y su logotipo. Pedidos en volumen. Pida presupuesto.'),
  de=('wellpappkartons','Wellpappkartons individuell','Individuelle Wellpappkartons | PackJoyU','Versand- und Wellpappkartons nach Maß, mit Flexo- oder Digitaldruck und Ihrem Logo. Auch für große Bestellmengen. Jetzt Angebot anfordern.'),
  fr=('cartons-ondules','cartons ondulés personnalisés','Cartons ondulés sur mesure | PackJoyU','Cartons d’expédition et boîtes postales en carton ondulé à vos dimensions, impression flexo ou numérique et votre logo. Commandes en volume. Devis sur demande.')),
 'color-boxes': dict(
  es=('cajas-impresas','cajas impresas personalizadas','Cajas impresas a medida | PackJoyU','Cajas de cartón impresas a todo color para cosmética, electrónica y retail. Medidas a medida, estampado, relieve y laminado mate o brillo. Pida presupuesto.'),
  de=('bedruckte-faltschachteln','bedruckte Faltschachteln','Bedruckte Faltschachteln nach Maß | PackJoyU','Vollfarbig bedruckte Faltschachteln für Kosmetik, Elektronik und Handel. Individuelle Maße, Folienprägung, Prägung und Kaschierung. Angebot anfordern.'),
  fr=('boites-pliantes-imprimees','boîtes imprimées sur mesure','Boîtes pliantes imprimées sur mesure | PackJoyU','Boîtes en carton imprimées en quadrichromie pour la cosmétique, l’électronique et la distribution. Formats sur mesure, dorure, gaufrage, pelliculage. Devis.')),
 'gift-boxes': dict(
  es=('cajas-de-regalo','cajas de regalo personalizadas','Cajas de regalo a medida | PackJoyU','Cajas de regalo rígidas con tapa magnética, tipo cajón e interiores a medida. Papeles especiales, estampado en caliente y relieve. Pida presupuesto.'),
  de=('geschenkboxen','Geschenkboxen individuell','Individuelle Geschenkboxen | PackJoyU','Feste Geschenkboxen mit Magnetdeckel, als Schiebeschachtel und mit passgenauen Einlagen. Feinstpapiere, Heißfolien- und Blindprägung. Angebot anfordern.'),
  fr=('coffrets-cadeaux','coffrets cadeaux personnalisés','Coffrets cadeaux sur mesure | PackJoyU','Coffrets cadeaux rigides à couvercle aimanté, tiroir et calages sur mesure. Papiers de création, marquage à chaud et gaufrage à votre marque. Demandez un devis.')),
 'pulp-molding': dict(
  es=('embalaje-pulpa-moldeada','embalaje de pulpa moldeada','Embalaje de pulpa moldeada | PackJoyU','Bandejas, interiores y cajas de pulpa moldeada con la forma de su producto. Pida presupuesto.'),
  de=('formfaserguss-verpackungen','Formfaserguss Verpackung','Verpackungen aus Formfaserguss | PackJoyU','Trays, Einlagen und Schachteln aus Formfaserguss, passgenau zu Ihrem Produkt geformt. Jetzt Angebot anfordern.'),
  fr=('emballages-pulpe-moulee','emballage pulpe moulée','Emballages en pulpe moulée | PackJoyU','Plateaux, calages et boîtes en pulpe moulée, formés selon votre produit. Demandez un devis.')),
 'paper-cups': dict(
  es=('vasos-de-papel-personalizados','vasos de papel personalizados','Vasos de papel personalizados | PackJoyU','Vasos de papel para café impresos con su logotipo, de pared simple o doble, en varias capacidades y con tapas a juego. Para cafeterías y marcas. Presupuesto.'),
  de=('bedruckte-pappbecher','Pappbecher bedrucken','Bedruckte Pappbecher mit Logo | PackJoyU','Kaffeebecher aus Pappe mit Ihrem Logo, einwandig oder doppelwandig, in verschiedenen Größen und mit passenden Deckeln. Für Cafés und Marken. Angebot anfordern.'),
  fr=('gobelets-carton-personnalises','gobelets carton personnalisés','Gobelets en carton personnalisés | PackJoyU','Gobelets à café imprimés à votre logo, simple ou double paroi, en plusieurs contenances, avec couvercles assortis. Pour cafés et marques. Demandez un devis.')),
 'party-supplies': dict(
  es=('articulos-para-fiestas','artículos para fiestas personalizados','Artículos para fiestas personalizados | PackJoyU','Artículos de fiesta de papel impresos con sus diseños: platos, vasos, servilletas y decoración. Pedidos en volumen para retail y marcas. Pida presupuesto.'),
  de=('partyartikel','Partyartikel bedruckt','Bedruckte Partyartikel | PackJoyU','Partyartikel aus Papier mit Ihren Motiven: Teller, Becher, Servietten und Deko. Große Bestellmengen für Handel und Marken. Jetzt Angebot anfordern.'),
  fr=('articles-de-fete','articles de fête personnalisés','Articles de fête personnalisés | PackJoyU','Articles de fête en papier imprimés à vos motifs : assiettes, gobelets, serviettes et décorations. Commandes en volume pour enseignes et marques. Devis.')),
 'wine-boxes': dict(
  es=('cajas-para-vino','cajas para vino personalizadas','Cajas para vino a medida | PackJoyU','Cajas de lujo para vino y licores, para una o varias botellas, con cierre magnético, interiores, estampado y logotipo en relieve. Listas para regalar.'),
  de=('weinverpackungen','Weinverpackung individuell','Individuelle Weinverpackungen | PackJoyU','Edle Verpackungen für Wein und Spirituosen, für eine oder mehrere Flaschen, mit Magnetverschluss, Einlagen, Folie und Prägung. Geschenkfertig. Angebot anfragen.'),
  fr=('coffrets-a-vin','coffrets à vin personnalisés','Coffrets à vin sur mesure | PackJoyU','Coffrets de luxe pour vins et spiritueux, une ou plusieurs bouteilles, fermeture aimantée, calages, dorure et logo gaufré. Prêts à offrir. Demandez un devis.')),
 'color-printing': dict(
  es=('impresion-de-embalaje','impresión de embalaje','Impresión de embalaje | PackJoyU','Impresión a todo color en CMYK y Pantone para embalaje, etiquetas e insertos sobre papel y cartón. Ajuste de color preciso y pruebas de color. Pida presupuesto.'),
  de=('verpackungsdruck','Verpackungsdruck','Verpackungsdruck | PackJoyU','Vollfarbdruck in CMYK und Pantone für Verpackungen, Etiketten und Beilagen auf Papier und Karton. Präzise Farbabstimmung und Proofs. Jetzt Angebot anfordern.'),
  fr=('impression-emballages','impression d’emballages','Impression d’emballages | PackJoyU','Impression CMJN et Pantone pour emballages, étiquettes et encarts sur papier et carton. Couleurs fidèles et épreuves avant tirage. Demandez un devis.')),
 'offset-printing': dict(
  es=('impresion-offset','impresión offset','Servicios de impresión offset | PackJoyU','Impresión offset en grandes tiradas para cajas, catálogos, folletos y etiquetas. Detalle nítido, color constante y opciones de acabado. Pida presupuesto.'),
  de=('offsetdruck','Offsetdruck','Offsetdruck für Verpackungen | PackJoyU','Offsetdruck in hohen Auflagen für Schachteln, Kataloge, Broschüren und Etiketten. Scharfe Details, konstante Farbe und Veredelung. Jetzt Angebot anfordern.'),
  fr=('impression-offset','impression offset','Impression offset | PackJoyU','Impression offset grands tirages pour boîtes, catalogues, brochures et étiquettes. Détails nets, couleur constante et options de finition. Demandez un devis.')),
 'gift-cards': dict(
  es=('tarjetas-de-felicitacion','tarjetas de felicitación personalizadas','Tarjetas de felicitación personalizadas | PackJoyU','Tarjetas de felicitación impresas a medida con estampado, barniz UV selectivo y relieve. Sobres y embalaje a juego para marcas de retail. Pida presupuesto.'),
  de=('grusskarten','Grußkarten drucken','Individuelle Grußkarten | PackJoyU','Individuell bedruckte Grußkarten mit Folienprägung, partiellem UV-Lack und Prägung. Passende Umschläge und Verpackungen für Marken. Angebot anfordern.'),
  fr=('cartes-de-voeux','cartes de vœux personnalisées','Cartes de vœux personnalisées | PackJoyU','Cartes de vœux imprimées sur mesure avec dorure, vernis UV sélectif et gaufrage. Enveloppes et emballages assortis pour les marques. Demandez un devis.')),
 'christmas-merchandise': dict(
  es=('embalaje-navideno','embalaje navideño personalizado','Embalaje navideño personalizado | PackJoyU','Cajas de regalo navideñas, calendarios de Adviento y embalaje de temporada impresos con su marca. Planifique su campaña con antelación. Pida presupuesto.'),
  de=('weihnachtsverpackungen','Weihnachtsverpackungen individuell','Individuelle Weihnachtsverpackungen | PackJoyU','Weihnachtliche Geschenkboxen, Adventskalender und Saisonverpackungen mit Ihrer Marke. Planen Sie Ihre Saison frühzeitig. Jetzt Angebot anfordern.'),
  fr=('emballages-de-noel','emballages de Noël personnalisés','Emballages de Noël personnalisés | PackJoyU','Coffrets cadeaux de Noël, calendriers de l’Avent et emballages saisonniers imprimés à votre marque. Anticipez votre saison. Demandez un devis.')),
}
BAD = {'es': r'mayorist|al por mayor', 'de': r'gro(ß|ss)handel', 'fr': r'en gros|grossiste'}
CLAIM = r'(?i)\bfsc\b|\biso\b|\beco|öko|écolo|recicl|recycl|biodegr|compost|certif|zertif|fda|aliment|lebensmittel|gratis|gratuit|kostenlos|\d+\s*(días|tage|jours|semanas|wochen|semaines|h\b)|24'
fails = []; rows = []
for k, v in M.items():
    for l, (slug, kw, t, d) in v.items():
        ok_t, ok_d = len(t) <= 60, len(d) <= 160
        if not ok_t: fails.append(f'{k}.{l} title {len(t)}')
        if not ok_d: fails.append(f'{k}.{l} description {len(d)}')
        if re.search(BAD[l], t, re.I): fails.append(f'{k}.{l} title has wholesale')
        if re.search(CLAIM, t + ' ' + d): fails.append(f'{k}.{l} claim word: {re.search(CLAIM, t+" "+d).group(0)}')
        rows.append((k, l, slug, kw, t, len(t), d, len(d)))
if __name__ == '__main__':
    out = ['# categoryMeta es/de/fr — proposal (not wired in)', '',
           'Generated by `.i18n-src/catmeta.py` (lengths verified: title ≤ 60, description ≤ 160, no custom+wholesale in titles, no claim words). Slugs and keywords are **proposals for SEO to decide** (see glossary §4). `eco-paper-cups` has no entry in categoryMeta.ts on main, so 11 categories.',
           'EN/RU sources now also neutral (PM 2026-10-17): color-printing "proofs before the run" (no speed), christmas "Plan your season early". paper-cups "4 to 22 oz" → several sizes in es/de/fr; EN left as is, ⏳ pending Ryan. gift-cards = greeting cards (Ryan).', '',
           '| key | lang | title | len | description | len |', '|---|---|---|---|---|---|']
    out += [f'| {k} | {l} | {t} | {lt} | {d} | {ld} |' for k, l, s, kw, t, lt, d, ld in rows]
    out += ['', '## TS snippet (shape follows current file; adapt after frontend phase 0)', '', '```ts', '// add to each CategoryMeta entry; type: es/de/fr?: { slug; title; description; keyword; draft: true }']
    for k, v in M.items():
        out.append(f"// {k}")
        for l, (slug, kw, t, d) in v.items():
            j = lambda x: "'" + x.replace("\\", "\\\\").replace("'", "\\'") + "'"
            out.append(f"  {l}: {{ slug: {j(slug)}, keyword: {j(kw)}, draft: true,\n    title: {j(t)},\n    description: {j(d)} }},")
    out += ['```', '']
    open('categoryMeta-es-de-fr.md', 'w', encoding='utf-8').write('\n'.join(out))
    print(f'{len(rows)} entries; max title {max(r[5] for r in rows)}, max description {max(r[7] for r in rows)}')
    if fails: print('FAIL'); print('\n'.join(fails)); sys.exit(1)
    print('PASS')
