import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';

/**
 * M3-T21 询盘/邮件视觉迁移的源码接线守卫。
 * 真实 computed style / 三尺寸 / D1–D6 / GIF 由 e2e/admin-legacy-inquiries-visual.spec.ts 在 CI 跑；
 * 本文件只锁：旧内联视觉已移除、作用域规则不泄漏、公共 adm-* 定义未被改动、业务/权限/匿名化不变。
 */
const read = (p: string) => readFileSync(p, 'utf8');
const css = read('src/app/admin/admin.css');
const mail = read('src/app/admin/mail.css');
const detail = read('src/components/admin/InquiryDetail.tsx');
const list = read('src/components/admin/InquiryList.tsx');
const anon = read('src/components/admin/anonymized.tsx');
const badge = read('src/components/admin/StatusBadge.tsx');
const tokens = read('src/styles/tokens.css');

test('唯一 minimalist-flat token：2px / 0 圆角 / 无阴影 / #b45700 / 44px', () => {
  assert.match(tokens, /--pj-border-width:2px/);
  assert.match(tokens, /--pj-radius:0px/);
  assert.match(tokens, /--pj-shadow:none/);
  assert.match(tokens, /--pj-accent:#b45700/);
  assert.match(tokens, /--pj-touch-target:44px/);
  // 新规则只消费 token，不写死 1px/圆角/渐变/阴影。
  const block = css.slice(css.indexOf('/* M3-T21'));
  // 注释里会提到这些词（说明范围边界），只核真实 CSS 声明。
  assert.doesNotMatch(block, /border:\s*1px/);
  assert.doesNotMatch(block, /border-radius:\s*(?:4|6|8|10|12|999)px/);
  assert.doesNotMatch(block, /background:\s*(?:conic|linear|radial)-gradient/);
  assert.match(css, /var\(--pj-border-width\)/);
  assert.match(css, /var\(--pj-radius\)/);
  assert.match(css, /var\(--pj-shadow\)/);
  assert.match(css, /var\(--pj-accent\)/);
});

test('InquiryDetail 移除 conic-gradient 环图，保留可信度数值与 aria-label', () => {
  // 注释里会提到 conic-gradient 这个词（说明为什么去掉），只核真实代码用法。
  assert.doesNotMatch(detail, /background:\s*`conic-gradient/);
  assert.doesNotMatch(detail, /className="adm-ring"/);
  assert.doesNotMatch(detail, /ringColor/);
  assert.match(detail, /data-testid="trust-score"/);
  assert.match(detail, /aria-label=\{`可信度 \$\{score\}`\}/);
  assert.match(detail, /<b>\{score\}<\/b>/, '数值不能因去环图而消失');
  assert.match(detail, /inq\.trustReasons\.map/, '原因列表保留');
  // 环图改数值+文字标签，且用 --pj-* 命名域。
  assert.match(detail, /className="adm-sec inq-trust-card"/);
  assert.match(detail, /className="inq-trust-score"/);
  assert.match(detail, /data-state=\{trustState\}/);
});

test('作用域 wrapper 用 display:contents，不生成布局盒（避免改父 flex/grid 子项关系）', () => {
  assert.match(css, /\.inq-detail,\.inq-list\{display:contents\}/);
  assert.doesNotMatch(css, /\.inq-detail\{[^}]*padding:/, '作用域 wrapper 不应有盒模型 padding');
  assert.match(detail, /<div className="inq-detail" data-testid="inq-detail-scope">/);
  assert.match(list, /<div className="inq-list" data-testid="inq-list-scope">/);
  // 子节点顺序不变：面包屑/标题/表格仍是首个渲染节点。
  assert.ok(detail.indexOf('className="adm-crumb"') > detail.indexOf('className="inq-detail"'));
  assert.ok(list.indexOf('<h1>询盘管理') > list.indexOf('className="inq-list"'));
});

test('公共 adm-* 选择器定义未被改写（models / SpecEditor 仍消费），只在命名域内覆盖', () => {
  // 旧公共类定义逐字保留——既有测试锁死的字面量。
  assert.match(css, /\.adm-card\{background:var\(--surface\);border:1px solid var\(--line\);border-radius:var\(--r-md\);overflow:hidden\}/);
  assert.match(css, /\.adm-btn\{font:inherit;border:1px solid var\(--line\)/);
  assert.match(css, /\.badge\{display:inline-block/);
  assert.match(css, /--neutral-bg:#F3EFE8/);
  // 多行选择器与注释会连在一起，先去掉注释再按 `{` 切选择器。
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = strip(css.slice(css.indexOf('/* M3-T21')));
  const selectors = [...block.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim().replace(/^\s*[\r\n]+/gm, '').trim());
  for (const sel of selectors) {
    assert.doesNotMatch(sel, /^\.adm-(card|btn|sec|g2|detail|ring|msg2|tabs|filters|pager)\b/, `不得裸改公共选择器: ${sel}`);
    assert.doesNotMatch(sel, /(^|,)\s*(td|button|input|select|textarea|th)\s*\{?/, `不得泄漏成全局元素选择器: ${sel}`);
  }
  // mail.css 覆盖同样限定 .ml 作用域。
  const mailBlock = strip(mail.slice(mail.indexOf('/* M3-T21')));
  const mailSel = [...mailBlock.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim().replace(/^\s*[\r\n]+/gm, '').trim());
  for (const sel of mailSel) {
    if (/^@media\b/.test(sel)) continue; // at-rule 不是选择器
    assert.match(sel, /^\.ml\b/, `mail.css 规则必须限定 .ml 域: ${sel}`);
  }
});

test('mail.css 旧 .ml-* 定义逐字保留，新规则在其后用 .ml 作用域覆盖', () => {
  assert.match(mail, /\.ml-msg\{max-width:78%;border-radius:12px/);
  assert.match(mail, /\.ml-pill\{font-size:12px;padding:2px 8px;border-radius:999px/);
  assert.match(mail, /\.ml-btn\{white-space:nowrap;min-height:44px/);
  assert.ok(mail.indexOf('/* M3-T21') > mail.indexOf('.ml-btn{'), '覆盖规则追加在旧定义之后');
  assert.match(mail, /\.ml \.ml-msg/);
  assert.match(mail, /background-image:none/, '去掉渐变/图案背景');
  assert.match(mail, /var\(--pj-focus-width\) solid var\(--pj-accent\)/);
});

test('anonymized.tsx：去掉 1px/4px/999px 内联旧值，保留匿名化只读语义与 data-testid', () => {
  assert.doesNotMatch(anon, /ANON_TAG_STYLE/);
  assert.doesNotMatch(anon, /borderRadius: 4|borderRadius: 999/);
  assert.doesNotMatch(anon, /'1px solid/);
  assert.match(anon, /className="inq-anon-tag" data-testid="anon-tag"/);
  assert.match(anon, /className="inq-deleted-tag" data-testid="deleted-tag"/);
  // 已匿名化：回复区/分配下拉隐藏、可信度卡片不渲染、PII 不重新显示。
  assert.match(anon, /showReply: !isAnonymized/);
  assert.match(anon, /showAssign: !isAnonymized/);
  assert.match(anon, /showTrust: !isAnonymized/);
  assert.match(anon, /DELETED_BODY = '内容已删除'/);
  assert.match(anon, /DeletedBody\(\)/);
  assert.match(anon, /piiField/);
  assert.match(anon, /ANON_LABEL = '已匿名化'/);
});

test('AnonTag 中性语义（承担原 admin-anonymized-ui 责任）：精确核 .inq-anon-tag 声明与 --pj-* 定义', () => {
  // 精确取 .inq-anon-tag,.inq-deleted-tag 规则体，而不是整个 CSS 文件某处含 border/radius。
  const rule = /\.inq-anon-tag,\.inq-deleted-tag\{([\s\S]*?)\}/.exec(css);
  assert.ok(rule, '必须存在 .inq-anon-tag 命名域声明');
  const body = rule![1];
  assert.match(body, /border:var\(--pj-border-width\) solid var\(--pj-border\)/);
  assert.match(body, /border-radius:var\(--pj-radius\)/);
  assert.match(body, /box-shadow:var\(--pj-shadow\)/);
  assert.match(body, /background:var\(--pj-bg\)/);
  assert.match(body, /color:var\(--pj-fg\)/);
  assert.doesNotMatch(body, /--err|--warn|--danger|red|#B42318/i, '中性标签不得用错误/警告色');
  assert.doesNotMatch(body, /1px|border-radius:\s*(?:4|6|8|10|12|999)px/, '不得把旧 1px/圆角加回');
  // --pj-* 实际定义（tokens.css）给出 2px / 0 / none / #ffffff / #000000。
  assert.match(tokens, /--pj-border-width:2px/);
  assert.match(tokens, /--pj-radius:0px/);
  assert.match(tokens, /--pj-shadow:none/);
  assert.match(tokens, /--pj-bg:#ffffff/);
  assert.match(tokens, /--pj-fg:#000000/);
  // 渲染出的标签有可访问文案，且 AnonTag 这一行没有把 --surface/--ink-2 旧内联加回
  //（其它状态文字仍用 --ink-2 属既有的中性灰字，不属被移除的标签旧内联）。
  const anonLine = /export function AnonTag\(\)[^\n]*/.exec(anon)?.[0] ?? '';
  assert.match(anonLine, /\{ANON_LABEL\}/);
  assert.doesNotMatch(anonLine, /var\(--surface\)|var\(--ink-2\)|border:|borderRadius/);
  // 已匿名化敏感内容仍隐藏（原测试的语义责任）。
  assert.match(anon, /DELETED_BODY = '内容已删除'/);
  assert.match(anon, /DeletedBody\(\)/);
  assert.match(anon, /export function piiField\(/);
  assert.match(anon, /if \(isAnonymized\(r\)\) return <AnonTag \/>/);
});

test('StatusBadge 保留 label 文本与既有 badge 类，新增命名域与 data-testid', () => {
  assert.match(badge, /className=\{`badge \$\{status\} inq-status-badge`\}/);
  assert.match(badge, /STATUS_LABEL\[status\]/, '状态文字不因去色而消失');
  assert.match(badge, /data-testid="status-badge"/);
  assert.match(badge, /data-state="current"/);
});

test('业务动作与 API/权限/mail gate 完全不变（只改视觉）', () => {
  // 详情：状态 PATCH、分配、notes、reply、history 刷新、mail gate、匿名化 409。
  for (const pat of [
    /adminApi\.updateInquiry\(id, \{ status \}\)/,
    /adminApi\.updateInquiry\(inq\.id, \{ assigneeId:/,
    /adminApi\.addNote\(inq\.id, note\.trim\(\)\)/,
    /adminApi\.reply\(inq\.id, \{ subject:/,
    /<InquiryHistory inquiryId=\{inq\.id\} refreshKey=\{historyKey\} \/>/,
    /useMailGate\(\)/,
    /showSendEntry\(gate\)/,
    /onAnonymized/,
  ]) assert.match(detail, pat);
  // 列表：GET 过滤/分页/users、含已匿名化开关、行点击进入详情。
  for (const pat of [
    /adminApi\.listInquiries\(query\)/,
    /adminApi\.listUsers\(\)/,
    /includeAnonymized/,
    /router\.push\(`\/admin\/inquiries\/\$\{r\.id\}`\)/,
    /SearchParams|useSearchParams/,
  ]) assert.match(list, pat);
});

test('六态与 DENSITY 7：44px 触屏、focus-visible、disabled、gap/pad 16、无横向溢出准备', () => {
  assert.match(css, /min-height:var\(--pj-touch-target\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /button:disabled\{opacity:1/);
  assert.match(css, /gap:16px/);
  assert.match(mail, /min-height:var\(--pj-touch-target\)/);
  assert.match(mail, /:focus-visible/);
  // 不删字段、不靠缩字过密度：字号仍为 14/20。
  assert.match(css, /font-size:14px/);
  assert.match(css, /line-height:20px/);
});

test('采证用例标题与报告映射一致，标题变更不能留下空报告', () => {
  const source = read('e2e/admin-legacy-inquiries-visual.spec.ts');
  const checkMapping = (text: string) => {
    const tree = ts.createSourceFile('evidence.ts', text, ts.ScriptTarget.Latest, true);
    const titles: string[] = [];
    let mapped: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'REPORT_BY_TEST' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        mapped = node.initializer.properties.map((p) => p.name && ts.isStringLiteral(p.name) ? p.name.text : '');
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const title = node.arguments[0].text;
        if (!title.startsWith('density_probe 负控：')) titles.push(title);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(titles.length, 8);
    assert.deepEqual(mapped.sort(), titles.sort());
  };
  checkMapping(source);
  const title = '键盘 36/44 触控';
  assert.ok(source.includes(title));
  assert.throws(() => checkMapping(source.replace(title, '键盘 44px 触控')));
});

test('匿名化状态负控只接受真实可用选项的禁用拒绝，不能以缺选项或其它失败充数', async () => {
  const source = read('e2e/admin-legacy-inquiries-visual.spec.ts');
  const start = source.indexOf('    const statusValue = await statusSel.inputValue();');
  const end = source.indexOf('    await expect(page.getByTestId(\'status-locked\').getByText(', start);
  assert.ok(start >= 0 && end > start, '状态负控须先取得实际存在的选项');
  const code = ts.transpileModule(`async function check() {\n${source.slice(start, end)}\nreturn enableRejected;\n}\ncheck();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const outcome of ['disabled', 'enabled', 'missing', 'transport']) {
    let attempted = false;
    const fake = {
      inputValue: async () => 'x',
      locator: () => ({ evaluateAll: async () => outcome === 'missing' ? [] : ['x'] }),
      selectOption: async (value: string) => {
        attempted = true; assert.equal(value, 'x');
        if (outcome === 'disabled') throw new Error('Timeout: element is not enabled');
        if (outcome === 'missing') throw new Error('Timeout: did not find some options');
        if (outcome === 'transport') throw new Error('browser closed');
        return ['x'];
      },
    };
    const expectLocal = (actual: unknown) => ({
      toContain: (wanted: unknown) => assert.ok(Array.isArray(actual) && actual.includes(wanted)),
      toBe: (wanted: unknown) => assert.equal(actual, wanted),
    });
    const checked = runInNewContext(code, { statusSel: fake, expect: expectLocal, Error }) as Promise<boolean>;
    if (outcome === 'disabled') assert.equal(await checked, true);
    else await assert.rejects(checked);
    assert.equal(attempted, outcome !== 'missing');
  }
});

test('本域错误 alert 覆盖旧 .warn：两个真实节点消费 accent 与 14/20，旧色不得作为验收值', () => {
  const check = (text: string) => {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = stripped.slice(stripped.indexOf('.inq-detail,.inq-list{display:contents}'));
    const bodyOf = (selector: string) => {
      for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sels = m[1].split(',').map((s) => s.trim().replace(/^\s*[\r\n]+/gm, '').trim());
        if (sels.includes(selector)) return m[2].trim();
      }
      return '';
    };
    for (const selector of ['.inq-list .adm-card td[role="alert"]', '.inq-detail > p[role="alert"]']) {
      const body = bodyOf(selector);
      assert.ok(body, `缺少本域错误规则: ${selector}`);
      assert.match(body, /color:var\(--pj-accent\)/, `${selector} 必须消费 accent`);
      assert.match(body, /font-size:var\(--pj-ui-size\)/, `${selector} 反馈文本 14px`);
      assert.match(body, /line-height:var\(--pj-ui-line\)/, `${selector} 反馈文本 20px`);
      assert.doesNotMatch(body, /#B4441F|rgb\(180,\s*68,\s*31\)/i, `${selector} 不得保留旧错误色`);
    }
    // 全局 .adm .warn 仍是旧定义，本域只做局部覆盖，不改全局。
    assert.match(text, /\.adm \.warn\{color:#B4441F;font-weight:700\}/);
    assert.match(tokens, /--pj-ui-size:14px/);
    assert.match(tokens, /--pj-ui-line:20px/);
  };
  check(css);
  // 负控：把本域 color 换回旧色，守卫必须失败。
  const broken = css.replace(
    /(\.inq-list \.adm-card td\[role="alert"\],\s*\.inq-detail > p\[role="alert"\]\{[^}]*?)color:var\(--pj-accent\)/,
    '$1color:#B4441F',
  );
  assert.notEqual(broken, css, '负控替换必须命中本域规则');
  assert.throws(() => check(broken));
});

test('普通桌面 tabs 与分页按钮的最终最小高度为36px，不被20px行高覆盖', () => {
  const start = css.indexOf('/* M3-T21');
  const media = css.indexOf('@media (pointer:coarse)', start);
  assert.ok(start >= 0 && media > start);
  const desktop = css.slice(start, media).replace(/\/\*[\s\S]*?\*\//g, '');
  const lastHeight = (text: string, selector: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
    .flatMap((m) => [...m[2].matchAll(/(?:^|;)\s*min-height:([^;}]*)/g)].map((d) => d[1].trim()))
    .at(-1);
  for (const selector of ['.inq-list .adm-tabs button', '.inq-list .adm-pager button']) {
    assert.equal(lastHeight(desktop, selector), 'var(--pj-admin-control-height)');
    assert.notEqual(lastHeight(`${desktop}\n${selector}{min-height:var(--pj-ui-line)}`, selector), 'var(--pj-admin-control-height)');
  }
});

test('P2 级联：真实按钮圆角、toast 前景、DateRange 弹层与早返回状态都有精确命名域规则', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = strip(css.slice(css.indexOf('/* M3-T21')));
  // 精确取规则体：按选择器逐项精确匹配，不做全文件任意命中。
  const rule = (selector: string): string => {
    for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1].split(',').map((s) => s.trim());
      if (sels.includes(selector)) return m[2].trim();
    }
    return '';
  };
  // 详情真实按钮：.adm-btn.sq 是 0,2,0，必须有一条选择器含更高特异性
  // `.inq-detail button.adm-btn.sq` 的命名域规则，且其声明把圆角归零。
  const higherRule = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes('.inq-detail button.adm-btn.sq'))
    .map((m) => m[2]);
  assert.ok(higherRule.length > 0, '必须有压过 .adm-btn.sq 的命名域选择器');
  assert.match(higherRule.join('\n'), /border-radius:var\(--pj-radius\)/, '该规则须把圆角归零');
  assert.match(higherRule.join('\n'), /min-height:var\(--pj-admin-control-height\)/);
  // 桌面 36 / 触控 44 分档，不是所有尺寸一律 44。
  assert.match(css, /min-height:var\(--pj-admin-control-height\)/);
  assert.match(css, /@media \(pointer:coarse\),\(max-width:767px\)/);
  const mediaIdx = css.indexOf('@media (pointer:coarse)');
  assert.ok(mediaIdx > 0, '触控 media 块须存在');
  // 输入 16px / 表头 14/20：精确取含 th 的那条分组规则体，而非全文件任意命中。
  assert.match(css, /font-size:var\(--pj-body-size\)/);
  const thRule = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes('.inq-list .adm-inq-table th'))
    .map((m) => m[2]).join('\n');
  assert.match(thRule, /font-size:var\(--pj-ui-size\)/);
  assert.match(thRule, /line-height:var\(--pj-ui-line\)/);
  // DateRange 弹层容器与内部控件被覆盖。
  assert.ok(rule('.inq-list .drp>button') && rule('.inq-list .drp-pop'), 'DateRange 弹层须有命名域规则');
  const drp = rule('.inq-list .drp>button');
  assert.match(drp, /border:var\(--pj-border-width\) solid var\(--pj-border\)/);
  assert.match(drp, /border-radius:var\(--pj-radius\)/);
  // 早返回状态 wrapper + 空态/骨架命名域规则。
  assert.match(css, /\.inq-state\{/);
  assert.match(css, /\.inq-state \.adm-empty/);
  assert.match(css, /\.inq-detail \.adm-tl-skel \.adm-tl-ic/);
  // mail.css：白底 toast 内 button 显式前景（旧定义是 color:#fff，父级覆盖不到子元素）。
  // 取所有 `.ml .ml-toast button` 规则，确证新增的那条（在 M3-T21 块内）显式改了前景。
  const mailBlock = strip(mail.slice(mail.indexOf('/* M3-T21')));
  const toastRules = [...mailBlock.matchAll(/\.ml \.ml-toast button\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(toastRules.length > 0, '必须有 .ml .ml-toast button 覆盖规则');
  assert.ok(toastRules.some((b) => /color:var\(--pj-fg\)/.test(b)), '须有一条显式把前景改为 --pj-fg');
  assert.ok(toastRules.some((b) => /background:transparent/.test(b)), '须显式给透明背景');
  assert.ok(!toastRules.some((b) => /color:#fff/.test(b)), '覆盖规则不得把白字加回');
});

test('绝不新增 models.css / specs.css / 公共 adm-* 全局定义或 T6 登录页', () => {
  // 本任务只写 admin.css / mail.css 与询盘/邮件组件；公共壳与账号区不动。
  const block = css.slice(css.indexOf('/* M3-T21'));
  assert.doesNotMatch(block, /\.adm-top|\.adm-side|\.adm-main|\.adm-account|\.adm-signout/);
  assert.doesNotMatch(block, /@import/);
  // 注释里会提到 models.css/specs.css 作为边界说明，只核真实代码（@import/选择器）不引用它们。
  const mailCode = mail.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(mailCode, /models\.css|specs\.css/);
  assert.doesNotMatch(mailCode, /@import/);
});
