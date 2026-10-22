type Msgs = { [k: string]: unknown };
const isObj = (v: unknown): v is Msgs => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 缺失的文案键回落到 en：以 en 为底，当前语言有的键覆盖上去（深合并）。
 * 只合并结构，不改任何已有文案；en/ru 目前键完全一致，合并结果就是 ru.json 本身。
 */
export function withEnFallback(en: Msgs, loc: Msgs): Msgs {
  const out: Msgs = { ...en };
  for (const [k, v] of Object.entries(loc)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(en[k]) ? withEnFallback(en[k] as Msgs, v) : v;
  }
  return out;
}
