// gate-harden verify: test PR, do not merge
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { fileRoute } from '@/lib/server/file-response';
import { handleMedia } from '@/lib/server/public-assets-media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 公开图片 /media/<id>-<w>.webp（PublicAsset）。fileRoute 让 404 / 500 也带 FILE_CSP + nosniff */
export const GET = fileRoute(async (_req: Request, { params }: { params: Promise<{ file: string }> }) => {
  const { file } = await params;
  return handleMedia(file, {
    findLive: (id) => prisma.publicAsset.findFirst({ where: { id, deletedAt: null } }),
    storage,
  });
});
