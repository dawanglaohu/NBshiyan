#!/usr/bin/env python3
"""Build Sanity NDJSON from docs/content markdown (Refs #99).
Usage: python3 docs/content/sanity-import/build.py [content_dir]
Matches sanity/schemas/index.ts: product / article docs with {en,ru} locale objects.
Portable Text subset matches src/lib/server/portableText.ts (normal/h2/h3/blockquote, bullet/number, strong/em).
Links have no mark in that subset, so markdown links become plain text."""
import json, re, sys, hashlib, pathlib
ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[1])
OUT = pathlib.Path(__file__).resolve().parent / 'import.ndjson'
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

LINKS = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'internal-links.json').read_text())['links']
HEAD = {'category→category': {'en': 'Related products', 'ru': 'Похожие товары'},
        'category→article': {'en': 'Further reading', 'ru': 'Полезные статьи'}}
def related_md(url, loc):
    md = []
    for kind in ('category→category', 'category→article'):
        ls = [x for x in LINKS if x['from'] == url and x['kind'] == kind]
        if ls: md += [f'## {HEAD[kind][loc]}'] + [f"- [{x['anchor'][:1].upper() + x['anchor'][1:]}]({x['to']})" for x in ls]
    return '\n'.join(md)

docs = []
for f in sorted(ROOT.glob('*.md')):
    if f.name in ('README.md', 'industries.md'): continue
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

arts = {}
for f in sorted((ROOT / 'articles').glob('*.md')):
    fm, body = front(f.read_text())
    loc = fm.get('locale', 'en')
    group = fm.get('en_version') or fm['slug']
    arts.setdefault(group, {})[loc] = (fm, body)
for group, langs in sorted(arts.items()):
    d = {'_id': f'article-{group}', '_type': 'article', 'title': {}, 'slug': {}, 'excerpt': {}, 'body': {},
         'seo': {'title': {}, 'description': {}, 'noindex': True}}
    for loc, (fm, body) in langs.items():
        d['title'][loc] = fm['title']
        d['slug'][loc] = {'_type': 'slug', 'current': fm['slug']}
        d['excerpt'][loc] = fm['meta_description']
        d['body'][loc] = blocks(body, f'{group}-{loc}')
        d['seo']['title'][loc] = fm['title']
        d['seo']['description'][loc] = fm['meta_description']
    docs.append(d)

OUT.write_text(''.join(json.dumps(d, ensure_ascii=False) + '\n' for d in docs))
print(f'wrote {len(docs)} docs -> {OUT}')
