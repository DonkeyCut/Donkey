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
import { MEDIA_REDIRECT_HEADERS, mediaObjectUrl, mediaUrlLifetime } from "./mediaCdn";
import { getProject, takenMediaNames } from "./projects";
import { copy, del, head, libraryKey, presignPut, projectMediaKey } from "./r2";
import { addUsage, quotaCheck } from "./usage";
import {
  caught,
  decodeFileParam,
  dedupeName,
  err,
  inspirationFolderId,
  redirect,
  safeFileName,
  typeOf,
} from "./util";

/** Cap on one signed-URL batch, matching the project media batch. */
const PRESIGN_GET_BATCH_MAX = 500;

/** Descriptive fields the engine derives with ffprobe; the cloud stores them on
 * the row, supplied by the client (which probed in the browser) or copied from
 * the source project doc. */
interface AssetMeta {
  name?: string;
  /** The short name the titling model read off the clip itself, standing in
   * for the file's own name wherever the asset is shown. Written once, by
   * cloud/clipTitle.ts. */
  title?: string;
  type?: "video" | "audio" | "image" | "font";
  duration?: number;
  width?: number;
  height?: number;
  source?: LibrarySource;
  /** File name of the source's cover image, an object of its own under this
   * account's library prefix. */
  posterFile?: string;
  /** How the asset entered the account from the iOS app: a phone camera
   * recording (the desktop's Camera Roll) or an inspiration item. */
  origin?: "camera" | "inspiration";
}

interface TemplateDoc {
  folderId?: string | null;
  duration: number;
  media: TemplateMedia[];
  layers: TemplateLayer[];
  audio: TemplateAudio[];
  texts: unknown[];
  cues: unknown[];
  sound?: LibraryTemplate["sound"];
}

/** A template with nothing on it saves nothing; a sound preset is a template
 * carrying only its treatment. */
const templateEmpty = (input: TemplateInput) =>
  !input.media?.length && !input.texts?.length && !input.cues?.length && !input.sound;

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
  obj: { fileName: string },
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
    ...(meta.posterFile ? { posterFile: meta.posterFile } : {}),
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.origin ? { origin: meta.origin } : {}),
  };
}

function templateView(row: {
  id: string;
  name: string;
  doc: unknown;
  createdAt: Date;
}): LibraryTemplate {
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
    ...(doc.sound ? { sound: doc.sound } : {}),
  };
}

const asJson = (doc: TemplateDoc) => doc as unknown as Prisma.InputJsonValue;

async function findTemplate(userId: string, id: string) {
  return prisma.cutTemplate.findFirst({ where: { id, userId } });
}

/** A project media object row, complete, by fileName — the copy source for
 * save/saveTemplate/addToTemplate. */
async function projectMediaObject(
  userId: string,
  projectId: string,
  fileName: string,
) {
  return prisma.cutMediaObject.findFirst({
    where: {
      userId,
      projectId,
      kind: "media",
      fileName,
      uploadState: "complete",
    },
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
  taken: Set<string>,
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
 * route and the storage-reclamation sweep (gc.ts).
 *
 * `tombstone` keeps the asset row behind with `deletedAt` set. That row is how
 * a delete made here reaches the iOS app, which mirrors the Camera Roll on the
 * phone: the listing names it, and the phone takes the same clip off. The
 * reclamation sweep passes nothing, so an asset it collects simply stops being
 * listed and the phone keeps the copy it shot. */
export async function deleteLibraryAssetCascade(
  userId: string,
  id: string,
  opts?: { tombstone?: boolean },
): Promise<number | null> {
  const asset = await prisma.cutLibraryAsset.findFirst({
    where: { id, userId, deletedAt: null },
  });
  if (!asset) return null;
  const obj = await prisma.cutMediaObject.findFirst({
    where: { id: asset.mediaObjectId, userId },
  });
  // The cover image is a second object under the library prefix, referenced
  // only by this row, so it leaves with it.
  const posterName = ((asset.meta ?? {}) as AssetMeta).posterFile;
  const poster = posterName
    ? await prisma.cutMediaObject.findFirst({
        where: { userId, kind: "library", fileName: posterName },
      })
    : null;
  const objects = [obj, poster].filter((o): o is NonNullable<typeof o> => !!o);
  const freed = objects
    .filter((o) => o.uploadState === "complete")
    .reduce((n, o) => n + Number(o.bytes), 0);
  await prisma.$transaction(async (tx) => {
    if (opts?.tombstone) {
      await tx.cutLibraryAsset.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    } else {
      await tx.cutLibraryAsset.delete({ where: { id } });
    }
    for (const o of objects)
      await tx.cutMediaObject.delete({ where: { id: o.id } });
    if (freed > 0) await addUsage(tx, userId, -freed);
  });
  if (objects.length > 0) await del(objects.map((o) => o.r2Key));
  return freed;
}

/** Copy one library object into a project, recording the row and usage.
 * Returns the fileName inside the project. */
async function copyIntoProject(
  userId: string,
  projectId: string,
  libFileName: string,
  taken: Set<string>,
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
    if (row.uploadState === "complete")
      await addUsage(tx, userId, -Number(row.bytes));
  });
  await del([row.r2Key]);
}

export const libraryCloud = {
  /** The shelf. `?deleted=1` adds the tombstoned ids — the phone asks for
   * them to mirror a delete made here onto its Camera Roll, and it is the
   * only client that does. Every other listing skips the query and the rows
   * it would carry: an account that has pruned its shelf for a season has
   * thousands of them, and the editor reads none. */
  async list(userId: string, req?: Request) {
    const wantsDeleted = !!req && new URL(req.url).searchParams.get("deleted") === "1";
    const [assetRows, deletedRows, folderRows, templateRows] = await Promise.all([
      prisma.cutLibraryAsset.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      }),
      wantsDeleted
        ? prisma.cutLibraryAsset.findMany({
            where: { userId, deletedAt: { not: null } },
            select: { id: true },
          })
        : Promise.resolve([]),
      prisma.cutFolder.findMany({
        where: { userId, scope: "library" },
        orderBy: { createdAt: "asc" },
      }),
      prisma.cutTemplate.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
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
    // Assets someone deleted, for a client that holds its own copy of them:
    // the iOS app deletes the matching clip on the phone.
    return Response.json({
      assets,
      folders,
      templates,
      ...(wantsDeleted ? { deletedAssetIds: deletedRows.map((r) => r.id) } : {}),
    });
  },

  /** Mint a presigned PUT for a direct-to-library upload. */
  async presign(userId: string, req: Request) {
    try {
      const body = (await req.json()) as {
        fileName?: string;
        mime?: string;
        bytes?: number;
        resume?: boolean;
      };
      if (!body.fileName || typeof body.bytes !== "number" || body.bytes <= 0) {
        return err("fileName and bytes are required.", 400);
      }
      if (!typeOf(body.fileName)) return err("Unsupported file type.", 400);
      // A resumed upload already holds its claim: the client kept the bytes
      // (the iOS app's journal) and asks for a fresh URL under the same name.
      // A claim that completed in the meantime reports done and uploads
      // nothing; a same-named row of a different size is a different file and
      // falls through to a fresh claim under a deduped name.
      if (body.resume) {
        const row = await prisma.cutMediaObject.findFirst({
          where: { userId, kind: "library", fileName: safeFileName(body.fileName) },
          orderBy: { createdAt: "desc" },
        });
        if (row && Number(row.bytes) === Math.round(body.bytes)) {
          if (row.uploadState === "complete") {
            return Response.json({ fileName: row.fileName, key: row.r2Key, done: true });
          }
          const url = await presignPut(row.r2Key, body.mime ?? "application/octet-stream");
          return Response.json({ fileName: row.fileName, key: row.r2Key, url });
        }
      }
      const over = await quotaCheck(userId, body.bytes);
      if (over) return over;
      const fileName = dedupeName(
        safeFileName(body.fileName),
        await takenLibraryNames(userId),
      );
      const key = libraryKey(userId, fileName);
      const url = await presignPut(
        key,
        body.mime ?? "application/octet-stream",
      );
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

  /** Finish a library upload: verify, mark complete, register the asset. An
   * inspiration upload files itself into the ensured Inspiration folder; any
   * other folderId must name one of this user's library folders. */
  async complete(userId: string, req: Request) {
    try {
      const { key, posterKey, meta, folderId } = (await req.json()) as {
        key?: string;
        posterKey?: string;
        meta?: AssetMeta;
        folderId?: string;
      };
      if (!key) return err("key is required.", 400);
      let destFolder: string | null = null;
      if (meta?.origin === "inspiration") {
        destFolder = await ensureInspirationFolder(userId);
      } else if (folderId) {
        const folder = await prisma.cutFolder.findFirst({
          where: { id: folderId, userId, scope: "library" },
        });
        if (!folder) return err("Folder not found.", 404);
        destFolder = folderId;
      }
      const obj = await prisma.cutMediaObject.findFirst({
        where: { userId, r2Key: key },
      });
      if (!obj) return err("Unknown upload.", 404);
      // A retried complete (the iOS app reconciling after an interrupted
      // sync) lands on the asset it already made instead of minting a twin.
      const already = await prisma.cutLibraryAsset.findFirst({
        where: { userId, mediaObjectId: obj.id, deletedAt: null },
      });
      if (already) return Response.json(assetView(already, obj));
      const info = obj.uploadState === "complete" ? null : await head(key);
      if (obj.uploadState !== "complete" && !info)
        return err("The upload never arrived.", 400);
      // A cover that came up alongside the file: its own object, finished the
      // same way, named on the asset so the delete cascade takes it too.
      const posterObj = posterKey
        ? await prisma.cutMediaObject.findFirst({
            where: { userId, r2Key: posterKey },
          })
        : null;
      const posterInfo =
        posterObj && posterObj.uploadState !== "complete"
          ? await head(posterKey!)
          : null;
      const posterFile =
        posterInfo || posterObj?.uploadState === "complete"
          ? posterObj!.fileName
          : undefined;
      const row = await prisma.$transaction(async (tx) => {
        if (posterObj && posterInfo) {
          await tx.cutMediaObject.update({
            where: { id: posterObj.id },
            data: {
              uploadState: "complete",
              bytes: BigInt(posterInfo.bytes),
              ...(posterInfo.mime ? { mime: posterInfo.mime } : {}),
            },
          });
          await addUsage(tx, userId, posterInfo.bytes);
        }
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
            folderId: destFolder,
            meta: {
              name: meta?.name ?? obj.fileName,
              type: meta?.type ?? typeOf(obj.fileName) ?? "video",
              duration: meta?.duration ?? 0,
              ...(meta?.width
                ? { width: meta.width, height: meta.height }
                : {}),
              ...(meta?.source ? { source: meta.source } : {}),
              ...((posterFile ?? meta?.posterFile)
                ? { posterFile: posterFile ?? meta?.posterFile }
                : {}),
              ...(meta?.origin === "camera" || meta?.origin === "inspiration"
                ? { origin: meta.origin }
                : {}),
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
      const { assetId, projectId } = (await req.json()) as {
        assetId: string;
        projectId: string;
      };
      const asset = await prisma.cutLibraryAsset.findFirst({
        where: { id: assetId, userId, deletedAt: null },
      });
      if (!asset) throw new Error("Library asset not found.");
      const obj = await prisma.cutMediaObject.findUnique({
        where: { id: asset.mediaObjectId },
      });
      if (!obj) throw new Error("Library asset not found.");
      if (!(await getProject(userId, projectId)))
        throw new Error("Project not found.");
      const fileName = await copyIntoProject(
        userId,
        projectId,
        obj.fileName,
        await takenMediaNames(userId, projectId),
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
      const docAsset = (
        project?.doc as { assets?: StoredAsset[] } | undefined
      )?.assets?.find((a) => a.fileName === fileName);
      const dest = await copyIntoLibrary(
        userId,
        src,
        await takenLibraryNames(userId),
      );
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
            ...(docAsset?.width
              ? { width: docAsset.width, height: docAsset.height }
              : {}),
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
      const { id, folderId } = (await req.json()) as {
        id: string;
        folderId: string | null;
      };
      if (folderId) {
        const folder = await prisma.cutFolder.findFirst({
          where: { id: folderId, userId, scope: "library" },
        });
        if (!folder) throw new Error("Folder not found.");
      }
      const asset = await prisma.cutLibraryAsset.findFirst({
        where: { id, userId, deletedAt: null },
      });
      if (asset) {
        await prisma.cutLibraryAsset.update({
          where: { id },
          data: { folderId: folderId ?? null },
        });
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
      // Idempotent: a delete replayed from the iOS app's journal after the
      // asset already left reports done, so the tombstone clears.
      await deleteLibraryAssetCascade(userId, id, { tombstone: true });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete.");
    }
  },

  /** Signed edge URLs for library files, the library's twin of the project
   * media batch (media.ts presignGetBatch). Everything that reads bytes to
   * decode them — a card's frames, a clip dragged onto the timeline — reads
   * the object directly instead of through serveMedia's redirect, which is
   * what puts those reads on the chunk cache and the edge cache. Library files
   * are written once, so the URLs carry no version.
   *
   * A name with no completed object is left out; the client falls back to the
   * route for it. */
  async presignGetBatch(userId: string, req: Request) {
    try {
      const { files } = (await req.json()) as { files?: string[] };
      if (!Array.isArray(files)) return err("files is required.", 400);
      if (files.length > PRESIGN_GET_BATCH_MAX) return err("Too many files.", 400);
      const wanted = [
        ...new Set(
          files
            .filter((f): f is string => typeof f === "string")
            .map((f) => safeFileName(f)),
        ),
      ];
      const rows = wanted.length
        ? await prisma.cutMediaObject.findMany({
            where: {
              userId,
              kind: "library",
              uploadState: "complete",
              fileName: { in: wanted },
            },
            select: { fileName: true },
          })
        : [];
      return Response.json({
        urls: rows.map((r) => ({
          fileName: r.fileName,
          url: mediaObjectUrl(libraryKey(userId, r.fileName)),
        })),
        expiresIn: mediaUrlLifetime(),
      });
    } catch (e) {
      return caught(e, "Could not sign the library URLs.");
    }
  },

  async serveMedia(userId: string, file: string, download = false) {
    try {
      const fileName = decodeFileParam(file);
      // Library files are written once — an import lands under a fresh name —
      // so the redirect itself is cacheable and a revisit paints every poster
      // from the browser's cache.
      return redirect(
        mediaObjectUrl(
          libraryKey(userId, fileName),
          download ? { downloadName: fileName } : undefined,
        ),
        MEDIA_REDIRECT_HEADERS,
      );
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
      return Response.json({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.getTime(),
      });
    } catch (e) {
      return caught(e, "Could not create folder.");
    }
  },

  async renameFolder(userId: string, id: string, req: Request) {
    try {
      const { name } = (await req.json()) as { name?: string };
      const trimmed = (name ?? "").trim();
      if (!trimmed) throw new Error("Folder name required.");
      const row = await prisma.cutFolder.findFirst({
        where: { id, userId, scope: "library" },
      });
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
        await tx.cutFolder.deleteMany({
          where: { id, userId, scope: "library" },
        });
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
      const { projectId, ...input } = (await req.json()) as {
        projectId: string;
      } & TemplateInput;
      if (!(await getProject(userId, projectId)))
        throw new Error("Project not found.");
      if (templateEmpty(input)) throw new Error("Nothing to save.");
      const taken = await takenLibraryNames(userId);
      const media: TemplateMedia[] = [];
      for (const m of input.media) {
        const src = await projectMediaObject(userId, projectId, m.fileName);
        if (!src) throw new Error("Media file not found in project.");
        const dest = await copyIntoLibrary(userId, src, taken);
        media.push({
          fileName: dest,
          name: m.name,
          type: m.type,
          duration: m.duration,
          width: m.width,
          height: m.height,
        });
      }
      const doc: TemplateDoc = {
        folderId: null,
        duration: input.duration,
        media,
        layers: input.layers ?? [],
        audio: input.audio ?? [],
        texts: input.texts ?? [],
        cues: input.cues ?? [],
        ...(input.sound ? { sound: input.sound } : {}),
      };
      const row = await prisma.cutTemplate.create({
        data: {
          userId,
          name: (input.name || "Template").trim().slice(0, 80),
          doc: asJson(doc),
        },
      });
      return Response.json(templateView(row));
    } catch (e) {
      return caught(e, "Could not save the template.");
    }
  },

  /** Take in a template carried off another shelf: its media are presigned
   * objects already in R2, named here in the doc's own order. */
  async importTemplate(userId: string, req: Request) {
    try {
      const { keys, ...input } = (await req.json()) as TemplateInput & {
        keys?: string[];
        folderId?: string | null;
      };
      if (templateEmpty(input)) throw new Error("Nothing to add.");
      const media: TemplateMedia[] = [];
      for (const [i, m] of (input.media ?? []).entries()) {
        const key = keys?.[i];
        const obj = key
          ? await prisma.cutMediaObject.findFirst({
              where: { userId, r2Key: key },
            })
          : null;
        if (!obj) throw new Error("Template media missing.");
        if (obj.uploadState !== "complete") {
          const info = await head(key!);
          if (!info) throw new Error("The upload never arrived.");
          await prisma.$transaction(async (tx) => {
            await tx.cutMediaObject.update({
              where: { id: obj.id },
              data: {
                uploadState: "complete",
                bytes: BigInt(info.bytes),
                ...(info.mime ? { mime: info.mime } : {}),
              },
            });
            await addUsage(tx, userId, info.bytes);
          });
        }
        media.push({ ...m, fileName: obj.fileName });
      }
      const doc: TemplateDoc = {
        folderId: input.folderId ?? null,
        duration: input.duration,
        media,
        layers: input.layers ?? [],
        audio: input.audio ?? [],
        texts: input.texts ?? [],
        cues: input.cues ?? [],
        ...(input.sound ? { sound: input.sound } : {}),
      };
      const row = await prisma.cutTemplate.create({
        data: {
          userId,
          name: (input.name || "Template").trim().slice(0, 80),
          doc: asJson(doc),
        },
      });
      return Response.json(templateView(row));
    } catch (e) {
      return caught(e, "Could not add the template.");
    }
  },

  /** Materialize a template into a project: copy its media in and hand back the
   * project file names (in template media order) plus the stored edit. */
  async useTemplate(userId: string, id: string, req: Request) {
    try {
      const { projectId } = (await req.json()) as { projectId: string };
      if (!(await getProject(userId, projectId)))
        throw new Error("Project not found.");
      const row = await findTemplate(userId, id);
      if (!row) throw new Error("Template not found.");
      const template = templateView(row);
      const taken = await takenMediaNames(userId, projectId);
      const media: TemplateMedia[] = [];
      for (const m of template.media) {
        const dest = await copyIntoProject(
          userId,
          projectId,
          m.fileName,
          taken,
        );
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
      const src = await projectMediaObject(
        userId,
        projectId,
        input.media.fileName,
      );
      if (!src) throw new Error("Media file not found in project.");
      const dest = await copyIntoLibrary(
        userId,
        src,
        await takenLibraryNames(userId),
      );
      const doc = row.doc as unknown as TemplateDoc;
      const mi = (doc.media ?? []).length;
      const next: TemplateDoc = {
        ...doc,
        media: [...(doc.media ?? []), { ...input.media, fileName: dest }],
        audio: input.audio
          ? [
              ...(doc.audio ?? []),
              { ...input.audio, media: mi, start: doc.duration },
            ]
          : (doc.audio ?? []),
        layers:
          !input.audio && input.layer
            ? [
                ...(doc.layers ?? []),
                { ...input.layer, media: mi, start: doc.duration },
              ]
            : (doc.layers ?? []),
        duration: doc.duration + input.extend,
      };
      const updated = await prisma.cutTemplate.update({
        where: { id },
        data: { doc: asJson(next) },
      });
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
        for (const m of doc.media ?? [])
          await deleteLibraryObject(userId, m.fileName);
      }
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the template.");
    }
  },
};

/** The folder a new account starts with, so the Library shows that it takes
 * font files before anyone has dropped one in. Derived from the user id, so a
 * retried signup lands on the same row; an ordinary folder otherwise, free to
 * rename, empty, or delete. */
export const fontsFolderId = (userId: string) => `fonts-${userId}`;

/** The Inspiration folder, created the first time an inspiration item lands.
 * Its id is derived (util.inspirationFolderId), so every writer converges on
 * one row; an ordinary folder otherwise, free to rename or delete. */
export async function ensureInspirationFolder(userId: string): Promise<string> {
  const id = inspirationFolderId(userId);
  await prisma.cutFolder.upsert({
    where: { id },
    create: { id, userId, name: "Inspiration", scope: "library" },
    update: {},
  });
  return id;
}

export async function seedFontsFolder(userId: string): Promise<void> {
  const id = fontsFolderId(userId);
  if (await prisma.cutFolder.findUnique({ where: { id } })) return;
  await prisma.cutFolder.create({
    data: { id, userId, name: "Fonts", scope: "library" },
  });
}
