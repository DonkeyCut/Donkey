-- CreateTable
CREATE TABLE "CutProjectCheckpoint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "doc" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CutProjectCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CutProjectCheckpoint_projectId_seq_idx" ON "CutProjectCheckpoint"("projectId", "seq");
