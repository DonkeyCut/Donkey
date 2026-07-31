-- CreateTable
CREATE TABLE "UserEmailSettings" (
    "userId" TEXT NOT NULL,
    "welcomeEmailSentAt" TIMESTAMP(3),
    "marketingUnsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEmailSettings_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserEmailSettings" ADD CONSTRAINT "UserEmailSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
