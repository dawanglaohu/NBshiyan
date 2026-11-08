import messages from 'virtual:en-messages';

/**
 * next-intl 只读替身：文案直接取自仓库 messages/en.json（非手写字符串）。
 * 支持 namespace、点号路径、t.has()、t.raw() 与 {vars} 插值，覆盖被挂载组件用到的 API。
 */
function pick(node: unknown, keys: string[]): unknown {
  let cur = node;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function format(value: string, vars?: Record<string, unknown>) {
  return vars ? value.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : value;
}

export const useLocale = () => 'en';

export function useTranslations(namespace?: string) {
  const base = namespace ? namespace.split('.') : [];
  const t = (key: string, vars?: Record<string, unknown>) => {
    const value = pick(messages, [...base, ...key.split('.')]);
    return typeof value === 'string' ? format(value, vars) : key;
  };
  return Object.assign(t, {
    has: (key: string) => typeof pick(messages, [...base, ...key.split('.')]) === 'string',
    raw: (key: string) => pick(messages, [...base, ...key.split('.')]),
  });
}

export function NextIntlClientProvider({ children }: { children?: unknown }) {
  return children as never;
}
