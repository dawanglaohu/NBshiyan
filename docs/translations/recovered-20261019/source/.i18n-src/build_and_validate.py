#!/usr/bin/env python3
"""Build messages/{es,de,fr}.json from .i18n-src/t*.txt and validate against messages/en.json."""
import json, re, sys, glob, collections
LANGS = ['es', 'de', 'fr']
en = json.load(open('messages/en.json'), object_pairs_hook=collections.OrderedDict)

def flat(o, p=''):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, f'{p}.{k}' if p else k)
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from flat(v, f'{p}[{i}]')
    else: yield p, o

tr = {}
for f in sorted(glob.glob('.i18n-src/t*.txt')):
    for ln, line in enumerate(open(f, encoding='utf-8'), 1):
        if not line.strip(): continue
        parts = [x.strip() for x in line.rstrip('\n').split('|||')]
        if len(parts) != 4: sys.exit(f'{f}:{ln} bad column count {len(parts)}')
        if parts[0] in tr: sys.exit(f'duplicate key {parts[0]}')
        tr[parts[0]] = dict(zip(LANGS, parts[1:]))

def build(o, p, lang):
    if isinstance(o, dict): return collections.OrderedDict((k, build(v, f'{p}.{k}' if p else k, lang)) for k, v in o.items())
    if isinstance(o, list): return [build(v, f'{p}[{i}]', lang) for i, v in enumerate(o)]
    return tr[p][lang] if p in tr else None

PH = re.compile(r'\{\{[^}]*\}\}|\{[A-Za-z_][A-Za-z0-9_]*\}|</?[a-z]+>')
enflat = dict(flat(en))
errors = []
missing = [k for k in enflat if k not in tr]; extra = [k for k in tr if k not in enflat]
if missing: errors.append(f'missing translations: {missing}')
if extra: errors.append(f'unknown keys: {extra}')
if not errors:
    for lang in LANGS:
        out = build(en, '', lang)
        with open(f'messages/{lang}.json', 'w', encoding='utf-8') as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2); fh.write('\n')
# validate written files independently
for lang in LANGS:
    try: m = json.load(open(f'messages/{lang}.json', encoding='utf-8'))
    except Exception as e: errors.append(f'{lang}: {e}'); continue
    mf = dict(flat(m))
    if list(mf) != list(enflat): errors.append(f'{lang}: key set/order differs (missing {set(enflat)-set(mf)}, extra {set(mf)-set(enflat)})')
    for k, v in enflat.items():
        t = mf.get(k)
        if not isinstance(t, str) or not t.strip(): errors.append(f'{lang}:{k} empty'); continue
        if collections.Counter(PH.findall(v)) != collections.Counter(PH.findall(t)):
            errors.append(f'{lang}:{k} placeholders {PH.findall(v)} vs {PH.findall(t)}')
    print(f'{lang}: {len(mf)} leaf strings, placeholders checked')
print(f'en: {len(enflat)} leaf strings, {sum(1 for v in enflat.values() if PH.search(v))} with placeholders')

# meta length check (<=160 descriptions, <=60 titles)
sys.path.insert(0, '.i18n-src')
from check_meta_lengths import check as _lencheck
for _l in LANGS:
    _n, _f = _lencheck(_l)
    errors += _f
    print(f'{_l}: {_n} meta strings length-checked')
if errors: print('FAIL'); print('\n'.join(errors)); sys.exit(1)
print('PASS: es/de/fr key sets, order and ICU/tag/{{}} placeholders identical to en.json')
