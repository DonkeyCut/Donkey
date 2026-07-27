// Cloud twin of the engine's shared library (server/library.ts): asset metadata
// in CutLibraryAsset rows, template docs in CutTemplate rows, bytes in R2 under
// cut/<userId>/library/. Response shapes mirror the engine exactly.
import type {
  LibraryAsset,
  LibraryFolder,
  LibrarySource,
  LibraryTemplate,
  TemplateAudio,
  TemplateInput,
  TemplateLayer,
  TemplateMedia,
} from "../library";
import type { StoredAsset } from "@/cut/lib/types";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getProject, takenMediaNames } from "./projects";
import { copy, del, head, libraryKey, presignGet, presignPut, projectMediaKey } from "./r2";
import { addUsage, quotaCheck } from "./usage";
import { caught, decodeFileParam, dedupeName, err, redirect, safeFileName, typeOf } from "./util";

/** Descriptive fields the engine derives with ffprobe; the cloud stores them on
 * the row, supplied by the client (which probed in the browser) or copied from
 * the source project doc. */
interface AssetMeta {
  name?: string;
  type?: "video" | "audio" | "image";
  duration?: number;
  width?: number;
  height?: number;
  source?: LibrarySource;
}

interface TemplateDoc {
  folderId?: string | null;
  duration: number;
  media: TemplateMedia[];
  layers: TemplateLayer[];
  audio: TemplateAudio[];
  texts: unknown[];
  cues: unknown[];
}

type MediaObjectRow = {
  id: string;
  r2Key: string;
  fileName: string;
  mime: string;
  bytes: bigint;
  uploadState: string;
};

async function takenLibraryNames(userId: string): Promise<Set<string>> {
  const rows = await prisma.cutMediaObject.findMany({
    where: { userId, kind: "library" },
    select: { fileName: true },
  });
  return new Set(rows.map((r) => r.fileName));
}

function assetView(
  row: { id: string; folderId: string | null; meta: unknown; createdAt: Date },
  obj: { fileName: string }
): LibraryAsset {
  const meta = (row.meta ?? {}) as AssetMeta;
  return {
    id: row.id,
    fileName: obj.fileName,
    name: meta.name ?? obj.fileName,
    type: meta.type ?? typeOf(obj.fileName) ?? "video",
    duration: meta.duration ?? 0,
    ...(meta.width ? { width: meta.width, height: meta.height } : {}),
    addedAt: row.createdAt.getTime(),
    folderId: row.folderId ?? null,
    ...(meta.source ? { source: meta.source } : {}),
  };
}

function templateView(row: { id: string; name: string; doc: unknown; createdAt: Date }): LibraryTemplate {
  const doc = row.doc as unknown as TemplateDoc;
  return {
    id: row.id,
    name: row.name,
    addedAt: row.createdAt.getTime(),
    folderId: doc.folderId ?? null,
    duration: doc.duration,
    media: doc.media ?? [],
    layers: doc.layers ?? [],
    audio: doc.audio ?? [],
    texts: doc.texts ?? [],
    cues: doc.cues ?? [],
  };
}

const asJson = (doc: TemplateDoc) => doc as unknown as Prisma.InputJsonValue;

async function findTemplate(userId: string, id: string) {
  return prisma.cutTemplate.findFirst({ where: { id, userId } });
}

/** A project media object row, complete, by fileName — the copy source for
 * save/saveTemplate/addToTemplate. */
async function projectMediaObject(userId: string, projectId: string, fileName: string) {
  return prisma.cutMediaObject.findFirst({
    where: { userId, projectId, kind: "media", fileName, uploadState: "complete" },
  });
}

async function libraryMediaObject(userId: string, fileName: string) {
  return prisma.cutMediaObject.findFirst({
    where: { userId, kind: "library", fileName },
  });
}

/** Copy one complete source object to a fresh library key, recording the row
 * and usage. Returns the library fileName. */
async function copyIntoLibrary(
  userId: string,
  src: MediaObjectRow,
  taken: Set<string>
): Promise<string> {
  const dest = dedupeName(safeFileName(src.fileName), taken);
  taken.add(dest);
  const key = libraryKey(userId, dest);
  await copy(src.r2Key, key);
  await prisma.$transaction(async (tx) => {
    await tx.cutMediaObject.create({
      data: {
        userId,
        r2Key: key,
        fileName: dest,
        mime: src.mime,
        bytes: src.bytes,
        kind: "library",
        uploadState: "complete",
      },
    });
    await addUsage(tx, userId, Number(src.bytes));
  });
  return dest;
}

/** Delete a library asset with its media object, bytes, and R2 key. Returns
 * bytes freed, or null when the asset is not this user's. Shared by the delete
 * route and the storage-reclamation sweep (gc.ts). */
export async function deleteLibraryAssetCascade(
  userId: string,
  id: string
): Promise<number | null> {
  const asset = await prisma.cutLibraryAsset.findFirst({ where: { id, userId } });
  if (!asset) return null;
  const obj = await prisma.cutMediaObject.findFirst({
    where: { id: asset.mediaObjectId, userId },
  });
  const freed = obj && obj.uploadState === "complete" ? Number(obj.bytes) : 0;
  await prisma.$transaction(async (tx) => {
    await tx.cutLibraryAsset.delete({ where: { id } });
    if (obj) {
      await tx.cutMediaObject.delete({ where: { id: obj.id } });
      if (freed > 0) await addUsage(tx, userId, -freed);
    }
  });
  if (obj) await del([obj.r2Key]);
  return freed;
}

/** Copy one library object into a project, recording the row and usage.
 * Returns the fileName inside the project. */
async function copyIntoProject(
  userId: string,
  projectId: string,
  libFileName: string,
  taken: Set<string>
): Promise<string> {
  const src = await libraryMediaObject(userId, libFileName);
  if (!src) throw new Error("Library asset not found.");
  const dest = dedupeName(safeFileName(libFileName), taken);
  taken.add(dest);
  const key = projectMediaKey(userId, projectId, dest);
  await copy(src.r2Key, key);
  await prisma.$transaction(async (tx) => {
    await tx.cutMediaObject.create({
      data: {
        userId,
        projectId,
        r2Key: key,
        fileName: dest,
        mime: src.mime,
        bytes: src.bytes,
        kind: "media",
        uploadState: "complete",
      },
    });
    await addUsage(tx, userId, Number(src.bytes));
  });
  return dest;
}

/** Delete one library media object (row + bytes + usage), best-effort on R2. */
async function deleteLibraryObject(userId: string, fileName: string) {
  const row = await libraryMediaObject(userId, fileName);
  if (!row) return;
  await prisma.$transaction(async (tx) => {
    await tx.cutMediaObject.delete({ where: { id: row.id } });
    if (row.uploadState === "complete") await addUsage(tx, userId, -Number(row.bytes));
  });
  await del([row.r2Key]);
}

export const libraryCloud = {
  async list(userId: string) {
    const [assetRows, folderRows, templateRows] = await Promise.all([
      prisma.cutLibraryAsset.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
      prisma.cutFolder.findMany({ where: { userId, scope: "library" }, orderBy: { createdAt: "asc" } }),
      prisma.cutTemplate.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    ]);
    const objs = await prisma.cutMediaObject.findMany({
      where: { id: { in: assetRows.map((r) => r.mediaObjectId) } },
      select: { id: true, fileName: true },
    });
    const byId = new Map(objs.map((o) => [o.id, o]));
    const assets = assetRows
      .map((r) => {
        const obj = byId.get(r.mediaObjectId);
        return obj ? assetView(r, obj) : null;
      })
      .filter((a): a is LibraryAsset => a !== null);
    const folders: LibraryFolder[] = folderRows.map((f) => ({
      id: f.id,
      name: f.name,
      createdAt: f.createdAt.getTime(),
    }));
    const templates = templateRows.map(templateView);
    return Response.json({ assets, folders, templates });
  },

  /** Mint a presigned PUT for a direct-to-library upload. */
  async presign(userId: string, req: Request) {
    try {
      const body = (await req.json()) as { fileName?: string; mime?: string; bytes?: number };
      if (!body.fileName || typeof body.bytes !== "number" || body.bytes <= 0) {
        return err("fileName and bytes are required.", 400);
      }
      if (!typeOf(body.fileName)) return err("Unsupported file type.", 400);
      const over = await quotaCheck(userId, body.bytes);
      if (over) return over;
      const fileName = dedupeName(safeFileName(body.fileName), await takenLibraryNames(userId));
      const key = libraryKey(userId, fileName);
      const url = await presignPut(key, body.mime ?? "application/octet-stream");
      await prisma.cutMediaObject.create({
        data: {
          userId,
          r2Key: key,
          fileName,
          mime: body.mime ?? "",
          bytes: BigInt(Math.round(body.bytes)),
          kind: "library",
          uploadState: "pending",
        },
      });
      return Response.json({ fileName, key, url });
    } catch (e) {
      return caught(e, "Could not presign the upload.");
    }
  },

  /** Finish a library upload: verify, mark complete, register the asset. */
  async complete(userId: string, req: Request) {
    try {
      const { key, meta } = (await req.json()) as { key?: string; meta?: AssetMeta };
      if (!key) return err("key is required.", 400);
      const obj = await prisma.cutMediaObject.findFirst({ where: { userId, r2Key: key } });
      if (!obj) return err("Unknown upload.", 404);
      const info = obj.uploadState === "complete" ? null : await head(key);
      if (obj.uploadState !== "complete" && !info) return err("The upload never arrived.", 400);
      const row = await prisma.$transaction(async (tx) => {
        if (info) {
          await tx.cutMediaObject.update({
            where: { id: obj.id },
            data: {
              uploadState: "complete",
              bytes: BigInt(info.bytes),
              ...(info.mime ? { mime: info.mime } : {}),
            },
          });
          await addUsage(tx, userId, info.bytes);
        }
        return tx.cutLibraryAsset.create({
          data: {
            userId,
            mediaObjectId: obj.id,
            meta: {
              name: meta?.name ?? obj.fileName,
              type: meta?.type ?? typeOf(obj.fileName) ?? "video",
              duration: meta?.duration ?? 0,
              ...(meta?.width ? { width: meta.width, height: meta.height } : {}),
              ...(meta?.source ? { source: meta.source } : {}),
            } as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return Response.json(assetView(row, obj));
    } catch (e) {
      return caught(e, "Could not complete the upload.");
    }
  },

  /** Copy a library asset into a project's media space. */
  async use(userId: string, req: Request) {
    try {
      const { assetId, projectId } = (await req.json()) as { assetId: string; projectId: string };
      const asset = await prisma.cutLibraryAsset.findFirst({ where: { id: assetId, userId } });
      if (!asset) throw new Error("Library asset not found.");
      const obj = await prisma.cutMediaObject.findUnique({ where: { id: asset.mediaObjectId } });
      if (!obj) throw new Error("Library asset not found.");
      if (!(await getProject(userId, projectId))) throw new Error("Project not found.");
      const fileName = await copyIntoProject(
        userId,
        projectId,
        obj.fileName,
        await takenMediaNames(userId, projectId)
      );
      return Response.json({ fileName });
    } catch (e) {
      return caught(e, "Could not add from library.");
    }
  },

  /** Copy a project media file into the shared library. */
  async save(userId: string, req: Request) {
    try {
      const { projectId, fileName, name } = (await req.json()) as {
        projectId: string;
        fileName: string;
        name?: string;
      };
      const src = await projectMediaObject(userId, projectId, fileName);
      if (!src) throw new Error("Media file not found in project.");
      const project = await getProject(userId, projectId);
      const docAsset = (project?.doc as { assets?: StoredAsset[] } | undefined)?.assets?.find(
        (a) => a.fileName === fileName
      );
      const dest = await copyIntoLibrary(userId, src, await takenLibraryNames(userId));
      const obj = await libraryMediaObject(userId, dest);
      if (!obj) throw new Error("Could not save to library.");
      const row = await prisma.cutLibraryAsset.create({
        data: {
          userId,
          mediaObjectId: obj.id,
          meta: {
            name: name || fileName,
            type: docAsset?.type ?? typeOf(dest) ?? "video",
            duration: docAsset?.duration ?? 0,
            ...(docAsset?.width ? { width: docAsset.width, height: docAsset.height } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return Response.json(assetView(row, obj));
    } catch (e) {
      return caught(e, "Could not save to library.");
    }
  },

  /** Move an item — asset or template — into a folder (or `null` to ungroup). */
  async move(userId: string, req: Request) {
    try {
      const { id, folderId } = (await req.json()) as { id: string; folderId: string | null };
      if (folderId) {
        const folder = await prisma.cutFolder.findFirst({
          where: { id: folderId, userId, scope: "library" },
        });
        if (!folder) throw new Error("Folder not found.");
      }
      const asset = await prisma.cutLibraryAsset.findFirst({ where: { id, userId } });
      if (asset) {
        await prisma.cutLibraryAsset.update({ where: { id }, data: { folderId: folderId ?? null } });
        return Response.json({ ok: true });
      }
      const template = await findTemplate(userId, id);
      if (!template) throw new Error("Library item not found.");
      const doc = template.doc as unknown as TemplateDoc;
      await prisma.cutTemplate.update({
        where: { id },
        data: { doc: asJson({ ...doc, folderId: folderId ?? null }) },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not move item.");
    }
  },

  async remove(userId: string, id: string) {
    try {
      const freed = await deleteLibraryAssetCascade(userId, id);
      if (freed === null) throw new Error("Library asset not found.");
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete.");
    }
  },

  async serveMedia(userId: string, file: string) {
    try {
      return redirect(await presignGet(libraryKey(userId, decodeFileParam(file))));
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },

  // --- Folders (scope "library") ---

  async createFolder(userId: string, req: Request) {
    try {
      const { name } = (await req.json()) as { name?: string };
      const trimmed = (name ?? "").trim();
      if (!trimmed) throw new Error("Folder name required.");
      const row = await prisma.cutFolder.create({
        data: { userId, name: trimmed.slice(0, 80), scope: "library" },
      });
      return Response.json({ id: row.id, name: row.name, createdAt: row.createdAt.getTime() });
    } catch (e) {
      return caught(e, "Could not create folder.");
    }
  },

  async renameFolder(userId: string, id: string, req: Request) {
    try {
      const { name } = (await req.json()) as { name?: string };
      const trimmed = (name ?? "").trim();
      if (!trimmed) throw new Error("Folder name required.");
      const row = await prisma.cutFolder.findFirst({ where: { id, userId, scope: "library" } });
      if (!row) throw new Error("Folder not found.");
      const updated = await prisma.cutFolder.update({
        where: { id },
        data: { name: trimmed.slice(0, 80) },
      });
      return Response.json({
        id: updated.id,
        name: updated.name,
        createdAt: updated.createdAt.getTime(),
      });
    } catch (e) {
      return caught(e, "Could not rename folder.");
    }
  },

  async deleteFolder(userId: string, id: string) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.cutFolder.deleteMany({ where: { id, userId, scope: "library" } });
        // Items in the folder fall back to ungrouped rather than vanishing.
        await tx.cutLibraryAsset.updateMany({
          where: { userId, folderId: id },
          data: { folderId: null },
        });
        const templates = await tx.cutTemplate.findMany({ where: { userId } });
        for (const t of templates) {
          const doc = t.doc as unknown as TemplateDoc;
          if (doc.folderId === id) {
            await tx.cutTemplate.update({
              where: { id: t.id },
              data: { doc: asJson({ ...doc, folderId: null }) },
            });
          }
        }
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete folder.");
    }
  },

  // --- Templates ---

  /** Save a timeline selection as a by-reference template: each source file is
   * copied into the library privately, then the edit is stored. */
  async saveTemplate(userId: string, req: Request) {
    try {
      const { projectId, ...input } = (await req.json()) as { projectId: string } & TemplateInput;
      if (!(await getProject(userId, projectId))) throw new Error("Project not found.");
      if (!input.media?.length && !input.texts?.length && !input.cues?.length) {
        throw new Error("Nothing to save.");
      }
      const taken = await takenLibraryNames(userId);
      const media: TemplateMedia[] = [];
      for (const m of input.media) {
        const src = await projectMediaObject(userId, projectId, m.fileName);
        if (!src) throw new Error("Media file not found in project.");
        const dest = await copyIntoLibrary(userId, src, taken);
        media.push({ fileName: dest, name: m.name, type: m.type, duration: m.duration, width: m.width, height: m.height });
      }
      const doc: TemplateDoc = {
        folderId: null,
        duration: input.duration,
        media,
        layers: input.layers ?? [],
        audio: input.audio ?? [],
        texts: input.texts ?? [],
        cues: input.cues ?? [],
      };
      const row = await prisma.cutTemplate.create({
        data: { userId, name: (input.name || "Template").trim().slice(0, 80), doc: asJson(doc) },
      });
      return Response.json(templateView(row));
    } catch (e) {
      return caught(e, "Could not save the template.");
    }
  },

  /** Materialize a template into a project: copy its media in and hand back the
   * project file names (in template media order) plus the stored edit. */
  async useTemplate(userId: string, id: string, req: Request) {
    try {
      const { projectId } = (await req.json()) as { projectId: string };
      if (!(await getProject(userId, projectId))) throw new Error("Project not found.");
      const row = await findTemplate(userId, id);
      if (!row) throw new Error("Template not found.");
      const template = templateView(row);
      const taken = await takenMediaNames(userId, projectId);
      const media: TemplateMedia[] = [];
      for (const m of template.media) {
        const dest = await copyIntoProject(userId, projectId, m.fileName, taken);
        media.push({ ...m, fileName: dest });
      }
      return Response.json({ template, media });
    } catch (e) {
      return caught(e, "Could not add the template.");
    }
  },

  /** Append one project media file to a template as a part at its end. */
  async addToTemplate(userId: string, id: string, req: Request) {
    try {
      const { projectId, ...input } = (await req.json()) as {
        projectId: string;
        media: TemplateMedia;
        layer?: Omit<TemplateLayer, "media" | "start">;
        audio?: Omit<TemplateAudio, "media" | "start">;
        extend: number;
      };
      const row = await findTemplate(userId, id);
      if (!row) throw new Error("Template not found.");
      const src = await projectMediaObject(userId, projectId, input.media.fileName);
      if (!src) throw new Error("Media file not found in project.");
      const dest = await copyIntoLibrary(userId, src, await takenLibraryNames(userId));
      const doc = (row.doc as unknown as TemplateDoc);
      const mi = (doc.media ?? []).length;
      const next: TemplateDoc = {
        ...doc,
        media: [...(doc.media ?? []), { ...input.media, fileName: dest }],
        audio: input.audio
          ? [...(doc.audio ?? []), { ...input.audio, media: mi, start: doc.duration }]
          : doc.audio ?? [],
        layers:
          !input.audio && input.layer
            ? [...(doc.layers ?? []), { ...input.layer, media: mi, start: doc.duration }]
            : doc.layers ?? [],
        duration: doc.duration + input.extend,
      };
      const updated = await prisma.cutTemplate.update({ where: { id }, data: { doc: asJson(next) } });
      return Response.json(templateView(updated));
    } catch (e) {
      return caught(e, "Could not add to the template.");
    }
  },

  async renameTemplate(userId: string, id: string, req: Request) {
    try {
      const { name } = (await req.json()) as { name?: string };
      const trimmed = (name ?? "").trim();
      if (!trimmed) throw new Error("Template name required.");
      const row = await findTemplate(userId, id);
      if (!row) throw new Error("Template not found.");
      const updated = await prisma.cutTemplate.update({
        where: { id },
        data: { name: trimmed.slice(0, 80) },
      });
      return Response.json(templateView(updated));
    } catch (e) {
      return caught(e, "Could not rename the template.");
    }
  },

  async removeTemplate(userId: string, id: string) {
    try {
      const row = await findTemplate(userId, id);
      if (row) {
        await prisma.cutTemplate.delete({ where: { id } });
        // The media copies are private to this template, so removing them is safe.
        const doc = row.doc as unknown as TemplateDoc;
        for (const m of doc.media ?? []) await deleteLibraryObject(userId, m.fileName);
      }
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the template.");
    }
  },
};
