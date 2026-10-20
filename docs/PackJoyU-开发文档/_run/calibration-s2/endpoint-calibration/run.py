import concurrent.futures
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path('D:/xiangmu/NBshiyan-docs-s2-s6')
OUT = Path('D:/xiangmu/.codex-plans/NBshiyan-docs-s2-s6/endpoint-calibration')
HELPER = ROOT / 'docs/PackJoyU-开发文档/_run/typesafe_ask.py'
manifest = json.loads((OUT / 'manifest.json').read_text(encoding='utf-8'))

def run(item):
    number = f'{item["index"]:02d}'
    cmd = [sys.executable, str(HELPER), '--log', str(OUT / item['log']), '--label', 'S2 endpoint ' + number + ' ' + item['method'] + ' ' + item['path'], 'run', 'endpoint', '--state', str(OUT / item['state'])]
    completed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180)
    (OUT / item['stdout']).write_text(completed.stdout, encoding='utf-8')
    (OUT / f'{number}.stderr.txt').write_text(completed.stderr, encoding='utf-8')
    data = json.loads(completed.stdout)
    summary = {'index': item['index'], 'method': item['method'], 'path': item['path'], 'exit_code': completed.returncode, 'status': data.get('status'), 'model': data.get('model'), 'line': data.get('line'), 'verdicts': data.get('verdicts'), 'language_warning': data.get('language_warning')}
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return summary

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for result in pool.map(run, manifest['endpoints']):
        results.append(result)
(OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'done': len(results), 'ok': sum(row['status'] == 'ok' for row in results), 'language_warnings': sum(bool(row['language_warning']) for row in results)}), flush=True)
