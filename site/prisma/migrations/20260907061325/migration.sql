-- CreateTable
CREATE TABLE "credit_offer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "expiresAfterDays" INTEGER,
    "description" TEXT,
    "offeredByUserId" TEXT NOT NULL,
    "emailSentAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "grantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_offer_grantId_key" ON "credit_offer"("grantId");

-- CreateIndex
CREATE INDEX "credit_offer_userId_idx" ON "credit_offer"("userId");

-- AddForeignKey
ALTER TABLE "credit_offer" ADD CONSTRAINT "credit_offer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_offer" ADD CONSTRAINT "credit_offer_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "user_credit_grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
