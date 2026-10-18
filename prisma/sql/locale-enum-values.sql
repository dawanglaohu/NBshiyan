-- 多语言第 0 期前置：Prisma `enum Locale` 追加 es/de/fr/ja/hi/ar。只供评审核对（review-only），不要手工执行。
-- 仓库仍用 `prisma db push`（launch-runbook.md、deploy/deploy.sh），不加 --accept-data-loss。
-- 下面 6 行就是 `prisma migrate diff`（main 0038eee 的 schema → 本分支 schema）生成的全部语句，原样照抄；
-- db push 实际执行的也只有这些。只新增枚举值，不改、不删、不重排已有的 en/ru，不动任何表或列。
-- deploy/plan-check.sh 的白名单本来就放行 `ALTER TYPE … ADD VALUE`（plan_problems 对这份计划无输出）。
-- 线上 Postgres 17（deploy/docker-compose.yml）：PG ≥ 12 允许在事务块里 ADD VALUE（新值在同一事务里不能被使用，本次也不使用）。
-- 如需手工补救，可改写成幂等形式：ALTER TYPE "Locale" ADD VALUE IF NOT EXISTS 'es'; 以此类推。

-- AlterEnum
ALTER TYPE "Locale" ADD VALUE 'es';
ALTER TYPE "Locale" ADD VALUE 'de';
ALTER TYPE "Locale" ADD VALUE 'fr';
ALTER TYPE "Locale" ADD VALUE 'ja';
ALTER TYPE "Locale" ADD VALUE 'hi';
ALTER TYPE "Locale" ADD VALUE 'ar';
