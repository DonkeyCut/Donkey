-- CreateTable
CREATE TABLE "UserOutreach" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaign" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "firstSentAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "ignoredAt" TIMESTAMP(3),
    "actorUserId" TEXT,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "balanceMicros" BIGINT NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3),
    "ranOutAt" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserOutreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserOutreach_campaign_status_lastActiveAt_idx" ON "UserOutreach"("campaign", "status", "lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserOutreach_userId_campaign_key" ON "UserOutreach"("userId", "campaign");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachTemplate_name_key" ON "OutreachTemplate"("name");

-- AddForeignKey
ALTER TABLE "UserOutreach" ADD CONSTRAINT "UserOutreach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
