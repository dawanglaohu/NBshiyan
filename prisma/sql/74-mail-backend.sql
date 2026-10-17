-- #74 邮件后端：MailMessage 表 + 3 个枚举。由 `prisma migrate diff`（main fc340b3 的 schema → 本分支 schema）生成，只供评审核对。
-- 仓库仍用 `prisma db push`（launch-runbook.md）：本次变更只新增（新表、新枚举、新索引、新外键），不改、不删任何已有列或表。
-- 已验证：在一次性临时 Postgres 上先按 fc340b3 的 schema 建库，再执行本文件，`prisma migrate diff` 对本分支 schema 无差异；验证后已删除该实例。

-- CreateEnum
CREATE TYPE "MailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'RECEIVED', 'UNASSIGNED', 'IGNORED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('UNKNOWN', 'BOUNCED');

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "direction" "MailDirection" NOT NULL,
    "status" "MailStatus" NOT NULL,
    "inquiryId" TEXT,
    "messageId" TEXT,
    "sendKey" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT,
    "remoteMailId" TEXT,
    "idemKey" TEXT,
    "fromAddr" TEXT NOT NULL,
    "fromHash" TEXT,
    "toAddr" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "hasRemoteImages" BOOLEAN NOT NULL DEFAULT false,
    "authSpf" TEXT,
    "authDkim" TEXT,
    "authDmarc" TEXT,
    "senderVerified" BOOLEAN,
    "authorId" TEXT,
    "errorCode" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "requestStartedAt" TIMESTAMP(3),
    "capDay" TIMESTAMP(3),
    "deferredUntil" TIMESTAMP(3),
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'UNKNOWN',
    "redactedAt" TIMESTAMP(3),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_messageId_key" ON "MailMessage"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_sendKey_key" ON "MailMessage"("sendKey");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_remoteMailId_key" ON "MailMessage"("remoteMailId");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_idemKey_key" ON "MailMessage"("idemKey");

-- CreateIndex
CREATE INDEX "MailMessage_inquiryId_createdAt_idx" ON "MailMessage"("inquiryId", "createdAt");

-- CreateIndex
CREATE INDEX "MailMessage_status_createdAt_idx" ON "MailMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MailMessage_direction_capDay_idx" ON "MailMessage"("direction", "capDay");

-- CreateIndex
CREATE INDEX "MailMessage_status_deferredUntil_idx" ON "MailMessage"("status", "deferredUntil");

-- CreateIndex
CREATE INDEX "MailMessage_fromHash_idx" ON "MailMessage"("fromHash");

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

