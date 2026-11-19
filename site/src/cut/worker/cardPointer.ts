import { prisma } from "@/lib/prisma";

// How many times the write re-reads a project a save landed on mid-write.
const POINT_ATTEMPTS = 3;

/** Point a project's card at a finished preview render. The project's edit
 * time stays where its last save put it: a card is drawn from the project,
 * and the listing sorts and dates projects by their own edits. */
export async function pointCardAt(
  job: { id: string; userId: string },
  projectId: string,
  key: string,
  db = prisma,
) {
  // The card this render set out to replace, from the first read.
  let replaced: string | null | undefined;

  for (let attempt = 0; attempt < POINT_ATTEMPTS; attempt++) {
    const settled = await db.$transaction(async (tx) => {
      const project = await tx.cutProject.findUnique({
        where: { id: projectId },
        select: { previewKey: true, updatedAt: true },
      });
      if (!project) {
        return true;
      }
      const newest = await tx.cutRenderJob.findFirst({
        where: { userId: job.userId, projectId, kind: "preview" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (newest?.id !== job.id) {
        return true;
      }

      // A newer completion changes the pointer, so this write cannot replace it.
      replaced = replaced === undefined ? project.previewKey : replaced;
      if (project.previewKey !== replaced) {
        return true;
      }

      // The edit time is written back as read, and guarded on it, so a save
      // landing between the read and the write keeps its own time.
      const { count } = await tx.cutProject.updateMany({
        where: { id: projectId, userId: job.userId, previewKey: project.previewKey, updatedAt: project.updatedAt },
        data: { previewKey: key, updatedAt: project.updatedAt },
      });
      return count > 0;
    });
    if (settled) {
      return;
    }
  }
}
