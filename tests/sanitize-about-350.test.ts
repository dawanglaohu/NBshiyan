import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAboutHtml, safeAboutHref, cleanPlainText, aboutHtmlToText } from '../src/lib/server/sanitize-about';

// #350 about 正文白名单：p h2 h3 strong em a ul ol li br；href 是唯一输入属性；只允许 https: / mailto: / 站内 /
const linkText = (href: string) => sanitizeAboutHtml(`<p><a href="${href}">x</a></p>`);

test('危险协议（大小写混写、Tab/换行/控制字符、实体编码、百分号编码）一律去掉链接、保留文字', () => {
  for (const href of [
    'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' \u0001javascript:alert(1)', '&#106;avascript:alert(1)',
    '&#x6A;avascript&colon;alert(1)', 'jav&#x09;ascript:alert(1)', '%6Aavascript:alert(1)', 'data:text/html,<b>x</b>', 'DATA:image/png;base64,AAAA',
    'vbscript:msgbox(1)', 'VBScript:x', 'http://example.com', 'ftp://example.com', 'relative/path', '#top', '?q=1',
  ]) assert.equal(linkText(href), '<p>x</p>', href);
});

test('协议相对和反斜杠：//evil.com、/\\evil.com、编码后的 // 都拒绝', () => {
  for (const href of ['//evil.com', '/\\evil.com', '\\\\evil.com', ' //evil.com', '/%2F%2Fevil.com', '/%5Cevil.com', '/\t/evil.com', '%2F%2Fevil.com', '/a\\b'])
    assert.equal(linkText(href), '<p>x</p>', href);
});

test('允许的链接：https、mailto、站内路径；统一 rel="noopener noreferrer"，不带 target / title / 原 rel', () => {
  assert.equal(sanitizeAboutHtml('<a href="https://example.com/a?b=1#c" target="_blank" rel="opener" title="t" class="k">ok</a>'), '<a href="https://example.com/a?b=1#c" rel="noopener noreferrer">ok</a>');
  assert.equal(linkText('HTTPS://Example.com'), '<p><a href="https://example.com/" rel="noopener noreferrer">x</a></p>');
  assert.equal(linkText('mailto:sales@example.com'), '<p><a href="mailto:sales@example.com" rel="noopener noreferrer">x</a></p>');
  assert.equal(linkText('/en/products?x=1'), '<p><a href="/en/products?x=1" rel="noopener noreferrer">x</a></p>');
  assert.equal(linkText(' https://ok.example '), '<p><a href="https://ok.example/" rel="noopener noreferrer">x</a></p>');
  assert.equal(safeAboutHref('https://user:pw@example.com'), null);
  assert.equal(safeAboutHref('mailto:'), null);
  assert.ok(!sanitizeAboutHtml('<a href="https://a.example">x</a>').includes('target'));
});

test('on* 事件、style、class、id 去掉；img/script/style/iframe 去掉（script/style 连内容）', () => {
  assert.equal(sanitizeAboutHtml('<p onclick="x()" onmouseover="y" style="color:red" class="c" id="i">hi</p>'), '<p>hi</p>');
  assert.equal(sanitizeAboutHtml('<img src=x onerror=alert(1)><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe>ok'), 'ok');
  assert.equal(sanitizeAboutHtml('<svg><script>alert(1)</script></svg><math><mi>x</mi></math>t'), 't');
  assert.equal(sanitizeAboutHtml('<a href="https://a.example" onclick="x">l</a>'), '<a href="https://a.example/" rel="noopener noreferrer">l</a>');
});

test('标签白名单：h1/div/span/table/u 去掉标签保留文字；白名单内的保留', () => {
  assert.equal(sanitizeAboutHtml('<h1>t</h1><div>b</div><span>s</span><u>u</u>'), 'tbsu');
  const ok = '<h2>A</h2><h3>B</h3><p><strong>s</strong> <em>e</em><br /></p><ul><li>1</li></ul><ol><li>2</li></ol>';
  assert.equal(sanitizeAboutHtml(ok), ok);
});

test('幂等：净化结果再净化一次不变（读出时再净化）', () => {
  for (const x of ['<p>a &amp; b &lt;x&gt;</p>', '<a href="/en">x</a>', '<p onclick=1><a href="java\tscript:1">t</a><img src=x></p>', '<p>Привет «мир» ё</p>']) {
    const once = sanitizeAboutHtml(x);
    assert.equal(sanitizeAboutHtml(once), once, x);
  }
  assert.equal(sanitizeAboutHtml(''), '');
  assert.equal(sanitizeAboutHtml(undefined as unknown as string), '');
});

test('纯文本字段：去掉标签和控制字符；多行字段保留换行', () => {
  assert.equal(cleanPlainText('  <b>Hi</b>\u0000 there\u200b &amp; <script>x</script> '), 'Hi there &');
  assert.equal(cleanPlainText('a\nb'), 'a b');
  assert.equal(cleanPlainText('a\r\n\n\n\nb  c', true), 'a\n\nb c');
  assert.equal(cleanPlainText('«Наше производство» ё'), '«Наше производство» ё');
  assert.equal(aboutHtmlToText('<h2>T</h2><p>a &amp; b</p>'), 'T\na & b');
});

test('回归：不合格链接后面的合格链接闭合标签仍是 </a>（不能出现 </span>），嵌套和文字里的 <a> 也正确', () => {
  assert.equal(sanitizeAboutHtml('<p><a href="javascript:1">j</a><a href="/\\e">b</a><a href="/en">ok</a></p>'), '<p>jb<a href="/en" rel="noopener noreferrer">ok</a></p>');
  assert.equal(sanitizeAboutHtml('<a href="/en">ok</a><a href="data:x">d</a><a href="/ru">ru</a>'), '<a href="/en" rel="noopener noreferrer">ok</a>d<a href="/ru" rel="noopener noreferrer">ru</a>');
  assert.equal(sanitizeAboutHtml('<a>plain</a> &lt;a&gt;text&lt;/a&gt;'), 'plain &lt;a&gt;text&lt;/a&gt;');
  const out = sanitizeAboutHtml('<a href="/x"><a href="javascript:1">in</a>tail</a>');
  assert.ok(!out.includes('span') && !out.includes('javascript'), out);
  assert.equal((out.match(/<a /g) ?? []).length, (out.match(/<\/a>/g) ?? []).length, out);
});

test('#367 review P1：含点段的站内路径规范化后不能变成 //host，整个链接去掉只留文字', () => {
  for (const h of ['/a/..//evil.com', '/.//evil.com', '/%2e//evil.com', '/a/%2e%2e//evil.com', '/%2E%2E//evil.com', '/./x', '/a/../b']) {
    assert.equal(safeAboutHref(h), null, h);
    const out = sanitizeAboutHtml(`<p><a href="${h}">t</a></p>`);
    assert.equal(out, '<p>t</p>', h);
    assert.ok(!out.includes('<a'), h);
  }
  assert.equal(safeAboutHref('/en/about?x=1#top'), '/en/about?x=1#top');
  assert.equal(safeAboutHref('/en/products.v2'), '/en/products.v2');
});

test('#367 review P3：mailto 只允许 subject 参数', () => {
  assert.equal(safeAboutHref('mailto:sales@example.com?subject=Hi'), 'mailto:sales@example.com?subject=Hi');
  for (const h of ['mailto:sales@example.com?bcc=x@example.com', 'mailto:sales@example.com?subject=a&cc=x@example.com', 'mailto:sales@example.com?body=x', 'mailto:sales@example.com?BCC=x@example.com']) assert.equal(safeAboutHref(h), null, h);
});
