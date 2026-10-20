"""1.9.0 回归：视觉方向改走 StyleKit。

S3 关卡要 handoff.design.style，不再要 dials。前端实施 / 审查 / 批次提示词点名 stylekit
与已保存的规格，不点名上一版视觉技能。桌面密度探针的原句保留。
"""
import unittest
from pathlib import Path

from test_maintenance import hc, SCRIPTS
import test_prompt_routing as routing
import test_stage as stagecase
import install_project


class VersionTests(unittest.TestCase):
    def test_version_is_1_9_0(self):
        self.assertEqual(hc.VERSION, '1.9.0')
        self.assertIn('test_release_1_9_stylekit.py', install_project.TESTS)
        self.assertEqual(stagecase.stage.DESIGN_KEYS,
                         ('register', 'style', 'tokens', 'components', 'spacing'))


class PromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def test_frontend_prompts_use_stylekit_and_saved_spec(self):
        payload = routing.payload_for('M1-T1')
        ho = payload['pres']['handoff']
        ho['frontendModules'] = ['M1']
        ho['design'] = {'register': 'product 后台', 'style': 'ink-ledger 墨色账本',
                        'tokens': '--a:#000;', 'components': '按钮高 32px',
                        'spacing': '页边距 24'}
        task = self.browser(payload)['tasks']['M1-T1']
        for impl in (task['implementation'], task['compiled']['implementation']):
            self.assertIn('stylekit', impl)
            self.assertIn('stylekit-spec.json', impl)
            self.assertIn('不许重新搜索', impl)
            self.assertIn('style：ink-ledger 墨色账本', impl)
            self.assertNotIn('finesse-ui', impl)
        review = task['compiled']['review']
        self.assertIn('eval-check.py', review)
        self.assertIn('桌面密度不归它管', review)
        self.assertNotIn('finesse-ui', review)
        pure = self.browser(payload)['pure0']
        self.assertIn('stylekit', pure)
        self.assertIn('桌面密度不归它管，用 _run/density_probe.js', pure)
        self.assertNotIn('finesse-ui', pure)

    def test_prompt_s3_asks_for_style_key(self):
        code, out = stagecase.run_stage(Path(__file__).resolve().parent, '--prompt', 'S3')
        self.assertEqual(code, 0, out)
        self.assertIn('register/style/tokens/components/spacing 五键齐', out)
        self.assertNotIn('finesse', out.lower())


class StyleGateTests(stagecase.StageBase):
    def test_s3_gate_requires_style_and_still_renders_old_dials(self):
        self.prepare_s1()
        self.assertEqual(stagecase.run_stage(self.doc, '--done', 'S1')[0], 0)
        self.prepare_s2()
        self.assertEqual(stagecase.run_stage(self.doc, '--done', 'S2')[0], 0)
        self.prepare_s3()
        pres = hc.read_json(self.doc / '_run/presentation.json')
        pres['handoff']['design'].pop('style')
        hc.write_json(self.doc / '_run/presentation.json', pres)
        code, out = stagecase.run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('style', out)
        self.assertNotIn('S3', (self.state().get('stages') or {}))
        pres['handoff']['design']['style'] = 'ink-ledger 墨色账本'
        pres['handoff']['design'].pop('dials', None)
        hc.write_json(self.doc / '_run/presentation.json', pres)
        code, out = stagecase.run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 0, out)


class LiveInstructionTests(unittest.TestCase):
    def test_generator_and_references_do_not_name_the_previous_visual_skill(self):
        for rel in ('build_docs.py', 'stage.py', 'typesafe_ask.py'):
            body = (SCRIPTS / rel).read_text(encoding='utf-8-sig')
            self.assertNotIn('finesse', body.lower(), rel)
        if SCRIPTS.name != 'scripts':
            return
        root = SCRIPTS.parent
        for path in (root / 'references').glob('*.md'):
            self.assertNotIn('finesse', path.read_text(encoding='utf-8-sig').lower(), path.name)
        skill = (root / 'SKILL.md').read_text(encoding='utf-8-sig')
        live = skill
        for marker in ('\n## 变更记录', '\n## Changelog'):
            if marker in live:
                live = live.split(marker, 1)[0]
        self.assertNotIn('finesse', live.lower())
        self.assertIn('没写 style', (SCRIPTS / 'build_docs.py').read_text(encoding='utf-8-sig'))


if __name__ == '__main__':
    unittest.main()
