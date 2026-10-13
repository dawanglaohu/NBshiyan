import { test as base, expect, type Page } from '@playwright/test';

// 所有外部请求一律拦截（CI 无外网），Turnstile 脚本用本地桩替代：给 .cf-turnstile 注入测试 token。
const TURNSTILE_STUB = `(() => { const r = () => document.querySelectorAll('.cf-turnstile').forEach((el) => {
  if (el.querySelector('input[name="cf-turnstile-response"]')) return;
  const i = document.createElement('input'); i.type = 'hidden'; i.name = 'cf-turnstile-response'; i.value = 'XXXX.DUMMY.TOKEN.XXXX'; el.appendChild(i); });
  r(); new MutationObserver(r).observe(document.documentElement, { childList: true, subtree: true }); window.turnstile = { reset() {}, render() {} }; })();`;

export type External = { urls: string[] };
export const test = base.extend<{ external: External }>({
  external: [async ({ page }, use) => {
    const ext: External = { urls: [] };
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
      const url = route.request().url();
      ext.urls.push(url);
      if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) return route.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB });
      return route.abort();
    });
    await use(ext);
  }, { auto: true }]
});
export { expect };

export async function consent(page: Page, value: string) {
  await page.evaluate((v) => { localStorage.setItem('pj-consent', v); window.dispatchEvent(new Event('pj:consent')); }, value);
}
