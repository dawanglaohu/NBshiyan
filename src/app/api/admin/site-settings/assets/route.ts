import { handleListAssets, handleUploadAsset } from '@/lib/server/public-assets-admin';
import { publicAssetDeps } from '@/lib/server/public-assets-deps';
import { requireAdmin } from '@/lib/server/auth';

/** 鉴权在这里传入：仅 ADMIN（角色表见 PUBLIC_ASSET_ROLES） */
const deps = { ...publicAssetDeps, requireAdmin: (req: Request, roles: Parameters<typeof requireAdmin>[1]) => requireAdmin(req, roles) };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 图片库：未删除的图片列表（仅 ADMIN） */
export async function GET(req: Request) {
  return handleListAssets(req, deps);
}

/** #350 上传图片（multipart，字段 file；≤10 MB；JPEG/PNG/WebP → 两种尺寸 WebP；仅 ADMIN） */
export async function POST(req: Request) {
  return handleUploadAsset(req, deps);
}
