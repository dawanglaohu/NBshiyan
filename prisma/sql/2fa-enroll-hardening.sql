-- #347 / #348 2FA 绑定加固：User 表新增 3 列。只供评审核对（review-only），不要手工执行。
-- 仓库仍用 `prisma db push`（deploy/deploy.sh schema_sync），不加 --accept-data-loss。
-- 下面的语句就是 `prisma migrate diff --from-schema-datamodel <main c9d3ce1 的 schema> --to-schema-datamodel prisma/schema.prisma --script`
-- 的全部输出，原样照抄；db push 实际执行的也只有这些。只加列，不改、不删已有列，不加约束和索引。
-- deploy/plan-check.sh：existing table 上的 ADD COLUMN 在白名单里；NOT NULL 那一列带 DEFAULT 0，所以 plan_problems 对这份计划无输出，
-- deploy.sh 会当作 additive 直接 db push，不会停下等 APPROVED_PLAN_SHA256。
-- 线上 Postgres 17：ADD COLUMN … DEFAULT 常量（PG ≥ 11）只改目录，不重写表；User 表行数很少。
-- 旧代码不读这 3 列，回滚应用版本不需要回滚表结构。
-- enrollIssuedAt 为空时代码用 createdAt 当绑定窗口起点；totpPendingUntil 为空的待确认密钥视为已过期（需重新 enroll）。

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "enrollIssuedAt" TIMESTAMP(3),
ADD COLUMN     "totpEnrollFails" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totpPendingUntil" TIMESTAMP(3);

