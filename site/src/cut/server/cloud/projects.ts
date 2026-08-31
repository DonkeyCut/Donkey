// Cloud twin of the engine's project CRUD (server/projects.ts + http/projects.ts):
// docs and metadata in Postgres, media bytes in R2. Every query scopes by userId.
import { resolveParent } from "@/cut/lib/folderTree";
import { normalizeAspect, type ProjectDoc, type ProjectFolder, type ProjectSummary } from "@/cut/lib/types";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteLadder } from "./ladderStore";
import { MEDIA_REDIRECT_HEADERS, mediaObjectUrl } from "./mediaCdn";
import { del, deletePrefix, projectExportKey, projectHlsRoot, projectMediaKey } from "./r2";
import { addUsage } from "./usage";
import { caught, decodeFileParam, err, redirect } from "./util";

const projectFolderView = (row: {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
}): ProjectFolder => ({
  id: row.id,
  name: row.name,
  parentId: row.parentId,
  createdAt: row.createdAt.getTime(),
});

type ProjectRow = {
  id: string;
  userId: string;
  name: string;
  doc: unknown;
  folderId: string | null;
  version: number;
  previewKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getProject(userId: string, id: string): Promise<ProjectRow | null> {
  return prisma.cutProject.findFirst({ where: { id, userId } });
}

/** Every media fileName already claimed in the project — pending uploads hold
 * their name too, so a racing presign can't hand out the same one. */
export async function takenMediaNames(userId: string, projectId: string): Promise<Set<string>> {
  const rows = await prisma.cutMediaObject.findMany({
    where: { userId, projectId, kind: "media" },
    select: { fileName: true },
  });
  return new Set(rows.map((r) => r.fileName));
}

/** The row's grouping column is authoritative; the stored doc's folderId is
 * overlaid on read so the two can never disagree. */
function docOf(row: ProjectRow): ProjectDoc {
  const doc = row.doc as ProjectDoc;
  return { ...doc, folderId: row.folderId ?? null };
}

/** Mirror of the engine's summarize(): track 0 is the cut. sizeBytes comes from
 * the project's complete media objects instead of a directory walk. */
function summarize(row: ProjectRow, sizeBytes: number): ProjectSummary {
  const doc = docOf(row);
  const clips = Array.isArray(doc.clips) ? doc.clips : [];
  const assets = Array.isArray(doc.assets) ? doc.assets : [];
  const track0 = clips.filter((c) => (c.track ?? 0) === 0);
  const duration = track0.reduce((sum, c) => sum + Math.max(0, c.out - c.in), 0);
  const firstClip = track0[0];
  const firstClipAsset = firstClip ? assets.find((a) => a.id === firstClip.assetId) : undefined;
  const previewAsset =
    firstClipAsset ?? assets.find((a) => a.type === "video" || a.type === "image");
  const previewStart = firstClipAsset && firstClip ? firstClip.in : 0;
  return {
    id: row.id,
    name: doc.name,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    duration,
    clipCount: track0.length,
    assetCount: assets.length,
    previewFile: previewAsset?.fileName,
    previewIsImage: previewAsset?.type === "image",
    previewStart,
    hasPreview: row.previewKey != null,
    aspect: normalizeAspect(doc.aspect) ?? undefined,
    folderId: row.folderId ?? null,
    sizeBytes,
  };
}

async function projectSizes(userId: string, projectIds: string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const sums = await prisma.cutMediaObject.groupBy({
    by: ["projectId"],
    where: { userId, projectId: { in: projectIds }, uploadState: "complete" },
    _sum: { bytes: true },
  });
  return new Map(sums.map((s) => [s.projectId as string, Number(s._sum.bytes ?? 0)]));
}

const asJson = (doc: ProjectDoc) => doc as unknown as Prisma.InputJsonValue;

/** Delete a project and everything hanging off it — media rows and bytes,
 * chats, shares — and settle the usage counter. Returns bytes freed. Shared by
 * the delete route and the storage-reclamation sweep (gc.ts). */
export async function deleteProjectCascade(userId: string, id: string): Promise<number> {
  const objects = await prisma.cutMediaObject.findMany({
    where: { userId, projectId: id },
  });
  // Quota-exempt rows (seeded starter media) never added usage, so they
  // subtract none here; their R2 copies still go with the rest.
  const freed = objects
    .filter((o) => o.uploadState === "complete" && !o.quotaExempt)
    .reduce((sum, o) => sum + Number(o.bytes), 0);
  // Cancel the project's in-flight renders first: a job finishing after
  // the delete would re-register storage for a project nothing can see.
  await prisma.cutRenderJob.updateMany({
    where: { userId, projectId: id, state: { in: ["queued", "running"] } },
    data: { state: "canceled" },
  });
  await prisma.$transaction(async (tx) => {
    await tx.cutMediaObject.deleteMany({ where: { userId, projectId: id } });
    await tx.cutChatThread.deleteMany({ where: { userId, projectId: id } });
    await tx.cutProjectShare.deleteMany({ where: { projectId: id } });
    // deleteMany, so ownership is enforced here rather than trusted from the
    // caller: a mismatched (userId, id) pair deletes nothing.
    await tx.cutProject.deleteMany({ where: { id, userId } });
    await addUsage(tx, userId, -freed);
  });
  await del(objects.map((o) => o.r2Key));
  // The HLS ladders have no media rows at all — they are found by prefix and
  // recorded in KV — so both have to be cleared by hand here. Neither affects
  // `freed`: a ladder never counted toward the quota.
  //
  // The bytes go before the record does. A long 4K cut runs to tens of
  // thousands of objects, so this pages rather than listing once; and pruning
  // the record first would leave anything the delete missed with no index that
  // could ever find it again.
  await deletePrefix(projectHlsRoot(userId, id)).catch(() => 0);
  await deleteLadder(id);
  return freed;
}

export const projectsCloud = {
  async list(userId: string) {
    const rows = await prisma.cutProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    const sizes = await projectSizes(userId, rows.map((r) => r.id));
    return Response.json(rows.map((r) => summarize(r, sizes.get(r.id) ?? 0)));
  },

  async create(userId: string, req: Request) {
    try {
      const { name, folderId, aspect } = (await req.json()) as {
        name?: string;
        folderId?: string | null;
        aspect?: string;
      };
      const folder = folderId
        ? await prisma.cutFolder.findFirst({ where: { id: folderId, userId, scope: "project" } })
        : null;
      const frame = normalizeAspect(aspect);
      const now = Date.now();
      const doc: ProjectDoc = {
        version: 1,
        name: (name ?? "Untitled").trim() || "Untitled",
        createdAt: now,
        updatedAt: now,
        assets: [],
        clips: [],
        audioClips: [],
        overlays: [],
        ...(frame ? { aspect: frame } : {}),
      };
      const row = await prisma.cutProject.create({
        data: { userId, name: doc.name, doc: asJson(doc), folderId: folder?.id ?? null },
      });
      return Response.json(summarize(row, 0));
    } catch (e) {
      return caught(e, "Could not create project.");
    }
  },

  async get(userId: string, id: string) {
    const row = await getProject(userId, id);
    if (!row) return err("Project not found.", 404);
    return Response.json(docOf(row), {
      headers: { "x-cut-doc-version": String(row.version) },
    });
  },

  /** Optimistic-concurrency save: ?v= carries the version the client loaded;
   * a mismatch 409s with the current doc so the client can rebase. A PUT
   * without ?v= (first save) applies unconditionally. */
  async put(userId: string, id: string, req: Request) {
    try {
      const row = await getProject(userId, id);
      if (!row) return err("Project not found.", 404);
      const vParam = new URL(req.url).searchParams.get("v");
      const existing = docOf(row);
      const body = (await req.json()) as Partial<ProjectDoc>;
      const doc: ProjectDoc = {
        ...existing,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
        assets: Array.isArray(body.assets) ? body.assets : existing.assets,
        clips: Array.isArray(body.clips) ? body.clips : existing.clips,
        transitions: Array.isArray(body.transitions) ? body.transitions : existing.transitions,
        audioClips: Array.isArray(body.audioClips) ? body.audioClips : existing.audioClips,
        // Same legacy-shape handling as the engine: a merged client saving
        // `clips` clears the old separate overlay array.
        overlayClips: Array.isArray(body.overlayClips)
          ? body.overlayClips
          : Array.isArray(body.clips)
            ? []
            : existing.overlayClips,
        overlays: Array.isArray(body.overlays) ? body.overlays : existing.overlays,
        templates: Array.isArray(body.templates) ? body.templates : existing.templates,
        mediaFolders: Array.isArray(body.mediaFolders) ? body.mediaFolders : existing.mediaFolders,
        aspect: normalizeAspect(body.aspect) ?? existing.aspect,
        fadeIn: typeof body.fadeIn === "number" ? body.fadeIn : existing.fadeIn,
        fadeOut: typeof body.fadeOut === "number" ? body.fadeOut : existing.fadeOut,
        background: typeof body.background === "string" ? body.background : existing.background,
        subtitles:
          body.subtitles && typeof body.subtitles === "object" ? body.subtitles : existing.subtitles,
        ui: body.ui && typeof body.ui === "object" ? { ...existing.ui, ...body.ui } : existing.ui,
        publish:
          body.publish && typeof body.publish === "object"
            ? { ...existing.publish, ...body.publish }
            : existing.publish,
        notes:
          body.notes && typeof body.notes === "object"
            ? { ...existing.notes, ...body.notes }
            : existing.notes,
        genvideo: body.genvideo !== undefined ? body.genvideo ?? undefined : existing.genvideo,
        renders: Array.isArray(body.renders) ? body.renders : existing.renders,
      };
      doc.updatedAt = Date.now();
      const data = { doc: asJson(doc), name: doc.name, version: { increment: 1 } };
      if (vParam === null) {
        // First save: apply unconditionally, report the authoritative version.
        const updated = await prisma.cutProject.update({ where: { id }, data });
        return Response.json({ ok: true, version: updated.version });
      }
      const v = Number(vParam);
      if (!Number.isInteger(v)) return err("Bad version.", 400);
      const updated = await prisma.cutProject.updateMany({
        where: { id, userId, version: v },
        data,
      });
      if (updated.count === 0) {
        const current = await getProject(userId, id);
        if (!current) return err("Project not found.", 404);
        return Response.json(
          { error: "conflict", doc: docOf(current), version: current.version },
          { status: 409 }
        );
      }
      return Response.json({ ok: true, version: v + 1 });
    } catch (e) {
      return caught(e, "Could not save project.");
    }
  },

  async remove(userId: string, id: string) {
    try {
      const row = await getProject(userId, id);
      if (!row) return err("Project not found.", 404);
      await deleteProjectCascade(userId, id);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete project.");
    }
  },

  async move(userId: string, id: string, req: Request) {
    try {
      const { folderId } = (await req.json()) as { folderId: string | null };
      const row = await getProject(userId, id);
      if (!row) return err("Project not found.", 404);
      if (folderId) {
        const folder = await prisma.cutFolder.findFirst({
          where: { id: folderId, userId, scope: "project" },
        });
        if (!folder) return err("Folder not found.", 500);
      }
      await prisma.cutProject.update({ where: { id }, data: { folderId: folderId ?? null } });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not move project.");
    }
  },

  async folders(userId: string) {
    const rows = await prisma.cutFolder.findMany({
      where: { userId, scope: "project" },
      orderBy: { createdAt: "asc" },
    });
    return Response.json(rows.map(projectFolderView));
  },

  async createFolder(userId: string, req: Request) {
    try {
      const { name, parentId } = (await req.json()) as { name?: string; parentId?: string | null };
      const trimmed = (name ?? "").trim();
      if (!trimmed) return err("Folder name required.", 500);
      const folders = await prisma.cutFolder.findMany({
        where: { userId, scope: "project" },
        select: { id: true, parentId: true },
      });
      const row = await prisma.cutFolder.create({
        data: {
          userId,
          name: trimmed.slice(0, 80),
          scope: "project",
          parentId: resolveParent(folders, "", parentId),
        },
      });
      return Response.json(projectFolderView(row));
    } catch (e) {
      return caught(e, "Could not create folder.");
    }
  },

  /** Rename a folder, file it under another (null for the top level), or
   * both; a key left out keeps what the folder has. */
  async updateFolder(userId: string, id: string, req: Request) {
    try {
      const { name, parentId } = (await req.json()) as { name?: string; parentId?: string | null };
      const trimmed = name?.trim();
      if (name !== undefined && !trimmed) return err("Folder name required.", 500);
      const folders = await prisma.cutFolder.findMany({
        where: { userId, scope: "project" },
        select: { id: true, parentId: true },
      });
      if (!folders.some((f) => f.id === id)) return err("Folder not found.", 500);
      const updated = await prisma.cutFolder.update({
        where: { id },
        data: {
          ...(trimmed ? { name: trimmed.slice(0, 80) } : {}),
          ...(parentId !== undefined ? { parentId: resolveParent(folders, id, parentId) } : {}),
        },
      });
      return Response.json(projectFolderView(updated));
    } catch (e) {
      return caught(e, "Could not update folder.");
    }
  },

  /** Delete a folder. What it held — its projects and the folders inside it —
   * comes up one level, filed where the folder was. */
  async deleteFolder(userId: string, id: string) {
    try {
      await prisma.$transaction(async (tx) => {
        const gone = await tx.cutFolder.findFirst({
          where: { id, userId, scope: "project" },
          select: { parentId: true },
        });
        if (!gone) return;
        await tx.cutFolder.delete({ where: { id } });
        await tx.cutProject.updateMany({
          where: { userId, folderId: id },
          data: { folderId: gone.parentId },
        });
        await tx.cutFolder.updateMany({
          where: { userId, scope: "project", parentId: id },
          data: { parentId: gone.parentId },
        });
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete folder.");
    }
  },

  // --- Media / export / preview bytes: 302 to a signed R2 GET. ---

  async serveMedia(userId: string, id: string, file: string, download = false) {
    try {
      const fileName = decodeFileParam(file);
      const row = await prisma.cutMediaObject.findFirst({
        where: { userId, projectId: id, kind: "media", fileName },
        select: { updatedAt: true },
      });
      if (!row) return err("Not found.", 404);
      return redirect(
        mediaObjectUrl(projectMediaKey(userId, id, fileName), {
          version: String(row.updatedAt.getTime()),
          ...(download ? { downloadName: fileName } : {}),
        })
      );
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },

  async removeMedia(userId: string, id: string, file: string) {
    try {
      const fileName = decodeFileParam(file);
      const row = await prisma.cutMediaObject.findFirst({
        where: { userId, projectId: id, kind: "media", fileName },
      });
      if (row) {
        await prisma.$transaction(async (tx) => {
          await tx.cutMediaObject.delete({ where: { id: row.id } });
          if (row.uploadState === "complete" && !row.quotaExempt) {
            await addUsage(tx, userId, -Number(row.bytes));
          }
        });
        await del([row.r2Key]);
      }
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the media file.");
    }
  },

  async listExports(userId: string, id: string) {
    const rows = await prisma.cutMediaObject.findMany({
      where: { userId, projectId: id, kind: "export", uploadState: "complete" },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json(
      rows.map((r) => ({ file: r.fileName, size: Number(r.bytes), mtime: r.updatedAt.getTime() }))
    );
  },

  async serveExport(userId: string, id: string, file: string, download = false) {
    try {
      const fileName = decodeFileParam(file);
      const key = projectExportKey(userId, id, fileName);
      // Export names are reserved once (exportName), so the mapping is
      // write-once and the redirect is cacheable.
      return redirect(
        mediaObjectUrl(key, download ? { downloadName: fileName } : undefined),
        MEDIA_REDIRECT_HEADERS
      );
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },

  async removeExport(userId: string, id: string, file: string) {
    try {
      const fileName = decodeFileParam(file);
      const row = await prisma.cutMediaObject.findFirst({
        where: { userId, projectId: id, kind: "export", fileName },
      });
      if (row) {
        await prisma.$transaction(async (tx) => {
          await tx.cutMediaObject.delete({ where: { id: row.id } });
          if (row.uploadState === "complete" && !row.quotaExempt) {
            await addUsage(tx, userId, -Number(row.bytes));
          }
        });
        await del([row.r2Key]);
      }
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the export.");
    }
  },

  async servePreview(userId: string, id: string) {
    try {
      const row = await getProject(userId, id);
      if (!row?.previewKey) return new Response("Not found.", { status: 404 });
      // One fixed key that every re-render overwrites, so the version is what
      // stops the edge serving the pre-edit proxy: the row's updatedAt moves
      // whenever the project that produced it did.
      return redirect(
        mediaObjectUrl(row.previewKey, { version: String(row.updatedAt.getTime()) })
      );
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },
};
