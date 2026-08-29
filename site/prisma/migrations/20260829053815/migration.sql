-- AlterTable
ALTER TABLE "OutreachTemplate" ALTER COLUMN "trackReplies" SET DEFAULT true,
ALTER COLUMN "unsubscribeLink" SET DEFAULT true;

-- AlterTable
ALTER TABLE "UserOutreach" ADD COLUMN     "storageBytes" BIGINT NOT NULL DEFAULT 0;

