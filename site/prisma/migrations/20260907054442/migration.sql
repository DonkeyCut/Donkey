/*
  Warnings:

  - You are about to drop the column `unit` on the `user_credit_grant` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,source,sourceId]` on the table `user_credit_grant` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "user_credit_grant_userId_unit_source_sourceId_key";

-- DropIndex
DROP INDEX "user_credit_grant_userId_unit_status_idx";

-- AlterTable
ALTER TABLE "user_credit_grant" DROP COLUMN "unit";

-- CreateIndex
CREATE INDEX "user_credit_grant_userId_status_idx" ON "user_credit_grant"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_credit_grant_userId_source_sourceId_key" ON "user_credit_grant"("userId", "source", "sourceId");
