import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * M3-T22 未归类邮件视觉迁移的组件/源码守卫。
 * 真实服务、ADMIN 导航无入口、直达 404、零请求与三尺寸截图由
 * e2e/admin-legacy-unassigned-gate.spec.ts 在 CI 跑；本文件只锁：
 * 组件证据、mail.css 专属选择器消费 --pj-* 同源值、旧字面量与 M3-T21 共享块不被改写、
 * 邮件功能保持关闭、业务/回调/可访问语义不丢。
 */
const read = (p: string) => readFileSync(p, 'utf8');
const css = read('src/app/admin/mail.css');
const inbox = read('src/components/admin/mail/UnassignedInbox.tsx');
const nav = read('src/components/admin/mail/UnassignedNav.tsx');
const page = read('src/app/admin/mail/unassigned/page.tsx');
const shell = read('src/components/admin/AdminShell.tsx');
const features = read('src/lib/admin/mail/features.ts');
const tokens = read('src/styles/tokens.css');
const gateSpec = read('e2e/admin-legacy-unassigned-gate.spec.ts');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取 M3-T22 追加块（文件末尾到最后一条 M3-T22 注释之后）。 */
function t22Block(text: string): string {
  const at = text.indexOf('/* M3-T22');
  assert.ok(at >= 0, '缺少 M3-T22 追加块');
  return strip(text.slice(at));
}

function selectorsOf(block: string): string[] {
  return [...block.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].replace(/^\s*[\r\n]+/gm, '').trim())
    .filter((s) => !/^@media\b/.test(s));
}

function checkBlock(text: string): void {
  const block = t22Block(text);
  assert.doesNotMatch(block, /border:\s*1px\b/, '专属块不得写死 1px 边界');
  assert.doesNotMatch(block, /border-radius:\s*(?:4|6|8|10|12|999)px/, '不得写死旧圆角');
  assert.doesNotMatch(block, /(?:linear|radial|conic)-gradient/, '不得新增渐变');
  assert.match(block, /var\(--pj-border-width\)/);
  assert.match(block, /var\(--pj-radius\)/);
  assert.match(block, /var\(--pj-shadow\)/);
  assert.match(block, /var\(--pj-accent\)/);
  assert.match(block, /var\(--pj-touch-target\)/);
  assert.match(block, /var\(--pj-admin-block-gap\)/);
  assert.match(block, /var\(--pj-ui-size\)/);
  assert.match(block, /var\(--pj-ui-line\)/);
  for (const sel of selectorsOf(block)) {
    assert.match(sel, /^\.ml\b/, `专属块规则必须限定 .ml 作用域：${sel}`);
    assert.doesNotMatch(sel, /^\.adm-|^\.pj-|^(?:button|input|td|th|select|textarea)\b/, `不得裸改公共/全局选择器：${sel}`);
  }
}

test('唯一 minimalist-flat token：2px / 0 圆角 / 无阴影 / #b45700 / 44px', () => {
  assert.match(tokens, /--pj-border-width:2px/);
  assert.match(tokens, /--pj-radius:0px/);
  assert.match(tokens, /--pj-shadow:none/);
  assert.match(tokens, /--pj-accent:#b45700/);
  assert.match(tokens, /--pj-touch-target:44px/);
  assert.match(tokens, /--pj-admin-block-gap:16px/);
  assert.match(tokens, /--pj-ui-size:14px/);
  assert.match(tokens, /--pj-ui-line:20px/);
});

test('mail.css：M3-T22 专属块在 M3-T21 之后，只消费 token 且作用域限定 .ml', () => {
  const t21 = css.indexOf('/* M3-T21');
  const t22 = css.indexOf('/* M3-T22');
  assert.ok(t21 >= 0 && t22 > t21, 'M3-T22 块必须追加在 M3-T21 共享块之后');
  checkBlock(css);
  // 负控：写死 1px 或旧圆角必须被守卫发现（只改 T22 追加块，不动 T21 共享块）。
  const at = css.indexOf('/* M3-T22');
  const head = css.slice(0, at);
  const block = css.slice(at);
  const brokenBorder = head + block.replace(/border:var\(--pj-border-width\) solid var\(--pj-border\)/, 'border:1px solid var(--pj-border)');
  assert.notEqual(brokenBorder, css);
  assert.throws(() => checkBlock(brokenBorder));
  const brokenRadius = head + block.replace(/border-radius:var\(--pj-radius\)/, 'border-radius:8px');
  assert.notEqual(brokenRadius, css);
  assert.throws(() => checkBlock(brokenRadius));
});

test('旧 .ml-* 基础字面量与 M3-T21 共享块逐字保留（只在其后覆盖）', () => {
  assert.match(css, /\.ml-inbox\{display:grid;grid-template-columns:minmax\(280px,380px\) 1fr;gap:16px/);
  assert.match(css, /\.ml-list\{list-style:none;margin:0;padding:0;background:var\(--surface\);border:1px solid var\(--line\);border-radius:12px/);
  assert.match(css, /\.ml-btn\{white-space:nowrap;min-height:44px;min-width:44px;padding:0 16px;border-radius:8px/);
  assert.match(css, /\.ml .ml-msg/);
  assert.ok(css.indexOf('/* M3-T21') > css.indexOf('.ml-btn{'));
});

test('两项 LIVE 开关保持 false，入口渲染条件仍要求 ADMIN 且 gate 未关闭', () => {
  assert.match(features, /UNASSIGNED_MAIL_LIVE = false as boolean/);
  assert.match(features, /MAIL_ATTACHMENTS_LIVE = false as boolean/);
  assert.match(shell, /UNASSIGNED_MAIL_LIVE && mailEnabled && mailGate\.state !== 'off' && role === 'ADMIN' && <UnassignedNav/);
  assert.match(page, /if \(!UNASSIGNED_MAIL_LIVE\) notFound\(\)/);
  assert.match(page, /if \(!mailEnabled\) notFound\(\)/);
  assert.match(page, /enforceAdminPage\(\['ADMIN'\], '\/admin\/mail\/unassigned'\)/);
});

test('UnassignedNav：关闭时不渲染、不启动轮询；轮询只在 LiveNav 内且清理监听', () => {
  assert.match(nav, /return UNASSIGNED_MAIL_LIVE \? <LiveNav active=\{active\} \/> : null/);
  assert.match(nav, /mailApi\.unassignedCount\(\)/);
  assert.match(nav, /setInterval\(tick, 60_000\)/);
  assert.match(nav, /clearInterval\(t\)/);
  assert.match(nav, /removeEventListener\('visibilitychange', vis\)/);
  assert.match(nav, /data-testid="unassigned-nav-link"/);
});

test('UnassignedInbox：移除内联旧间距，组件证据钩子就位，回调与可访问语义保留', () => {
  assert.doesNotMatch(inbox, /style=\{\{ marginTop: 16 \}\}/);
  assert.doesNotMatch(inbox, /marginTop/);
  for (const tid of ['unassigned-inbox', 'unassigned-tabs', 'unassigned-list', 'unassigned-detail', 'unassigned-toast']) {
    assert.match(inbox, new RegExp(`data-testid="${tid}"`), `缺少组件证据钩子 ${tid}`);
  }
  for (const pat of [
    /mailApi\.listUnassigned\(t\)/,
    /mailApi\.getUnassigned\(sel\)/,
    /mailApi\.ignore\(id\)/,
    /mailApi\.unignore\(id\)/,
    /mailApi\.assignLookup\(r\)/,
    /mailApi\.assign\(d\.id, hit\.ref\)/,
    /expiresText\(r\.expiresAt\)/,
    /FlagChips flags=\{r\.flags\}/,
    /FlagBanners flags=\{d\.flags\}/,
    /aria-pressed=\{tab === 'UNASSIGNED'\}/,
    /aria-current=\{sel === r\.id \? 'true' : undefined\}/,
    /role="status"/,
    /role="alert"/,
    /role="dialog" aria-modal="true"/,
  ]) assert.match(inbox, pat);
  // 附件入口仍由开关控制；关闭时不得渲染下载卡片。
  assert.match(inbox, /MAIL_ATTACHMENTS_LIVE && d\.attachments\.filter/);
  assert.match(inbox, /📎 \{r\.attachmentCount\}/);
});

test('不新增后端/接口路径，不改共享 MailParts/MailThread', () => {
  const appFiles = inbox + nav + page;
  assert.doesNotMatch(appFiles, /\/api\/admin\/mail\/(?:assign|ignore|unassigned)\/route/);
  assert.doesNotMatch(appFiles, /fetch\(['"]\/api\//);
  assert.match(inbox, /from '\.\/MailParts'/);
  assert.doesNotMatch(inbox, /from '\.\/MailThread'/);
});

test('门禁 e2e 采证覆盖：ADMIN 无入口、直达 404、零相关请求、三尺寸截图', () => {
  assert.match(gateSpec, /CLOSED_API/);
  assert.match(gateSpec, /unassigned\|assign-lookup\|assign\|ignore\|attachments/);
  assert.match(gateSpec, /\/api\/admin\/account/);
  assert.match(gateSpec, /expect\([^)]*status\(\)\)\.toBe\(404\)/);
  assert.match(gateSpec, /width: 1920, height: 1080/);
  assert.match(gateSpec, /width: 1440, height: 900/);
  assert.match(gateSpec, /width: 390, height: 844/);
  assert.match(gateSpec, /screenshot/);
  // 关闭页面不在 DOM 中：不能把密度/computed style 填成通过。
  assert.match(gateSpec, /not-rendered|not\.toContainText|count\(\)\)\.toBe\(0\)/);
});
