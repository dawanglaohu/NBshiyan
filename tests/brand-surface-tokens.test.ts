// 产品卡和深色首页入口必须走到 11 节的 2px / 0 圆角 / 无阴影。
// 旧 .card、.entry a 声明留在原处（别的测试按原文锁定），生效的是文件后面同特异性的覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

function blocks(selector: string): string[] {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[\\n{}])\\s*${esc}\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
}

function lastProp(selector: string, prop: string): string | undefined {
  let value: string | undefined;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const body of blocks(selector)) {
    const hit = re.exec(body);
    if (hit) value = hit[1].trim();
  }
  return value;
}

test('产品卡覆盖规则：2px 黑边、0 圆角、无阴影', () => {
  const body = blocks('.card').find((b) => b.includes('--pj-border-width'));
  assert.ok(body, 'globals.css 末尾缺少 .card 的 token 覆盖');
  assert.match(body!, /border:var\(--pj-border-width\) solid var\(--pj-border\)/);
  assert.equal(lastProp('.card', 'border-radius'), 'var(--pj-radius)');
  assert.equal(lastProp('.card', 'box-shadow'), 'none');
});

test('深色产品卡和深色首页入口用白边，焦点环同色', () => {
  assert.equal(lastProp('.card.theme-premium', 'border-color'), 'var(--pj-bg)');
  assert.equal(lastProp('.entry a.theme-premium', 'border-color'), 'var(--pj-bg)');
  assert.match(blocks('.entry a.theme-premium:focus-visible').at(-1) ?? '', /outline:var\(--pj-focus-width\) solid var\(--pj-bg\)/);
  assert.equal(lastProp('.card.theme-premium :focus-visible', 'outline-color'), 'var(--pj-bg)');
});
