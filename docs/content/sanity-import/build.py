#!/usr/bin/env python3
"""Build Sanity NDJSON from docs/content markdown (Refs #99).
Usage: python3 docs/content/sanity-import/build.py [content_dir]
Matches sanity/schemas/index.ts: product / article docs with {en,ru} locale objects.
Portable Text subset matches src/lib/server/portableText.ts (normal/h2/h3/blockquote, bullet/number, strong/em).
Links have no mark in that subset, so markdown links become plain text.

Usage: build.py [content_dir] [--out PATH]
Product docs come from the #188 landing sources (docs/content/custom-*.md etc.). On a branch without them
(e.g. #205 before #188 is merged) the product lines already committed in import.ndjson are kept verbatim
instead of being dropped; only the articles are regenerated. tests/sanity-import.test.ts checks that a
rebuild reproduces the committed file byte for byte."""
import json, re, sys, hashlib, pathlib
_args = sys.argv[1:]
_out = None
if '--out' in _args:
    i = _args.index('--out'); _out = _args[i + 1]; del _args[i:i + 2]
_links = None
if '--links' in _args:
    i = _args.index('--links'); _links = _args[i + 1]; del _args[i:i + 2]
ROOT = pathlib.Path(_args[0] if _args else pathlib.Path(__file__).resolve().parents[1])
COMMITTED = pathlib.Path(__file__).resolve().parent / 'import.ndjson'
OUT = pathlib.Path(_out) if _out else COMMITTED
META_TS = pathlib.Path(__file__).resolve().parents[3] / 'src/lib/seo/categoryMeta.ts'

def key(*p): return hashlib.sha1('|'.join(p).encode()).hexdigest()[:12]

SAFE_HREF = re.compile(r'^/(en|ru)/[a-z0-9/-]*$')

def spans(text, k, defs):
    """Inline markdown -> spans. **bold** -> strong; [t](/en/..|/ru/..) -> link markDef.
    Any other href (external, relative without locale) is dropped to plain text."""
    text = text.replace('`', '')
    out = []
    tok = re.compile(r'\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)')
    pos, i = 0, 0
    def add(t, marks):
        nonlocal i
        if t: out.append({'_type': 'span', '_key': key(k, str(i)), 'text': t, 'marks': marks}); i += 1
    for m in tok.finditer(text):
        add(text[pos:m.start()], [])
        if m.group(1) is not None:
            add(m.group(1), ['strong'])
        else:
            href = m.group(3).strip()
            if SAFE_HREF.match(href):
                dk = key(k, 'link', href, str(len(defs)))
                defs.append({'_type': 'link', '_key': dk, 'href': href})
                add(m.group(2), [dk])
            else:
                add(m.group(2), [])
        pos = m.end()
    add(text[pos:], [])
    return out

def blocks(md, ns):
    res = []
    for n, raw in enumerate(md.splitlines()):
        line = raw.strip()
        if not line or line.startswith('---') or re.match(r'^\|[-| ]+\|$', line) or line.startswith('**CTA'): continue
        style, li = 'normal', None
        if line.startswith('> '): continue  # editorial notes (e.g. 校对 flags) stay out of published body
        if m := re.match(r'^#{4,} (.*)', line): style, line = 'h3', m.group(1)
        elif m := re.match(r'^### (.*)', line): style, line = 'h3', m.group(1)
        elif m := re.match(r'^## (.*)', line): style, line = 'h2', m.group(1)
        elif line.startswith('# '): continue
        elif m := re.match(r'^[-*] (.*)', line): li, line = 'bullet', m.group(1)
        elif m := re.match(r'^\d+\. (.*)', line): li, line = 'number', m.group(1)
        elif line.startswith('|'):
            cells = [c.strip() for c in line.strip('|').split('|')]
            if cells[0] in ('Option', 'Параметр'): continue
            li, line = 'bullet', f'**{cells[0]}:** {cells[1]}'
        k = key(ns, str(n))
        defs = []
        b = {'_type': 'block', '_key': k, 'style': style, 'markDefs': defs, 'children': spans(line, k, defs)}
        if li: b.update(listItem=li, level=1)
        res.append(b)
    return res

def front(md):
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', md, re.S)
    fm = dict(re.findall(r'^(\w+): "?(.*?)"?$', m.group(1), re.M))
    return fm, m.group(2)

def first_para(body):
    for p in re.split(r'\n\s*\n', body):
        p = p.strip()
        if p and not p.startswith(('#', '>', '-', '|')): return re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', p)
    return ''

def drop_first_para(body, para):
    return body.replace(para, '', 1) if para else body

def section(md, start, end):
    s = md.index(start); e = md.index(end, s + 1) if end else len(md)
    return md[s + len(start):e]

meta = META_TS.read_text()
def cat_meta(k):
    b = meta.split(f"key: '{k}'")[1].split('{ key:')[0]
    en, ru = b.split('ru: {')
    g = lambda s, f: re.search(f + r": '([^']*)'", s).group(1)
    return {l: {f: g(s, f) for f in ('slug', 'title', 'description')} for l, s in (('en', en), ('ru', ru))}

LINKS = json.loads(pathlib.Path(_links or pathlib.Path(__file__).resolve().parent.parent / 'internal-links.json').read_text())['links']
HEAD = {'category→category': {'en': 'Related products', 'ru': 'Похожие товары'},
        'category→article': {'en': 'Further reading', 'ru': 'Полезные статьи'}}
def related_md(url, loc):
    md = []
    for kind in ('category→category', 'category→article'):
        ls = [x for x in LINKS if x['from'] == url and x['kind'] == kind]
        if ls: md += [f'## {HEAD[kind][loc]}'] + [f"- [{x['anchor'][:1].upper() + x['anchor'][1:]}]({x['to']})" for x in ls]
    return '\n'.join(md)

# Landing sources are the #188 files that carry an internal key; other docs (FAQ drafts, proofreading, fact sheet) are skipped.
LANDING = [f for f in sorted(ROOT.glob('*.md')) if f.name not in ('README.md', 'industries.md', 'internal-links.md') and '内部 key `' in f.read_text()]
kept_products = []
if not LANDING:
    # #188 landing sources not on this branch: keep the committed product lines as they are (no data invented, none dropped)
    if COMMITTED.exists():
        kept_products = [l for l in COMMITTED.read_text().splitlines(keepends=True) if json.loads(l).get('_type') == 'product']
    # Their trailing "Related products"/"Further reading" sections are rebuilt from internal-links.json, so links to
    # articles that are not importable (import: false / missing) drop out and come back with linkmap.py. The section
    # start line is recovered from the committed block key, so an unchanged link map reproduces the line byte for byte.
    def relink(line):
        d = json.loads(line)
        for loc, body in d['body'].items():
            ns = f"{d['category']}-{loc}"
            i = next(j for j, b in enumerate(body) if b['style'] == 'h2' and b['children'][0]['text'] == HEAD['category→category'][loc])
            n0 = next(n for n in range(10000) if key(ns, str(n)) == body[i]['_key'])
            body[i:] = blocks('\n' * n0 + related_md(f"/{loc}/products/{d['slug'][loc]['current']}", loc), ns)
        return json.dumps(d, ensure_ascii=False) + '\n'
    kept_products = [relink(l) for l in kept_products]
    print(f'warning: no landing sources in {ROOT}; keeping {len(kept_products)} committed product docs (link sections rebuilt from internal-links.json)', file=sys.stderr)

docs = []
for f in LANDING:
    md = f.read_text()
    k = re.search(r'内部 key `([^`]+)`', md).group(1)
    cm = cat_meta(k)
    d = {'_id': f'product-{k}', '_type': 'product', 'category': k,
         'title': {}, 'slug': {}, 'excerpt': {}, 'body': {},
         'seo': {'title': {}, 'description': {}, 'noindex': True}}
    for loc, start, end in (('en', '## EN — Landing copy', '### FAQ'), ('ru', '## RU — Текст посадочной страницы', '### FAQ')):
        sec = section(md, start, end)
        h1 = re.search(r'^### H1: (.*)$', sec, re.M).group(1)
        sec = sec.replace(re.search(r'^### H1: .*$', sec, re.M).group(0), '')
        intro = first_para(sec)
        d['title'][loc] = h1
        d['slug'][loc] = {'_type': 'slug', 'current': cm[loc]['slug']}
        d['excerpt'][loc] = intro
        url = f"/{loc}/products/{cm[loc]['slug']}"
        d['body'][loc] = blocks(drop_first_para(sec, intro) + '\n' + related_md(url, loc), f'{k}-{loc}')
        d['seo']['title'][loc] = cm[loc]['title']
        d['seo']['description'][loc] = cm[loc]['description']
    docs.append(d)

# Guard: an importable article must not carry unconfirmed facts in its published body.
# Same lines blocks() publishes: front matter and '> ' editorial notes are not checked.
UNCONFIRMED = re.compile(r'\{\{待Ryan确认\}\}|\bTBD\b')

# Guard: product docs (everything that lands in import.ndjson) must not carry them either: no lead time, MOQ or
# other unconfirmed fact goes live as TBD. Landing sources are checked per file line (only the EN/RU landing
# sections that blocks() publishes, '> ' notes skipped); kept product lines per import.ndjson line and field.
def product_refusals():
    bad = []
    for f in LANDING:
        lines = f.read_text().splitlines()
        on = False
        for n, raw in enumerate(lines, 1):
            if raw.startswith(('## EN — Landing copy', '## RU — Текст посадочной страницы')): on = True; continue
            if raw.startswith('### FAQ'): on = False
            if on and not raw.strip().startswith('>') and UNCONFIRMED.search(raw): bad.append(f'{f}:{n}: {raw.strip()}')
    for n, l in enumerate(kept_products, 1):
        d = json.loads(l)
        fields = [(f'{f}.{loc}', v) for f in ('title', 'excerpt') for loc, v in d.get(f, {}).items()]
        fields += [(f'seo.{f}.{loc}', v) for f in ('title', 'description') for loc, v in d.get('seo', {}).get(f, {}).items()]
        fields += [(f'body.{loc}[{i}]', ''.join(c.get('text', '') for c in b.get('children', [])))
                   for loc, body in d.get('body', {}).items() for i, b in enumerate(body)]
        bad += [f'{COMMITTED.name}:{n}: {d["_id"]} {where}: {v}' for where, v in fields if UNCONFIRMED.search(v)]
    for d in docs:
        if d['_type'] != 'product': continue
        for loc, v in [*d['title'].items(), *d['excerpt'].items(), *d['seo']['title'].items(), *d['seo']['description'].items()]:
            if UNCONFIRMED.search(v): bad.append(f'{d["_id"]} ({loc}): {v}')
    return bad
_prod_bad = product_refusals()
if _prod_bad:
    print('error: refusing import, product body has {{待Ryan确认}} or TBD (replace with neutral wording, no time or number):', file=sys.stderr)
    print('\n'.join(_prod_bad), file=sys.stderr)
    sys.exit(1)
def unconfirmed_lines(text):
    head = re.match(r'^---\n.*?\n---\n', text, re.S)
    offset = head.group(0).count('\n') if head else 0
    body = text[head.end():] if head else text
    return [(offset + n + 1, raw.strip()) for n, raw in enumerate(body.splitlines())
            if not raw.strip().startswith('>') and UNCONFIRMED.search(raw)]

arts = {}
refused = []
for f in sorted((ROOT / 'articles').glob('*.md')):
    text = f.read_text()
    fm, body = front(text)
    if fm.get('import') == 'false': continue  # drafts with open {{待Ryan确认}} facts stay out of Sanity until filled
    refused += [f'{f}:{n}: {line}' for n, line in unconfirmed_lines(text)]
    loc = fm.get('locale', 'en')
    group = fm.get('en_version') or fm['slug']
    arts.setdefault(group, {})[loc] = (fm, body)
if refused:
    print('error: refusing import, article body has {{待Ryan确认}} or TBD (fill it in or set import: false):', file=sys.stderr)
    print('\n'.join(refused), file=sys.stderr)
    sys.exit(1)
for group, langs in sorted(arts.items()):
    d = {'_id': f'article-{group}', '_type': 'article', 'title': {}, 'slug': {}, 'excerpt': {}, 'body': {},
         'seo': {'title': {}, 'description': {}, 'noindex': True}}
    for loc, (fm, body) in langs.items():
        d['title'][loc] = fm['title']
        d['slug'][loc] = {'_type': 'slug', 'current': fm['slug']}
        d['excerpt'][loc] = fm['meta_description']
        d['body'][loc] = blocks(body, f'{group}-{loc}')
        d['seo']['title'][loc] = fm.get('seo_title') or fm['title']  # ≤60 字符的 SEO 标题；H1 仍用 title
        d['seo']['description'][loc] = fm['meta_description']
    docs.append(d)

OUT.write_text(''.join(kept_products) + ''.join(json.dumps(d, ensure_ascii=False) + '\n' for d in docs))
print(f'wrote {len(kept_products) + len(docs)} docs ({len(kept_products)} kept) -> {OUT}')
