-- AlterTable
ALTER TABLE "CutNote" ADD COLUMN     "labelIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "CutNoteLabel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutNoteLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CutNoteLabel_userId_idx" ON "CutNoteLabel"("userId");
