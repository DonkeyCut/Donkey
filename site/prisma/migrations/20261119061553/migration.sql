-- CreateTable
CREATE TABLE "ChatgptEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tool" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatgptEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatgptEvent_createdAt_idx" ON "ChatgptEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ChatgptEvent_userId_idx" ON "ChatgptEvent"("userId");

-- AddForeignKey
ALTER TABLE "ChatgptEvent" ADD CONSTRAINT "ChatgptEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
