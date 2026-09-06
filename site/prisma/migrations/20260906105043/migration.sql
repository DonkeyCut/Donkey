-- CreateTable
CREATE TABLE "DeletedAccount" (
    "emailHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signedUpAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedMicros" BIGINT NOT NULL DEFAULT 0,
    "chargedMicros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "DeletedAccount_pkey" PRIMARY KEY ("emailHash")
);
