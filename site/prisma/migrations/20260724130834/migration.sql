-- CreateTable
CREATE TABLE "CutChatThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutChatThread_pkey" PRIMARY KEY ("projectId","id")
);

-- CreateIndex
CREATE INDEX "CutChatThread_userId_projectId_updatedAt_idx" ON "CutChatThread"("userId", "projectId", "updatedAt");
