-- CreateTable
CREATE TABLE "CutProjectShare" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'restricted',
    "emails" JSONB NOT NULL DEFAULT '[]',
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutProjectShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutCopyJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'share',
    "shareId" TEXT,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "newProjectId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutCopyJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CutProjectShare_projectId_key" ON "CutProjectShare"("projectId");

-- CreateIndex
CREATE INDEX "CutProjectShare_userId_idx" ON "CutProjectShare"("userId");

-- CreateIndex
CREATE INDEX "CutCopyJob_userId_createdAt_idx" ON "CutCopyJob"("userId", "createdAt");
