import { NextResponse } from 'next/server';
import { loadSpecs } from '@/lib/server/specs-public';
import { PUBLIC_CACHE, isCategoryKey, publicView, parseLocale } from '@/lib/server/specs';

export const runtime = 'nodejs';

/** GET /api/specs/:category?locale=en|ru：未知品类 404；已知但未填写返回 { category } */
export async function GET(req: Request, { params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  if (!isCategoryKey(category)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const locale = parseLocale(new URL(req.url).searchParams.get('locale'));
  if (!locale) return NextResponse.json({ error: 'invalid_locale' }, { status: 400 });
  const row = (await loadSpecs()).find((r) => r.category === category) ?? null;
  return NextResponse.json({ locale, ...publicView(category, row, locale) }, { headers: PUBLIC_CACHE });
}
