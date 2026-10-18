import type { Prisma } from '@prisma/client';
import type { LiveAsset } from './site-settings-admin';
import type { PublicAssetRow } from './public-assets-admin';
import { ABOUT_IMAGES_KEY } from './site-settings-model';

/**
 * #350（#374 安全审查 P3）about.images 引用锁：「删除 PublicAsset」和「保存 about.images」在同一把锁下串行。
 *
 * 之前删除是「读 about.images 看有没有引用 → 软删除」两步，保存是「查 id 是否存在且未删除 → 锁行写入」，
 * 两边的检查都在锁外，并发时保存可能引用一张刚被删掉的图（前台 404）。现在两条路径都走 run()：
 *   1. pg_advisory_xact_lock(hashtext(ABOUT_IMAGES_LOCK))：about.images 这一行还不存在时 FOR UPDATE 锁不到东西，
 *      所以先拿一把固定的事务级 advisory lock，行存在与否都能串行；随事务提交 / 回滚自动释放。
 *   2. SELECT … FROM "SiteSetting" WHERE key = 'about.images' FOR UPDATE：锁住并读出当前值（行不存在时为 null）。
 *   3. fn 在同一事务里查 PublicAsset 是否未删除、软删除、写 about.images。
 * 加锁顺序固定为 advisory lock → SiteSetting 行 → PublicAsset 行，两条路径一致，不会互相死锁。
 * 删存储里的文件不在事务里做：由调用方在 run() 返回（已提交）之后再删。
 */
export const ABOUT_IMAGES_LOCK = 'site-settings:about.images';

export interface AboutImagesTx {
  /** 加锁后读到的 about.images 原值；行不存在为 null */
  readonly current: unknown | null;
  /** 同一事务里查：存在且未删除的 PublicAsset */
  liveAssets(ids: string[]): Promise<LiveAsset[]>;
  /** 同一事务里软删除（只标记未删除的那一行）；已删除或不存在返回 null */
  markAssetDeleted(id: string, by: string, at: Date): Promise<PublicAssetRow | null>;
  /** 同一事务里写 about.images（行不存在时新建） */
  writeAboutImages(value: Prisma.InputJsonValue): Promise<void>;
}
export interface AboutImagesLock {
  run<T>(fn: (tx: AboutImagesTx) => Promise<T>): Promise<T>;
}

type Tx = {
  $executeRaw(q: TemplateStringsArray, ...v: unknown[]): Promise<number>;
  $queryRaw<T>(q: TemplateStringsArray, ...v: unknown[]): Promise<T>;
  siteSetting: {
    update(a: { where: { key: string }; data: { value: Prisma.InputJsonValue } }): Promise<unknown>;
    create(a: { data: { key: string; value: Prisma.InputJsonValue } }): Promise<unknown>;
  };
  publicAsset: {
    findMany(a: object): Promise<LiveAsset[]>;
    updateMany(a: object): Promise<{ count: number }>;
    findUnique(a: { where: { id: string } }): Promise<PublicAssetRow | null>;
  };
};
type Db = { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };

export function prismaAboutImagesLock(db: Db): AboutImagesLock {
  return {
    run: (fn) => db.$transaction(async (ptx) => {
      const tx = ptx as unknown as Tx;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ABOUT_IMAGES_LOCK}))`;
      const rows = await tx.$queryRaw<{ value: string }[]>`SELECT "value"::text AS "value" FROM "SiteSetting" WHERE "key" = ${ABOUT_IMAGES_KEY} FOR UPDATE`;
      let exists = rows.length > 0;
      const current: unknown = exists ? JSON.parse(rows[0].value) : null;
      return fn({
        current,
        liveAssets: async (ids) => (ids.length
          ? tx.publicAsset.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, smWidth: true, smHeight: true, lgWidth: true, lgHeight: true } })
          : []),
        async markAssetDeleted(id, by, at) {
          const r = await tx.publicAsset.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: at, deletedBy: by } });
          return r.count === 1 ? tx.publicAsset.findUnique({ where: { id } }) : null;
        },
        async writeAboutImages(value) {
          if (exists) await tx.siteSetting.update({ where: { key: ABOUT_IMAGES_KEY }, data: { value } });
          else { await tx.siteSetting.create({ data: { key: ABOUT_IMAGES_KEY, value } }); exists = true; }
        },
      });
    }),
  };
}
