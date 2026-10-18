import { NextResponse } from 'next/server';
import type { Prisma, Role, User } from '@prisma/client';
import type { PrivateStorage } from './storage';
import type { SiteSettingsStore } from './site-settings-admin';
import type { AboutImagesLock } from './about-images-lock';
import { ABOUT_IMAGES_KEY, parseStoredAboutImages } from './site-settings-model';
import {
  PUBLIC_ASSET_ID_RE, PUBLIC_ASSET_KIND, PUBLIC_ASSET_SIZES, processPublicImage, publicAssetKey, publicAssetUrl, readUploadFile, sha256Hex,
  type PublicAssetWarning,
} from './public-assets';
import { sniffImage } from './uploads';

/**
 * #350 PublicAsset 后台接口（上传 / 列表 / 删除）。路由文件只负责接线并传入 requireAdmin，逻辑在这里，依赖可注入，测试不连库。
 * 顺序：requireAdmin(['ADMIN']) → assertSameOrigin（改动类）→ enforceAdminRateLimit（按 IP）→ 上传另按管理员 enforceAdminUserRateLimit → 读请求体 → 处理 → 写存储 → 写库 → 审计。
 */
export const PUBLIC_ASSET_ROLES: Role[] = ['ADMIN']; // SALES / EDITOR 403
export const AUDIT_ASSET_UPLOAD = 'site.asset.upload';
export const AUDIT_ASSET_DELETE = 'site.asset.delete';
/** 上传：每个管理员（user id）每分钟 20 次（全栈）；同一 IP 再兜底每分钟 120 次（默认值），同一出口 IP 的多个管理员互不挤占 */
export const ASSET_UPLOAD_RATE = 20;
export const ASSET_UPLOAD_IP_RATE = 120;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const err = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });

export type PublicAssetRow = {
  id: string; kind: string;
  smKey: string; smWidth: number; smHeight: number; smBytes: number;
  lgKey: string; lgWidth: number; lgHeight: number; lgBytes: number;
  bytes: number; sha256: string; createdBy: string | null; createdAt: Date; deletedAt: Date | null; deletedBy: string | null;
};
export type NewPublicAsset = Omit<PublicAssetRow, 'createdAt' | 'deletedAt' | 'deletedBy'>;

export interface PublicAssetRepo {
  findLiveBySha(kind: string, sha256: string): Promise<PublicAssetRow | null>;
  findLive(ids: string[]): Promise<PublicAssetRow[]>;
  listLive(kind: string): Promise<PublicAssetRow[]>;
  create(row: NewPublicAsset): Promise<PublicAssetRow>;
  /** 只把未删除的那一行标记为删除；返回被标记的行，已删除或不存在返回 null */
  markDeleted(id: string, by: string, at: Date): Promise<PublicAssetRow | null>;
}

type Db = {
  publicAsset: {
    findFirst(a: object): Promise<PublicAssetRow | null>;
    findMany(a: object): Promise<PublicAssetRow[]>;
    create(a: { data: NewPublicAsset }): Promise<PublicAssetRow>;
    updateMany(a: object): Promise<{ count: number }>;
    findUnique(a: { where: { id: string } }): Promise<PublicAssetRow | null>;
  };
};
export function prismaPublicAssetRepo(db: Db): PublicAssetRepo {
  return {
    findLiveBySha: (kind, sha256) => db.publicAsset.findFirst({ where: { kind, sha256, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    findLive: (ids) => (ids.length ? db.publicAsset.findMany({ where: { id: { in: ids }, deletedAt: null } }) : Promise.resolve([])),
    listLive: (kind) => db.publicAsset.findMany({ where: { kind, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 200 }),
    create: (data) => db.publicAsset.create({ data }),
    async markDeleted(id, by, at) {
      const r = await db.publicAsset.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: at, deletedBy: by } });
      return r.count === 1 ? db.publicAsset.findUnique({ where: { id } }) : null;
    },
  };
}

export type PublicAssetDeps = {
  requireAdmin(req: Request, roles: Role[]): Promise<{ user: User; ip: string | null } | Response>;
  assertSameOrigin(req: Request): Response | null;
  enforceAdminRateLimit(req: Request, key: string, limit?: number): Promise<Response | null>;
  enforceAdminUserRateLimit(userId: string, key: string, limit?: number): Promise<Response | null>;
  storage: Pick<PrivateStorage, 'put' | 'delete'>;
  repo: PublicAssetRepo;
  /** 只给列表的 inUse 提示用（不加锁）；删除时的引用检查走 aboutImagesLock */
  settings: Pick<SiteSettingsStore, 'readMany'>;
  /** about.images 引用锁：删除时在锁内查引用并软删除（和保存 about.images 互斥），见 about-images-lock.ts */
  aboutImagesLock: AboutImagesLock;
  audit(e: { actorId: string; action: string; target: string; meta: Prisma.InputJsonValue; ip: string | null }): Promise<void>;
  revalidate(): void;
  newId(): string;
  now(): Date;
};

export type PublicAssetView = {
  id: string; kind: string;
  /** 大图（lg）的宽高，用于占位比例 */
  width: number; height: number;
  sm: { url: string; width: number; height: number; bytes: number };
  lg: { url: string; width: number; height: number; bytes: number };
  bytes: number; createdAt: string;
};
export const assetView = (r: PublicAssetRow): PublicAssetView => ({
  id: r.id, kind: r.kind, width: r.lgWidth, height: r.lgHeight,
  sm: { url: publicAssetUrl(r.id, r.smKey === r.lgKey ? 'lg' : 'sm'), width: r.smWidth, height: r.smHeight, bytes: r.smBytes },
  lg: { url: publicAssetUrl(r.id, 'lg'), width: r.lgWidth, height: r.lgHeight, bytes: r.lgBytes },
  bytes: r.bytes, createdAt: r.createdAt.toISOString(),
});
const warningsFor = (r: Pick<PublicAssetRow, 'lgWidth' | 'lgHeight'>): PublicAssetWarning[] => (Math.max(r.lgWidth, r.lgHeight) < PUBLIC_ASSET_SIZES.lg ? ['image_small'] : []);

const STATUS = { file_too_large: 413, unsupported_type: 415, image_too_small: 422, image_too_large_dimensions: 422, processing_failed: 422 } as const;

/** POST /api/admin/site-settings/assets（multipart，字段 file） */
export async function handleUploadAsset(req: Request, d: PublicAssetDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, PUBLIC_ASSET_ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = d.assertSameOrigin(req)
    ?? (await d.enforceAdminRateLimit(req, 'site_assets.upload', ASSET_UPLOAD_IP_RATE))
    ?? (await d.enforceAdminUserRateLimit(ctx.user.id, 'site_assets.upload', ASSET_UPLOAD_RATE));
  if (blocked) return blocked;
  const f = await readUploadFile(req);
  if (!f.ok) return err(f.error, f.status);
  if (!sniffImage(f.data)) return err('unsupported_type', 415);

  // 同一张图（原图 sha256 相同）重复上传：复用已有记录，不再处理、不再写文件
  const sha = sha256Hex(f.data);
  const dup = await d.repo.findLiveBySha(PUBLIC_ASSET_KIND, sha);
  if (dup) return NextResponse.json({ ...assetView(dup), warnings: warningsFor(dup), deduplicated: true }, { status: 200, headers: NO_STORE });

  const p = await processPublicImage(f.data);
  if (!p.ok) return err(p.error, STATUS[p.error]);

  const id = d.newId();
  if (!PUBLIC_ASSET_ID_RE.test(id)) throw new Error('bad asset id');
  const now = d.now();
  const lgKey = publicAssetKey(id, p.same ? 'one' : 'lg', now);
  const smKey = p.same ? lgKey : publicAssetKey(id, 'sm', now);
  const written: string[] = [];
  let row: PublicAssetRow;
  try {
    await d.storage.put(lgKey, p.lg.data, 'image/webp'); written.push(lgKey);
    if (!p.same) { await d.storage.put(smKey, p.sm.data, 'image/webp'); written.push(smKey); }
    row = await d.repo.create({
      id, kind: PUBLIC_ASSET_KIND,
      smKey, smWidth: p.sm.width, smHeight: p.sm.height, smBytes: p.sm.data.length,
      lgKey, lgWidth: p.lg.width, lgHeight: p.lg.height, lgBytes: p.lg.data.length,
      bytes: p.bytes, sha256: p.sha256, createdBy: ctx.user.id,
    });
  } catch (e) {
    await Promise.all(written.map((k) => d.storage.delete(k).catch(() => {})));
    throw e;
  }
  await d.audit({ actorId: ctx.user.id, action: AUDIT_ASSET_UPLOAD, target: id, meta: { kind: PUBLIC_ASSET_KIND, bytes: p.bytes, lg: [p.lg.width, p.lg.height], sm: [p.sm.width, p.sm.height] }, ip: ctx.ip });
  return NextResponse.json({ ...assetView(row), warnings: p.warnings, deduplicated: false }, { status: 201, headers: NO_STORE });
}

/** 哪些地方引用了这张图：目前只有 about.images（各语言 imageMeta 里的 alt 不算引用） */
const idsIn = (aboutImages: unknown) => new Set(parseStoredAboutImages(aboutImages).items.map((i) => i.id));
async function referencedIds(d: PublicAssetDeps): Promise<Set<string>> {
  const raw = await d.settings.readMany([ABOUT_IMAGES_KEY]);
  return idsIn(raw[ABOUT_IMAGES_KEY]);
}

/** GET /api/admin/site-settings/assets：未删除的图片（最新的在前，最多 200 张），带 inUse */
export async function handleListAssets(req: Request, d: PublicAssetDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, PUBLIC_ASSET_ROLES);
  if (ctx instanceof Response) return ctx;
  const limited = await d.enforceAdminRateLimit(req, 'site_assets.view');
  if (limited) return limited;
  const [rows, used] = await Promise.all([d.repo.listLive(PUBLIC_ASSET_KIND), referencedIds(d)]);
  return NextResponse.json({ assets: rows.map((r) => ({ ...assetView(r), warnings: warningsFor(r), inUse: used.has(r.id) })) }, { headers: NO_STORE });
}

/** DELETE /api/admin/site-settings/assets/[id]：只能删未被 about.images 引用的图片；锁内查引用 + 软删除，提交后删除文件 */
export async function handleDeleteAsset(req: Request, id: string, d: PublicAssetDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, PUBLIC_ASSET_ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = d.assertSameOrigin(req) ?? (await d.enforceAdminRateLimit(req, 'site_assets.delete', 30));
  if (blocked) return blocked;
  if (!PUBLIC_ASSET_ID_RE.test(id)) return err('not_found', 404);
  const [live] = await d.repo.findLive([id]);
  if (!live) return err('not_found', 404);
  // 查引用和软删除在同一个事务、同一把 about.images 锁下（保存 about.images 也拿这把锁），中间插不进一次保存
  const r = await d.aboutImagesLock.run(async (tx) => {
    if (idsIn(tx.current).has(id)) return 'in_use' as const;
    return tx.markAssetDeleted(id, ctx.user.id, d.now());
  });
  if (r === 'in_use') return err('asset_in_use', 409, { usedBy: [ABOUT_IMAGES_KEY] });
  const row = r;
  if (!row) return err('not_found', 404);
  // 事务已提交，再删文件；文件删不掉不影响结果：记录已标记删除，公开地址已经 404
  for (const k of new Set([row.smKey, row.lgKey])) await d.storage.delete(k).catch((e) => console.error('[public-asset] storage delete failed', { id, name: (e as Error)?.name }));
  await d.audit({ actorId: ctx.user.id, action: AUDIT_ASSET_DELETE, target: id, meta: { kind: row.kind }, ip: ctx.ip });
  d.revalidate();
  return NextResponse.json({ id, deleted: true }, { headers: NO_STORE });
}

