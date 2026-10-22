#!/usr/bin/env python3
"""Meta length check for messages/<locale>.json.
- keys ending in 'description' / 'metaDescription' under a meta context (Meta.*, *.meta.*, *.metaDescription) : <= 160 chars
- meta titles (Meta.title, *.metaTitle, *.meta.title): <= 60 chars
Placeholders {industry}/{industryGen}/{category}/{name} are expanded with the LONGEST value available in that locale
(Solutions.industries.*.name / industryGen, Products.names.*) so templated metas are checked at worst case.
Usage: check_meta_lengths.py [locale ...]   (default: all messages/*.json). Exit 1 on any failure."""
import json, re, sys, glob, os
DESC_MAX, TITLE_MAX = 160, 60
def flat(o, p=''):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, f'{p}.{k}' if p else k)
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from flat(v, f'{p}[{i}]')
    else: yield p, o
def kind(k):
    last = k.split('.')[-1]; lk = k.lower()
    is_meta = k.startswith('Meta.') or '.meta.' in f'.{lk}' or last in ('metaTitle', 'metaDescription')
    if not is_meta: return None
    if last in ('description', 'metaDescription'): return 'desc'
    if last in ('title', 'metaTitle'): return 'title'
    return None
def check(locale):
    m = dict(flat(json.load(open(f'messages/{locale}.json', encoding='utf-8'))))
    longest = lambda pat: max((v for k, v in m.items() if re.fullmatch(pat, k)), key=len, default='')
    fill = {'industry': longest(r'Solutions\.industries\.[^.]+\.name'), 'industryGen': longest(r'Solutions\.industries\.[^.]+\.industryGen'),
            'category': longest(r'Products\.names\.[^.]+'), 'name': longest(r'Products\.names\.[^.]+')}
    fails, n = [], 0
    for k, v in m.items():
        t = kind(k)
        if not t: continue
        n += 1
        ex = re.sub(r'\{(\w+)\}', lambda mm: fill.get(mm.group(1), mm.group(0)), v)
        lim = DESC_MAX if t == 'desc' else TITLE_MAX
        if len(ex) > lim: fails.append(f'{locale}:{k} {t} {len(ex)} > {lim}' + (' (worst-case placeholder fill)' if ex != v else ''))
    return n, fails
if __name__ == '__main__':
    locs = sys.argv[1:] or sorted(os.path.basename(f)[:-5] for f in glob.glob('messages/*.json'))
    allf = []
    for l in locs:
        n, f = check(l); allf += f
        print(f'{l}: {n} meta strings, {"OK" if not f else f"{len(f)} over limit"}')
    if allf: print('FAIL'); print('\n'.join(allf)); sys.exit(1)
    print(f'PASS: meta descriptions <= {DESC_MAX}, meta titles <= {TITLE_MAX} ({", ".join(locs)})')
