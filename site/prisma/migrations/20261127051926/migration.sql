-- CreateTable
CREATE TABLE "CutPhoneDrop" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "single" BOOLEAN NOT NULL DEFAULT false,
    "aliveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CutPhoneDrop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutPhonePass" (
    "id" TEXT NOT NULL,
    "dropId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CutPhonePass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutPhoneFile" (
    "id" TEXT NOT NULL,
    "dropId" TEXT NOT NULL,
    "passId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "sentBytes" BIGINT NOT NULL DEFAULT 0,
    "r2Key" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "thumbKey" TEXT,
    "state" TEXT NOT NULL DEFAULT 'sending',
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutPhoneFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CutPhoneDrop_codeHash_key" ON "CutPhoneDrop"("codeHash");

-- CreateIndex
CREATE INDEX "CutPhoneDrop_userId_aliveAt_idx" ON "CutPhoneDrop"("userId", "aliveAt");

-- CreateIndex
CREATE INDEX "CutPhoneDrop_aliveAt_idx" ON "CutPhoneDrop"("aliveAt");

-- CreateIndex
CREATE UNIQUE INDEX "CutPhonePass_tokenHash_key" ON "CutPhonePass"("tokenHash");

-- CreateIndex
CREATE INDEX "CutPhonePass_dropId_idx" ON "CutPhonePass"("dropId");

-- CreateIndex
CREATE UNIQUE INDEX "CutPhoneFile_r2Key_key" ON "CutPhoneFile"("r2Key");

-- CreateIndex
CREATE INDEX "CutPhoneFile_dropId_idx" ON "CutPhoneFile"("dropId");

-- CreateIndex
CREATE INDEX "CutPhoneFile_userId_state_idx" ON "CutPhoneFile"("userId", "state");

-- CreateIndex
CREATE INDEX "CutPhoneFile_createdAt_idx" ON "CutPhoneFile"("createdAt");
