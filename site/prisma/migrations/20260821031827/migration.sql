-- CreateTable
CREATE TABLE "CutNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "colorIndex" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CutNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutPhoneLink" (
    "userId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutPhoneLink_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "CutNote_userId_updatedAt_idx" ON "CutNote"("userId", "updatedAt");
