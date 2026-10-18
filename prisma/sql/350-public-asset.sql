-- #350 图片上传：新表 "PublicAsset"。只供评审核对（review-only），不要手工执行。
-- 仓库仍用 `prisma db push`（launch-runbook.md、deploy/deploy.sh），不加 --accept-data-loss。
-- 下面是 `prisma migrate diff`（main ec18586 的 schema → 本分支 schema）生成的全部语句，原样照抄；db push 实际执行的也只有这些。
-- 只新增：1 张新表 + 2 个普通索引。不改、不删任何已有表、列、枚举。deploy/plan-check.sh 的 plan_problems 对这份计划无输出。
-- NOT NULL 只出现在新表的 CREATE TABLE 里（表是空的），不是对已有列 SET NOT NULL。

-- CreateTable
CREATE TABLE "PublicAsset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'about',
    "smKey" TEXT NOT NULL,
    "smWidth" INTEGER NOT NULL,
    "smHeight" INTEGER NOT NULL,
    "smBytes" INTEGER NOT NULL,
    "lgKey" TEXT NOT NULL,
    "lgWidth" INTEGER NOT NULL,
    "lgHeight" INTEGER NOT NULL,
    "lgBytes" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PublicAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublicAsset_kind_deletedAt_createdAt_idx" ON "PublicAsset"("kind", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "PublicAsset_sha256_idx" ON "PublicAsset"("sha256");

