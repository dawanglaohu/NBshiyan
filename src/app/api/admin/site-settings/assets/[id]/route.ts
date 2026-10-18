import { handleDeleteAsset } from '@/lib/server/public-assets-admin';
import { publicAssetDeps } from '@/lib/server/public-assets-deps';
import { requireAdmin } from '@/lib/server/auth';

/** 鉴权在这里传入：仅 ADMIN（角色表见 PUBLIC_ASSET_ROLES） */
const deps = { ...publicAssetDeps, requireAdmin: (req: Request, roles: Parameters<typeof requireAdmin>[1]) => requireAdmin(req, roles) };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type P = { params: Promise<{ id: string }> };

/** #350 删除图片：被 about.images 引用时 409 asset_in_use（仅 ADMIN） */
export async function DELETE(req: Request, { params }: P) {
  const { id } = await params;
  return handleDeleteAsset(req, id, deps);
}
