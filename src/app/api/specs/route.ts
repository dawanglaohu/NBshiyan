import { NextResponse } from 'next/server';
import { loadSpecs } from '@/lib/server/specs-public';
import { PUBLIC_CACHE, CATEGORY_KEYS, publicView, hasPublicFields, parseLocale } from '@/lib/server/specs';

export const runtime = 'nodejs';


/** GET /api/specs?locale=en|ru：所有已填写规格的品类（按 categoryMeta 顺序），未填写的字段省略 */
export async function GET(req: Request) {
  const locale = parseLocale(new URL(req.url).searchParams.get('locale'));
  if (!locale) return NextResponse.json({ error: 'invalid_locale' }, { status: 400 });
  const rows = new Map((await loadSpecs()).map((r) => [r.category, r]));
  const specs = CATEGORY_KEYS.map((k) => publicView(k, rows.get(k) ?? null, locale)).filter(hasPublicFields);
  return NextResponse.json({ locale, specs }, { headers: PUBLIC_CACHE });
}
