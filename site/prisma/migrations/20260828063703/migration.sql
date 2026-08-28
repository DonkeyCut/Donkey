-- AlterTable
ALTER TABLE "OutreachTemplate" ADD COLUMN     "trackReplies" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "unsubscribeLink" BOOLEAN NOT NULL DEFAULT true;
