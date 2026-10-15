// 询价清单的纯函数（#104 / #180）：最多 20 项，与服务端 CART_MAX_ITEMS 一致；满了就拒绝添加，绝不悄悄丢掉已有项
export const QUOTE_MAX_ITEMS = 20;

export type QuoteItem = { slug: string; quantity?: number };

export type AddResult = { items: QuoteItem[]; status: 'added' | 'exists' | 'full' };

export function addQuoteItem(items: QuoteItem[], slug: string, max = QUOTE_MAX_ITEMS): AddResult {
  if (items.some((i) => i.slug === slug)) return { items, status: 'exists' };
  if (items.length >= max) return { items, status: 'full' };
  return { items: [...items, { slug }], status: 'added' };
}

/** 读取 localStorage 里的清单：只过滤格式不对的项，不截断（旧版本上限是 30，超出的项保留，由界面提示用户删减） */
export function parseQuoteItems(raw: string | null): QuoteItem[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return [];
    const seen = new Set<string>();
    return p.filter((i) => typeof i?.slug === 'string' && !seen.has(i.slug) && seen.add(i.slug))
      .map((i) => (typeof i.quantity === 'number' ? { slug: i.slug, quantity: i.quantity } : { slug: i.slug }));
  } catch {
    return [];
  }
}

/** More than the cap: block submit, never auto-trim. */
export const isOverQuoteLimit = (n: number) => n > QUOTE_MAX_ITEMS;
