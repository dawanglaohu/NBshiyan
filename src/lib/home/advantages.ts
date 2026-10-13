// 首页「为什么选择我们」卡片：只渲染有数值的条目。
// 没有出处的数字（产能、认证、打样天数、环保比例）在 messages 里留空，
// 等 Ryan 确认后再填，页面上不出现空卡片，也不显示 TBD（Refs #99、#218）。
export type AdvEntry = { value?: unknown; label?: unknown };
export type AdvItem = { key: string; value: string; label: string };

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function visibleAdvantages(raw: unknown, keys: readonly string[]): AdvItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const src = raw as Record<string, AdvEntry | undefined>;
  const out: AdvItem[] = [];
  for (const key of keys) {
    const e = src[key];
    const value = text(e?.value);
    const label = text(e?.label);
    if (value && label) out.push({ key, value, label });
  }
  return out;
}
