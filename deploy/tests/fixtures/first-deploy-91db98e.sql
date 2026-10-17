-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SALES', 'EDITOR');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('NEW', 'FOLLOWING', 'QUOTED', 'WON', 'INVALID');

-- CreateEnum
CREATE TYPE "InquirySource" AS ENUM ('FORM', 'WIZARD', 'CART', 'CUSTOMIZER', 'SAMPLE');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'ru');

-- CreateEnum
CREATE TYPE "Incoterm" AS ENUM ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP');

-- CreateEnum
CREATE TYPE "MailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'RECEIVED', 'UNASSIGNED', 'IGNORED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('UNKNOWN', 'BOUNCED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'SALES',
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpLastStep" INTEGER,
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "reactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "normalizedEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "replyToken" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "source" "InquirySource" NOT NULL,
    "status" "InquiryStatus" NOT NULL DEFAULT 'NEW',
    "message" TEXT,
    "trustScore" INTEGER NOT NULL DEFAULT 50,
    "trustReasons" JSONB,
    "assigneeId" TEXT,
    "attribution" JSONB,
    "ipCountry" TEXT,
    "autoReplyAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InquiryItem" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "productSlug" TEXT NOT NULL,
    "quantity" INTEGER,
    "config" JSONB,
    "notes" TEXT,
    "designId" TEXT,

    CONSTRAINT "InquiryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InquiryMessage" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InquiryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InquiryNote" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InquiryNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleRequest" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "status" "SampleStatus" NOT NULL DEFAULT 'PENDING',
    "trackingNo" TEXT,
    "reviewedBy" TEXT,
    "normalizedEmail" TEXT,
    "shippingAddress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SampleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedDesign" (
    "id" TEXT NOT NULL,
    "productSlug" TEXT NOT NULL,
    "category" TEXT,
    "locale" "Locale" NOT NULL DEFAULT 'en',
    "config" JSONB NOT NULL,
    "logoUploadId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedDesign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model3D" (
    "id" TEXT NOT NULL,
    "productSlug" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "status" "ModelStatus" NOT NULL DEFAULT 'UPLOADED',
    "sourceKey" TEXT NOT NULL,
    "glbKey" TEXT,
    "lodKey" TEXT,
    "posterKey" TEXT,
    "sizeBytes" INTEGER,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "customizable" JSONB,
    "checks" JSONB,
    "triangles" INTEGER,
    "animations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uploadedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Model3D_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "SiteSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogoUpload" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "inquiryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogoUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategorySpec" (
    "category" TEXT NOT NULL,
    "sizeMin" JSONB,
    "sizeMax" JSONB,
    "material" JSONB,
    "moq" INTEGER,
    "sampleFeeAmount" DECIMAL(10,2),
    "sampleFeeCurrency" TEXT,
    "sampleFree" BOOLEAN,
    "leadTimeDaysMin" INTEGER,
    "leadTimeDaysMax" INTEGER,
    "certifications" JSONB,
    "tradeTerms" "Incoterm"[] DEFAULT ARRAY[]::"Incoterm"[],
    "notes" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "CategorySpec_pkey" PRIMARY KEY ("category")
);

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
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Contact_normalizedEmail_idx" ON "Contact"("normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_ref_key" ON "Inquiry"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_replyToken_key" ON "Inquiry"("replyToken");

-- CreateIndex
CREATE INDEX "Inquiry_status_createdAt_idx" ON "Inquiry"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Inquiry_assigneeId_idx" ON "Inquiry"("assigneeId");

-- CreateIndex
CREATE INDEX "Inquiry_retainUntil_anonymizedAt_idx" ON "Inquiry"("retainUntil", "anonymizedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SampleRequest_inquiryId_key" ON "SampleRequest"("inquiryId");

-- CreateIndex
CREATE INDEX "SampleRequest_normalizedEmail_createdAt_idx" ON "SampleRequest"("normalizedEmail", "createdAt");

-- CreateIndex
CREATE INDEX "SharedDesign_expiresAt_idx" ON "SharedDesign"("expiresAt");

-- CreateIndex
CREATE INDEX "Model3D_published_sortOrder_idx" ON "Model3D"("published", "sortOrder");

-- CreateIndex
CREATE INDEX "Model3D_productSlug_idx" ON "Model3D"("productSlug");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "LogoUpload_inquiryId_createdAt_idx" ON "LogoUpload"("inquiryId", "createdAt");

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
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryItem" ADD CONSTRAINT "InquiryItem_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryItem" ADD CONSTRAINT "InquiryItem_designId_fkey" FOREIGN KEY ("designId") REFERENCES "SharedDesign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryMessage" ADD CONSTRAINT "InquiryMessage_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryNote" ADD CONSTRAINT "InquiryNote_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleRequest" ADD CONSTRAINT "SampleRequest_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedDesign" ADD CONSTRAINT "SharedDesign_logoUploadId_fkey" FOREIGN KEY ("logoUploadId") REFERENCES "LogoUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LogoUpload" ADD CONSTRAINT "LogoUpload_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

