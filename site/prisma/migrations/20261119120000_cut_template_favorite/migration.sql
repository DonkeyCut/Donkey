-- CreateTable
CREATE TABLE "CutTemplateFavorite" (
    "userId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CutTemplateFavorite_pkey" PRIMARY KEY ("userId","templateId")
);

