-- AlterTable
ALTER TABLE "UserOnboarding" ADD COLUMN     "slidesDoneAt" TIMESTAMP(3),
ADD COLUMN     "tourSteps" TEXT[] DEFAULT ARRAY[]::TEXT[];
