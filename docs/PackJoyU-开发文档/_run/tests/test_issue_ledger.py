"""10/24 遗留 issue 覆盖层：不进入原批次，状态按登记显示。"""
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_docs


ROOT = Path(__file__).resolve().parents[2]
WANT = {
    'FE-347': 'todo',
    'FE-378': 'hold',
    'SEO-1': 'done',
    'SEO-2': 'done',
    'SEO-3': 'hold',
    'SEO-4': 'hold',
    'SEO-5': 'done',
    'SEO-6': 'done',
    'SEO-7': 'done',
    'CITY-STILL-WEBP': 'done',
    'BE-I18N-P0': 'done',
    'BE-RESET-TTY': 'done',
    'BE-RESET-STDIN-TTY': 'done',
    'BE-RATELIMIT-P3': 'done',
    'BE-350A': 'done',
    'BE-350B': 'ops',
    'DEP-AUDIT-1': 'done',
    'DEPLOY-FIX-1': 'done',
    'DOCKER-UPLOADS-1': 'done',
    'GATE-PATHS-1': 'done',
    'GATE-PATHS-2': 'done',
    'GATE-HARDEN': 'merging',
    'GATE-HARDEN-2': 'todo',
    'POST-LAUNCH-P3': 'todo',
    'FE-404-TITLE': 'todo',
}
MERGED = {
    'DEP-AUDIT-1': '950b63c235a3ce945fa6140dedf0bfad7a946bc3',
    'DEPLOY-FIX-1': '40b2eb5c52361ac57390530c7347498e3b2e07b1',
    'DOCKER-UPLOADS-1': '0b71952e7c0e15b2cc5cc0549167561e57789fc5',
    'GATE-PATHS-1': '78f535ec43e68cb6619a012270f878fdf4e3b954',
    'GATE-PATHS-2': 'c8ebb9c6d3bf3fe230aae757bf187bfaef3c6d5c',
    'SEO-1': '55a5a7111c81d3938b0528c5567b3b50c878f0d7',
    'SEO-2': '6161329671e6e03e47f387643c3772633e2ce673',
    'SEO-6': '151724cb74ae876c97d6297b169dc7ce49590af9',
    'SEO-7': '55a5a7111c81d3938b0528c5567b3b50c878f0d7',
    'CITY-STILL-WEBP': '369c2e90a2ea92096896e0126f579d61bfe553ea',
    'BE-I18N-P0': 'a761b058de8bc45c87d19207a411b1cfc204ab82',
    'BE-RESET-TTY': 'e12d00e7e384316854e4e04584a57dfcf4108a53',
    'BE-RESET-STDIN-TTY': '926a34b7041e51ad25d9425a62b1b06e7dbdd680',
    'BE-RATELIMIT-P3': '3c45e699c41c0e0c01efbba5f4d2e58746193944',
    'BE-350A': '009860c2f28c51f01a1e710f8f5b823b04f20de9',
    'SEO-5': '466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd',
}


class IssueLedgerTests(unittest.TestCase):
    def test_overlay_does_not_change_original_batch_membership(self):
        tasks = [
            {'id': 'M1-T1', 'deps': []},
            {'id': 'SEO-2', 'deps': [], 'issue': True},
        ]
        self.assertEqual(build_docs.unwrapped_batches(
            tasks, {'M1-T1': 'done', 'SEO-2': 'todo'}, {}), [(1, ['M1-T1'])])

    def test_status_words_cover_ledger_states(self):
        self.assertEqual(build_docs.note_status('---\nid: X\nstatus: hold\n---\n'), ('X', 'hold'))
        self.assertEqual(build_docs.note_status('---\nid: X\nstatus: merging\n---\n'), ('X', 'merging'))
        self.assertEqual(build_docs.note_status('---\nid: X\nstatus: ops\n---\n'), ('X', 'ops'))
        self.assertEqual(build_docs.note_status('---\nid: X\nstatus: doing\n---\n'), ('X', 'doing'))

    def test_bad_fence_is_rejected(self):
        with self.assertRaises(ValueError):
            build_docs.parse_issue_tasks('```issue\nid: SEO-9\n```\n', 'fixture')

    def test_unclosed_issue_fence_names_file_and_line(self):
        text = 'intro\n```issue\nid: SEO-9\nstatus: todo\n'
        with self.assertRaises(ValueError) as caught:
            build_docs.parse_issue_tasks(text, '遗留issue-20261024.md')
        message = str(caught.exception)
        self.assertIn('遗留issue-20261024.md:2', message)
        self.assertIn('未闭合', message)

    def test_unclosed_fence_after_a_closed_one_is_rejected(self):
        text = '```issue\nid: SEO-9\n```\n```issue\nid: SEO-8\n'
        with self.assertRaises(ValueError) as caught:
            build_docs.parse_issue_tasks(text, 'ledger.md')
        self.assertIn('ledger.md:4', str(caught.exception))
        self.assertIn('未闭合', str(caught.exception))

    def test_second_issue_opener_before_close_is_rejected(self):
        text = '```issue\nid: SEO-9\n```issue\nid: SEO-8\n```\n'
        with self.assertRaises(ValueError) as caught:
            build_docs.parse_issue_tasks(text, 'ledger.md')
        message = str(caught.exception)
        self.assertIn('ledger.md:3', message)
        self.assertIn('从第 1 行开始', message)

    def test_real_ledger_keeps_batch_three_clean(self):
        groups, by_num = build_docs.collect(str(ROOT))
        self.assertTrue(groups)
        data = build_docs.extract(by_num)
        original = [dict(t) for t in data['tasks']]
        before = build_docs.task_layers(original)
        records = build_docs.read_batch_records(str(ROOT))
        build_docs.inject_repair_tasks(data, records)
        issues, contracts = build_docs.inject_issue_tasks(data, ROOT)
        self.assertEqual([t['id'] for t in issues], list(WANT))
        self.assertEqual({t['id']: t['ledgerStatus'] for t in issues}, WANT)
        base = [t for t in data['tasks'] if not t.get('issue') and not t.get('repair')]
        self.assertEqual([t['id'] for t in base], [t['id'] for t in original])
        self.assertEqual(build_docs.task_layers(base), before)
        for task in issues:
            self.assertTrue(task['issue'])
            self.assertIn(task['id'], contracts)
            self.assertTrue(contracts[task['id']]['supportPaths'])
        by_id = {t['id']: t for t in issues}
        self.assertEqual(by_id['FE-378']['gh'], '待开')
        self.assertEqual(by_id['GATE-HARDEN-2']['gh'], '待开')
        self.assertEqual(by_id['FE-378']['deps'], ['BE-350A'])
        self.assertEqual(by_id['BE-350A']['deps'], ['SEO-1'])
        self.assertEqual(by_id['GATE-HARDEN-2']['deps'], ['GATE-HARDEN'])
        self.assertNotIn('PublishedLocaleSchema', by_id['BE-I18N-P0']['output'])
        self.assertIn('不发布任何新语言', by_id['BE-I18N-P0']['output'])
        self.assertIn('400', by_id['BE-I18N-P0']['output'])
        for path in ('design/emails/inquiry-ack.es.html', 'design/emails/inquiry-ack.de.txt',
                     'design/emails/inquiry-ack.fr.html', 'src/lib/server/email/templates.generated.ts',
                     'src/lib/server/specs.ts'):
            self.assertIn(path, by_id['BE-I18N-P0']['paths'])
        self.assertEqual(by_id['BE-RESET-TTY']['review'], 'fullstack')
        self.assertIn('aboutLanguages()', by_id['SEO-1']['accept'])
        self.assertIn('只发布一种语言时不输出 x-default', by_id['SEO-1']['accept'])
        self.assertNotIn('x-default 在 en 发布时指向 en', by_id['SEO-1']['accept'])
        self.assertIn('AboutSettings.tsx', by_id['FE-378']['note'])
        self.assertIn('GATE-HARDEN', by_id['FE-378']['note'])
        self.assertIn('全栈安全审查', by_id['FE-378']['note'])
        self.assertEqual(by_id['SEO-6']['gh'], '444')
        self.assertEqual(by_id['SEO-6']['ledgerStatus'], 'done')
        self.assertIn('151724cb74ae876c97d6297b169dc7ce49590af9', by_id['SEO-6']['note'])
        self.assertEqual(by_id['SEO-2']['ledgerStatus'], 'done')
        self.assertEqual(by_id['BE-I18N-P0']['ledgerStatus'], 'done')
        self.assertEqual(by_id['SEO-5']['pr'], '456')
        self.assertEqual(by_id['SEO-5']['ledgerStatus'], 'done')
        self.assertIn('466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd', by_id['SEO-5']['note'])
        self.assertIn('069412f0', by_id['SEO-5']['note'])
        self.assertNotIn('尚未合入', by_id['SEO-5']['note'])
        self.assertNotIn('已派发/PR 审查中', by_id['SEO-5']['note'])
        self.assertNotIn('2026-10-25', by_id['SEO-5']['note'])
        self.assertIn('e2e/not-found-robots.spec.ts', by_id['SEO-5']['paths'])
        self.assertIn('原始 HTML 里只有 1 条 robots', by_id['SEO-5']['accept'])
        self.assertIn('不含独立的 index 或 follow', by_id['SEO-5']['accept'])
        self.assertNotIn('noindex, follow', by_id['SEO-5']['accept'])
        self.assertIn('3c45e699', by_id['FE-378']['note'])
        self.assertIn('Cloudflare 边缘缓存', by_id['FE-378']['note'])
        self.assertIn('Cloudflare 边缘缓存', by_id['FE-378']['accept'])
        self.assertIn('Ryan', by_id['FE-378']['note'])
        self.assertIn('GATE-HARDEN（#438）合入', by_id['FE-378']['accept'])
        self.assertIn('issue #433', by_id['BE-350A']['note'])
        self.assertIn('firstLine', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('不列入剩余工作', by_id['POST-LAUNCH-P3']['note'])
        self.assertEqual(by_id['POST-LAUNCH-P3']['review'], 'fullstack')
        self.assertEqual(by_id['BE-RESET-STDIN-TTY']['gh'], '无')
        self.assertIn('2026-10-24', by_id['BE-RESET-TTY']['note'])
        self.assertNotIn('2026-10-25', by_id['BE-RESET-TTY']['note'])
        self.assertIn('2026-10-24', by_id['BE-RESET-STDIN-TTY']['accept'])
        self.assertNotIn('2026-10-25', by_id['BE-RESET-STDIN-TTY']['accept'])
        self.assertIn('没有单独的 GitHub issue', by_id['BE-RESET-STDIN-TTY']['accept'])
        self.assertIn('剩余 P3 见 POST-LAUNCH-P3', by_id['BE-RATELIMIT-P3']['note'])
        self.assertIn('VERCEL_ENV', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('productionRedisProblem', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('任意 .gif 请求', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('不能删掉', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('curl 请求一个不存在的 /og/*.jpg', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('/og/home-en.jpg', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('先 load() 再 play()', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('不改 onError', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('审查人是前端和 UX', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('并不会自动调用 play()', by_id['POST-LAUNCH-P3']['accept'])
        self.assertNotIn('在 play() 之前先 load()', by_id['POST-LAUNCH-P3']['accept'])
        self.assertIn('src/components/layout/BrandScene.tsx', by_id['POST-LAUNCH-P3']['paths'])
        self.assertEqual(by_id['FE-404-TITLE']['ledgerStatus'], 'todo')
        self.assertEqual(by_id['FE-404-TITLE']['gh'], '待开')
        self.assertIn('htmlLimitedBots', by_id['FE-404-TITLE']['accept'])
        self.assertIn('</head>', by_id['FE-404-TITLE']['accept'])
        self.assertIn('document.title', by_id['FE-404-TITLE']['accept'])
        self.assertIn('Googlebot', by_id['FE-404-TITLE']['accept'])
        self.assertIn('不能只验', by_id['FE-404-TITLE']['accept'])
        self.assertNotIn('next.config.ts', by_id['FE-404-TITLE']['paths'])
        self.assertIn('e2e/not-found-robots.spec.ts', by_id['FE-404-TITLE']['paths'])
        self.assertIn('e2e/seo.spec.ts', by_id['FE-404-TITLE']['paths'])
        self.assertIn('toHaveTitle', by_id['FE-404-TITLE']['accept'])
        self.assertIn('/en/xxx', by_id['FE-404-TITLE']['accept'])
        self.assertIn('未上线语言 /de', by_id['FE-404-TITLE']['accept'])
        self.assertIn('UX 只复核', by_id['FE-404-TITLE']['accept'])
        self.assertIn('poster 用 still 同一帧的 WebP', by_id['SEO-6']['accept'])
        self.assertIn('poster 方案已改为静帧底层，见实施沉淀', by_id['SEO-6']['accept'])
        self.assertEqual(by_id['SEO-7']['gh'], '446')
        self.assertEqual(by_id['SEO-7']['pr'], '445')
        self.assertEqual(by_id['SEO-7']['ledgerStatus'], 'done')
        self.assertIn('aboutLanguages()', by_id['SEO-7']['accept'])
        self.assertEqual(by_id['CITY-STILL-WEBP']['gh'], '待开')
        self.assertEqual(by_id['CITY-STILL-WEBP']['ledgerStatus'], 'done')
        self.assertIn('已知限制', by_id['BE-350A']['accept'])
        self.assertIn('线上验收', by_id['BE-350A']['accept'])
        self.assertIn('线上验收', by_id['BE-350B']['accept'])
        self.assertIn('已知限制', by_id['BE-350B']['accept'])
        self.assertEqual(by_id['GATE-HARDEN']['pr'], '438')
        self.assertNotIn('docs/seo-post-launch-indexing.md', by_id['BE-350A']['paths'])
        prs = {'DEP-AUDIT-1': '420', 'DEPLOY-FIX-1': '421', 'DOCKER-UPLOADS-1': '422',
               'GATE-PATHS-1': '423', 'GATE-PATHS-2': '435',
               'SEO-1': '445', 'SEO-2': '450', 'SEO-6': '453', 'SEO-7': '445',
               'CITY-STILL-WEBP': '448', 'BE-I18N-P0': '449', 'BE-RESET-TTY': '455',
               'BE-RESET-STDIN-TTY': '457', 'BE-RATELIMIT-P3': '454', 'BE-350A': '452',
               'SEO-5': '456'}
        for tid, sha in MERGED.items():
            self.assertEqual(by_id[tid]['merged'], sha)
            self.assertEqual(by_id[tid]['pr'], prs[tid])
        batch3 = tuple(sorted(['M1-T6', 'M1-T8', 'M1-T9', 'M2-T4', 'M3-T14', 'M5-T1']))
        latest = None
        for name, rec in sorted(records.items(), key=lambda item: (str(item[1].get('date', '')), item[0])):
            if tuple(rec['tasks']) == batch3:
                latest = (name, rec)
        self.assertIsNotNone(latest)
        self.assertEqual(latest[1]['verdict'], 'clean')
        self.assertEqual(latest[0], 'batch-3-20261024-r6')
        ui = (ROOT / '02-设计' / '11-UI.md').read_text(encoding='utf-8')
        self.assertIn('待理顺：实际实现是 1240', ui)
        self.assertIn('publicBrand；正文≤75ch左对齐', ui)
        reader = (ROOT / '_run' / 'build_docs.py').read_text(encoding='utf-8')
        self.assertIn('由 PR 上 bot 审查替代', reader)
        self.assertIn('!t.issue', reader)
        self.assertIn('persist_issue_landed', reader)

    def test_landed_issue_status_survives_note_rebuild(self):
        landed = '''```issue
id: SEO-9
title: 示例登记
module: M7
status: todo
gh: 100
pr: 200
merged: 0123456789abcdef0123456789abcdef01234567
depends-on: none
paths: src/app/sitemap.ts
estimate: 0.5d
input: 输入
output: 产出
acceptance: 验收
edges: none
```
'''
        other = landed.replace('id: SEO-9', 'id: SEO-8').replace('status: todo', 'status: hold').replace(
            'pr: 200\nmerged: 0123456789abcdef0123456789abcdef01234567\n', '')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = root / '04-执行'
            ledger.mkdir()
            path = ledger / '遗留issue-20261024.md'
            path.write_text(landed + '\n' + other, encoding='utf-8', newline='\n')
            with self.assertRaises(ValueError) as caught:
                build_docs.persist_issue_landed(str(root), ['SEO-8'])
            self.assertIn('SEO-8', str(caught.exception))
            self.assertIn('status: hold', path.read_text(encoding='utf-8'))
            self.assertEqual(build_docs.persist_issue_landed(str(root), ['SEO-9']), ['SEO-9'])
            issues = {task['id']: task for task in build_docs.load_issue_ledger(str(root))}
            self.assertEqual(issues['SEO-9']['ledgerStatus'], 'done')
            self.assertEqual(issues['SEO-8']['ledgerStatus'], 'hold')
            build_docs.ensure_issue_notes(str(root), [issues['SEO-9']])
            note = root / '图谱' / '任务' / 'SEO-9.md'
            self.assertIn('\nstatus: done\n', '\n' + note.read_text(encoding='utf-8'))
            build_docs.ensure_issue_notes(str(root), build_docs.load_issue_ledger(str(root)))
            self.assertIn('\nstatus: done\n', '\n' + note.read_text(encoding='utf-8'))
            self.assertEqual(build_docs.persist_issue_landed(str(root), ['M1-T1']), [])

    def test_gh_none_renders_as_no_separate_issue(self):
        text = '''```issue
id: SEO-9
title: 示例登记
module: M7
status: todo
gh: 无
depends-on: none
paths: src/app/sitemap.ts
estimate: 0.5d
input: 输入
output: 产出
acceptance: 没有单独的 GitHub issue。
edges: none
```
'''
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = root / '04-执行'
            ledger.mkdir()
            (ledger / '遗留issue-20261024.md').write_text(text, encoding='utf-8', newline='\n')
            issues = build_docs.load_issue_ledger(str(root))
            self.assertEqual(issues[0]['gh'], '无')
            build_docs.ensure_issue_notes(str(root), issues)
            note = (root / '图谱' / '任务' / 'SEO-9.md').read_text(encoding='utf-8')
            self.assertIn('- GitHub：没有单独的 GitHub issue\n', note)
            self.assertNotIn('待开 issue', note)


if __name__ == '__main__':
    unittest.main()
