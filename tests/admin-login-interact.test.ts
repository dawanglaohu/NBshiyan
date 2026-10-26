import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3100/admin-login' });
const { window } = dom;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.HTMLElement = window.HTMLElement;
globals.HTMLInputElement = window.HTMLInputElement;
globals.HTMLButtonElement = window.HTMLButtonElement;
globals.Element = window.Element;
globals.Node = window.Node;
globals.DocumentFragment = window.DocumentFragment;
globals.MutationObserver = window.MutationObserver;
globals.SVGElement = window.SVGElement;
globals.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof globalThis.getComputedStyle !== 'function') globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.HTMLElement.prototype.scrollIntoView = () => {};

type Result = { error?: string | null; code?: string | null } | undefined;
const queued: Result[] = [];
const calls: unknown[] = [];
const signInFn = (async (_provider: string, options?: unknown) => {
  calls.push(options);
  return queued.shift();
}) as typeof import('next-auth/react').signIn;

const loaded = (async () => {
  const React = await import('react');
  (globalThis as unknown as { React?: typeof React }).React = React;
  const rtl = await import('@testing-library/react');
  const { default: LoginForm } = await import('../src/components/admin/auth/LoginForm');
  return { React, LoginForm, ...rtl };
})();

async function form() {
  const { React, LoginForm, render, screen, fireEvent, cleanup } = await loaded;
  cleanup();
  calls.length = 0;
  queued.length = 0;
  const view = render(React.createElement(LoginForm, { callbackUrl: '/admin/settings', initialLang: 'zh', signInFn }));
  await view.findByRole('button', { name: '登录' });
  const submit = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement;
  await screen.findByRole('button', { name: '登录' });
  if (submit.disabled) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { screen, fireEvent, submit: screen.getByRole('button', { name: '登录' }) as HTMLButtonElement };
}

test('the eye button switches its accessible name and has no pressed state', async () => {
  const { screen, fireEvent } = await form();
  const toggle = screen.getByRole('button', { name: '显示密码' });
  assert.equal(toggle.hasAttribute('aria-pressed'), false);
  assert.equal(toggle.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  fireEvent.click(toggle);
  const hidden = screen.getByRole('button', { name: '隐藏密码' });
  assert.equal(hidden.hasAttribute('aria-pressed'), false);
  assert.equal((screen.getByLabelText('密码') as HTMLInputElement).type, 'text');
  fireEvent.click(hidden);
  assert.equal(screen.getByRole('button', { name: '显示密码' }).hasAttribute('aria-pressed'), false);
  assert.equal((screen.getByLabelText('密码') as HTMLInputElement).type, 'password');
});

test('an empty email does not clear the password or send a request', async () => {
  const { screen, fireEvent, submit } = await form();
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-value' } });
  fireEvent.click(submit);
  assert.equal(calls.length, 0);
  assert.equal((screen.getByLabelText('密码') as HTMLInputElement).value, 'secret-value');
  assert.match(screen.getByRole('alert').textContent ?? '', /邮箱或密码不正确/);
});

test('a rejected sign-in clears the password only after the request is sent', async () => {
  const { screen, fireEvent, submit } = await form();
  queued.push({ error: 'CredentialsSignin', code: 'credentials' });
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'ada@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-value' } });
  fireEvent.click(submit);
  await screen.findByRole('alert');
  assert.equal(calls.length, 1);
  assert.equal((screen.getByLabelText('密码') as HTMLInputElement).value, '');
});

test('back clears the password and hides it again', async () => {
  const { screen, fireEvent, submit } = await form();
  queued.push({ error: 'CredentialsSignin', code: 'totp_required' });
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'ada@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-value' } });
  fireEvent.click(screen.getByRole('button', { name: '显示密码' }));
  fireEvent.click(submit);
  const back = await screen.findByRole('button', { name: '返回' });
  fireEvent.click(back);
  const password = await screen.findByLabelText('密码') as HTMLInputElement;
  assert.equal(password.value, '');
  assert.equal(password.type, 'password');
  const toggle = screen.getByRole('button', { name: '显示密码' });
  assert.equal(toggle.hasAttribute('aria-pressed'), false);
});

test('an invalid challenge focuses the empty hidden password', async () => {
  const { screen, fireEvent, submit } = await form();
  queued.push({ error: 'CredentialsSignin', code: 'totp_required' });
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'ada@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-value' } });
  fireEvent.click(screen.getByRole('button', { name: '显示密码' }));
  fireEvent.click(submit);
  const code = await screen.findByLabelText('验证码');
  queued.push({ error: 'CredentialsSignin', code: 'challenge_invalid' });
  fireEvent.change(code, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  const password = await screen.findByLabelText('密码') as HTMLInputElement;
  assert.equal(password.value, '');
  assert.equal(password.type, 'password');
  assert.equal(document.activeElement, password);
  assert.match(screen.getByRole('alert').textContent ?? '', /验证已超时/);
  assert.equal(screen.getByRole('button', { name: '显示密码' }).hasAttribute('aria-pressed'), false);
});
