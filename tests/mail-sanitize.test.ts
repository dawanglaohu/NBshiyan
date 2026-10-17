import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeInboundHtml, looksLikeUrl, htmlToText } from '../src/lib/server/mail/sanitize';

const S = (h: string) => sanitizeInboundHtml(h).html;

// §18（全栈审 #295）逐项一个用例 + §6 M2
test('§18 去掉 <base> <meta>（refresh / CSP） <link>', () => {
  const out = S('<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"><meta http-equiv="Content-Security-Policy" content="x"><link rel="stylesheet" href="https://evil.example/a.css"><p>hi</p>');
  assert.equal(out, '<p>hi</p>');
});
test('§18 <script> <iframe> <object> <embed> <form> 连内容一起去掉', () => {
  const out = S('<p>a</p><script>alert(1)</script><iframe src="https://evil.example">x</iframe><object data="x">o</object><embed src="x"><form action="https://evil.example" target="_top"><input name="pw"><button formaction="https://evil.example">Go</button></form><p>b</p>');
  assert.equal(out, '<p>a</p><p>b</p>');
});
test('§18 <style>（含 @import / url()）去掉；style 属性里的 url( / expression / @import / behavior / position:fixed 去掉', () => {
  assert.equal(S('<style>@import url(https://evil.example/x.css); p{background:url(x)}</style><p>t</p>'), '<p>t</p>');
  const out = S('<p style="color:red;background-image:url(https://evil.example/t.png);width:expression(alert(1));position:fixed;behavior:url(x.htc);font-weight:bold">t</p>');
  assert.match(out, /color:red/); assert.match(out, /font-weight:bold/);
  for (const bad of ['url(', 'expression', 'position', 'behavior', 'background-image']) assert.ok(!out.includes(bad), bad);
});
test('§18 去掉全部 on* 属性、srcset、formaction、background', () => {
  const out = S('<div onclick="x()" onmouseover="y()" background="bg.png"><img src="data:image/png;base64,iVBORw0KGgo=" srcset="https://evil.example/a.png 2x" onerror="z()"><span formaction="x">s</span></div>');
  for (const bad of ['onclick', 'onmouseover', 'onerror', 'srcset', 'formaction', 'background']) assert.ok(!out.includes(bad), bad);
});
test('§18 javascript: / data: 链接降为纯文本；data:image 图片保留，data:image/svg+xml 去掉', () => {
  assert.equal(S('<a href="javascript:alert(1)">click</a>'), '<span>click</span>');
  assert.equal(S('<a href="JaVaScRiPt:alert(1)">x</a>'), '<span>x</span>');
  assert.equal(S('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'), '<span>x</span>');
  assert.equal(S('<a href="vbscript:x">x</a>'), '<span>x</span>');
  assert.match(S('<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">'), /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.ok(!S('<img src="data:image/svg+xml;base64,PHN2Zz4=">').includes('data:'));
  assert.equal(S('<svg><script>alert(1)</script></svg><math><mi>x</mi></math>ok'), 'ok');
});
test('§18 链接改写：target=_blank rel="noopener noreferrer" title=完整 URL', () => {
  const out = S('<a href="https://example.com/a?b=1" target="_self" rel="opener">go</a>');
  assert.equal(out, '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer" title="https://example.com/a?b=1">go</a>');
  assert.match(S('<a href="mailto:x@example.com">mail</a>'), /href="mailto:x@example.com" target="_blank" rel="noopener noreferrer"/);
});
test('§6 外链图片不加载：src → data-remote-src，hasRemoteImages；cid: 只留占位', () => {
  const r = sanitizeInboundHtml('<img src="https://tracker.example/p.gif" alt="t"><img src="cid:logo@x">');
  assert.equal(r.hasRemoteImages, true);
  assert.ok(!/ src=/.test(r.html));
  assert.match(r.html, /data-remote-src="https:\/\/tracker.example\/p.gif"/);
  assert.match(r.html, /data-cid="1"/);
  assert.equal(sanitizeInboundHtml('<p>x</p>').hasRemoteImages, false);
});
test('§6 data-mismatch：显示文字像网址且主机不同才标；大小写 / www. / IDN 等价不标；mailto 和普通文字不标', () => {
  assert.match(S('<a href="https://evil.example/login">https://bank.example</a>'), /data-mismatch="1"/);
  assert.match(S('<a href="https://evil.example/">www.bank.example</a>'), /data-mismatch="1"/);
  assert.match(S('<a href="https://evil.example/">bank.example/login</a>'), /data-mismatch="1"/);
  assert.ok(!S('<a href="https://WWW.Bank.example/x">bank.example</a>').includes('data-mismatch'));
  assert.ok(!S('<a href="https://xn--80ak6aa92e.com/">https://аррӏе.com</a>').includes('data-mismatch'));
  assert.ok(!S('<a href="https://evil.example/">Click here</a>').includes('data-mismatch'));
  assert.ok(!S('<a href="mailto:a@evil.example">bank.example</a>').includes('data-mismatch'));
  assert.ok(looksLikeUrl('example.com/path') && looksLikeUrl('www.x.y') && !looksLikeUrl('hello world'));
});
test('htmlToText 去标签、去掉 script/style 内容', () => {
  assert.equal(htmlToText('<p>a</p><script>bad()</script><p>b &amp; c</p>'), 'a\nb & c');
});
