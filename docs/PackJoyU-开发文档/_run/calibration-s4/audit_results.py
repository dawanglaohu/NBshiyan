import collections
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
source = json.loads((ROOT / 'source-rows.json').read_text(encoding='utf-8'))
results = []
for row in source:
    stem = f"{int(row['id'][2:]):02d}"
    state = json.loads((ROOT / f'{stem}.state.json').read_text(encoding='utf-8'))
    response = json.loads((ROOT / f'{stem}.response.json').read_text(encoding='utf-8'))
    log_lines = (ROOT / f'{stem}.jsonl').read_text(encoding='utf-8').splitlines()
    assert len(log_lines) == 1, (stem, len(log_lines))
    log = json.loads(log_lines[0])
    meta = json.loads((ROOT / f'{stem}.meta.json').read_text(encoding='utf-8'))
    expected_hash = hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:16]
    assert response['status'] == 'ok' and not response.get('language_warning'), stem
    assert meta['exit_code'] == 0, stem
    assert log['state_sha256'] == expected_hash, stem
    assert log['model'] == response['model'] and log['verdicts'] == response['verdicts'] and log['usage'] == response['usage'], stem
    assert log['label'] == f'S4-E-{stem}' and log['template'] == 'edge', stem
    assert not re.search(r'[\u3400-\u9fff]', json.dumps(state, ensure_ascii=False)), stem
    assert sum(map(len, state['modules'].values())) <= 900, stem
    v = response['verdicts']
    record = {**row, 'stem': stem, 'model': response['model'], 'state_sha256': expected_hash, 'line': response['line'], 'usage': response['usage'], 'verdicts': v}
    record['high_priority'] = v['severity']['level'] == 'data is lost or corrupted, money moves wrongly, or a permission is bypassed' and v['likelihood']['level'] != 'rare, needs deliberate misuse'
    results.append(record)
summary = {
    'count': len(results),
    'models': sorted(set(x['model'] for x in results)),
    'language_warnings': 0,
    'independent_logs': len(results),
    'hash_matches': len(results),
    'executable_counts': dict(collections.Counter(x['verdicts']['executable']['verdict'] for x in results)),
    'mandatory_rewrite': [x['id'] for x in results if x['verdicts']['executable']['verdict'] == 'no'],
    'unsure': [x['id'] for x in results if x['verdicts']['executable']['verdict'] == 'unsure'],
    'owner_mismatches': [{ 'id': x['id'], 'ledger': x['owner'], 'model': x['verdicts']['owner']['choice'], 'confidence': x['verdicts']['owner']['confidence']} for x in results if x['owner'] != x['verdicts']['owner']['choice']],
    'high_priority': [x['id'] for x in results if x['high_priority']],
    'high_priority_high_confidence': [x['id'] for x in results if x['high_priority'] and x['verdicts']['severity']['band'] == 'high'],
    'usage': {k: sum(x['usage'].get(k, 0) for x in results) for k in ('input_tokens', 'output_tokens')},
}
(ROOT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
