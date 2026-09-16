-- CreateTable
CREATE TABLE "ChatgptGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatgptGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatgptToken" (
    "hash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "ChatgptToken_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "ChatgptGrant_userId_idx" ON "ChatgptGrant"("userId");

-- CreateIndex
CREATE INDEX "ChatgptGrant_expiresAt_idx" ON "ChatgptGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "ChatgptToken_grantId_idx" ON "ChatgptToken"("grantId");

-- CreateIndex
CREATE INDEX "ChatgptToken_expiresAt_idx" ON "ChatgptToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "ChatgptGrant" ADD CONSTRAINT "ChatgptGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatgptToken" ADD CONSTRAINT "ChatgptToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "ChatgptGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
