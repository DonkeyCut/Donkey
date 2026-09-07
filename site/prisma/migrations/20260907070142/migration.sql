-- CreateTable
CREATE TABLE "subscribe_bonus_offer" (
    "userId" TEXT NOT NULL,
    "bonusMicros" BIGINT NOT NULL,
    "creditsExpireAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "grantId" TEXT,

    CONSTRAINT "subscribe_bonus_offer_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "sender" TEXT NOT NULL DEFAULT 'bulk',
    "audience" JSONB NOT NULL DEFAULT '{}',
    "excludePromotionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRecipient" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscribe_bonus_offer_grantId_key" ON "subscribe_bonus_offer"("grantId");

-- CreateIndex
CREATE INDEX "Promotion_status_createdAt_idx" ON "Promotion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PromotionRecipient_promotionId_sentAt_idx" ON "PromotionRecipient"("promotionId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionRecipient_promotionId_userId_key" ON "PromotionRecipient"("promotionId", "userId");

-- AddForeignKey
ALTER TABLE "subscribe_bonus_offer" ADD CONSTRAINT "subscribe_bonus_offer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscribe_bonus_offer" ADD CONSTRAINT "subscribe_bonus_offer_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "user_credit_grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRecipient" ADD CONSTRAINT "PromotionRecipient_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRecipient" ADD CONSTRAINT "PromotionRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
