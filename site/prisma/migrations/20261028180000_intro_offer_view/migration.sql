-- CreateTable
CREATE TABLE "intro_offer_view" (
    "userId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intro_offer_view_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "intro_offer_view" ADD CONSTRAINT "intro_offer_view_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
