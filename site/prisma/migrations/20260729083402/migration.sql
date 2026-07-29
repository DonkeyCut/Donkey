/*
  Warnings:

  - You are about to drop the column `referralDetail` on the `UserOnboarding` table. All the data in the column will be lost.
  - You are about to drop the column `referralSource` on the `UserOnboarding` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "UserOnboarding" DROP COLUMN "referralDetail",
DROP COLUMN "referralSource",
ADD COLUMN     "referralSources" TEXT[] DEFAULT ARRAY[]::TEXT[];
