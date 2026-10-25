import { test as base, expect, type Page } from '@playwright/test';

// 所有外部请求一律拦截（CI 无外网），Turnstile 脚本用本地桩替代。
// 桩按真实 API 行为：只有显式 render() 才会出控件（不再自动扫描 .cf-turnstile），这样 #181 这类重挂载问题能被测出来。
const TURNSTILE_STUB = `(() => { let n = 0; const w = {};
  const issue = (id) => { const x = w[id]; if (!x) return; x.input.value = 'XXXX.DUMMY.TOKEN.' + (++n); x.opts.callback && x.opts.callback(x.input.value); };
  window.turnstile = {
    render(el, opts) { const id = 'w' + (++n); const i = document.createElement('input'); i.type = 'hidden'; i.name = 'cf-turnstile-response'; el.appendChild(i); w[id] = { el, opts, input: i }; issue(id); return id; },
    reset(id) { if (id) issue(id); else Object.keys(w).forEach(issue); },
    remove(id) { const x = w[id]; if (x) { x.input.remove(); delete w[id]; } }
  }; })();`;

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

// 测试夹具直接写 localStorage。产品里的新写入一律 chat:false；'all' 只打开分析。
export async function consent(page: Page, value: 'all' | 'none') {
  await page.evaluate((all) => {
    const value = { v: 2, analytics: all, chat: false, ts: Date.now() };
    localStorage.setItem('pj-consent', JSON.stringify(value));
    window.dispatchEvent(new CustomEvent('pj:consent', { detail: value }));
  }, value === 'all');
}
