-- DropIndex
DROP INDEX "CutFolder_userId_scope_idx";

-- CreateTable
CREATE TABLE "CutLibraryShare" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'restricted',
    "emails" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutLibraryShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CutLibraryShare_userId_kind_targetId_key" ON "CutLibraryShare"("userId", "kind", "targetId");

-- CreateIndex
CREATE INDEX "CutFolder_userId_scope_parentId_idx" ON "CutFolder"("userId", "scope", "parentId");

-- CreateIndex
CREATE INDEX "CutLibraryAsset_userId_folderId_id_idx" ON "CutLibraryAsset"("userId", "folderId", "id");
