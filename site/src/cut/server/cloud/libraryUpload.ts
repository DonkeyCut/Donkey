import { libraryUploadId, libraryUploadSchema } from "@/cut/lib/libraryUpload";
import { libraryTypeOf } from "@/cut/lib/libraryFileType";
import { assetView } from "@/cut/server/cloud/library";
import { renderJobCheck } from "@/cut/server/cloud/limits";
import { head } from "@/cut/server/cloud/r2";
import { err } from "@/cut/server/cloud/util";
import { wakeRenderWorker } from "@/cut/server/cloud/wake";
import { prisma } from "@/lib/prisma";

export function createLibraryUploadPreparation({
  db = prisma, inspect = head, checkLimit = renderJobCheck, wake = wakeRenderWorker,
}: {
  db?: Pick<typeof prisma, "cutMediaObject" | "cutLibraryAsset" | "cutFolder" | "cutRenderJob">;
  inspect?: typeof head;
  checkLimit?: typeof renderJobCheck;
  wake?: typeof wakeRenderWorker;
} = {}) {
  /** Queue preparation after the original's direct upload has arrived. */
  return async function prepareLibraryUpload(userId: string, req: Request): Promise<Response> {
    const parsed = libraryUploadSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return err("Invalid library upload.", 400);
    const input = parsed.data;
    const object = await db.cutMediaObject.findFirst({
      where: { userId, r2Key: input.key, kind: "library", projectId: null },
    });
    if (!object) return err("Unknown upload.", 404);
    const type = libraryTypeOf(object.fileName);
    if (type !== "video" && type !== "audio") return err("This upload has no video or audio.", 400);
    if (input.folderId && !(await db.cutFolder.findFirst({
      where: { id: input.folderId, userId, scope: "library" }, select: { id: true },
    }))) return err("Folder not found.", 404);

    const id = libraryUploadId(object.id);
    const asset = await db.cutLibraryAsset.findFirst({ where: { id, userId, deletedAt: null } });
    if (asset) {
      const media = await db.cutMediaObject.findFirst({ where: { id: asset.mediaObjectId, userId } });
      if (media) return Response.json(assetView(asset, media));
    }
    if (object.uploadState !== "pending") return err("This file is already in the Library.", 409);
    const existing = await db.cutRenderJob.findFirst({ where: { id, userId } });
    if (existing && (existing.state === "queued" || existing.state === "running")) {
      wake();
      return Response.json({ jobId: id });
    }
    const info = await inspect(input.key);
    if (!info || info.bytes !== Number(object.bytes)) return err("The upload is incomplete. Select the file again.", 400);
    const capped = await checkLimit(userId);
    if (capped) return capped;
    const spec = { ...input, target: "library", objectId: object.id };
    await db.cutRenderJob.upsert({
      where: { id },
      create: { id, userId, kind: "convert", spec },
      update: {},
    });
    if (existing) {
      await db.cutRenderJob.updateMany({
        where: { id, userId, state: { in: ["error", "canceled", "dismissed", "done"] } },
        data: { state: "queued", progress: 0, error: null, claimedAt: null, spec },
      });
    }
    wake();
    return Response.json({ jobId: id });
  }

}

export const prepareLibraryUpload = createLibraryUploadPreparation();
