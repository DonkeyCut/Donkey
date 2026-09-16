import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveSettings } from "@/lib/config/resolve";
import { wakeRenderWorker } from "./wake";

const dependencies = { db: prisma, wake: wakeRenderWorker };

/** All clients share revision reuse and the one-waiting-preview queue. */
export async function queuePreview(userId: string, projectId: string, spec: Prisma.InputJsonValue, revision?: string, { db, wake } = dependencies) {
  const override = await db.settingOverride.findUnique({ where: { key: "cutPreviewJobs" }, select: { value: true } });
  const { maxAttempts } = resolveSettings(override ? { cutPreviewJobs: override.value } : {}, []).settings.cutPreviewJobs;
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await db.$transaction(async (tx) => {
        if (revision) {
          const existing = await tx.cutRenderJob.findFirst({
            where: { userId, projectId, kind: "preview", state: { in: ["queued", "running", "done"] }, spec: { path: ["revision"], equals: revision } },
            orderBy: { createdAt: "desc" },
          });
          if (existing && (existing.state !== "done" || (existing.outputKey && await tx.cutMediaObject.findUnique({
            where: { r2Key: existing.outputKey }, select: { id: true },
          })))) return existing;
        }
        await tx.cutRenderJob.updateMany({ where: { userId, projectId, kind: "preview", state: "queued" }, data: { state: "canceled", error: "A newer preview was requested." } });
        return tx.cutRenderJob.create({ data: { userId, projectId, kind: "preview", spec, outName: "preview.mp4" } });
      }, { isolationLevel: "Serializable" });
      if (row.state !== "done") wake();
      return row;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= maxAttempts) throw error;
    }
  }
}

/** A remote client renders the saved revision through the same headless renderer. */
export async function previewFromDoc(userId: string, projectId: string, deps = dependencies) {
  const { db } = deps;
  const project = await db.cutProject.findFirst({ where: { id: projectId, userId }, select: { doc: true, version: true } });
  if (!project) return null;
  const revision = `cloud:${project.version}`;
  return queuePreview(userId, projectId, { revision, fromDoc: { snapshot: { doc: project.doc, version: String(project.version) } } } as Prisma.InputJsonValue, revision, deps);
}
