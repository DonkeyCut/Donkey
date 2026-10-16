-- CreateTable
CREATE TABLE "SignupNetwork" (
    "networkKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "claims" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SignupNetwork_pkey" PRIMARY KEY ("networkKey")
);
