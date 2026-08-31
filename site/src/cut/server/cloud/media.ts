// Media upload plumbing for cloud projects: browser bytes go straight to R2 via
// presigned PUTs; these routes mint the URLs and keep CutMediaObject + quota in
// step. Small images (AI generations, stock tiles) still ride through the
// server like the engine's importImage.
import { prisma } from "@/lib/prisma";
import { mediaObjectUrl, mediaUrlLifetime } from "./mediaCdn";
import { getProject, takenMediaNames } from "./projects";
import { head, presignPut, projectMediaKey, putObject } from "./r2";
import { addUsage, quotaCheck } from "./usage";
import { caught, dedupeName, err, safeFileName } from "./util";

/** Direct-upload cap: anything larger goes through presign. */
const INLINE_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const PRESIGN_GET_BATCH_MAX = 500;

/** Width/height from the image header (PNG, JPEG, GIF, WebP). The hosted
 * runtime has no ffprobe; unknown formats report 0×0. */
function imageDims(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return { width: 0, height: 0 };
}

export const mediaCloud = {
  /** Mint a presigned PUT for one project media upload. The fileName is deduped
   * and claimed by a pending CutMediaObject row before the URL goes out. */
  async presign(userId: string, projectId: string, req: Request) {
    try {
      const body = (await req.json()) as {
        fileName?: string;
        mime?: string;
        bytes?: number;
        resume?: boolean;
        avoid?: string[];
      };
      if (!body.fileName || typeof body.bytes !== "number" || body.bytes <= 0) {
        return err("fileName and bytes are required.", 400);
      }
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      // A resumed upload already holds its name: the browser kept the bytes
      // across a reload and asks for a fresh URL for the same claim. Re-mint
      // against the claimed key so the name never shifts; a claim that
      // completed in the meantime reports done and uploads nothing. The size
      // has to match the claim — a same-named row of a different size is a
      // different file (the browser's local stash colliding with an object it
      // never saw), and answering "done" for it would silently swallow the
      // upload; that ask falls through to a fresh claim under a deduped name.
      if (body.resume) {
        const row = await prisma.cutMediaObject.findFirst({
          where: { userId, projectId, fileName: safeFileName(body.fileName), kind: "media" },
          orderBy: { createdAt: "desc" },
        });
        if (row && Number(row.bytes) === Math.round(body.bytes)) {
          if (row.uploadState === "complete") {
            return Response.json({ fileName: row.fileName, key: row.r2Key, done: true });
          }
          const url = await presignPut(row.r2Key, body.mime ?? "application/octet-stream", Number(row.bytes));
          return Response.json({ fileName: row.fileName, key: row.r2Key, url });
        }
      }
      const over = await quotaCheck(userId, body.bytes);
      if (over) return over;
      // `avoid` carries names the browser holds locally with no cloud row
      // (413-era stashes): claiming one would collide with the only copy of
      // another file on the client's disk.
      const avoid = Array.isArray(body.avoid)
        ? body.avoid.filter((n): n is string => typeof n === "string").map(safeFileName)
        : [];
      const fileName = dedupeName(
        safeFileName(body.fileName),
        new Set([...(await takenMediaNames(userId, projectId)), ...avoid])
      );
      const key = projectMediaKey(userId, projectId, fileName);
      const bytes = Math.round(body.bytes);
      const url = await presignPut(key, body.mime ?? "application/octet-stream", bytes);
      await prisma.cutMediaObject.create({
        data: {
          userId,
          projectId,
          r2Key: key,
          fileName,
          mime: body.mime ?? "",
          bytes: BigInt(bytes),
          kind: "media",
          uploadState: "pending",
        },
      });
      return Response.json({ fileName, key, url });
    } catch (e) {
      return caught(e, "Could not presign the upload.");
    }
  },

  /** The browser finished its PUT: verify the object landed, mark the row
   * complete with the real size, and bump usage. */
  async complete(userId: string, req: Request) {
    try {
      const { key } = (await req.json()) as { key?: string };
      if (!key) return err("key is required.", 400);
      const row = await prisma.cutMediaObject.findFirst({ where: { userId, r2Key: key } });
      if (!row) return err("Unknown upload.", 404);
      if (row.uploadState === "complete") return Response.json({ fileName: row.fileName });
      const info = await head(key);
      if (!info) return err("The upload never arrived.", 400);
      await prisma.$transaction(async (tx) => {
        await tx.cutMediaObject.update({
          where: { id: row.id },
          data: {
            uploadState: "complete",
            bytes: BigInt(info.bytes),
            ...(info.mime ? { mime: info.mime } : {}),
          },
        });
        await addUsage(tx, userId, info.bytes);
      });
      return Response.json({ fileName: row.fileName });
    } catch (e) {
      return caught(e, "Could not complete the upload.");
    }
  },

  /** Batch signed GETs so a loaded project can hydrate every asset URL in one
   * round trip. Keys are deterministic from projectId + fileName. */
  async presignGetBatch(userId: string, req: Request) {
    try {
      const { items } = (await req.json()) as {
        items?: { projectId?: string; fileName?: string }[];
      };
      if (!Array.isArray(items)) return err("items is required.", 400);
      if (items.length > PRESIGN_GET_BATCH_MAX) return err("Too many items.", 400);
      const wanted = items.filter(
        (i) => typeof i.projectId === "string" && typeof i.fileName === "string"
      );
      // One query for the whole batch, not one per file. It carries the version
      // each URL needs — a filename freed by a delete can be handed out again,
      // and the edge would serve the old object under it — and it is also how a
      // file that no longer exists is left out instead of minted for.
      const rows = await prisma.cutMediaObject.findMany({
        where: {
          userId,
          kind: "media",
          projectId: { in: [...new Set(wanted.map((i) => i.projectId!))] },
        },
        select: { projectId: true, fileName: true, updatedAt: true },
      });
      const versions = new Map(
        rows.map((r) => [`${r.projectId}/${r.fileName}`, String(r.updatedAt.getTime())])
      );
      const urls = wanted.flatMap((i) => {
        const fileName = safeFileName(i.fileName!);
        const version = versions.get(`${i.projectId}/${fileName}`);
        if (!version) return [];
        return [
          {
            projectId: i.projectId!,
            fileName: i.fileName!,
            url: mediaObjectUrl(projectMediaKey(userId, i.projectId!, fileName), { version }),
          },
        ];
      });
      return Response.json({ urls, expiresIn: mediaUrlLifetime() });
    } catch (e) {
      return caught(e, "Could not sign the media URLs.");
    }
  },

  /** Mirror of the engine's importImage for small payloads: store the bytes,
   * return the MediaAsset shape. Larger callers use presign. */
  async importImage(userId: string, projectId: string, req: Request) {
    try {
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("No image in upload.", 400);
      if (file.size > INLINE_UPLOAD_BYTES) return err("Image too large — use the presigned upload.", 413);
      const over = await quotaCheck(userId, file.size);
      if (over) return over;
      const nameField = form.get("name");
      const name = typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name;
      const raw = form.get("origin");
      const origin = raw === "generated" || raw === "sticker" ? raw : undefined;
      const fileName = dedupeName(
        safeFileName(file.name),
        await takenMediaNames(userId, projectId)
      );
      const key = projectMediaKey(userId, projectId, fileName);
      const buf = Buffer.from(await file.arrayBuffer());
      await putObject(key, buf, file.type || "application/octet-stream");
      await prisma.$transaction(async (tx) => {
        await tx.cutMediaObject.create({
          data: {
            userId,
            projectId,
            r2Key: key,
            fileName,
            mime: file.type ?? "",
            bytes: BigInt(buf.length),
            kind: "media",
            uploadState: "complete",
          },
        });
        await addUsage(tx, userId, buf.length);
      });
      const dims = imageDims(buf);
      return Response.json({
        id: crypto.randomUUID().slice(0, 8),
        type: "image",
        name,
        fileName,
        duration: 0,
        width: dims.width,
        height: dims.height,
        ...(origin ? { origin } : {}),
      });
    } catch (e) {
      return caught(e, "Could not import the image.");
    }
  },
};
