import { revalidatePath, revalidateTag } from 'next/cache';
import { SITE_SETTINGS_TAG } from '@/lib/server/site-settings-model';

export const dynamic = 'force-dynamic';

const PATHS = ['/en', '/ru', '/en/about', '/ru/about'] as const;

/** Test-only cache bust. Production has no E2E_SITE_REVALIDATE, so this stays a 404. */
export async function POST() {
  if (process.env.E2E_SITE_REVALIDATE !== '1') {
    return new Response(null, { status: 404 });
  }
  revalidateTag(SITE_SETTINGS_TAG);
  revalidatePath('/sitemap.xml');
  for (const path of PATHS) revalidatePath(path);
  revalidatePath('/en', 'layout');
  revalidatePath('/ru', 'layout');
  return new Response(null, { status: 204 });
}
