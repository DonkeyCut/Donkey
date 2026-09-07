/*
  Warnings:

  - You are about to drop the `subscribe_bonus_offer` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "subscribe_bonus_offer" DROP CONSTRAINT "subscribe_bonus_offer_grantId_fkey";

-- DropForeignKey
ALTER TABLE "subscribe_bonus_offer" DROP CONSTRAINT "subscribe_bonus_offer_userId_fkey";

-- DropIndex
DROP INDEX "credit_offer_userId_idx";

-- AlterTable
ALTER TABLE "credit_offer" ADD COLUMN     "closesAt" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "terms" JSONB,
ALTER COLUMN "offeredByUserId" DROP NOT NULL;

-- DropTable
DROP TABLE "subscribe_bonus_offer";

-- CreateIndex
CREATE INDEX "credit_offer_userId_kind_idx" ON "credit_offer"("userId", "kind");
