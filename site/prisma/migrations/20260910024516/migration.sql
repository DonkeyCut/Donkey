/*
  Warnings:

  - You are about to drop the column `inFlight` on the `EmailDailyQuota` table. All the data in the column will be lost.
  - You are about to drop the `PromotionRecipient` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PromotionRecipient" DROP CONSTRAINT "PromotionRecipient_promotionId_fkey";

-- DropForeignKey
ALTER TABLE "PromotionRecipient" DROP CONSTRAINT "PromotionRecipient_userId_fkey";

-- AlterTable
ALTER TABLE "EmailDailyQuota" DROP COLUMN "inFlight";

-- DropTable
DROP TABLE "PromotionRecipient";

-- CreateTable
CREATE TABLE "EmailSend" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "promotionId" TEXT,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSend_idempotencyKey_key" ON "EmailSend"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailSend_state_priority_rank_createdAt_idx" ON "EmailSend"("state", "priority", "rank", "createdAt");

-- CreateIndex
CREATE INDEX "EmailSend_promotionId_state_idx" ON "EmailSend"("promotionId", "state");

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
