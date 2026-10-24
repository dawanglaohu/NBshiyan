"""10/24 遗留 issue 覆盖层：不进入原批次，状态按登记显示。"""
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_docs


ROOT = Path(__file__).resolve().parents[2]
WANT = {
    'FE-347': 'todo',
    'FE-378': 'hold',
    'SEO-1': 'doing',
    'SEO-2': 'todo',
    'SEO-3': 'hold',
    'SEO-4': 'hold',
    'SEO-5': 'todo',
    'SEO-6': 'todo',
    'SEO-7': 'doing',
    'BE-I18N-P0': 'todo',
    'BE-RESET-TTY': 'todo',
    'BE-RATELIMIT-P3': 'todo',
    'BE-350A': 'todo',
    'BE-350B': 'ops',
    'DEP-AUDIT-1': 'done',
    'DEPLOY-FIX-1': 'done',
    'DOCKER-UPLOADS-1': 'done',
    'GATE-PATHS-1': 'done',
    'GATE-PATHS-2': 'done',
    'GATE-HARDEN': 'merging',
    'GATE-HARDEN-2': 'todo',
}
MERGED = {
    'DEP-AUDIT-1': '950b63c235a3ce945fa6140dedf0bfad7a946bc3',
    'DEPLOY-FIX-1': '40b2eb5c52361ac57390530c7347498e3b2e07b1',
    'DOCKER-UPLOADS-1': '0b71952e7c0e15b2cc5cc0549167561e57789fc5',
    'GATE-PATHS-1': '78f535ec43e68cb6619a012270f878fdf4e3b954',
    'GATE-PATHS-2': 'c8ebb9c6d3bf3fe230aae757bf187bfaef3c6d5c',
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
        self.assertNotIn('x-default 在 en 发布时指向 en', by_id['SEO-1']['accept'])
        self.assertEqual(by_id['SEO-6']['gh'], '444')
        self.assertEqual(by_id['SEO-6']['ledgerStatus'], 'todo')
        self.assertIn('3D', by_id['SEO-6']['note'])
        self.assertEqual(by_id['SEO-7']['gh'], '446')
        self.assertEqual(by_id['SEO-7']['pr'], '445')
        self.assertIn('aboutLanguages()', by_id['SEO-7']['accept'])
        self.assertIn('已知限制', by_id['BE-350A']['accept'])
        self.assertIn('线上验收', by_id['BE-350A']['accept'])
        self.assertIn('线上验收', by_id['BE-350B']['accept'])
        self.assertIn('已知限制', by_id['BE-350B']['accept'])
        self.assertEqual(by_id['GATE-HARDEN']['pr'], '438')
        self.assertNotIn('docs/seo-post-launch-indexing.md', by_id['BE-350A']['paths'])
        prs = {'DEP-AUDIT-1': '420', 'DEPLOY-FIX-1': '421', 'DOCKER-UPLOADS-1': '422',
               'GATE-PATHS-1': '423', 'GATE-PATHS-2': '435'}
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


if __name__ == '__main__':
    unittest.main()
