-- AlterTable
ALTER TABLE "UserOutreach" ADD COLUMN     "paymentFailedAt" TIMESTAMP(3),
ADD COLUMN     "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
