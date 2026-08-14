/*
  Warnings:

  - You are about to drop the `VisionApiSubscription` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "VisionApiSubscription" DROP CONSTRAINT "VisionApiSubscription_userId_fkey";

-- DropTable
DROP TABLE "VisionApiSubscription";
