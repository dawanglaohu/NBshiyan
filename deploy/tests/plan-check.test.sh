#!/usr/bin/env bash
# Tests for deploy/plan-check.sh (no docker, no DB). Run: bash deploy/tests/plan-check.test.sh
# GOOD samples must produce no problems; BAD samples must produce at least one.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/plan-check.sh
. "$here/../plan-check.sh"
pass=0; fail=0; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
check() {  # check good|bad <name> <sql>
  printf '%s' "$3" > "$tmp"; out=$(plan_problems "$tmp")
  if { [ "$1" = good ] && [ -z "$out" ]; } || { [ "$1" = bad ] && [ -n "$out" ]; }; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL [%s] %s\n%s\n' "$1" "$2" "${out:-<no problems reported>}"; fi
}
# ---- GOOD ----
printf '' > "$tmp"; if [ -z "$(plan_problems "$tmp")" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL empty plan"; fi
out=$(plan_problems "$here/fixtures/first-deploy-91db98e.sql")
if [ -z "$out" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL [good] first deploy (91db98e)\n%s\n' "$out"; fi
check good "prisma empty-migration comment" '-- This is an empty migration.'
check good "additive on existing table" '-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "note" TEXT,
ADD COLUMN     "flag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "price" DECIMAL(10,2) NOT NULL DEFAULT 0;
-- CreateIndex
CREATE INDEX "Inquiry_note_idx" ON "Inquiry"("note");
ALTER TYPE "InquiryStatus" ADD VALUE '"'"'ARCHIVED'"'"';
ALTER TABLE "Inquiry" ALTER COLUMN "note" SET DEFAULT '"'"'x'"'"';'
check good "new table + its unique index + FK on the new table" 'CREATE TABLE "MailThread" ("id" TEXT NOT NULL, "inquiryId" TEXT NOT NULL, CONSTRAINT "MailThread_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "MailThread_inquiryId_key" ON "MailThread"("inquiryId");
ALTER TABLE "MailThread" ADD CONSTRAINT "MailThread_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;'
check good "identifiers that contain keywords (nullable)" 'ALTER TABLE "Inquiry" ADD COLUMN "dropReason" TEXT, ADD COLUMN "renameTo" TEXT, ADD COLUMN "typeHint" TEXT;'
# ---- BAD: original classes ----
check bad "DROP TABLE" 'DROP TABLE "Old";'
check bad "drop index (lowercase)" 'drop index "Inquiry_x_idx";'
check bad "ALTER COLUMN SET DATA TYPE" 'ALTER TABLE "Inquiry" ALTER COLUMN "a" SET DATA TYPE VARCHAR(10);'
check bad "ALTER COLUMN TYPE USING" 'ALTER TABLE "Inquiry" ALTER COLUMN "a" TYPE INTEGER USING ("a"::integer);'
check bad "ALTER without COLUMN keyword TYPE" 'ALTER TABLE "Inquiry" ALTER "a" TYPE INTEGER;'
check bad "RENAME COLUMN" 'ALTER TABLE "Inquiry" RENAME COLUMN "a" TO "b";'
check bad "SET NOT NULL" 'ALTER TABLE "Inquiry" ALTER COLUMN "a" SET NOT NULL;'
check bad "DROP NOT NULL (DROP)" 'ALTER TABLE "Inquiry" ALTER COLUMN "a" DROP NOT NULL;'
check bad "CREATE UNIQUE INDEX on existing" 'CREATE UNIQUE INDEX "Inquiry_email_key" ON "Inquiry"("email");'
check bad "CREATE UNIQUE INDEX, ON on next line, schema-qualified" 'CREATE UNIQUE INDEX "k"
ON "public"."Inquiry"("email");'
check bad "ADD COLUMN NOT NULL no DEFAULT" 'ALTER TABLE "Inquiry" ADD COLUMN "b" TEXT NOT NULL;'
check bad "ADD CONSTRAINT on existing" 'ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_u_fkey" FOREIGN KEY ("u") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;'
check bad "lowercase add column not null" 'alter table "Inquiry" add column "b" text not null;'
check bad "NOT NULL split over lines" 'ALTER TABLE "Inquiry"
  ADD COLUMN "b" TEXT
  NOT NULL;'
check bad "TRUNCATE" 'TRUNCATE "Inquiry";'
check bad "DELETE FROM" 'DELETE FROM "Inquiry";'
# ---- BAD: new bypasses (P1) ----
check bad "multi-clause ALTER, 2nd NOT NULL" 'ALTER TABLE "Inquiry" ADD COLUMN "a" TEXT,
 ADD COLUMN "b" TEXT NOT NULL;'
check bad "multi-clause ALTER, 2nd ADD CONSTRAINT" 'ALTER TABLE "Inquiry" ADD COLUMN "a" TEXT,
 ADD CONSTRAINT "Inquiry_a_key" UNIQUE ("a");'
check bad '"isDefault" BOOLEAN NOT NULL' 'ALTER TABLE "Inquiry" ADD COLUMN "isDefault" BOOLEAN NOT NULL;'
check bad '"default" identifier NOT NULL' 'ALTER TABLE "Inquiry" ADD COLUMN "default" TEXT NOT NULL;'
check bad "other column has DEFAULT, NOT NULL one has not" 'ALTER TABLE "Inquiry" ADD COLUMN "a" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "b" TEXT NOT NULL;'
check bad "DEFAULT only inside a comment" 'ALTER TABLE "Inquiry" ADD COLUMN "b" TEXT NOT NULL; -- DEFAULT later'
check bad "DEFAULT only inside a string" 'ALTER TABLE "Inquiry" ADD COLUMN "a" TEXT, ADD COLUMN "b" TEXT NOT NULL CONSTRAINT "c" CHECK ("b" <> '"'"'DEFAULT'"'"');'
check bad "DECIMAL(10,2) NOT NULL (comma in parens)" 'ALTER TABLE "Inquiry" ADD COLUMN "p" DECIMAL(10,2) NOT NULL;'
check bad "semicolon inside a string" 'ALTER TABLE "Inquiry" ADD COLUMN "a" TEXT DEFAULT '"'"'x;y'"'"', ADD COLUMN "b" TEXT NOT NULL;'
check bad "ONLY + schema-qualified existing table" 'ALTER TABLE ONLY "public"."Inquiry" ADD COLUMN "b" TEXT NOT NULL;'
check bad "inline REFERENCES on existing" 'ALTER TABLE "Inquiry" ADD COLUMN "u" TEXT REFERENCES "User"("id");'
check bad "case-different new table is not the same table" 'CREATE TABLE "inquiry" ("id" TEXT NOT NULL);
ALTER TABLE "Inquiry" ADD COLUMN "b" TEXT NOT NULL;'
check bad "unrecognised statement (UPDATE)" 'UPDATE "Inquiry" SET "a" = 1;'
check bad "unrecognised statement (INSERT)" 'INSERT INTO "Inquiry" ("id") VALUES ('"'"'x'"'"');'
check bad "first deploy + one bad statement appended" "$(cat "$here/fixtures/first-deploy-91db98e.sql")
ALTER TABLE \"Admin\" ADD COLUMN \"x\" TEXT,
ADD COLUMN \"y\" TEXT NOT NULL;"
echo "plan-check: $pass passed, $fail failed"; (( fail == 0 ))
