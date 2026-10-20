"""1.8.0 回归：页面入口与死接线、vibehub 接入。

起因是 renwudiaoduqi：任务列表页与落地清单页注册了路由却没有界面入口，停止按钮的 onStop 在生产装配处
没人传，验收只写「逐条 navigateTo() 断言渲染」，e2e 用 page.goto 直达、只断言控件可见。1.8.0 让前端任务的
提示词要求点击可达的入口证据、审查把「接线实效」列为阻断，批次收口与查全项目 bug 多查入口与死接线；
review.py X22 提醒产出页面却没写入口的任务。vibehub（外部术语技能）进前端任务的实施与审查提示词，
没装就跳过，后端任务与 handoff.vibehub=false 的项目一条不带。"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_maintenance import hc, review
import install_project
import test_prompt_routing as routing

VB_CMD = '/scripts/vibehub.mjs" resolve --query <术语> --compact'


class EntryAndVibehubPromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def payload(self, frontend=('M1',), vibehub=None, wiring=True):
        payload = routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})
        ho = payload['pres']['handoff']
        ho['frontendModules'] = list(frontend)
        if vibehub is not None:
            ho['vibehub'] = vibehub
        if wiring:
            ho['wiring'] = {'frontendRoutes': 'packages/daemon/src/app.tsx'}
        return payload

    def compiled(self, payload, tid='M1-T2'):
        result = self.browser(payload)
        return result['tasks'][tid]['compiled'], result

    def test_frontend_impl_carries_vibehub_block_skill_and_report_line(self):
        impl = self.compiled(self.payload())[0]['implementation']
        for needle in ('## 界面术语（vibehub）', 'node "~/.claude/skills/vibehub' + VB_CMD,
                       '~/.codex/skills/vibehub', 'scripts/vibehub.mjs 存在', 'VIBEHUB: skipped（原因）',
                       '只采用返回结果里的 title / secondaryTitle 与 url', '- `vibehub`　写入口描述',
                       'VIBEHUB: <术语（English） → 链接；…> | skipped'):
            self.assertIn(needle, impl)
        self.assertLess(impl.index('## 界面术语（vibehub）'), impl.index('## 步骤'))
        self.assertLess(impl.index('入口可达证据：'), impl.index('VIBEHUB: <'))
        self.assertNotIn('[object Object]', impl)

    def test_frontend_impl_requires_click_reachable_entry_evidence(self):
        impl = self.compiled(self.payload())[0]['implementation']
        self.assertIn('从 #/（首页）起依次点了哪些可见控件', impl)
        self.assertIn('只调 navigateTo、page.goto、直接改 hash', impl)
        self.assertIn('页面已挂进装配件可导航，且从首页经可见控件点击可达', impl)

    def test_frontend_review_blocks_dead_wiring_and_has_vibehub_section(self):
        text = self.compiled(self.payload())[0]['review']
        for needle in ('接线实效（界面任务）', 'if (onStop) 未注入', '只被测试导入',
                       '；界面入口缺失、死按钮、可选回调未注入、只被测试导入的新文件。',
                       '核实施方的 VIBEHUB 行', '\nVIBEHUB\n- 实施方与本轮用到的术语', '- `vibehub`　核 VIBEHUB 行'):
            self.assertIn(needle, text)
        self.assertLess(text.index('\nTS_CHECK\n'), text.index('\nVIBEHUB\n'))
        self.assertLess(text.index('\nVIBEHUB\n'), text.index('\nOUT_OF_SCOPE\n'))

    def test_backend_tasks_get_no_vibehub_or_frontend_entry_rules(self):
        compiled = self.compiled(self.payload(frontend=('M9',)))[0]
        for text in (compiled['implementation'], compiled['review'], compiled['bug']):
            self.assertNotIn('vibehub', text)
            self.assertNotIn('VIBEHUB', text)
            self.assertNotIn('接线实效', text)
            self.assertNotIn('从 #/（首页）起', text)

    def test_vibehub_opt_out_and_root_override(self):
        for off in (False, {'enabled': False}):
            with self.subTest(off=off):
                compiled = self.compiled(self.payload(vibehub=off))[0]
                for text in (compiled['implementation'], compiled['review']):
                    self.assertNotIn('vibehub', text)
                self.assertIn('接线实效', compiled['review'])
        impl = self.compiled(self.payload(vibehub={'root': 'D:/skills/vibehub'}))[0]['implementation']
        self.assertIn('node "D:/skills/vibehub' + VB_CMD, impl)
        self.assertNotIn('node "~/.claude/skills/vibehub', impl)

    def test_kickoff_and_batch_wrapup_cover_entry_and_vibehub(self):
        payload = self.payload()
        kick = self.run_node(['node', '-e', routing.KICKOFF], {'payload': payload, 'core': self.core})['kick']
        self.assertIn('- `vibehub`　界面任务写入口描述', kick)
        self.assertIn('oil-oil/vibe-hub-skill', kick)
        _, result = self.compiled(payload)
        self.assertIn('另查入口与死接线', result['pure0'])
        self.assertLess(result['pure0'].index('查五类接缝'), result['pure0'].index('另查入口与死接线'))
        backend = self.payload(frontend=())
        kick = self.run_node(['node', '-e', routing.KICKOFF], {'payload': backend, 'core': self.core})['kick']
        self.assertNotIn('vibehub', kick)
        self.assertNotIn('另查入口与死接线', self.compiled(backend)[1]['pure0'])


ROW = '| {id} | {title} | M1 | 无 | 已有路由表 | {output} | {accept} | 1d |'
HEAD = '| ID | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估 |\n|---|---|---|---|---|---|---|---|\n'


class X22Tests(unittest.TestCase):
    def x22(self, *rows):
        rep = review.Report()
        review.check_tasks(rep, {'file': '19-模块任务拆分.md', 'body': HEAD + '\n'.join(rows)}, {'M1'}, set(), '')
        return [i for i in rep.items if i['code'] == 'X22']

    def test_page_output_without_entry_warns(self):
        found = self.x22(ROW.format(id='M1-T1', title='挂载任务列表页面', output='`pages/tasks-page.tsx`',
                                    accept='1) navigateTo 后渲染容器（E-01） 2) 缺参走未知路径（E-02）'))
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['level'], 'WARN')
        self.assertIn('M1-T1', found[0]['msg'])

    def test_entry_in_acceptance_or_non_page_output_is_quiet(self):
        self.assertEqual(self.x22(
            ROW.format(id='M1-T1', title='挂载任务列表页面', output='`pages/tasks-page.tsx`',
                       accept='1) 入口：甲板顶栏「任务列表」按钮 → #/tasks（E-01） 2) 点击后渲染列表（E-02）'),
            ROW.format(id='M1-T2', title='实现派发接口服务', output='`service/dispatch.ts`',
                       accept='1) 被谁调用：POST /runs（E-01） 2) 幂等（E-02）')), [])


class VersionTests(unittest.TestCase):
    def test_version_is_1_8_0(self):
        self.assertEqual(hc.VERSION, '1.9.0')
        self.assertIn('test_release_1_8_entry.py', install_project.TESTS)


if __name__ == '__main__':
    unittest.main()