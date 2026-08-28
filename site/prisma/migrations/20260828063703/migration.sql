-- AlterTable
ALTER TABLE "OutreachTemplate" ADD COLUMN     "trackReplies" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unsubscribeLink" BOOLEAN NOT NULL DEFAULT false;
