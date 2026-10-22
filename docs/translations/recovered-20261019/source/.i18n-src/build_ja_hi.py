#!/usr/bin/env python3
"""Build messages/<langs>.json from .i18n-src/<dir>/a*.txt (usage: build_ja_hi.py [ar]; default ja/hi) and validate against messages/en.json
(key set + order, ICU {x} / {{x}} / <tag> placeholders, script check, claim-word scan)."""
import json, re, sys, glob, collections
# messages/{ja,hi,ar}.json were replaced by independently reviewed versions (2026-10-17): validate only.
# Rebuilding from .i18n-src/ sources would regress them, so writing requires an explicit --write.
WRITE = '--write' in sys.argv
args = [a for a in sys.argv[1:] if a != '--write']
LANGS, SRC = (['ar'], 'ar') if args == ['ar'] else (['ja', 'hi'], 'jahi')
en = json.load(open('messages/en.json'), object_pairs_hook=collections.OrderedDict)
def flat(o, p=''):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, f'{p}.{k}' if p else k)
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from flat(v, f'{p}[{i}]')
    else: yield p, o
tr = {}
for f in sorted(glob.glob(f'.i18n-src/{SRC}/a*.txt')):
    for ln, line in enumerate(open(f, encoding='utf-8'), 1):
        if not line.strip(): continue
        parts = [x.strip() for x in line.rstrip('\n').split('|||')]
        if len(parts) != len(LANGS) + 1: sys.exit(f'{f}:{ln} bad column count {len(parts)}')
        if parts[0] in tr: sys.exit(f'duplicate key {parts[0]}')
        tr[parts[0]] = dict(zip(LANGS, parts[1:]))
def build(o, p, lang):
    if isinstance(o, dict): return collections.OrderedDict((k, build(v, f'{p}.{k}' if p else k, lang)) for k, v in o.items())
    if isinstance(o, list): return [build(v, f'{p}[{i}]', lang) for i, v in enumerate(o)]
    return tr[p][lang]
PH = re.compile(r'\{\{[^}]*\}\}|\{[A-Za-z_][A-Za-z0-9_]*\}|</?[a-z]+>')
SCRIPT = {'ar': re.compile(r'[\u0600-\u06ff]'), 'ja': re.compile(r'[\u3040-\u30ff\u4e00-\u9fff]'), 'hi': re.compile(r'[\u0900-\u097f]')}
CLAIM = re.compile(r'(?i)\bfsc\b|\biso\b|\bfda\b|\beco|recycl|biodegr|compost|certif|food.?grade|24\s*h|エコ|環境に優しい|リサイクル|生分解|堆肥|認証|食品グレード|無料|इको|रीसायकल|रिसाइकल|बायोडिग्रेड|कम्पोस्ट|सर्टिफ़ाइड|प्रमाणित|फ़ूड-ग्रेड|मुफ़्त|निःशुल्क|صديق للبيئة|صديقة للبيئة|قابل لإعادة التدوير|قابلة لإعادة التدوير|قابل للتحلل|قابلة للتحلل|معتمد من|معتمدة من|حاصل على شهادة|حاصلة على شهادة|آمن للأغذية|مجاني|مجانًا')
enflat = dict(flat(en)); errors = []; warn = []
missing = [k for k in enflat if k not in tr]; extra = [k for k in tr if k not in enflat]
if WRITE and missing: errors.append(f'missing: {missing}')
if WRITE and extra: errors.append(f'unknown: {extra}')
if WRITE and not errors:
    for lang in LANGS:
        with open(f'messages/{lang}.json', 'w', encoding='utf-8') as fh:
            json.dump(build(en, '', lang), fh, ensure_ascii=False, indent=2); fh.write('\n')
for lang in LANGS:
    mf = dict(flat(json.load(open(f'messages/{lang}.json', encoding='utf-8'))))
    if list(mf) != list(enflat): errors.append(f'{lang}: key set/order differs')
    for k, v in enflat.items():
        t = mf.get(k)
        if not isinstance(t, str) or not t.strip(): errors.append(f'{lang}:{k} empty'); continue
        if collections.Counter(PH.findall(v)) != collections.Counter(PH.findall(t)): errors.append(f'{lang}:{k} placeholders {PH.findall(v)} vs {PH.findall(t)}')
        if not SCRIPT[lang].search(t) and t != v: warn.append(f'{lang}:{k} no {lang} script: {t}')
        if t == v and len(v) > 4: warn.append(f'{lang}:{k} identical to EN: {t}')
        m = CLAIM.search(t)
        if m and not CLAIM.search(v): errors.append(f'{lang}:{k} claim word "{m.group(0)}" not in EN')
    print(f'{lang}: {len(mf)} leaf strings, placeholders checked')
print(f'en: {len(enflat)} leaf strings, {sum(1 for v in enflat.values() if PH.search(v))} with placeholders')
if warn: print('NOTE (review, not failures):'); print('\n'.join('  ' + w for w in warn))

# meta length check (<=160 descriptions, <=60 titles)
sys.path.insert(0, '.i18n-src')
from check_meta_lengths import check as _lencheck
for _l in LANGS:
    _n, _f = _lencheck(_l)
    errors += _f
    print(f'{_l}: {_n} meta strings length-checked')
if errors: print('FAIL'); print('\n'.join(errors)); sys.exit(1)
print(f'PASS: {"/".join(LANGS)} key sets, order and ICU/tag/{{{{}}}} placeholders identical to en.json; no new claim words')
