-- AlterTable
ALTER TABLE "OutreachTemplate" ADD COLUMN     "promotion" JSONB;

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "creditOffer" JSONB;

-- CreateTable
CREATE TABLE "EmailDailyQuota" (
    "day" TEXT NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "inFlight" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDailyQuota_pkey" PRIMARY KEY ("day")
);
