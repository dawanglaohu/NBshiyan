import concurrent.futures
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HELPER = Path('D:/xiangmu/NBshiyan-docs-s2-s6/docs/PackJoyU-开发文档/_run/typesafe_ask.py')

def run_one(number):
    stem = f'{number:02d}'
    response_path = ROOT / f'{stem}.response.json'
    if response_path.exists():
        previous = json.loads(response_path.read_text(encoding='utf-8-sig'))
        if previous.get('status') == 'ok' and not previous.get('language_warning'):
            return {'number': number, 'status': 'already_saved', 'line': previous.get('line')}
        raise RuntimeError(f'{stem}: existing unsuccessful response must be inspected before retrying')
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    command = [sys.executable, str(HELPER), '--log', str(ROOT / f'{stem}.jsonl'), '--label', f'S4-E-{stem}', 'run', 'edge', '--state', str(ROOT / f'{stem}.state.json')]
    child_env = dict(os.environ)
    child_env['PYTHONIOENCODING'] = 'utf-8'
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=child_env)
    (ROOT / f'{stem}.stdout.txt').write_text(result.stdout, encoding='utf-8')
    (ROOT / f'{stem}.stderr.txt').write_text(result.stderr, encoding='utf-8')
    (ROOT / f'{stem}.meta.json').write_text(json.dumps({'started': started, 'finished': dt.datetime.now(dt.timezone.utc).isoformat(), 'exit_code': result.returncode, 'command': command}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    parsed = json.loads(result.stdout)
    response_path.write_text(result.stdout, encoding='utf-8')
    return {'number': number, 'exit_code': result.returncode, 'status': parsed.get('status'), 'language_warning': parsed.get('language_warning'), 'line': parsed.get('line')}

first, last = [int(x) for x in sys.argv[1:3]] if len(sys.argv) >= 3 else (1, 104)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    pending = {pool.submit(run_one, n): n for n in range(first, last + 1)}
    for future in concurrent.futures.as_completed(pending):
        try:
            print(json.dumps(future.result(), ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'number': pending[future], 'runner_error': str(error)}, ensure_ascii=False), flush=True)
