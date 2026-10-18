-- #347 方案 A 一次性绑定令牌：User 表新增 2 列。只供评审核对（review-only），不要手工执行。
-- 仓库仍用 `prisma db push`（deploy/deploy.sh schema_sync），不加 --accept-data-loss。
-- 下面的语句就是 `prisma migrate diff --from-schema-datamodel <main ffc3de3 的 schema> --to-schema-datamodel prisma/schema.prisma --script`
-- 的全部输出，原样照抄；db push 实际执行的也只有这些。只加两个可空列，不改、不删已有列，不加约束、索引和默认值。
-- 线上 Postgres 17：ADD COLUMN 可空、无默认值只改目录，不重写表；User 表行数很少。
-- 旧代码不读这 2 列，回滚应用版本不需要回滚表结构（回滚后 enroll 又只凭密码，等于回到 #361 的状态）。
-- 上线时已存在、还没绑定 2FA 的账号这两列为空 → enroll/confirm 一律 401，需要用后台「重置 2FA」或 CLI 重新签发链接。

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "enrollTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "enrollTokenHash" TEXT;

